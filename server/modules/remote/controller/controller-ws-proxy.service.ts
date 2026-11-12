/**
 * The Controller's WebSocket side: `/r/<peerId>/ws` (chat) and `/r/<peerId>/shell` (terminal), plugged
 * into the websocket gateway through `RemoteWebSocketGateway` (the gateway never imports this module).
 *
 * Authentication happens at the upgrade, with the tab token carried in `Sec-WebSocket-Protocol` as
 * `['cloudcli-tab', <token>]`: a URL would end up in proxy logs. The gateway echoes the marker
 * `cloudcli-tab` and never the token; the main JWT, a token in the query string and a token for another
 * peer are all refused. While the link is not online the upgrade is refused with 503 so the browser
 * retries. `/shell` upgrades of one pairing are spaced out by delaying the verdict (the stock shell
 * client reconnects at once with no back-off): the upgrade is postponed, never refused, unless more than
 * a few are already waiting (429). The login and the pairing are checked again after the wait, and an
 * upgrade whose browser went away while it waited is dropped.
 *
 * An accepted socket is bridged to one mux WebSocket stream: messages go both ways unchanged (the Host
 * bridge applies its message policy), close codes are translated to what each side can send, and
 * back-pressure is honoured towards the browser (stop reading while the stream queue is full). In the
 * other direction the Host can outrun a slow browser, so unread bytes are counted (`bufferedAmount`)
 * and streams are cut with `REMOTE_QUOTA` above the per-stream, per-pairing or global budget.
 */

import type { IncomingMessage } from 'node:http';

import { WebSocket } from 'ws';

import type { RemoteBrowserConnection, RemoteMuxStream, RemoteStreamEnd, RemoteUpgradeVerdict, RemoteWebSocketGateway } from '@/shared/types.js';

import { MAX_WS_MESSAGE_BYTES } from '../mux/frames.js';

import type { PeerRegistry } from './peer-registry.service.js';
import { DEFAULT_RECEIVE_BUDGET_BYTES, createReceiveLedger, resolveReceiveBudgets, type ReceiveLedger } from './receive-budget.js';
import { createShellUpgradeThrottle } from './shell-upgrade-throttle.js';
import type { TabTokenService } from './tab-token.service.js';

/** The subprotocol the frame offers first; the token is the second entry and is never echoed. */
export const TAB_SUBPROTOCOL = 'remotecli-tab';
export const LEGACY_TAB_SUBPROTOCOL = 'cloudcli-tab';
/** Smallest gap between two `/shell` upgrades of one pairing (contracts section 1). */
const SHELL_UPGRADE_MIN_INTERVAL_MS = 2000;
/** `/shell` upgrades of one pairing that may wait for their slot; one more is refused with 429. */
const SHELL_UPGRADE_MAX_PENDING = 4;
/**
 * Largest WebSocket message the transport will buffer from a `/r` browser socket: twice the message the
 * gateway forwards, so an honest too-big message still gets the gateway's own close reason while a hostile
 * frame is refused by the socket layer before it is buffered whole.
 */
export const REMOTE_SOCKET_MAX_PAYLOAD_BYTES = 2 * MAX_WS_MESSAGE_BYTES;
const CLOSE_POLICY = 4403;
const CLOSE_TRY_AGAIN = 1013;
const CLOSE_INTERNAL = 1011;
/** A close frame's reason must fit in 123 bytes together with the 2-byte code. */
const MAX_CLOSE_REASON_BYTES = 123;
const UPGRADE_PATH = /^\/r\/([A-Za-z0-9_-]{1,64})\/(ws|shell)$/;

export type RemoteWebSocketGatewayOptions = {
  tabs: Pick<TabTokenService, 'authenticate'>;
  registry: Pick<PeerRegistry, 'attach' | 'trackConnection'>;
  /** Minimum gap between `/shell` upgrades of one pairing (default 2000 ms). */
  shellMinIntervalMs?: number;
  /** `/shell` upgrades of one pairing that may wait for their slot (default 4); one more is refused with 429. */
  shellMaxPending?: number;
  /** Unread bytes tolerated per socket before the stream is cut (default 8 MiB). Ignored when `receiveLedger` is given. */
  receiveBudgetBytes?: number;
  /** The receive budgets shared with the HTTP proxy (per stream, per pairing, global); a private ledger when absent. */
  receiveLedger?: ReceiveLedger;
  /** Largest browser message forwarded (default: the mux limit, 1 MiB). */
  maxMessageBytes?: number;
};

type UpgradeContext = { peerId: string; path: '/ws' | '/shell' };

const refuse = (status: number, reason: string): RemoteUpgradeVerdict => ({ ok: false, status, reason });


/** A close code the mux can carry (1000-1003, 1007-1014, 3000-4999); the reserved ones a browser can report become 1000/1011. */
const muxCloseCode = (code: number): number => {
  if (code === 1005) return 1000;
  if ((code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)) return code;
  return CLOSE_INTERNAL;
};

const truncateReason = (reason: string): string => {
  let bytes = Buffer.from(reason, 'utf8');
  if (bytes.length <= MAX_CLOSE_REASON_BYTES) return reason;
  bytes = bytes.subarray(0, MAX_CLOSE_REASON_BYTES);
  // Never leave half a UTF-8 sequence at the cut.
  return bytes.toString('utf8').replace(/�+$/, '');
};

/** Close code for a stream that ended without the Host closing the WebSocket itself. */
const closeCodeFor = (end: RemoteStreamEnd): { code: number; reason: string } => {
  switch (end.cause) {
    case 'peer-ws-close':
      return { code: end.code, reason: end.reason };
    case 'link-down':
      return { code: CLOSE_TRY_AGAIN, reason: 'link-down' };
    case 'queue-overflow':
      return { code: CLOSE_TRY_AGAIN, reason: 'overloaded' };
    case 'error':
      if (end.code === 'REMOTE_FORBIDDEN') return { code: CLOSE_POLICY, reason: 'not-allowed' };
      if (end.code === 'REMOTE_QUOTA' || end.code === 'REMOTE_LINK_DOWN') return { code: CLOSE_TRY_AGAIN, reason: 'try-again' };
      return { code: CLOSE_INTERNAL, reason: 'host-error' };
    default:
      return { code: CLOSE_INTERNAL, reason: 'closed' };
  }
};

/**
 * Creates the gateway for `/r/**` sockets.
 * Consumed by: the Remote module, which hands it to the websocket module through the server entrypoint.
 */
export function createRemoteWebSocketGateway(options: RemoteWebSocketGatewayOptions): RemoteWebSocketGateway {
  const { tabs, registry } = options;
  const maxMessage = options.maxMessageBytes ?? MAX_WS_MESSAGE_BYTES;
  const ledger =
    options.receiveLedger ?? createReceiveLedger(resolveReceiveBudgets({}, { perStream: options.receiveBudgetBytes ?? DEFAULT_RECEIVE_BUDGET_BYTES }));
  const shellThrottle = createShellUpgradeThrottle({
    intervalMs: options.shellMinIntervalMs ?? SHELL_UPGRADE_MIN_INTERVAL_MS,
    maxPending: options.shellMaxPending ?? SHELL_UPGRADE_MAX_PENDING,
  });
  /** What the verdict decided, handed to the connection handler of the same request. */
  const contexts = new WeakMap<IncomingMessage, UpgradeContext>();

  /** The token and the pairing are good and the link is up right now (checked before and, for `/shell`, after the wait). */
  const checkAccess = (token: string, peerId: string): RemoteUpgradeVerdict => {
    if (!tabs.authenticate(token, peerId).ok) return refuse(401, 'unauthorized');
    let link;
    try {
      link = registry.attach(peerId);
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404) return refuse(404, 'not found');
      if (status === 410) return refuse(410, 'expired');
      return refuse(503, 'link down');
    }
    return link.sessionActive ? { ok: true } : refuse(503, 'link down');
  };

  /** Resolves `aborted` when the browser's connection ends while its upgrade waits. */
  const abortWhenClosed = (request: IncomingMessage): { signal: AbortSignal; dispose(): void } => {
    const controller = new AbortController();
    const onClose = (): void => controller.abort();
    const { socket } = request;
    // The server side stays half-open after the browser's FIN until someone ends it, so 'end' (not only 'close') means "gone".
    socket.once('close', onClose);
    socket.once('end', onClose);
    // An upgraded socket is not read until the handshake completes, so a browser that hung up would go
    // unnoticed. A client sends nothing before the 101, so reading (and discarding) meanwhile loses nothing.
    socket.resume();
    return {
      signal: controller.signal,
      dispose: () => {
        socket.off('close', onClose);
        socket.off('end', onClose);
      },
    };
  };

  const verifyUpgrade = async (request: IncomingMessage): Promise<RemoteUpgradeVerdict> => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    const match = UPGRADE_PATH.exec(pathname);
    if (!match) return refuse(404, 'not found');
    const [, peerId, channel] = match;

    // The token is read from the subprotocol list only: [marker, token], exactly.
    const offered = String(request.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    const validProtocol = offered.length === 2 && (offered[0] === TAB_SUBPROTOCOL || offered[0] === LEGACY_TAB_SUBPROTOCOL);
    if (!validProtocol) return refuse(401, 'unauthorized');
    const token = offered[1];
    const verdict = checkAccess(token, peerId);
    if (!verdict.ok) return verdict;

    if (channel === 'shell') {
      const { signal, dispose } = abortWhenClosed(request);
      try {
        const slot = await shellThrottle.acquire(peerId, signal);
        if (slot === 'full') return refuse(429, 'too many pending shell upgrades');
        if (slot === 'aborted') return refuse(499, 'closed by the browser');
        // The wait can be long: "log out everywhere", a forgotten pairing or a dropped link may have happened meanwhile.
        const after = checkAccess(token, peerId);
        if (!after.ok) return after;
      } finally {
        dispose();
      }
    }
    contexts.set(request, { peerId, path: channel === 'shell' ? '/shell' : '/ws' });
    return { ok: true };
  };

  const handleConnection = (socket: WebSocket, request: IncomingMessage): void => {
    const context = contexts.get(request);
    contexts.delete(request);
    if (!context) {
      socket.close(1008, 'unauthorized');
      return;
    }
    const { peerId, path } = context;

    let stream: RemoteMuxStream | undefined;
    let untrack: () => void = () => undefined;
    let done = false;
    // Unread bytes of this socket count towards the per-stream, per-pairing and global receive budgets.
    const budget = ledger.track(peerId, {
      unread: () => socket.bufferedAmount,
      cancel: () => stream?.fail('REMOTE_QUOTA', 'The browser reads too slowly.'),
    });

    const closeBrowser = (code: number, reason: string): void => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(code, truncateReason(reason));
    };
    const finish = (): void => {
      done = true;
      budget.release();
      untrack();
    };

    try {
      const link = registry.attach(peerId);
      if (!link.sessionActive) throw new Error('link down');
      stream = link.openStream(
        { kind: 'ws', meta: { path } },
        {
          onMessage: (payload, binary) => {
            if (done || socket.readyState !== WebSocket.OPEN) return;
            socket.send(payload, { binary });
            budget.enforce();
          },
          onPause: () => socket.pause(),
          onResume: () => socket.resume(),
          onClosed: (end) => {
            // Already ended from this side (a local close, or an over-size message): the browser got its code.
            if (done) return;
            finish();
            const { code, reason } = closeCodeFor(end);
            closeBrowser(code, reason);
          },
        },
      );
    } catch {
      budget.release();
      closeBrowser(CLOSE_TRY_AGAIN, 'link-down');
      return;
    }
    const open = stream;

    const connection: RemoteBrowserConnection = {
      close: (code, reason) => {
        if (done) return;
        finish();
        open.cancel();
        closeBrowser(code, reason);
      },
    };
    untrack = registry.trackConnection(peerId, connection);

    socket.on('message', (data, isBinary) => {
      if (done) return;
      const payload = data as Buffer; // the server socket keeps ws's default binaryType: one Buffer per message
      if (payload.length > maxMessage) {
        finish();
        open.cancel();
        closeBrowser(1009, 'message too big');
        return;
      }
      if (!open.sendMessage(payload, isBinary)) socket.pause();
    });
    socket.on('close', (code, reason) => {
      const alreadyDone = done;
      finish();
      if (!alreadyDone && !open.closed) open.closeWebSocket(muxCloseCode(code), truncateReason(reason.toString('utf8')));
    });
    // 'close' always follows an 'error'; listening keeps it from being thrown.
    socket.on('error', () => undefined);
  };

  return {
    owns: (pathname) => pathname.startsWith('/r/'),
    maxPayloadBytes: Math.max(REMOTE_SOCKET_MAX_PAYLOAD_BYTES, maxMessage * 2),
    verifyUpgrade,
    selectProtocol: (protocols) => {
      if (protocols.has(TAB_SUBPROTOCOL)) return TAB_SUBPROTOCOL;
      if (protocols.has(LEGACY_TAB_SUBPROTOCOL)) return LEGACY_TAB_SUBPROTOCOL;
      return false;
    },
    handleConnection,
  };
}

/**
 * Relay link for one pairing and one role (Host or Controller): relay connection, E2E session and
 * the glue between them (contracts sections 2, 4, 5). The pieces live next to it:
 * `reconnect-policy` (close classification and back-off), `link-status` (observable status),
 * `link-handshake` (HELLO1/2/3) and `link-session` (one established session).
 *
 * Connection: one relay socket per attempt, tagged with a generation number. Anything a socket
 * reports after the link moved on (closed it, saw it close, opened a newer one) is ignored, so a
 * late `close(4409)` of an old socket cannot mark a healthy link `replaced`.
 *
 * Failure policy for a session that ends: a protocol version mismatch makes the Controller wait the
 * long delay; the Host just drops the session and waits for the next HELLO1 when the Controller
 * went silent, mismatched or declared a protocol error. A desync or a peer's mid-session protocol
 * error makes the Controller re-handshake on the same socket after the next back-off step; a Host
 * that sees a desync resets its relay socket instead, so the relay tells the Controller at once
 * and the link is back within about a second. Everything else reconnects with back-off.
 */

import crypto from 'node:crypto';

import type {
  RemoteClock,
  RemoteLinkReason,
  RemoteLinkState,
  RemoteLinkStatus,
  RemoteMuxLimits,
  RemotePairingRole,
  RemoteRelayLink,
  RemoteRelaySocket,
  RemoteRelaySocketFactory,
  RemoteSessionKeys,
} from '@/shared/types.js';

import { computeGate, deriveLinkKeys } from '../crypto/key-derivation.js';
import { ChannelDesync, FRAME_TYPE_DATA } from '../crypto/secure-channel.js';
import { systemClock } from '../pairing/pairing-clock.js';

import { createLinkEmitter } from './link-emitter.js';
import { createLinkHandshake } from './link-handshake.js';
import { createLinkSession, type LinkSession } from './link-session.js';
import { createLinkStatus } from './link-status.js';
import { REFUSED_RETRY_MS, STABLE_MS, classifyClose, createBackoff } from './reconnect-policy.js';
import { createWsRelaySocketFactory } from './relay-socket.js';

export { toRemotePeerState } from './link-status.js';

/** Mux protocol version carried in APP_HELLO; a different value on the peer is `REMOTE_PROTOCOL` (AC-23). */
export const REMOTE_PROTOCOL_VERSION = 1;

/** Thrown by `openStream` while no session is established; maps to HTTP 503 `REMOTE_LINK_DOWN`. */
export class RemoteLinkDownError extends Error {
  readonly code = 'REMOTE_LINK_DOWN';

  constructor() {
    super('The relay link is not online.');
    this.name = 'RemoteLinkDownError';
  }
}

export type RelayLinkOptions = {
  role: RemotePairingRole;
  /** The 32-byte pairing key K (copied; the copy is wiped by `close`). */
  k: Uint8Array;
  /** Normalized relay base URL (`wss://host[:port]`). */
  relayUrl: string;
  /** `RELAY_SECRET`: only used to compute the connection gate. */
  relaySecret: string;
  /** Own app version announced in APP_HELLO. */
  appVersion: string;
  protocolVersion?: number;
  /** Defaults to the real `ws` client. */
  socketFactory?: RemoteRelaySocketFactory;
  /** Defaults to the system clock (unref'd timers). */
  clock?: RemoteClock;
  /** Per-link mux ceilings (open streams, queued bytes, replies, PINGs per second); see `RemoteMuxLimits`. */
  limits?: Partial<RemoteMuxLimits>;
  /** A stream/connection handler threw (diagnostics). */
  onHandlerError?(error: unknown): void;
};

type StreamHandler = Parameters<RemoteRelayLink['onStream']>[0];

const sha256Hex = (text: string): string => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

// Consumed by: Host bridge (phase 07) and Controller proxy (phase 08).
export const createRelayLink = (options: RelayLinkOptions): RemoteRelayLink => {
  const { role, relayUrl } = options;
  const clock = options.clock ?? systemClock;
  const protocolVersion = options.protocolVersion ?? REMOTE_PROTOCOL_VERSION;
  const socketFactory = options.socketFactory ?? createWsRelaySocketFactory({ clock });
  const keyCopy = Buffer.from(options.k);
  const linkKeys = deriveLinkKeys(keyCopy);
  const gate = computeGate('link', linkKeys.roomId, options.relaySecret);
  const authFrame = JSON.stringify(
    role === 'host'
      ? { t: 'auth', token: linkKeys.hostToken, ctl: sha256Hex(linkKeys.controllerToken) }
      : { t: 'auth', token: linkKeys.controllerToken },
  );
  const emitter = createLinkEmitter();
  const backoff = createBackoff();
  const linkStatus = createLinkStatus(emitter, backoff);

  let started = false;
  let finalClosed = false;
  let generation = 0;
  let socket: RemoteRelaySocket | undefined;
  let relayReady = false;
  let peerUp = false;
  let session: LinkSession | undefined;
  let streamHandler: StreamHandler | undefined;
  let cancelReconnect: (() => void) | undefined;
  let cancelRehandshake: (() => void) | undefined;
  let cancelSessionStable: (() => void) | undefined;
  let cancelSocketStable: (() => void) | undefined;

  const setStatus = linkStatus.set;

  // ------------------------------------------------------------------ timers and sockets

  /** Drops the handshake in progress and any scheduled re-handshake. */
  const cancelHandshakeWork = (): void => {
    handshake.cancel();
    cancelRehandshake?.();
    cancelRehandshake = undefined;
  };

  const cancelAllTimers = (): void => {
    cancelReconnect?.();
    cancelSessionStable?.();
    cancelSocketStable?.();
    cancelReconnect = cancelSessionStable = cancelSocketStable = undefined;
    cancelHandshakeWork();
  };

  /** Gives up on the current socket: later events from it are ignored. */
  const abandonSocket = (): void => {
    generation += 1;
    const old = socket;
    socket = undefined;
    relayReady = false;
    peerUp = false;
    try {
      old?.close(1000);
    } catch {
      // Already closed.
    }
  };

  const sendRaw = (data: Uint8Array): void => {
    try {
      const sent = socket?.sendBinary(data);
      if (sent) sent.catch(() => undefined);
    } catch {
      // A dead socket reports its close separately.
    }
  };

  const teardownSession = (reason: RemoteLinkReason): void => {
    cancelSessionStable?.();
    cancelSessionStable = undefined;
    const old = session;
    session = undefined;
    if (!old) return;
    const wasEstablished = old.established;
    old.stop(reason);
    if (wasEstablished) emitter.emit('session', { up: false, reason });
  };

  const scheduleReconnect = (state: RemoteLinkState, reason: RemoteLinkReason, delayMs: number): void => {
    setStatus(state, reason, delayMs);
    cancelReconnect = clock.setTimer(() => {
      cancelReconnect = undefined;
      connect();
    }, delayMs);
  };

  /** Drops the socket and the session and retries with back-off (Controller and Host alike). */
  const restartConnection = (reason: RemoteLinkReason): void => {
    teardownSession(reason);
    cancelAllTimers();
    abandonSocket();
    scheduleReconnect('connecting', reason, backoff.next());
  };

  /** Controller: tears the session down and starts a new handshake on the same socket after the next back-off step. */
  const scheduleRehandshake = (reason: RemoteLinkReason): void => {
    teardownSession(reason);
    const delay = backoff.next();
    setStatus('connecting', reason, delay);
    const forGeneration = generation;
    cancelRehandshake = clock.setTimer(() => {
      cancelRehandshake = undefined;
      if (forGeneration === generation) beginControllerHandshake();
    }, delay);
  };

  /** A calm minute clears the back-off counter; republish the status so observers see `attempt: 0`. */
  const armStableTimer = (slot: 'session' | 'socket'): void => {
    const timer = clock.setTimer(() => {
      if (slot === 'session') cancelSessionStable = undefined;
      else cancelSocketStable = undefined;
      backoff.reset();
      const { state, reason, retryInMs } = linkStatus.current;
      setStatus(state, reason, retryInMs);
    }, STABLE_MS);
    if (slot === 'session') cancelSessionStable = timer;
    else cancelSocketStable = timer;
  };

  // ------------------------------------------------------------------ session

  const startSession = (keys: RemoteSessionKeys): void => {
    const live = socket;
    if (!live) return;
    const created: LinkSession = createLinkSession({
      role,
      keys,
      transmit: (frame) => live.sendBinary(frame),
      clock,
      limits: options.limits,
      appVersion: options.appVersion,
      protocolVersion,
      onIncomingStream: (stream, open) => (streamHandler ? streamHandler(stream, open) : 'REMOTE_INTERNAL'),
      onEstablished: (peerAppVersion) => {
        if (session !== created) return;
        armStableTimer('session');
        if (role === 'controller') setStatus('online', null);
        emitter.emit('session', { up: true, peerAppVersion });
      },
      onFailed: (reason) => {
        if (session === created) handleSessionFailure(reason);
      },
      onHandlerError: options.onHandlerError,
    });
    session = created;
  };

  const handleSessionFailure = (reason: RemoteLinkReason): void => {
    if (reason === 'protocol-mismatch' && role === 'controller') {
      // A peer on another protocol version will not change within seconds: wait the long delay.
      teardownSession(reason);
      cancelAllTimers();
      abandonSocket();
      scheduleReconnect('rejected', reason, REFUSED_RETRY_MS);
    } else if (role === 'host' && (reason === 'protocol-mismatch' || reason === 'handshake-timeout' || reason === 'liveness-timeout' || reason === 'protocol-error')) {
      // The Host stays connected and waits for the Controller to try again.
      teardownSession(reason);
    } else if (role === 'controller' && reason === 'protocol-error') {
      scheduleRehandshake(reason);
    } else {
      restartConnection(reason);
    }
  };

  const handleDesync = (desync: ChannelDesync): void => {
    emitter.emit('desync', { code: desync.code });
    if (role === 'host') {
      // Resetting the relay socket makes the relay tell the Controller (peer down, then up again on
      // reconnect), which then handshakes at once: far faster than waiting for its PING to time out.
      restartConnection('desync');
    } else {
      scheduleRehandshake('desync');
    }
  };

  // ------------------------------------------------------------------ handshake

  const handshake = createLinkHandshake({
    role,
    k: keyCopy,
    clock,
    sendRaw,
    generation: () => generation,
    onKeys: (keys) => {
      // The peer proved it holds K: the previous session (if any) is replaced only now.
      teardownSession('peer-down');
      startSession(keys);
    },
    onTimeout: () => restartConnection('handshake-timeout'),
    onError: (code) => emitter.emit('handshake-error', { code }),
  });

  const beginControllerHandshake = (): void => {
    if (role !== 'controller' || !relayReady || !peerUp) return;
    // A new HELLO1 supersedes whatever session or handshake was there.
    teardownSession('peer-down');
    cancelHandshakeWork();
    setStatus('connecting', null);
    handshake.beginController();
  };

  const onData = (frame: Uint8Array): void => {
    if (!session) return;
    try {
      session.receive(frame);
    } catch (error) {
      if (error instanceof ChannelDesync) handleDesync(error);
      else handleSessionFailure('transmit-failed');
    }
  };

  // ------------------------------------------------------------------ relay events

  const onRelayText = (text: string): void => {
    let message: { t?: unknown; up?: unknown } | null;
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }
    if (typeof message !== 'object' || message === null) return;
    if (message.t === 'ready') {
      relayReady = true;
      // Host: a relay connection that stays ready for a minute clears earlier failures, so idle reconnects do not sit at the ceiling.
      if (role === 'host' && !cancelSocketStable) armStableTimer('socket');
      if (role === 'host') setStatus('online', null);
      else if (!peerUp) setStatus('connecting', 'host-absent');
    } else if (message.t === 'peer' && typeof message.up === 'boolean') {
      peerUp = message.up;
      emitter.emit('peer', { up: peerUp });
      if (peerUp) {
        beginControllerHandshake();
      } else {
        teardownSession('peer-down');
        cancelHandshakeWork();
        if (role === 'controller') setStatus('connecting', 'host-absent');
      }
    }
  };

  const onRelayBinary = (data: Uint8Array): void => {
    if (data.length === 0) return;
    if (data[0] === FRAME_TYPE_DATA) onData(data);
    else handshake.receive(data[0], data);
  };

  const onRelayClose = (code: number, httpStatus: number | undefined): void => {
    // The socket is gone: events it might still emit must not count (generation guard).
    generation += 1;
    socket = undefined;
    relayReady = false;
    peerUp = false;
    const outcome = classifyClose(code, httpStatus);
    teardownSession(outcome.reason);
    cancelAllTimers();
    if (outcome.retryMs === null) {
      setStatus(outcome.state, outcome.reason);
    } else {
      scheduleReconnect(outcome.state, outcome.reason, outcome.retryMs === 'backoff' ? backoff.next() : outcome.retryMs);
    }
  };

  const connect = (): void => {
    if (finalClosed) return;
    generation += 1;
    const mine = generation;
    relayReady = false;
    peerUp = false;
    setStatus('connecting', linkStatus.current.reason === 'stopped' ? null : linkStatus.current.reason);
    let created: RemoteRelaySocket;
    try {
      created = socketFactory(
        { relayUrl, kind: 'link', room: linkKeys.roomId, role, gate },
        {
          onOpen: () => {
            if (mine !== generation) return;
            try {
              socket?.sendText(authFrame);
            } catch {
              // The close event follows.
            }
          },
          onText: (text) => {
            if (mine === generation) onRelayText(text);
          },
          onBinary: (data) => {
            if (mine === generation) onRelayBinary(data);
          },
          onClose: (code, httpStatus) => {
            if (mine === generation) onRelayClose(code, httpStatus);
          },
        },
      );
    } catch {
      // The socket could not even be created (bad URL): treat like an unreachable relay.
      generation += 1;
      scheduleReconnect('connecting', 'relay-unreachable', backoff.next());
      return;
    }
    socket = created;
  };

  // ------------------------------------------------------------------ public API

  return {
    role,

    get status(): RemoteLinkStatus {
      return linkStatus.current;
    },

    get sessionActive() {
      return session?.established === true;
    },

    get peerAppVersion() {
      return session?.established ? session.peerAppVersion : null;
    },

    start() {
      if (finalClosed || started) return;
      started = true;
      connect();
    },

    close() {
      if (finalClosed) return;
      finalClosed = true;
      cancelAllTimers();
      teardownSession('stopped');
      abandonSocket();
      keyCopy.fill(0);
      linkKeys.macKey.fill(0);
      setStatus('stopped', 'stopped');
      emitter.clear();
    },

    openStream(open, handlers) {
      if (!session?.established) throw new RemoteLinkDownError();
      return session.table.openStream(open, handlers);
    },

    onStream(handler) {
      streamHandler = handler;
      return () => {
        if (streamHandler === handler) streamHandler = undefined;
      };
    },

    destroyRoom() {
      if (role !== 'host' || !socket || !relayReady) return false;
      try {
        socket.sendText('{"t":"destroy"}');
        return true;
      } catch {
        return false;
      }
    },

    on(event, listener) {
      return emitter.on(event, listener);
    },
  };
};

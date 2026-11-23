import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocket, WebSocketServer, type VerifyClientCallbackAsync, type VerifyClientCallbackSync } from 'ws';
import { getSessionRuntime } from '@/modules/auth/index.js';

import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { verifyWebSocketClient } from '@/modules/websocket/services/websocket-auth.service.js';
import { handlePluginWsProxy } from '@/modules/websocket/services/plugin-websocket-proxy.service.js';
import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';
import { handleDesktopNotificationsConnection } from '@/modules/notifications/index.js';
import type {
  AuthenticatedWebSocketRequest,
  RemoteAuthEpochHook,
  RemoteWebSocketGateway,
} from '@/shared/types.js';

type WebSocketServerDependencies = {
  verifyClient: Parameters<typeof verifyWebSocketClient>[1];
  chat: Parameters<typeof handleChatConnection>[2];
  shell: Parameters<typeof handleShellConnection>[1];
  getPluginPort: Parameters<typeof handlePluginWsProxy>[2];
  /** `/r/**` sockets of the Remote Controller; absent when Remote is disabled or unsupported. */
  remote?: RemoteWebSocketGateway;
  /** Lets "log out everywhere" end the regular sockets too (only when the main JWT really changed). */
  authEpoch?: RemoteAuthEpochHook;
};

/** Close code for regular sockets ended by "log out everywhere" (the client re-authenticates on reconnect). */
const SESSION_ENDED_CLOSE_CODE = 4401;

/** Message ceiling of the Remote server when the gateway does not name one (the mux carries 1 MiB messages). */
const DEFAULT_REMOTE_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

/**
 * Used by this module's websocket gateway to keep active transports alive and
 * close half-open connections so their route-specific clients can reconnect.
 */
export function attachWebSocketHeartbeat(
  ws: WebSocket,
  intervalMs = 30_000,
  scheduler = {
    setInterval,
    clearInterval,
  },
): () => void {
  let isAlive = true;
  let stopped = false;

  const markAlive = () => {
    isAlive = true;
  };

  const stopHeartbeat = () => {
    if (stopped) {
      return;
    }

    stopped = true;
    scheduler.clearInterval(heartbeat);
    ws.off('pong', markAlive);
    ws.off('close', stopHeartbeat);
    ws.off('error', stopHeartbeat);
  };

  ws.on('pong', markAlive);
  ws.on('close', stopHeartbeat);
  ws.on('error', stopHeartbeat);

  const heartbeat = scheduler.setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }

    // A socket that did not answer the previous ping is half-open from the
    // server's perspective. Terminating it emits close and lets clients resume.
    if (!isAlive) {
      stopHeartbeat();
      ws.terminate();
      return;
    }

    isAlive = false;
    try {
      ws.ping();
    } catch {
      stopHeartbeat();
      ws.terminate();
    }
  }, intervalMs);

  return stopHeartbeat;
}

/**
 * Creates and wires the server-wide websocket gateway used for chat, shell, and
 * plugin proxy routes. Exported through the websocket module for server startup.
 */
export function createWebSocketServer(
  server: HttpServer,
  dependencies: WebSocketServerDependencies
): WebSocketServer {
  const { remote, authEpoch } = dependencies;

  const pathnameOf = (request: { url?: string }): string => new URL(request.url ?? '/', 'http://localhost').pathname;

  // The callback form (arity 2) lets `/r/**` upgrades be decided asynchronously; regular paths keep
  // the synchronous JWT check and answer straight away.
  const verifyClient: VerifyClientCallbackAsync<AuthenticatedWebSocketRequest> = (info, callback) => {
    callback(verifyWebSocketClient(info, dependencies.verifyClient));
  };

  // Without `server`, `ws` does not listen for upgrades itself: the one listener below hands each upgrade
  // to the Local server or, for `/r/**`, to the Remote server, which has its own (smaller) `maxPayload`
  // (the shared limit of the Local sockets cannot be lowered: chat messages carry image attachments).
  const wss = new WebSocketServer({
    noServer: true,
    verifyClient,
    // Without a Remote gateway the library default applies (first offered subprotocol).
    handleProtocols: (protocols) => protocols.values().next().value ?? false,
  });

  /** Sockets bridged to a Remote peer; "log out everywhere" closes those through the Remote module. */
  const remoteWss = remote
    ? new WebSocketServer({
        noServer: true,
        // `ws` reads `maxPayload` from the server options; the default would let one frame hold 100 MiB.
        maxPayload: remote.maxPayloadBytes ?? DEFAULT_REMOTE_MAX_PAYLOAD_BYTES,
        verifyClient: ((info, callback) => {
          remote.verifyUpgrade(info.req).then(
            (verdict) => {
              if (verdict.ok) callback(true);
              else callback(false, verdict.status, verdict.reason);
            },
            () => callback(false, 500, 'internal error'),
          );
        }) as VerifyClientCallbackAsync<AuthenticatedWebSocketRequest>,
        handleProtocols: (protocols) => remote.selectProtocol(protocols),
      })
    : undefined;

  const isRemotePath = (request: { url?: string }): boolean => {
    try {
      return remote?.owns(pathnameOf(request)) ?? false;
    } catch {
      return false; // a request line that is not a URL is the Local server's to refuse
    }
  };

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const target = remoteWss && isRemotePath(request) ? remoteWss : wss;
    target.handleUpgrade(request, socket, head, (ws) => {
      target.emit('connection', ws, request);
    });
  };
  server.on('upgrade', onUpgrade);
  wss.on('close', () => server.off('upgrade', onUpgrade));

  // Closing the gateway ends the Remote sockets too (`ws` leaves open connections alone on close()).
  if (remoteWss) {
    const closeLocal = wss.close.bind(wss);
    wss.close = (callback?: (error?: Error) => void) => {
      for (const client of remoteWss.clients) client.terminate();
      remoteWss.close();
      closeLocal(callback);
    };
    remoteWss.on('connection', (ws, request) => {
      attachWebSocketHeartbeat(ws);
      remote?.handleConnection(ws, request);
    });
  }

  if (authEpoch) {
    const unsubscribe = authEpoch.subscribe(() => {
      if (!authEpoch.closesRegularSockets()) return;
      // Only the Local sockets live here; the Remote module ends its own through the peer registry.
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.close(SESSION_ENDED_CLOSE_CODE, 'session-ended');
        }
      }
    });
    wss.on('close', unsubscribe);
  }

  wss.on('connection', (ws, request) => {
    attachWebSocketHeartbeat(ws);

    const incomingRequest = request as AuthenticatedWebSocketRequest;
    const pathname = pathnameOf(incomingRequest);
    const sessionId = incomingRequest.user?.sessionId;
    if (typeof sessionId === 'string') {
      const runtime = getSessionRuntime();
      const release = runtime.connections.track(sessionId, () => ws.close(4401, 'session-ended'));
      ws.once('close', release);
      if (!runtime.store.getActive(sessionId)) return;
    }

    if (pathname === '/shell') {
      handleShellConnection(ws, dependencies.shell, incomingRequest.user);
      return;
    }

    if (pathname === '/ws') {
      handleChatConnection(ws, incomingRequest, dependencies.chat);
      return;
    }

    if (pathname === '/desktop-notifications') {
      handleDesktopNotificationsConnection(ws, incomingRequest);
      return;
    }

    if (pathname.startsWith('/plugin-ws/')) {
      handlePluginWsProxy(ws, pathname, dependencies.getPluginPort,
        () => typeof sessionId !== 'string' || Boolean(getSessionRuntime().store.getActive(sessionId)));
      return;
    }

    console.log('[WARN] Unknown WebSocket path:', pathname);
    ws.close();
  });

  return wss;
}

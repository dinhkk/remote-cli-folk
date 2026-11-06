// A complete Remote setup for one test file: a relay, a Host server and a Controller server (two real
// processes), the relay configured on both, one finished pairing, the Host accepting and the link online.
import { RemoteSocket } from './e2e-browser-client.js';
import { type ApiResponse, type E2eServer, startE2eServer } from './e2e-server.js';
import { type E2eRelay, startE2eRelay } from './e2e-relay.js';
import { sleep, waitUntil } from './e2e-util.js';

export type WorldOptions = {
  /** Environment of the Host child (for example CLAUDE_TOOL_APPROVAL_TIMEOUT_MS). */
  hostEnv?: Record<string, string>;
  controllerEnv?: Record<string, string>;
  /** false: servers and relay only, no pairing (the pairing test does it step by step). */
  pair?: boolean;
  /** false: pair, but leave Accept off. */
  accept?: boolean;
};

export type RemoteWorld = {
  relay: E2eRelay;
  host: E2eServer;
  controller: E2eServer;
  /** Stored pairing id on the Host (disconnect/revoke) and the peer id on the Controller (`/r/<peerId>`). */
  hostPairingId: string;
  peerId: string;
  /** Management call on a server with the account password merged into the body (the `*` endpoints). */
  manage(server: E2eServer, pathAndQuery: string, method: string, body?: Record<string, unknown>): Promise<ApiResponse>;
  /** Fresh tab token of the Controller for the paired Host. */
  tabToken(): Promise<string>;
  /** Request through the Controller's `/r/<peerId>` proxy with a tab token. */
  viaRemote(pathAndQuery: string, init?: { method?: string; body?: unknown; rawBody?: string | Buffer; token?: string | null; headers?: Record<string, string> }): Promise<ApiResponse>;
  /** Creates a chat session on the Host through the proxy and returns its id. */
  createSession(token: string): Promise<string>;
  openChat(token: string): Promise<RemoteSocket>;
  stop(): Promise<void>;
};

const unwrap = <T>(response: ApiResponse, what: string): T => {
  if (response.status < 200 || response.status >= 300) throw new Error(`${what} failed: ${response.status} ${response.text}`);
  return response.json<T>();
};

export const configureRelay = async (relay: E2eRelay, ...servers: E2eServer[]): Promise<void> => {
  for (const server of servers) {
    const response = await server.api('/api/remote/relay-config', {
      method: 'PUT',
      body: { url: relay.url, secret: relay.secret, password: server.password },
    });
    unwrap(response, `[${server.name}] PUT relay-config`);
  }
};

/**
 * Joins a Host's code from `controller` and waits for the SAS it shows. Host `start()` hands out the code before
 * its pair-room socket is registered at the relay, so a join within the first few hundred milliseconds can come
 * back `REMOTE_PAIR_CODE_INVALID` (relay close 4404). A person cannot type that fast; the helper retries like a
 * second attempt would.
 */
export const joinControllerAndGetSas = async (controller: E2eServer, code: string, deviceName: string): Promise<{ joinId: string; sas: string }> => {
  for (let attempt = 0; ; attempt += 1) {
    const join = unwrap<{ joinId: string }>(await controller.api('/api/remote/peers/join', { method: 'POST', body: { code, deviceName } }), 'join');
    const outcome = await waitUntil(
      async () => {
        const status = unwrap<{ sas?: string; failure?: string }>(await controller.api(`/api/remote/peers/join/${join.joinId}`), 'join status');
        return status.sas ? { sas: status.sas } : status.failure ? { failure: status.failure } : null;
      },
      'the Controller to show the SAS',
      20_000,
    );
    if ('sas' in outcome) return { joinId: join.joinId, sas: outcome.sas };
    if (outcome.failure !== 'REMOTE_PAIR_CODE_INVALID' || attempt >= 6) throw new Error(`pairing failed: ${outcome.failure}`);
    await sleep(300);
  }
};

/** Runs the real ceremony between two configured servers; returns the Host's stored pairing id and the Controller's peer id. */
export const pairServers = async (host: E2eServer, controller: E2eServer, deviceName = 'e2e-controller'): Promise<{ hostPairingId: string; peerId: string }> => {
  const withPassword = (server: E2eServer, body: Record<string, unknown> = {}) => ({ ...body, password: server.password });
  const started = unwrap<{ pairingId: string; code: string }>(
    await host.api('/api/remote/host/pairings/start', { method: 'POST', body: withPassword(host) }),
    'start pairing',
  );
  const join = await joinControllerAndGetSas(controller, started.code, deviceName);
  const sas = join.sas;
  unwrap(await host.api(`/api/remote/host/pairings/${started.pairingId}/confirm`, { method: 'POST', body: { sas } }), 'confirm SAS');
  const done = await waitUntil(
    async () => {
      const status = unwrap<{ state: string; peerId?: string; failure?: string }>(await controller.api(`/api/remote/peers/join/${join.joinId}`), 'join status');
      if (status.failure) throw new Error(`pairing failed: ${status.failure}`);
      return status.state === 'done' ? status : null;
    },
    'the Controller pairing to finish',
    20_000,
  );
  const hostStatus = await waitUntil(
    async () => {
      const status = unwrap<{ controllers: Array<{ pairingId: string; name: string }> }>(await host.api('/api/remote/host/status'), 'host status');
      return status.controllers.length > 0 ? status : null;
    },
    'the Host to list the Controller',
    20_000,
  );
  return { hostPairingId: hostStatus.controllers[0].pairingId, peerId: String(done.peerId) };
};

export const waitForPeerState = (controller: E2eServer, peerId: string, state: string, timeoutMs = 20_000): Promise<unknown> =>
  waitUntil(
    async () => {
      const peers = unwrap<Array<{ peerId: string; state: string }>>(await controller.api('/api/remote/peers'), 'peers');
      return peers.find((peer) => peer.peerId === peerId)?.state === state;
    },
    `peer ${peerId} to be ${state}`,
    timeoutMs,
  );

/** Starts everything. Always call `stop()` (in `after`). */
export async function startWorld(options: WorldOptions = {}): Promise<RemoteWorld> {
  const relay = await startE2eRelay();
  let host: E2eServer | undefined;
  let controller: E2eServer | undefined;
  try {
    [host, controller] = await Promise.all([
      startE2eServer({ name: 'host', env: options.hostEnv }),
      startE2eServer({ name: 'controller', env: options.controllerEnv }),
    ]);
    await configureRelay(relay, host, controller);

    let hostPairingId = '';
    let peerId = '';
    if (options.pair !== false) {
      if (options.accept !== false) {
        unwrap(await host.api('/api/remote/host/accept', { method: 'PUT', body: { enabled: true, password: host.password } }), 'enable Accept');
      }
      ({ hostPairingId, peerId } = await pairServers(host, controller));
      if (options.accept !== false) await waitForPeerState(controller, peerId, 'online');
    }

    const hostServer = host;
    const controllerServer = controller;
    const world: RemoteWorld = {
      relay,
      host: hostServer,
      controller: controllerServer,
      hostPairingId,
      peerId,
      manage: (server, pathAndQuery, method, body = {}) => server.api(`/api/remote${pathAndQuery}`, { method, body: { ...body, password: server.password } }),
      async tabToken() {
        return unwrap<{ tabToken: string }>(await controllerServer.api(`/api/remote/peers/${world.peerId}/tab-token`, { method: 'POST', body: {} }), 'tab-token').tabToken;
      },
      viaRemote(pathAndQuery, init = {}) {
        return controllerServer.api(`/r/${world.peerId}${pathAndQuery}`, {
          method: init.method,
          body: init.body,
          rawBody: init.rawBody,
          // Never the Controller's own JWT by default: /r answers to tab tokens only.
          token: init.token ?? null,
          headers: init.headers,
        });
      },
      async createSession(token) {
        const created = await world.viaRemote('/api/providers/sessions', {
          method: 'POST',
          token,
          body: { provider: 'claude', projectPath: hostServer.home, initialMessage: 'e2e' },
        });
        return unwrap<{ data: { sessionId: string } }>(created, 'create session').data.sessionId;
      },
      openChat: (token) => RemoteSocket.open(controllerServer.baseUrl, world.peerId, 'ws', token),
      async stop() {
        await Promise.allSettled([hostServer.stop(), controllerServer.stop()]);
        await relay.stop();
      },
    };
    return world;
  } catch (error) {
    await Promise.allSettled([host?.stop(), controller?.stop()]);
    await relay.stop();
    throw error;
  }
}

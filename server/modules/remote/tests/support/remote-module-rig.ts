/**
 * Test rig for the whole Remote module as the server wires it: a throwaway database with a real account,
 * the real `createRemoteModule` mounted on an Express app (with the WebSocket gateway behind a real
 * `createWebSocketServer`), an in-process fake relay with a virtual clock for every link and pairing room,
 * and helpers to call the management API the way the UI does and to stand up the Host side of a pairing.
 */

import crypto from 'node:crypto';

import express from 'express';
import type { WebSocketServer } from 'ws';
import { getSessionRuntime } from '@/modules/auth/index.js';

import { authenticateWebSocket, issueTabToken } from '@/modules/auth/index.js';
import { createWebSocketServer } from '@/modules/websocket/index.js';
import type { RemotePairingRecord, RemotePairingStore, RemoteRelayLink } from '@/shared/types.js';

import { createSecretBox } from '../../crypto/secret-box.js';
import { createRelayLink } from '../../link/relay-link.js';
import { createPairingStore } from '../../pairing/pairing-store.service.js';
import { createRemoteModule, type RemoteModule, type RemoteModuleOptions } from '../../runtime/remote.module.js';
import { createRemoteConfigService } from '../../storage/remote-storage.service.js';

import { TEST_PASSWORD, createTestAccount, login, logoutEverywhere, type TestAccount } from './auth-test-session.js';
import { FakeRelay } from './fake-relay.js';
import { send, serve, type RunningServer, type TestResponse } from './http-test-client.js';
import { createManualClock, type ManualClock } from './manual-clock.js';
import { createInProcessNetwork, type InProcessNetwork } from './relay-link-rig.js';
import { withTempDatabase } from './temp-database.js';

export const PASSWORD = TEST_PASSWORD;
export const RELAY_SECRET = 'r'.repeat(40);
export const RELAY_URL = 'wss://fake-relay.test';
export const MASTER_KEY = Buffer.alloc(32, 0x42);

export type ApiCall = { method?: string; body?: unknown; password?: boolean | string; headers?: Record<string, string>; token?: string };

export type ModuleRig = {
  port: number;
  server: RunningServer;
  app: express.Express;
  wss: WebSocketServer;
  module: RemoteModule;
  clock: ManualClock;
  relay: FakeRelay;
  net: InProcessNetwork;
  /** The account's current login (changes after `relogin`). */
  readonly jwt: string;
  user: { id: number; username: string };
  /** The real "log out everywhere" of the account: bumps the auth epoch (and rotates the JWT secret unless pinned). */
  logoutAll(): Promise<number>;
  /** Logs in again (after a log-out-everywhere rotated the secret). */
  relogin(): Promise<string>;
  /** A second view of the same stored data (same master key), for assertions and arranging pairings. */
  pairings: RemotePairingStore;
  config: ReturnType<typeof createRemoteConfigService>;
  /** Calls `/api/remote<path>` like the UI: full JWT, same origin, JSON; `password: true` adds the account password. */
  api(path: string, call?: ApiCall): Promise<TestResponse>;
  /** Saves the relay settings through the API. */
  configureRelay(): Promise<void>;
  /** A Controller pairing in the database and the Host link that answers it, not yet started. */
  arrangePeer(name?: string): { record: RemotePairingRecord; k: Buffer; host: RemoteRelayLink; tabToken: string };
  /** Every response body seen by `api`, for the "no secret leaked" scans. */
  bodies: string[];
};

export type ModuleRigOptions = {
  env?: Record<string, string | undefined>;
  /** Do not call `module.start()` (tests that start it themselves). */
  skipStart?: boolean;
  moduleOptions?: Partial<RemoteModuleOptions>;
};

/** Runs `run` against a fully wired module; everything is torn down afterwards. */
export const withModuleRig = async (options: ModuleRigOptions, run: (rig: ModuleRig) => Promise<void>): Promise<void> =>
  withTempDatabase(async () => {
    const account: TestAccount = await createTestAccount();
    const user = { id: account.id, username: account.username };
    const { username } = user;
    let jwt = account.jwt;

    const relay = new FakeRelay({ secret: RELAY_SECRET });
    const clock = createManualClock(relay.now(), relay);
    const net = createInProcessNetwork(relay);

    const env: NodeJS.ProcessEnv = { CLOUDCLI_REMOTE_MASTER_KEY: MASTER_KEY.toString('base64'), ...options.env };
    const app = express();
    const server = await serve(app);
    const module = createRemoteModule({
      appVersion: 'test',
      port: server.port,
      env,
      runtime: { socketFactory: net.factory, clock },
      ...options.moduleOptions,
    });
    module.mount(app);
    app.use((_req, res) => res.status(404).type('text/plain').send('fell through'));

    const wss = createWebSocketServer(server.server, {
      verifyClient: { isPlatform: false, authenticateWebSocket },
      chat: {} as never,
      shell: {} as never,
      getPluginPort: (() => undefined) as never,
      remote: module.websocket,
      authEpoch: module.authEpoch,
    });
    if (!options.skipStart) module.start();

    const box = createSecretBox(MASTER_KEY);
    const pairings = createPairingStore({ box, now: clock.now });
    const config = createRemoteConfigService({ box });
    const bodies: string[] = [];

    const api: ModuleRig['api'] = async (path, call = {}) => {
      const body = call.body === undefined ? undefined : { ...(call.body as object) };
      if (call.password && body) (body as Record<string, unknown>).password = call.password === true ? PASSWORD : call.password;
      const payload = call.password && !body ? { password: call.password === true ? PASSWORD : call.password } : body;
      const response = await send(server.port, {
        method: call.method ?? 'GET',
        path: `/api/remote${path}`,
        headers: {
          cookie: `remotecli_session=${call.token ?? jwt}`,
          'x-remotecli-request': '1',
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
          ...call.headers,
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      bodies.push(response.text());
      return response;
    };

    const rig: ModuleRig = {
      port: server.port,
      server,
      app,
      wss,
      module,
      clock,
      relay,
      net,
      get jwt() {
        return jwt;
      },
      user,
      logoutAll: () => logoutEverywhere({ ...account, jwt }),
      async relogin() {
        jwt = await login(username);
        return jwt;
      },
      pairings,
      config,
      bodies,
      api,
      async configureRelay() {
        const response = await api('/relay-config', { method: 'PUT', body: { url: RELAY_URL, secret: RELAY_SECRET }, password: true });
        if (response.status !== 200) throw new Error(`relay config failed: ${response.status} ${response.text()}`);
      },
      arrangePeer(name = 'Host') {
        const k = crypto.randomBytes(32);
        const record = pairings.insertPairing({ role: 'controller', peerName: name, k, relayUrl: RELAY_URL });
        const host = createRelayLink({
          role: 'host',
          k,
          relayUrl: RELAY_URL,
          relaySecret: RELAY_SECRET,
          appVersion: 'host-test',
          socketFactory: net.factory,
          clock,
        });
        return { record, k, host, tabToken: issueTabToken({ userId: user.id, username, peerId: record.id, sessionId: getSessionRuntime().store.authenticate(jwt)!.id }) };
      },
    };
    try {
      await run(rig);
    } finally {
      module.stop();
      for (const client of wss.clients) client.terminate();
      wss.close();
      await server.close();
    }
  });

/** Polls until `condition` holds (real time). */
export const until = async (condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 8000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/**
 * The bridge against the REAL authentication middleware (no fake auth): `validateApiKey`,
 * `authenticateToken`, `authenticateWebSocket` and `authRoutes` from the auth barrel, mounted on a
 * minimal Express app with one sample route and one sample WebSocket. This is the test that proves the
 * loopback token, the API_KEY attachment, the `?token` stripping and the `/api/auth/*` deny work
 * against the code that actually guards the Host, not against a double.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import type net from 'node:net';
import test from 'node:test';

import express from 'express';
import jwt from 'jsonwebtoken';
import { WebSocket } from 'ws';
import { getSessionRuntime } from '@/modules/auth/index.js';

import { authRoutes, authenticateToken, authenticateWebSocket, issueLoopbackToken, issueTabToken, validateApiKey } from '@/modules/auth/index.js';
import { userDb } from '@/modules/database/index.js';
import { createWebSocketServer, type ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import type { RemoteStreamEnd } from '@/shared/types.js';

import { createHostBridge } from '../../bridge/host-bridge.js';
import { RESPONSE_HEADER_ALLOW_LIST } from '../../policy/header-filter.js';
import { callThroughBridge, createBridgedLoopback, startWsCall } from '../support/bridge-test-harness.js';
import { waitFor } from '../support/relay-link-rig.js';
import { syntheticPathPolicy } from '../support/synthetic-path-policy.js';
import { withTempDatabase } from '../support/temp-database.js';

type SampleServer = {
  port: number;
  /** Users the real `verifyWebSocketClient` authenticated (it calls `authenticateWebSocket`, recorded here). */
  sockets: Array<{ username: string }>;
  /** Request URL of every WebSocket upgrade that reached the server, accepted or not. */
  upgradeUrls: string[];
  hits: { count: number };
  close(): Promise<void>;
};

/** A provider runtime that does nothing: the real chat handler still answers `chat.subscribe`. */
const idleRuntime: ProviderRuntimeGateway = {
  hasRuntime: () => false,
  run: async () => undefined,
  abort: async () => false,
  stopBackgroundTask: async () => false,
  hasBackgroundWork: () => false,
  resolveToolApproval: () => undefined,
  getPendingApprovalsForSession: () => [],
};

/**
 * Minimal Host: real middleware, a protected sample route, the real auth routes and the REAL WebSocket
 * gateway (`createWebSocketServer` from the websocket barrel: the real `verifyWebSocketClient`, the real
 * `/ws` and `/shell` dispatch and the real chat handler). Only the provider runtime is idle.
 */
const startSampleHost = async (): Promise<SampleServer> => {
  const app = express();
  const hits = { count: 0 };
  app.use((_req, _res, next) => {
    hits.count += 1;
    next();
  });
  app.use(express.json());
  app.use('/api', validateApiKey);
  app.use('/api/auth', authRoutes);
  app.get('/api/projects/sample', authenticateToken, (req, res) => {
    // Headers the stock server can send on an authenticated answer; none may reach the Controller.
    res.setHeader('X-Refreshed-Token', 'eyJ.SHOULD-NOT-ARRIVE');
    res.setHeader('Set-Cookie', 'sid=should-not-arrive');
    res.json({ username: (req as unknown as { user: { username: string } }).user.username });
  });

  const server = http.createServer(app);
  const sockets: SampleServer['sockets'] = [];
  const upgradeUrls: string[] = [];
  server.on('upgrade', (request: http.IncomingMessage) => {
    upgradeUrls.push(request.url ?? '');
  });
  const wss = createWebSocketServer(server, {
    verifyClient: {
      isPlatform: false,
      // The real authenticator, observed: the real verifier decides which token it is given (`?token` first).
      authenticateWebSocket: (token) => {
        const user = authenticateWebSocket(token);
        if (user) sockets.push({ username: String(user.username) });
        return user;
      },
    },
    chat: { runtime: idleRuntime },
    shell: { resolveProviderSessionId: () => null },
    getPluginPort: () => null,
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    sockets,
    upgradeUrls,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

const errorCode = (end: RemoteStreamEnd): string | undefined => (end.cause === 'error' ? end.code : undefined);

/** A message the real chat handler answers with `chat_subscribed` (no provider runtime needed). */
const SUBSCRIBE = '{"type":"chat.subscribe","sessions":[{"sessionId":"api-key-session"}]}';
const subscribedSession = (payload: Buffer): string | undefined => {
  const message = JSON.parse(payload.toString()) as { kind?: string; sessionId?: string };
  return message.kind === 'chat_subscribed' ? message.sessionId : undefined;
};

/** Opens a WebSocket straight at the Host (no bridge) and reports how the upgrade ended. */
const directUpgrade = (port: number, path: string, headers: Record<string, string> = {}): Promise<{ opened: boolean; status?: number }> =>
  new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    socket.on('open', () => {
      socket.terminate();
      resolve({ opened: true });
    });
    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      resolve({ opened: false, status: response.statusCode });
    });
    socket.on('error', () => undefined);
  });

test('the bridge against the real middleware: loopback token, API_KEY, ?token stripping, header filter, platform mode, /api/auth/* deny', async (t) => {
  const saved = { jwt: process.env.JWT_SECRET, apiKey: process.env.API_KEY, platform: process.env.VITE_IS_PLATFORM, legacy: process.env.IS_PLATFORM };
  delete process.env.JWT_SECRET;
  delete process.env.API_KEY;
  delete process.env.VITE_IS_PLATFORM;
  delete process.env.IS_PLATFORM;

  await withTempDatabase(async () => {
    const user = userDb.createUser('alice', 'unused-hash');
    const userId = Number(user.id);
    const sample = await startSampleHost();
    // The default wiring: real token source, live process environment.
    const bridge = createHostBridge({ port: sample.port, evaluateHttp: syntheticPathPolicy });
    const loop = createBridgedLoopback((stream, open) => bridge.handleStream(stream, open));
    const tabToken = issueTabToken({ userId, username: 'alice', peerId: 'peer-1', sessionId: getSessionRuntime().store.create(userId).session.id });

    try {
      await t.test('(a) a request through the bridge authenticates with the loopback token and reaches the protected route', async () => {
        const outcome = await callThroughBridge(loop, { path: '/api/projects/sample', headers: { accept: 'application/json' } });
        assert.equal(outcome.response?.status, 200);
        assert.deepEqual(JSON.parse(outcome.body.toString()), { username: 'alice' });
      });

      await t.test('(b) a tab token is rejected by the real middleware (REST and WebSocket), even inside the Controller query/header', async () => {
        const direct = await fetch(`http://127.0.0.1:${sample.port}/api/projects/sample`, { headers: { authorization: `Bearer ${tabToken}` } });
        assert.equal(direct.status, 401);
        const directQuery = await fetch(`http://127.0.0.1:${sample.port}/api/projects/sample?token=${tabToken}`);
        assert.equal(directQuery.status, 401);
        assert.deepEqual(await directUpgrade(sample.port, `/ws?token=${tabToken}`), { opened: false, status: 401 });

        // Through the bridge the Controller's tab token (header or ?token) is never used: the loopback token authenticates.
        const viaBridge = await callThroughBridge(loop, { path: `/api/projects/sample?token=${tabToken}`, headers: { authorization: `Bearer ${tabToken}` } });
        assert.equal(viaBridge.response?.status, 200);
      });

      await t.test('(c) API_KEY set on the Host: direct calls need it, the bridge attaches it, the Controller cannot supply or override it', async () => {
        process.env.API_KEY = 'host-api-key';
        try {
          const loopbackToken = issueLoopbackToken();
          const withoutKey = await fetch(`http://127.0.0.1:${sample.port}/api/projects/sample`, { headers: { authorization: `Bearer ${loopbackToken}` } });
          assert.equal(withoutKey.status, 401, 'control: the real validateApiKey rejects a request without the key');

          const outcome = await callThroughBridge(loop, { path: '/api/projects/sample', headers: { 'x-api-key': 'attacker-guess' } });
          assert.equal(outcome.response?.status, 200);
          const ws = startWsCall(loop, '/ws');
          ws.stream.sendMessage(Buffer.from(SUBSCRIBE), false);
          await ws.waitForMessages(1);
          assert.equal(subscribedSession(ws.messages[0].payload), 'api-key-session');
          ws.stream.closeWebSocket(1000, 'done');
        } finally {
          delete process.env.API_KEY;
        }
      });

      await t.test('(d) a WebSocket upgrade with ?token=<tab token> from the Controller succeeds: the bridge drops the key and uses the loopback token', async () => {
        const before = sample.sockets.length;
        const upgradesBefore = sample.upgradeUrls.length;
        const call = startWsCall(loop, `/ws?token=${tabToken}`, ['cloudcli-tab', 'short-subprotocol-token']);
        call.stream.sendMessage(Buffer.from(SUBSCRIBE), false);
        await call.waitForMessages(1);
        // The real chat handler behind the real verifier answered the subscribe: the upgrade authenticated and dispatched on /ws.
        assert.equal(subscribedSession(call.messages[0].payload), 'api-key-session');
        assert.equal(sample.sockets.length, before + 1);
        assert.deepEqual(sample.sockets[before], { username: 'alice' });
        assert.deepEqual(sample.upgradeUrls.slice(upgradesBefore), ['/ws'], 'the Host saw no query (no tab token)');
        call.stream.closeWebSocket(1000, 'done');
      });

      await t.test('(d2) the same upgrade straight at the Host with the tab token fails in the real verifier (control for (d))', async () => {
        assert.deepEqual(await directUpgrade(sample.port, `/ws?token=${tabToken}`), { opened: false, status: 401 });
        assert.deepEqual(await directUpgrade(sample.port, '/ws', { authorization: `Bearer ${tabToken}` }), { opened: false, status: 401 });
        assert.deepEqual(await directUpgrade(sample.port, '/ws'), { opened: false, status: 401 });
      });

      await t.test('(d3) /shell is dispatched by the real gateway and authenticates with the loopback token; other gateway paths are refused by the bridge', async () => {
        const before = sample.sockets.length;
        const upgradesBefore = sample.upgradeUrls.length;
        const shell = startWsCall(loop, `/shell?token=${tabToken}`);
        await waitFor(() => sample.sockets.length === before + 1, 'the /shell upgrade to authenticate');
        assert.deepEqual(sample.upgradeUrls.slice(upgradesBefore), ['/shell']);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(shell.end, undefined, 'the real shell handler keeps the socket open');
        shell.stream.closeWebSocket(1000, 'done');

        for (const path of ['/desktop-notifications', '/plugin-ws/some-plugin', '/WS', '/ws/extra']) {
          const refused = startWsCall(loop, path);
          const end = await refused.waitForEnd();
          assert.ok(end.cause === 'peer-ws-close' && end.code === 4403, `${path}: ${JSON.stringify(end)}`);
        }
        assert.equal(sample.upgradeUrls.length, upgradesBefore + 1, 'only /shell reached the Host');
      });

      await t.test('(e) X-Refreshed-Token and Set-Cookie sent by the Host never arrive at the Controller', async () => {
        const outcome = await callThroughBridge(loop, { path: '/api/projects/sample' });
        assert.equal(outcome.response?.status, 200);
        const serialized = JSON.stringify(outcome.response);
        assert.ok(!/refreshed|set-cookie|should-not-arrive|sid=/i.test(serialized), serialized);
        // Only allow-listed Host headers, plus the two security headers the bridge itself forces.
        const bridgeForced = ['x-content-type-options', 'content-security-policy'];
        assert.ok(Object.keys(outcome.response?.headers ?? {}).every((name) => RESPONSE_HEADER_ALLOW_LIST.includes(name) || bridgeForced.includes(name)), serialized);
      });

      await t.test('(f) IS_PLATFORM: Remote refuses with REMOTE_UNSUPPORTED_MODE and nothing reaches the Host', async () => {
        const hitsBefore = sample.hits.count;
        const socketsBefore = sample.sockets.length;
        for (const flag of ['VITE_IS_PLATFORM', 'IS_PLATFORM']) {
          process.env[flag] = 'true';
          try {
            const refused = await callThroughBridge(loop, { path: '/api/projects/sample' });
            assert.equal(errorCode(refused.end), 'REMOTE_UNSUPPORTED_MODE', flag);
            assert.equal(errorCode(await startWsCall(loop, '/ws').waitForEnd()), 'REMOTE_UNSUPPORTED_MODE', flag);
          } finally {
            delete process.env[flag];
          }
        }
        assert.equal(sample.hits.count, hitsBefore);
        assert.equal(sample.sockets.length, socketsBefore);
      });

      await t.test('G-06: /api/auth/* remains denied and refresh never mints a browser credential', async () => {
        // A direct internal refresh can return the user, but cannot issue a browser session.
        const direct = await fetch(`http://127.0.0.1:${sample.port}/api/auth/refresh`, { method: 'POST', headers: { authorization: `Bearer ${issueLoopbackToken()}` } });
        assert.equal(direct.status, 200);
        assert.equal((await direct.json()).token, undefined);
        assert.equal(direct.headers.get('set-cookie'), null);

        const hitsBefore = sample.hits.count;
        for (const path of ['/api/auth/refresh', '/api/auth/user', '/api/auth/status', '/api/auth/logout-all', '/api/%61uth/refresh', '/API/AUTH/Refresh', '/api/projects/../auth/refresh']) {
          const outcome = await callThroughBridge(loop, { method: 'POST', path, body: [] });
          assert.equal(errorCode(outcome.end), 'REMOTE_FORBIDDEN', path);
          assert.equal(outcome.response, undefined, path);
        }
        assert.equal(sample.hits.count, hitsBefore, 'no /api/auth request reached the Host through the bridge');
      });

      await t.test('an expired or foreign loopback token is a Host 401, reported as REMOTE_UPSTREAM_AUTH (the bridge never replays it)', async () => {
        const broken = createHostBridge({ port: sample.port, evaluateHttp: syntheticPathPolicy, issueToken: () => jwt.sign({ userId, username: 'alice' }, 'some-other-secret', { expiresIn: 60 }) });
        const brokenLoop = createBridgedLoopback((stream, open) => broken.handleStream(stream, open));
        const outcome = await callThroughBridge(brokenLoop, { path: '/api/projects/sample' });
        assert.equal(errorCode(outcome.end), 'REMOTE_UPSTREAM_AUTH');
        assert.equal(outcome.response, undefined, 'no head, so no X-Auth-Error for the tab');
        const ws = startWsCall(brokenLoop, '/ws');
        assert.equal(errorCode(await ws.waitForEnd()), 'REMOTE_UPSTREAM_AUTH');
      });

      await waitFor(() => bridge.activeStreams === 0, 'the bridge to release every stream');
    } finally {
      bridge.closeAll();
      await sample.close();
    }
  });

  for (const [name, value] of Object.entries({ JWT_SECRET: saved.jwt, API_KEY: saved.apiKey, VITE_IS_PLATFORM: saved.platform, IS_PLATFORM: saved.legacy })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

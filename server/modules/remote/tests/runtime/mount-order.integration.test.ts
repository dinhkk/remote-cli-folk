/**
 * Mount order on the REAL `server/index.ts` (contracts section 1): the server runs as a child process with
 * a throwaway database, a pinned JWT secret and a temporary home directory, a Controller pairing whose
 * Host is a scripted peer in this process, reached over the in-process fake relay served on a real socket.
 *
 * What it proves that the unit tests cannot: `/r` and `/api/remote` really sit ahead of the global 50 MB
 * parsers (a 100 KB JSON body reaches the Host byte for byte, a 25 MB upload is streamed, a 5 KB management
 * body is refused with 413 by the 4 KB parser), ahead of static files and the SPA catch-all (`/r/x/api/health`
 * is JSON, not index.html), the `?target=` CSP is on the page, the WebSocket gateway is wired with the
 * subprotocol echo, and `CLOUDCLI_REMOTE_DISABLED=1` makes the server answer as if Remote did not exist.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { WebSocket } from 'ws';
import { getSessionRuntime } from '@/modules/auth/index.js';

import { issueTabToken } from '@/modules/auth/index.js';
import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import type { RemoteRelayLink } from '@/shared/types.js';

import { createRelayLink } from '../../link/relay-link.js';
import { initializeRemoteStorage } from '../../storage/remote-storage.service.js';
import { MAIN_PAGE_CSP } from '../../runtime/main-page-security-headers.js';
import { buildTargetPageCsp, readInlineScriptHashes } from '../../runtime/target-page-csp.js';
import { createTestAccount } from '../support/auth-test-session.js';
import { FakeRelay } from '../support/fake-relay.js';
import { startFakeRelayWsServer, type FakeRelayWsServer } from '../support/fake-relay-ws-server.js';
import { send } from '../support/http-test-client.js';
import { buildInventory } from '../support/route-inventory-table.js';

const FORK_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

const JWT_SECRET = 'j'.repeat(48);
const RELAY_SECRET = 'r'.repeat(40);
const MASTER_KEY = Buffer.alloc(32, 0x37).toString('base64');

type Child = { process: ChildProcess; port: number; output: string[]; stop(): Promise<void> };

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

const waitUntil = async (condition: () => boolean | Promise<boolean>, what: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

/** Starts the real server entrypoint and waits for `/health`. */
const startServer = async (env: Record<string, string>, home: string, databasePath: string): Promise<Child> => {
  const port = await freePort();
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ['API_KEY', 'VITE_IS_PLATFORM', 'IS_PLATFORM', 'CLOUDCLI_REMOTE_DISABLED', 'CLOUDCLI_REMOTE_MASTER_KEY']) delete childEnv[name];
  Object.assign(childEnv, {
    SERVER_PORT: String(port),
    HOST: '127.0.0.1',
    DATABASE_PATH: databasePath,
    HOME: home,
    USERPROFILE: home,
    TSX_TSCONFIG_PATH: 'server/tsconfig.json',
    JWT_SECRET,
    ...env,
  });
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: FORK_ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const output: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  try {
    await waitUntil(async () => {
      if (exited) throw new Error(`the server exited early:\n${output.join('').slice(-3000)}`);
      try {
        return (await send(port, { path: '/health', timeoutMs: 2000 })).status === 200;
      } catch {
        return false;
      }
    }, 'the server to answer /health', 120_000);
  } catch (error) {
    child.kill();
    throw error;
  }
  return {
    process: child,
    port,
    output,
    stop: () =>
      new Promise<void>((resolve) => {
        if (exited) return resolve();
        child.once('exit', () => resolve());
        child.kill();
      }),
  };
};

const jsonBody = (response: { text(): string }): Record<string, unknown> => JSON.parse(response.text()) as Record<string, unknown>;

describe('server/index.ts with Remote', () => {
  let directory = '';
  let child: Child;
  let relayServer: FakeRelayWsServer;
  let host: RemoteRelayLink;
  let peerId = '';
  let tabToken = '';
  let jwt = '';
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousSecret = process.env.JWT_SECRET;

  it('G-01/G-02/K-01: every mounted protected API rejects requests before body parsing; /api has no CORS', async () => {
    const publicRoutes = new Set(['GET /api/auth/status', 'POST /api/auth/login', 'POST /api/auth/register', 'POST /api/auth/mfa/verify']);
    const inventory = buildInventory();
    assert.deepEqual(inventory.problems, []);
    const routes = inventory.rows.filter((row) => row.route.startsWith('/api/')
      && !/^\/api\/(agent|browser-use-mcp)(\/|$)/.test(row.route)
      && !publicRoutes.has(`${row.method} ${row.route}`));
    assert.ok(routes.length > 150);
    for (const row of routes) {
      const route = row.route.replace(/:[A-Za-z0-9_]+/g, 'synthetic').replace(/\*/g, 'synthetic');
      const response = await send(child.port, {
        path: route, method: row.method,
        headers: { origin: 'https://foreign.example', 'content-type': 'application/json' },
        ...(!['GET', 'HEAD'].includes(row.method) ? { body: '{invalid' } : {}),
      });
      assert.equal(response.status, 401, `${row.method} ${route}`);
      assert.equal(response.headers['access-control-allow-origin'], undefined);
      assert.equal(response.headers['access-control-allow-credentials'], undefined);
    }
  });

  it('N-03/K-26: health exposes only status/timestamp; version metadata needs a session', async () => {
    const health = jsonBody(await send(child.port, { path: '/health' }));
    assert.deepEqual(Object.keys(health).sort(), ['status', 'timestamp']);
    assert.equal(health.status, 'ok');
    assert.equal((await send(child.port, { path: '/api/auth/version' })).status, 401);
  });

  it('C-10/C-11/C-12/C-13: static and Remote CORS never enable ambient credentials', async () => {
    for (const route of ['/manifest.json', `/r/${peerId}/health`]) {
      const response = await send(child.port, { path: route, headers: { origin: 'null', authorization: `Bearer ${tabToken}` } });
      assert.equal(response.status, 200);
      assert.equal(response.headers['access-control-allow-origin'], '*');
      assert.equal(response.headers['access-control-allow-credentials'], undefined);
    }
  });

  before(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'remote-mount-'));
    const databasePath = path.join(directory, 'auth.db');

    // Prepare the database the server will open: an account, the relay settings and one Controller pairing.
    closeConnection();
    process.env.DATABASE_PATH = databasePath;
    process.env.JWT_SECRET = JWT_SECRET;
    await writeFile(databasePath, '');
    await initializeDatabase();

    const relay = new FakeRelay({ secret: RELAY_SECRET });
    relayServer = await startFakeRelayWsServer(relay);

    const user = await createTestAccount('owner');
    const storage = initializeRemoteStorage({ env: { CLOUDCLI_REMOTE_MASTER_KEY: MASTER_KEY } });
    storage.config.setRelayUrl(relayServer.url);
    storage.config.setRelaySecret(RELAY_SECRET);
    const k = crypto.randomBytes(32);
    peerId = storage.pairings.insertPairing({ role: 'controller', peerName: 'Office PC', k, relayUrl: relayServer.url }).id;
    jwt = user.jwt;
    tabToken = issueTabToken({ userId: user.id, username: user.username, peerId, sessionId: getSessionRuntime().store.authenticate(user.jwt)!.id });
    closeConnection();

    // The Host: answers every proxied HTTP request with what it received, echoes WebSocket messages.
    host = createRelayLink({ role: 'host', k, relayUrl: relayServer.url, relaySecret: RELAY_SECRET, appVersion: 'scripted-host' });
    host.onStream((stream, open) => {
      if (open.kind === 'ws') {
        stream.setHandlers({ onMessage: (payload, binary) => void stream.sendMessage(payload, binary) });
        return;
      }
      const hash = crypto.createHash('sha256');
      let bytes = 0;
      stream.setHandlers({
        onBody: (chunk, fin) => {
          hash.update(chunk);
          bytes += chunk.length;
          if (!fin) return;
          const answer = { method: open.meta.method, path: open.meta.path, bytes, sha256: hash.digest('hex') };
          stream.sendResponse({ status: 200, headers: { 'content-type': 'application/json' } });
          stream.writeBody(Buffer.from(JSON.stringify(answer)), true);
        },
      });
    });
    host.start();

    child = await startServer({ CLOUDCLI_REMOTE_MASTER_KEY: MASTER_KEY }, directory, databasePath);
    // Listing the peers opens the Controller's link (lazy); wait until the Host is reachable through the relay.
    await waitUntil(async () => {
      const peers = await send(child.port, { path: '/api/remote/peers', headers: { cookie: `remotecli_session=${jwt}`, 'x-remotecli-request': '1', 'sec-fetch-site': 'same-origin' } });
      return peers.status === 200 && (JSON.parse(peers.text()) as Array<{ state: string }>)[0]?.state === 'online';
    }, 'the Controller link to come online', 60_000);
  });

  after(async () => {
    host?.close();
    await child?.stop();
    await relayServer?.close();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const tabHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({ authorization: `Bearer ${tabToken}`, ...extra });

  it('streams a 100 KB JSON body through /r to the Host byte for byte (the 50 MB parser did not read it first)', async () => {
    const payload = Buffer.from(JSON.stringify({ pad: 'x'.repeat(100_000) }));
    const response = await send(child.port, {
      method: 'POST',
      path: `/r/${peerId}/api/projects/create-project`,
      headers: tabHeaders({ 'content-type': 'application/json' }),
      body: payload,
    });
    assert.equal(response.status, 200, response.text());
    assert.deepEqual(jsonBody(response), {
      method: 'POST',
      path: '/api/projects/create-project',
      bytes: payload.length,
      sha256: crypto.createHash('sha256').update(payload).digest('hex'),
    });
  });

  it('streams a 25 MB upload through /r without buffering it as JSON', { timeout: 120_000 }, async () => {
    const upload = Buffer.alloc(25_000_000);
    crypto.randomFillSync(upload, 0, 1_000_000); // not all zeros, so a truncated or re-encoded body would differ
    const response = await send(child.port, {
      method: 'POST',
      path: `/r/${peerId}/api/file-tree/projects/p1/files/upload`,
      headers: tabHeaders({ 'content-type': 'application/octet-stream' }),
      body: upload,
      timeoutMs: 100_000,
    });
    assert.equal(response.status, 200, response.text());
    const answer = jsonBody(response);
    assert.equal(answer.bytes, upload.length);
    assert.equal(answer.sha256, crypto.createHash('sha256').update(upload).digest('hex'));
  });

  it('refuses a 5 KB management body with 413 from the 4 KB parser, not the 50 MB one', async () => {
    const response = await send(child.port, {
      method: 'POST',
      path: '/api/remote/peers/join',
      headers: { cookie: `remotecli_session=${jwt}`, 'x-remotecli-request': '1', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ code: 'x'.repeat(5000), deviceName: 'phone' }),
    });
    assert.equal(response.status, 413);
    assert.equal((jsonBody(response).error as { code: string }).code, 'REMOTE_TOO_LARGE');
  });

  it('answers /r before static files and the SPA catch-all: JSON, never index.html', async () => {
    const unknownPeer = await send(child.port, { path: '/r/x/api/health' });
    assert.equal(unknownPeer.status, 401);
    assert.match(String(unknownPeer.headers['content-type']), /application\/json/);
    assert.ok(!unknownPeer.text().includes('<'), 'no HTML');

    const local = await send(child.port, { path: `/r/${peerId}/health`, headers: tabHeaders() });
    assert.equal(local.status, 200);
    assert.equal(jsonBody(local).status, 'ok');
    const user = await send(child.port, { path: `/r/${peerId}/api/auth/user`, headers: tabHeaders() });
    assert.equal(user.status, 200);
    assert.equal((jsonBody(user).user as { username: string }).username, 'owner');

    const management = await send(child.port, { path: '/api/remote/relay-config', headers: { authorization: `Bearer ${tabToken}`, 'sec-fetch-site': 'same-origin' } });
    assert.equal(management.status, 401, 'a tab token does not open the management API');
  });

  it('refuses the main JWT on /r and a tab token for another peer', async () => {
    const asJwt = await send(child.port, { path: `/r/${peerId}/api/health`, headers: { cookie: `remotecli_session=${jwt}`, 'x-remotecli-request': '1' } });
    assert.equal(asJwt.status, 401);
    const otherPeer = await send(child.port, { path: '/r/another-peer/api/health', headers: tabHeaders() });
    assert.equal(otherPeer.status, 401);
  });

  it('puts the target-page CSP on the page served with ?target= and not on the plain page', async () => {
    const target = await send(child.port, { path: '/?target=abc', headers: { accept: 'text/html' } });
    // The real server allows the inline scripts of the built page by hash (none when there is no build).
    const expected = buildTargetPageCsp(readInlineScriptHashes(path.join(FORK_ROOT, 'dist', 'index.html')));
    assert.equal(target.headers['content-security-policy'], expected);
    assert.ok(expected.startsWith("default-src 'self'"));
    const plain = await send(child.port, { path: '/', headers: { accept: 'text/html' } });
    assert.equal(plain.headers['content-security-policy'], MAIN_PAGE_CSP, 'the plain page has only the main-page policy');
  });

  it('upgrades /r/<peer>/ws with the tab-token subprotocol, echoes only the marker, and reaches the Host', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${child.port}/r/${peerId}/ws`, ['cloudcli-tab', tabToken]);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
      socket.once('unexpected-response', (_req, res) => reject(new Error(`refused:${res.statusCode}`)));
    });
    assert.equal(socket.protocol, 'cloudcli-tab');
    const echoed = new Promise<string>((resolve) => socket.once('message', (data) => resolve(data.toString())));
    socket.send('hello through the relay');
    assert.equal(await echoed, 'hello through the relay');
    socket.close();

    const refused = new WebSocket(`ws://127.0.0.1:${child.port}/r/${peerId}/ws`, ['cloudcli-tab', jwt]);
    const status = await new Promise<number>((resolve) => {
      refused.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      refused.once('open', () => resolve(101));
      refused.once('error', () => undefined);
    });
    assert.equal(status, 401, 'the main JWT is not a tab token');
  });

  it('keeps the ordinary behaviour: /health and the regular WebSocket still work', async () => {
    assert.equal(jsonBody(await send(child.port, { path: '/health' })).status, 'ok');
    const socket = new WebSocket(`ws://127.0.0.1:${child.port}/desktop-notifications`, { headers: { cookie: `remotecli_session=${jwt}`, origin: `http://127.0.0.1:${child.port}` } });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.close();
  });
});

describe('server/index.ts with CLOUDCLI_REMOTE_DISABLED=1', () => {
  let directory = '';
  let child: Child;
  const previousDatabasePath = process.env.DATABASE_PATH;

  before(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'remote-disabled-'));
    const databasePath = path.join(directory, 'auth.db');
    closeConnection();
    process.env.DATABASE_PATH = databasePath;
    await writeFile(databasePath, '');
    await initializeDatabase();
    closeConnection();
    child = await startServer({ CLOUDCLI_REMOTE_DISABLED: '1' }, directory, databasePath);
  });

  after(async () => {
    await child?.stop();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('G-02: health stays public and disabled Remote APIs still require authentication', async () => {
    assert.equal((await send(child.port, { path: '/health' })).status, 200);
    for (const route of ['/api/remote/relay-config', '/r/x/api/health']) {
      const response = await send(child.port, { path: route, headers: { authorization: 'Bearer nothing' } });
      if (route.startsWith('/api/')) {
        assert.equal(response.status, 401);
        assert.match(String(response.headers['content-type']), /application\/json/);
      } else {
        assert.doesNotMatch(String(response.headers['content-type'] ?? ''), /application\/json/, route);
      }
    }
    const page = await send(child.port, { path: '/?target=abc', headers: { accept: 'text/html' } });
    assert.equal(page.headers['content-security-policy'], undefined);
  });

  it('has no /r WebSocket: the upgrade is not served by Remote', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${child.port}/r/x/ws`, ['cloudcli-tab', 'token']);
    const outcome = await new Promise<string>((resolve) => {
      socket.once('open', () => resolve('open'));
      socket.once('unexpected-response', (_req, res) => resolve(`refused:${res.statusCode}`));
      socket.once('error', () => resolve('error'));
    });
    // The stock gateway refuses any socket without a valid login.
    assert.notEqual(outcome, 'open');
    assert.ok(outcome.startsWith('refused:401') || outcome === 'error', outcome);
  });
});

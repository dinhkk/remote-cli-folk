import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';
import multer from 'multer';
import jwt from 'jsonwebtoken';

import { getConnection } from '../../database/index.js';
import { authRoutes } from '../auth.module.js';
import { authenticateToken, authenticateWebSocket, getJwtSecret, validateApiKey } from '../auth.middleware.js';
import { createApiSessionGuard } from '../services/api-session-guard.service.js';
import { getSessionRuntime } from '../services/session-runtime.service.js';
import { issueTabToken, verifyTabToken } from '../services/remote-token.service.js';

import { withIsolatedAuthDatabase } from './with-isolated-auth-database.js';

const bcrypt = createRequire(import.meta.url)('bcryptjs');
const password = 'synthetic-password-for-test';

async function withServer(run: (base: string, uploads: () => number) => Promise<void>) {
  await withIsolatedAuthDatabase(async (user) => {
    getConnection().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(password, 4), user.id);
    const app = express();
    const uploadDirectory = mkdtempSync(path.join(tmpdir(), 'session-upload-test-'));
    app.use('/api', validateApiKey, createApiSessionGuard(authenticateToken));
    app.use(express.json());
    app.use('/api/auth', authRoutes);
    app.get('/api/private', (_req, res) => res.json({ ok: true }));
    app.get('/api/stream', (_req, res) => { res.type('text/event-stream'); res.write('data: start\n\n'); });
    app.post('/api/assets/files', multer({ dest: uploadDirectory, limits: { fileSize: 10 * 1024 * 1024, files: 10 } }).array('files', 10), (_req, res) => {
      res.json({ ok: true });
    });
    app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: 'test failure' }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, () => readdirSync(uploadDirectory).length); }
    finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(uploadDirectory, { recursive: true, force: true }); }
  });
}

const headers = (base: string, cookie?: string): Record<string, string> => ({
  Origin: base, 'X-RemoteCLI-Request': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}),
});

test('N-02/K-25: API key mismatches of equal or different length return 401', async () => {
  const previous = process.env.API_KEY;
  process.env.API_KEY = 'synthetic-api-key';
  try {
    await withServer(async (base) => {
      for (const supplied of ['synthetic-api-kex', 'short', '', 'x'.repeat(100)]) {
        const response = await fetch(`${base}/api/auth/status`, { headers: { ...headers(base), 'X-API-Key': supplied } });
        assert.equal(response.status, 401);
      }
      assert.equal((await fetch(`${base}/api/auth/status`, { headers: { ...headers(base), 'X-API-Key': process.env.API_KEY! } })).status, 200);
    });
  } finally {
    if (previous === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = previous;
  }
});
async function login(base: string) {
  const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: headers(base), body: JSON.stringify({ username: 'alice', password }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).token, undefined);
  const cookie = response.headers.get('set-cookie')!;
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  return cookie.split(';', 1)[0];
}

test('G-01/G-02/K-01: all API prefixes and unknown routes require a session before parsing', async () => {
  await withServer(async (base) => {
    for (const path of ['private', 'file-tree', 'projects', 'assets', 'git', 'worktrees', 'taskmaster', 'commands', 'settings', 'system', 'notifications', 'user', 'plugins', 'browser-use', 'providers', 'scheduled-messages', 'voice', 'remote/peers', 'future-route']) {
      assert.equal((await fetch(`${base}/api/${path}`, { method: 'POST', headers: headers(base), body: 'invalid JSON' })).status, 401, path);
    }
    const old = jwt.sign({ userId: 1 }, getJwtSecret(), { expiresIn: '7d' });
    assert.equal((await fetch(`${base}/api/private?token=${old}`, { headers: { ...headers(base), Authorization: `Bearer ${old}` } })).status, 401);
  });
});

test('A-03/C-01/K-11: real login cookies, owner session list, logout A preserves B and ends A streams', async () => {
  await withServer(async (base) => {
    const a = await login(base), b = await login(base);
    assert.notEqual(a, b);
    const list = await (await fetch(`${base}/api/auth/sessions`, { headers: headers(base, a) })).json();
    assert.equal(list.sessions.length, 2);
    assert.equal(list.sessions.filter((s: { current: boolean }) => s.current).length, 1);
    assert.ok(!JSON.stringify(list).includes(a.split('=')[1]));
    const stream = await fetch(`${base}/api/stream`, { headers: headers(base, a) });
    const reader = stream.body!.getReader();
    await reader.read();
    const ended = reader.read().then((chunk) => chunk.done, () => true);
    const result = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: headers(base, a) });
    assert.equal(result.status, 200);
    assert.equal(await ended, true);
    assert.equal((await fetch(`${base}/api/private`, { headers: headers(base, a) })).status, 401);
    assert.equal((await fetch(`${base}/api/private`, { headers: headers(base, b) })).status, 200);
  });
});

test('C-02/C-03/C-04/K-29/K-30/K-31: multipart allowlist and origin/header checks precede the upload parser', async () => {
  await withServer(async (base, uploads) => {
    const cookie = await login(base);
    const body = () => { const form = new FormData(); form.set('files', new Blob(['synthetic content']), 'fixture.txt'); return form; };
    assert.equal((await fetch(`${base}/api/private`, { method: 'POST', headers: { Origin: base, 'X-RemoteCLI-Request': '1', Cookie: cookie }, body: body() })).status, 415);
    assert.equal((await fetch(`${base}/api/assets/files`, { method: 'POST', headers: { Origin: base, Cookie: cookie }, body: body() })).status, 403);
    assert.equal(uploads(), 0);
    for (const override of [{ Origin: 'null' }, { Origin: 'https://foreign.example' }, { 'Sec-Fetch-Site': 'same-site' }]) {
      assert.equal((await fetch(`${base}/api/private`, { headers: { ...headers(base, cookie), ...override } })).status, 403);
    }
    assert.equal((await fetch(`${base}/api/assets/files`, { method: 'POST', headers: { Origin: base, 'X-RemoteCLI-Request': '1', Cookie: cookie }, body: body() })).status, 200);
    assert.equal(uploads(), 1);
  });
});

test('K-11/L-04: parent revocation invalidates tab tokens while another browser remains valid', async () => {
  await withIsolatedAuthDatabase((user) => {
    const { store } = getSessionRuntime();
    const a = store.create(user.id), b = store.create(user.id);
    const token = issueTabToken({ userId: user.id, username: user.username, peerId: 'synthetic-peer', sessionId: a.session.id });
    assert.equal(verifyTabToken(token, 'synthetic-peer').ok, true);
    store.revoke(a.session.id, user.id);
    assert.equal(verifyTabToken(token, 'synthetic-peer').ok, false);
    assert.ok(store.authenticate(b.secret));
  });
});

test('C-05/C-06/K-04: every browser socket path requires a cookie and a valid Origin', async () => {
  await withIsolatedAuthDatabase((user) => {
    const { secret } = getSessionRuntime().store.create(user.id);
    for (const url of ['/ws', '/shell', '/plugin-ws/test', '/desktop-notifications']) {
      const request = { url, headers: { host: 'localhost:3001', cookie: `remotecli_session=${secret}`, origin: 'http://localhost:3001' }, socket: { remoteAddress: '127.0.0.1' } };
      assert.equal(authenticateWebSocket(request)?.userId, user.id, url);
      assert.equal(authenticateWebSocket({ ...request, headers: { ...request.headers, origin: undefined } }), null, url);
      assert.equal(authenticateWebSocket({ ...request, headers: { ...request.headers, origin: 'https://foreign.example' } }), null, url);
      assert.equal(authenticateWebSocket({ ...request, headers: { ...request.headers, cookie: undefined } }), null, url);
    }
  });
});


test('K-07/A-03: login initializes the browser label without a change event', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { ...headers(base), 'User-Agent': 'Firefox/130.0' },
      body: JSON.stringify({ username: 'alice', password }),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie')!.split(';', 1)[0];
    const db = getConnection();
    assert.equal(db.prepare<{ browser: string }>('SELECT browser FROM auth_sessions').get()?.browser, 'Firefox');
    const changes = () => db.prepare<{ count: number }>("SELECT COUNT(*) AS count FROM auth_events WHERE kind = 'browser-changed'").get()!.count;
    assert.equal(changes(), 0);
    await fetch(`${base}/api/private`, { headers: { ...headers(base, cookie), 'User-Agent': 'Firefox/130.0' } });
    assert.equal(changes(), 0);
    await fetch(`${base}/api/private`, { headers: { ...headers(base, cookie), 'User-Agent': 'Chrome/131.0' } });
    assert.equal(changes(), 1);
  });
});

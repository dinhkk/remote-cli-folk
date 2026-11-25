// The plugin switch is read once at import, and the plugin directory comes from HOME: both are set
// before any server module loads (node --test runs each test file in its own process).
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import express from 'express';
import { WebSocket } from 'ws';

const home = mkdtempSync(path.join(tmpdir(), 'plugins-disabled-test-'));
const previousHome = process.env.HOME;
process.env.HOME = home;
process.env.REMOTECLI_PLUGINS_DISABLED = '1';
const previousDatabasePath = process.env.DATABASE_PATH;
after(() => {
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousDatabasePath;
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

// A plugin installed and enabled before the switch was turned on. Its server would write a marker file.
const pluginDir = path.join(home, '.claude-code-ui', 'plugins', 'synthetic-plugin');
const marker = path.join(home, 'plugin-server-started');
mkdirSync(pluginDir, { recursive: true });
writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify({
  name: 'synthetic-plugin', displayName: 'Synthetic', version: '1.0.0', entry: 'index.js', server: 'server.js',
}));
writeFileSync(path.join(pluginDir, 'index.js'), 'export function mount() {}\n');
writeFileSync(path.join(pluginDir, 'server.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');\n`);
writeFileSync(path.join(home, '.claude-code-ui', 'plugins.json'), JSON.stringify({ 'synthetic-plugin': { enabled: true } }));

process.env.DATABASE_PATH = path.join(home, 'auth.db');
writeFileSync(process.env.DATABASE_PATH, ''); // never import a checkout's legacy database

const { closeConnection, getConnection, initializeDatabase, userDb } = await import('@/modules/database/index.js');
const { authRoutes, authenticateToken, createApiSessionGuard, validateApiKey } = await import('@/modules/auth/index.js');
const { createWebSocketServer } = await import('@/modules/websocket/index.js');
const { pluginsRoutes, pluginsSwitch, startEnabledPluginServers, getPluginPort, PLUGINS_DISABLED } = await import('../index.js');

const bcrypt = createRequire(import.meta.url)('bcryptjs');
const password = 'synthetic-password-for-test';

async function withServer(run: (base: string) => Promise<void>) {
  await initializeDatabase();
  const user = userDb.createUser('alice', 'unused-hash');
  getConnection().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(password, 4), user.id);
  const app = express();
  app.use('/api', validateApiKey, createApiSessionGuard(authenticateToken));
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  // Mounted exactly as the server entrypoint does.
  app.use('/api/plugins', authenticateToken, pluginsSwitch, pluginsRoutes);
  app.use((err: { statusCode?: number; code?: string; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.statusCode ?? 500).json({ success: false, error: { code: err.code, message: err.message } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); closeConnection(); }
}

const headers = (base: string, cookie?: string): Record<string, string> => ({
  Origin: base, 'X-RemoteCLI-Request': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}),
});

const ROUTES: Array<[string, string]> = [
  ['POST', '/api/plugins/install'],
  ['POST', '/api/plugins/synthetic-plugin/update'],
  ['PUT', '/api/plugins/synthetic-plugin/enable'],
  ['DELETE', '/api/plugins/synthetic-plugin'],
  ['GET', '/api/plugins/synthetic-plugin/manifest'],
  ['GET', '/api/plugins/synthetic-plugin/assets/index.js'],
  ['GET', '/api/plugins/synthetic-plugin/rpc/anything'],
  ['POST', '/api/plugins/synthetic-plugin/rpc/anything'],
];

test('PD-01: REMOTECLI_PLUGINS_DISABLED=1 turns plugins off', () => {
  assert.equal(PLUGINS_DISABLED, true);
});

test('PD-03/PD-10a: every plugin route answers 403 PLUGINS_DISABLED after authentication, 401 without a session', async () => {
  await withServer(async (base) => {
    for (const [method, route] of ROUTES) {
      const anonymous = await fetch(`${base}${route}`, { method, headers: headers(base), body: method === 'GET' ? undefined : '{}' });
      assert.equal(anonymous.status, 401, `${method} ${route} without a session`);
    }
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: headers(base), body: JSON.stringify({ username: 'alice', password }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';', 1)[0];
    for (const [method, route] of ROUTES) {
      const response = await fetch(`${base}${route}`, {
        method, headers: headers(base, cookie), body: method === 'GET' ? undefined : JSON.stringify({ url: 'https://example.invalid/x.git', enabled: true }),
      });
      assert.equal(response.status, 403, `${method} ${route}`);
      assert.equal((await response.json()).error.code, 'PLUGINS_DISABLED', `${method} ${route}`);
    }
    // The list stays available and says plugins are off, without naming what is on disk.
    const list = await fetch(`${base}/api/plugins`, { headers: headers(base, cookie) });
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), { plugins: [], disabled: true });
    // PD-07: nothing on disk was removed or changed.
    assert.ok(existsSync(path.join(pluginDir, 'manifest.json')));
    assert.ok(existsSync(path.join(home, '.claude-code-ui', 'plugins.json')));
  });
});

test('PD-02/PD-07/PD-10b: an installed, enabled plugin is not started and startup logs one line', async () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try { await startEnabledPluginServers(); } finally { console.log = original; }
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(existsSync(marker), false, 'the plugin server never ran');
  assert.equal(getPluginPort('synthetic-plugin'), null);
  assert.deepEqual(lines.filter((line) => line.includes('[Plugins]')).length, 1);
  assert.match(lines[0], /Plugins are disabled/);
});

test('PD-04/PD-10c: /plugin-ws connections are refused', async () => {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const wss = createWebSocketServer(server, {
    verifyClient: { isPlatform: true, authenticateWebSocket: () => ({ userId: 1, username: 'alice', authKind: 'platform' }) } as never,
    chat: {} as never,
    shell: {} as never,
    getPluginPort: () => 12345,
    pluginsDisabled: true,
  });
  try {
    const { port } = server.address() as AddressInfo;
    const closed = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/plugin-ws/synthetic-plugin`, { headers: { origin: `http://127.0.0.1:${port}` } });
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
      socket.once('unexpected-response', (_req, res) => resolve({ code: res.statusCode ?? 0, reason: 'http' }));
      socket.once('error', reject);
    });
    assert.deepEqual(closed, { code: 4403, reason: 'plugins-disabled' });
  } finally {
    wss.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// The API guard lets exactly one browser load through without the request header: the app loading the HTML
// preview page into its own iframe. Everything else about the request (session cookie, lock, method) still
// applies, and no other route or spelling of the path gets the same treatment.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test, { after } from 'node:test';

import express from 'express';

const home = mkdtempSync(path.join(tmpdir(), 'html-preview-guard-'));
const previousDatabasePath = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = path.join(home, 'auth.db');
writeFileSync(process.env.DATABASE_PATH, ''); // never import a checkout's legacy database
after(() => {
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousDatabasePath;
  rmSync(home, { recursive: true, force: true });
});

const { closeConnection, getConnection, initializeDatabase, userDb } = await import('@/modules/database/index.js');
const { authRoutes, authenticateToken, createApiSessionGuard, getSessionRuntime, issueLoopbackToken, validateApiKey } = await import('@/modules/auth/index.js');
const { createFileTreeRouter } = await import('@/modules/file-tree/file-tree.routes.js');

const bcrypt = createRequire(import.meta.url)('bcryptjs');
const password = 'synthetic-password-for-test';
const PROJECT = '0f8c2a4e-5b1d-4c3e-9a7f-1e2d3c4b5a69';
const PREVIEW = `/api/file-tree/projects/${PROJECT}/files/html-preview?path=index.html`;
const PAGE = '<script>document.title = "ran"</script>';

type Rig = { base: string; cookie: string; served: string[] };

let runs = 0;

async function withServer(run: (rig: Rig) => Promise<void>) {
  await initializeDatabase();
  const username = `alice${runs += 1}`;
  const user = userDb.createUser(username, 'unused-hash');
  getConnection().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(password, 4), user.id);
  const served: string[] = [];
  const unexpected = async (): Promise<never> => { throw new Error('unexpected'); };
  const services = {
    browseWorkspace: unexpected, createWorkspaceFolder: unexpected, readTextFile: unexpected, saveTextFile: unexpected,
    createEntry: unexpected, renameEntry: unexpected, deleteEntry: unexpected, storeUploadedFiles: unexpected,
    openHtmlPreview: async (_projectId: string, filePath: string) => { served.push(`preview ${filePath}`); return { stream: Readable.from([PAGE]) }; },
    openFile: async (_projectId: string, filePath: string) => { served.push(`content ${filePath}`); return { contentType: 'text/html', stream: Readable.from([PAGE]) }; },
    listProjectFiles: async () => { served.push('list'); return []; },
  };
  const app = express();
  // Mounted as the server entrypoint does: the guard before every /api router and body parser.
  app.use('/api', validateApiKey, createApiSessionGuard(authenticateToken));
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use('/api/file-tree', createFileTreeRouter(services as never, (_req, _res, next) => next(), { maximumFileSizeMegabytes: 200, maximumFileCount: 20 }, { error: () => undefined }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { Origin: base, 'X-RemoteCLI-Request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    assert.equal(login.status, 200);
    await run({ base, cookie: login.headers.get('set-cookie')!.split(';', 1)[0], served });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeConnection();
  }
}

// What a browser sends when the app's own page sets the src of a preview iframe.
const FRAME_LOAD = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe' };

type Sent = { status: number; text(): Promise<string>; json(): Promise<{ code?: string; error?: string }> };

// node:http, not fetch: fetch writes its own Sec-Fetch-Mode, and these tests set every header themselves.
const send = (rig: Rig, url: string, headers: Record<string, string | undefined>, method = 'GET'): Promise<Sent> => {
  const sent: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) if (value !== undefined) sent[name] = value;
  return new Promise((resolve, reject) => {
    const request = http.request(`${rig.base}${url}`, { method, headers: sent }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode ?? 0, text: async () => body, json: async () => JSON.parse(body) });
      });
    });
    request.on('error', reject);
    request.end();
  });
};

test('HP-03: the iframe load of the preview page passes without the request header', async () => {
  await withServer(async (rig) => {
    const plain = await send(rig, PREVIEW, { ...FRAME_LOAD, Cookie: rig.cookie });
    assert.equal(plain.status, 200);
    assert.equal(await plain.text(), PAGE);
    const ownOrigin = await send(rig, PREVIEW, { ...FRAME_LOAD, Cookie: rig.cookie, Origin: rig.base });
    assert.equal(ownOrigin.status, 200);
    await ownOrigin.text();
    assert.deepEqual(rig.served, ['preview index.html', 'preview index.html']);
  });
});

test('HP-03/HP-10c: every other combination of Fetch Metadata, Origin or method is refused', async () => {
  await withServer(async (rig) => {
    const refused: Array<[string, Record<string, string | undefined>, string?]> = [];
    for (const dest of ['document', 'empty', 'script', 'image', 'frame', undefined]) refused.push([`dest ${dest}`, { 'Sec-Fetch-Dest': dest }]);
    for (const site of ['cross-site', 'same-site', 'none', undefined]) refused.push([`site ${site}`, { 'Sec-Fetch-Site': site }]);
    for (const mode of ['cors', 'no-cors', 'same-origin', undefined]) refused.push([`mode ${mode}`, { 'Sec-Fetch-Mode': mode }]);
    refused.push(['other origin', { Origin: 'http://evil.example' }]);
    refused.push(['other port', { Origin: rig.base.replace(/:\d+$/, ':1') }]);
    refused.push(['null origin', { Origin: 'null' }]);
    for (const method of ['HEAD', 'POST', 'PUT', 'DELETE']) refused.push([`method ${method}`, {}, method]);
    for (const [label, change, method] of refused) {
      const response = await send(rig, PREVIEW, { ...FRAME_LOAD, Cookie: rig.cookie, ...change }, method);
      assert.equal(response.status, 403, label);
      if (method !== 'HEAD') assert.equal((await response.json()).code, 'AUTH_REQUEST_FORBIDDEN', label);
    }
    // Typed into the address bar: the browser says so, and the server refuses.
    const addressBar = await send(rig, PREVIEW, { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', Cookie: rig.cookie });
    assert.equal(addressBar.status, 403);
    // No Fetch Metadata at all (an old browser or a script outside a browser): no fallback.
    assert.equal((await send(rig, PREVIEW, { Cookie: rig.cookie })).status, 403);
    assert.deepEqual(rig.served, []);
  });
});

test('HP-03/HP-10c: another spelling of the path never gets the exception', async () => {
  await withServer(async (rig) => {
    const spellings = [
      `/api/file-tree/projects/${PROJECT}/files/html-preview/?path=index.html`,
      `/api/file-tree/projects/${PROJECT}//files/html-preview?path=index.html`,
      `/api/file-tree//projects/${PROJECT}/files/html-preview?path=index.html`,
      `/api/file-tree/projects/${PROJECT}%2Fx/files/html-preview?path=index.html`,
      `/api/file-tree/projects/${PROJECT}%2fx/files/html-preview?path=index.html`,
      `/api/file-tree/projects/${PROJECT}/files%2Fhtml-preview?path=index.html`,
      `/api/file-tree/projects/${PROJECT}/files/HTML-Preview?path=index.html`,
      `/API/file-tree/projects/${PROJECT}/files/html-preview?path=index.html`,
      `/api/file-tree/projects/${PROJECT}/files/html-preview.json?path=index.html`,
      `/api/file-tree/projects/${PROJECT}/files/html-preview/extra?path=index.html`,
      `/api/file-tree/projects/${PROJECT}/files/html-preview;x?path=index.html`,
      `/api/file-tree/projects/${PROJECT}/files/html-preview%20?path=index.html`,
    ];
    for (const url of spellings) {
      const response = await send(rig, url, { ...FRAME_LOAD, Cookie: rig.cookie });
      assert.equal(response.status, 403, url);
    }
    assert.deepEqual(rig.served, []);
  });
});

test('HP-03/HP-10g: other file routes with the same frame headers still need the request header', async () => {
  await withServer(async (rig) => {
    for (const url of [`/api/file-tree/projects/${PROJECT}/files/content?path=index.html`, `/api/file-tree/projects/${PROJECT}/files`, '/api/auth/user']) {
      const response = await send(rig, url, { ...FRAME_LOAD, Cookie: rig.cookie });
      assert.equal(response.status, 403, url);
    }
    // With the header, the guard lets them through as before.
    const content = await send(rig, `/api/file-tree/projects/${PROJECT}/files/content?path=index.html`, { Cookie: rig.cookie, 'X-RemoteCLI-Request': '1', 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(content.status, 200);
    await content.text();
    assert.deepEqual(rig.served, ['content index.html']);
  });
});

test('the Host bridge bearer reaches the preview page; a session secret or a URL token as a bearer never does', async () => {
  await withServer(async (rig) => {
    const bridge = await send(rig, PREVIEW, { Authorization: `Bearer ${issueLoopbackToken()}` });
    assert.equal(bridge.status, 200);
    assert.equal(await bridge.text(), PAGE);
    assert.deepEqual(rig.served, ['preview index.html']);
    const secret = rig.cookie.split('=', 2)[1];
    const sessionAsBearer = await send(rig, PREVIEW, { Authorization: `Bearer ${secret}` });
    assert.equal(sessionAsBearer.status, 401);
    const wrongBearer = await send(rig, PREVIEW, { Authorization: 'Bearer not-a-valid-bridge-token' });
    assert.equal(wrongBearer.status, 401);
    assert.deepEqual(rig.served, ['preview index.html'], 'only the bridge request was served');
  });
});

test('HP-02/HP-10b: no session 401, locked session 423, a URL token or a bearer never authenticates', async () => {
  await withServer(async (rig) => {
    const anonymous = await send(rig, PREVIEW, FRAME_LOAD);
    assert.equal(anonymous.status, 401);
    const secret = rig.cookie.split('=', 2)[1];
    const urlToken = await send(rig, `${PREVIEW}&token=${secret}&session=${secret}`, FRAME_LOAD);
    assert.equal(urlToken.status, 401);
    const bearer = await send(rig, PREVIEW, { ...FRAME_LOAD, Authorization: `Bearer ${secret}` });
    assert.equal(bearer.status, 401);
    // A locked session is refused like on every other route.
    // (The store locks only sessions of an MFA user; the row is marked directly to reach the same state.)
    const session = getSessionRuntime().store.authenticate(secret, true)!;
    getConnection().prepare('UPDATE auth_sessions SET locked_at = ? WHERE id = ?').run(Date.now(), session.id);
    assert.ok(getSessionRuntime().store.authenticate(secret, true)?.lockedAt);
    const locked = await send(rig, PREVIEW, { ...FRAME_LOAD, Cookie: rig.cookie });
    assert.equal(locked.status, 423);
    assert.deepEqual(rig.served, []);
  });
});

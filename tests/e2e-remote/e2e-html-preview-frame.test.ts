// The HTML preview page through a real Controller and a real Host: a signed-in browser frame load (session cookie and
// the three Fetch Metadata headers a browser sets for an iframe) gets the file with the script-enabled sandbox policy
// the Controller sets itself; every other way to ask for the same page gets the plain sandbox or a refusal. The
// browser half (a real sandboxed frame running a hostile file) is checked separately in Chrome and Edge.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createHostProject, type HostProject } from './support/e2e-host-project.js';
import { startWorld, waitForPeerState, type RemoteWorld } from './support/e2e-world.js';

const FRAME = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' };
const FETCH = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };
const PAGE = '<!doctype html><title>e2e</title><p id="p">hello from the host</p><script>document.getElementById("p").textContent = "ran";</script>\n';
const PLAIN_SANDBOX = "sandbox; default-src 'none'";

type Answer = { status: number; headers: http.IncomingHttpHeaders; text: string; json<T>(): T };

/**
 * One GET with exactly the headers given. Node's fetch sets Fetch Metadata itself (mode `cors`), so a frame load, which
 * a browser sends with mode `navigate`, needs the plain HTTP client.
 */
const get = (baseUrl: string, pathAndQuery: string, headers: Record<string, string>): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const url = new URL(baseUrl);
    const request = http.request({ host: url.hostname, port: url.port, path: pathAndQuery, method: 'GET', headers: { host: url.host, ...headers }, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode ?? 0, headers: response.headers, text, json: <T>() => JSON.parse(text) as T });
      });
    });
    request.on('error', reject);
    request.end();
  });

describe('HTML preview page through the Controller', () => {
  let world: RemoteWorld;
  let project: HostProject;
  let tabToken = '';

  const previewPath = (file: string): string => `/api/file-tree/projects/${encodeURIComponent(project.id)}/files/html-preview?path=${encodeURIComponent(path.join(project.dir, file))}`;
  const cookie = (): Record<string, string> => ({ cookie: `remotecli_session=${world.controller.jwt}` });
  const ask = (pathAndQuery: string, headers: Record<string, string>) => get(world.controller.baseUrl, `/r/${world.peerId}${pathAndQuery}`, headers);
  const frameLoad = (file: string, headers: Record<string, string> = {}) => ask(previewPath(file), { ...FRAME, ...cookie(), ...headers });
  const csp = (response: Answer): string => String(response.headers['content-security-policy'] ?? '');

  before(async () => {
    world = await startWorld();
    project = await createHostProject(world.host, 'html-preview-frame');
    writeFileSync(path.join(project.dir, 'page.html'), PAGE);
    writeFileSync(path.join(project.dir, 'notes.txt'), 'not html\n');
    tabToken = await world.tabToken();
  });
  after(async () => {
    await world.stop();
  });

  it('a signed-in frame load gets the file with the policy the Controller sets, and no cookie back', async () => {
    const response = await frameLoad('page.html');
    assert.equal(response.status, 200);
    assert.equal(response.text, PAGE);
    assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
    const policy = csp(response);
    assert.ok(policy.startsWith('sandbox allow-scripts;'), policy);
    assert.ok(policy.includes("default-src 'none'") && policy.includes("script-src 'unsafe-inline'") && policy.includes("frame-ancestors 'self'"), policy);
    assert.ok(!policy.includes('allow-same-origin'), policy);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(response.headers['set-cookie'], undefined);
    // The real server mounts `cors()` for `/r`: it allows any origin to read, and never with credentials.
    assert.equal(response.headers['access-control-allow-origin'], '*');
    assert.equal(response.headers['access-control-allow-credentials'], undefined);
  });

  it('the status check a tab makes with its token gets the page under the plain sandbox, never the script-enabled one', async () => {
    const response = await ask(previewPath('page.html'), { ...FETCH, authorization: `Bearer ${tabToken}` });
    assert.equal(response.status, 200);
    assert.equal(csp(response), PLAIN_SANDBOX);
  });

  it('a tab-token request that carries no Fetch Metadata is refused before it reaches the Host', async () => {
    const response = await ask(previewPath('page.html'), { authorization: `Bearer ${tabToken}` });
    assert.equal(response.status, 400);
    assert.equal(response.json<{ error: { code: string } }>().error.code, 'HTML_PREVIEW_FETCH_METADATA_REQUIRED');
    assert.equal(csp(response), PLAIN_SANDBOX);
  });

  it('is refused as a top-level navigation, with a token next to the cookie, and with no cookie', async () => {
    const asDocument = await frameLoad('page.html', { 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' });
    assert.equal(asDocument.status, 401);
    const withToken = await frameLoad('page.html', { authorization: `Bearer ${tabToken}` });
    assert.equal(withToken.status, 401);
    const noCookie = await ask(previewPath('page.html'), FRAME);
    assert.equal(noCookie.status, 401);
    for (const response of [asDocument, withToken, noCookie]) assert.equal(csp(response), PLAIN_SANDBOX);
  });

  it('the cookie with the frame-load headers reaches no other route through the Controller', async () => {
    for (const route of ['/api/projects', '/api/file-tree/projects/x/files/content?path=a.html', '/health', '/api/auth/user']) {
      const response = await ask(route, { ...FRAME, ...cookie() });
      assert.equal(response.status, 401, route);
    }
  });

  it('a file the Host refuses to serve as a page keeps the plain sandbox', async () => {
    const notHtml = await frameLoad('notes.txt');
    assert.ok(notHtml.status >= 400, `status ${notHtml.status}`);
    assert.ok(!csp(notHtml).includes('allow-scripts'), csp(notHtml));
    const outside = await ask(`/api/file-tree/projects/${encodeURIComponent(project.id)}/files/html-preview?path=${encodeURIComponent('/etc/hosts')}`, { ...FRAME, ...cookie() });
    assert.ok(outside.status >= 400, `status ${outside.status}`);
    assert.ok(!csp(outside).includes('allow-scripts'), csp(outside));
  });

  // Last, because it ends the pairing for the rest of the file.
  it('after the Host revokes the pairing, a frame load and a status check are refused, with no content and no script policy', async () => {
    const revoked = await world.manage(world.host, `/host/pairings/${world.hostPairingId}`, 'DELETE');
    assert.equal(revoked.status, 200, revoked.text);
    await waitForPeerState(world.controller, world.peerId, 'revoked', 30_000);
    const frame = await frameLoad('page.html');
    assert.equal(frame.status, 503);
    assert.equal(frame.json<{ error: { code: string } }>().error.code, 'REMOTE_LINK_DOWN');
    assert.ok(!frame.text.includes('hello from the host'));
    assert.equal(csp(frame), PLAIN_SANDBOX);
    const check = await ask(previewPath('page.html'), { ...FETCH, authorization: `Bearer ${tabToken}` });
    assert.equal(check.status, 503);
  });
});

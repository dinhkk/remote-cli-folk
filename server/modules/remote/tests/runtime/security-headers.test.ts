/**
 * Security headers of the Controller's pages (NFR-12): the main page gets a minimal CSP (frame-ancestors,
 * base-uri, object-src) plus nosniff and a Referrer-Policy; the `?target=` tab page keeps its own strict
 * policy; API and asset responses get no CSP; the kill switch leaves everything as it was. The same
 * headers were also checked in a real browser (reports/security-headers-browser-check-261105.md).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAIN_PAGE_CSP, isMainPageRequest } from '../../runtime/main-page-security-headers.js';
import { TARGET_PAGE_CSP } from '../../runtime/target-page-csp.js';
import { send } from '../support/http-test-client.js';
import { withModuleRig } from '../support/remote-module-rig.js';

const directives = (policy: string | string[] | undefined): string[] => String(policy ?? '').split(';').map((part) => part.trim()).filter(Boolean);

const request = (query = '', path = '/', method = 'GET') => ({ method, path, query: Object.fromEntries(new URLSearchParams(query)) }) as Parameters<typeof isMainPageRequest>[0];

describe('main page security headers', () => {
  it('the policy has frame-ancestors, base-uri and object-src, and nothing that could break the Local UI', () => {
    assert.deepEqual(directives(MAIN_PAGE_CSP), ["frame-ancestors 'self'", "base-uri 'self'", "object-src 'none'"]);
    for (const risky of ['default-src', 'script-src', 'style-src', 'connect-src', 'img-src', 'font-src', 'worker-src', 'form-action']) {
      assert.ok(!MAIN_PAGE_CSP.includes(risky), `${risky} could break the Local UI`);
    }
  });

  it('applies to HTML routes only: not to the API, the relay proxy, the sockets, files or tab pages', () => {
    for (const path of ['/', '/index.html', '/session/abc', '/settings']) assert.equal(isMainPageRequest(request('', path)), true, path);
    for (const path of ['/api/projects', '/r/peer/api/x', '/ws', '/shell', '/health', '/assets/app-1a2b.js', '/favicon.svg', '/sw.js', '/manifest.json']) {
      assert.equal(isMainPageRequest(request('', path)), false, path);
    }
    assert.equal(isMainPageRequest(request('target=peer', '/')), false);
    assert.equal(isMainPageRequest(request('', '/', 'POST')), false);
  });

  it('serves the CSP, nosniff and Referrer-Policy on the main page and its SPA routes; the tab page keeps the strict policy', async () => {
    await withModuleRig({}, async (rig) => {
      for (const path of ['/', '/index.html', '/some/spa/route']) {
        const response = await send(rig.port, { path });
        assert.deepEqual(directives(response.headers['content-security-policy']), directives(MAIN_PAGE_CSP), path);
        assert.equal(response.headers['x-content-type-options'], 'nosniff');
        assert.equal(response.headers['referrer-policy'], 'same-origin');
      }
      const tab = await send(rig.port, { path: '/?target=some-peer' });
      const policy = directives(tab.headers['content-security-policy']);
      assert.deepEqual(policy.filter((directive) => directive.startsWith('connect-src')), ["connect-src 'self'"]);
      for (const directive of directives(TARGET_PAGE_CSP)) assert.ok(policy.includes(directive), `the tab page lost: ${directive}`);
      assert.equal(tab.headers['x-content-type-options'], 'nosniff');
    });
  });

  it('API and asset responses get nosniff but no CSP', async () => {
    await withModuleRig({}, async (rig) => {
      for (const path of ['/api/remote/relay-config', '/assets/app.js', '/api/projects']) {
        const response = await send(rig.port, { path, headers: { authorization: `Bearer ${rig.jwt}`, 'sec-fetch-site': 'same-origin' } });
        assert.equal(response.headers['content-security-policy'], undefined, path);
        assert.equal(response.headers['x-content-type-options'], 'nosniff', path);
      }
    });
  });

  it('HEAD requests of HTML pages get the same headers as GET (the tab page keeps its own policy)', async () => {
    await withModuleRig({}, async (rig) => {
      for (const path of ['/', '/index.html', '/some/spa/route']) {
        const head = await send(rig.port, { method: 'HEAD', path });
        assert.deepEqual(directives(head.headers['content-security-policy']), directives(MAIN_PAGE_CSP), `HEAD ${path}`);
        assert.equal(head.headers['x-content-type-options'], 'nosniff');
        assert.equal(head.headers['referrer-policy'], 'same-origin');
      }
      const tabGet = await send(rig.port, { path: '/?target=some-peer' });
      const tabHead = await send(rig.port, { method: 'HEAD', path: '/?target=some-peer' });
      assert.deepEqual(directives(tabHead.headers['content-security-policy']), directives(tabGet.headers['content-security-policy']), 'HEAD of a tab page carries the strict policy');
      assert.ok(directives(tabHead.headers['content-security-policy']).some((directive) => directive.startsWith('connect-src')));
    });
  });

  it('CLOUDCLI_REMOTE_MAIN_PAGE_HEADERS is on by default; 1/true/unset keep frame-ancestors and Referrer-Policy', async () => {
    for (const env of [{}, { CLOUDCLI_REMOTE_MAIN_PAGE_HEADERS: '1' }, { CLOUDCLI_REMOTE_MAIN_PAGE_HEADERS: 'true' }, { CLOUDCLI_REMOTE_MAIN_PAGE_HEADERS: 'banana' }]) {
      await withModuleRig({ env }, async (rig) => {
        const response = await send(rig.port, { path: '/' });
        assert.ok(directives(response.headers['content-security-policy']).includes("frame-ancestors 'self'"), JSON.stringify(env));
        assert.equal(response.headers['referrer-policy'], 'same-origin');
      });
    }
  });

  it('CLOUDCLI_REMOTE_MAIN_PAGE_HEADERS=0 drops only frame-ancestors and Referrer-Policy; Remote keeps working and the tab page keeps its policy', async () => {
    for (const value of ['0', 'false']) {
      await withModuleRig({ env: { CLOUDCLI_REMOTE_MAIN_PAGE_HEADERS: value } }, async (rig) => {
        for (const method of ['GET', 'HEAD']) {
          const response = await send(rig.port, { method, path: '/' });
          const policy = directives(response.headers['content-security-policy']);
          assert.ok(!policy.some((directive) => directive.startsWith('frame-ancestors')), `${method}: framing stays possible`);
          assert.deepEqual(policy, ["base-uri 'self'", "object-src 'none'"]);
          assert.equal(response.headers['referrer-policy'], undefined);
          assert.equal(response.headers['x-content-type-options'], 'nosniff');
        }
        const tab = await send(rig.port, { path: '/?target=some-peer' });
        assert.deepEqual(directives(tab.headers['content-security-policy']).filter((directive) => directive.startsWith('connect-src')), ["connect-src 'self'"]);
        const api = await send(rig.port, { path: '/api/remote/relay-config', headers: { authorization: `Bearer ${rig.jwt}`, 'sec-fetch-site': 'same-origin' } });
        assert.notEqual(api.status, 404, 'the Remote API is still mounted');
      });
    }
  });

  it('CLOUDCLI_REMOTE_DISABLED=1 leaves the server exactly as before: none of these headers', async () => {
    await withModuleRig({ env: { CLOUDCLI_REMOTE_DISABLED: '1' } }, async (rig) => {
      const response = await send(rig.port, { path: '/' });
      assert.equal(response.headers['content-security-policy'], undefined);
      assert.equal(response.headers['x-content-type-options'], undefined);
      assert.equal(response.headers['referrer-policy'], undefined);
    });
  });
});

/**
 * Security headers of the Controller's pages (NFR-12): the main page gets a CSP that limits scripts to its
 * own origin and hashed inline scripts and connections to its own origin (its WebSocket form included), plus
 * frame-ancestors, base-uri, object-src, nosniff and a Referrer-Policy; the `?target=` tab page keeps its own
 * strict policy; API and asset responses get no CSP; the kill switch leaves everything as it was.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAIN_PAGE_CSP, buildMainPageCsp, isMainPageRequest } from '../../runtime/main-page-security-headers.js';
import { TARGET_PAGE_CSP, sameHostSocketSources } from '../../runtime/target-page-csp.js';
import { send } from '../support/http-test-client.js';
import { withModuleRig } from '../support/remote-module-rig.js';

const directives = (policy: string | string[] | undefined): string[] => String(policy ?? '').split(';').map((part) => part.trim()).filter(Boolean);

/** The main-page policy the rig's server sends to a request for `127.0.0.1:<port>`. */
const mainPolicyFor = (port: number, frameAncestors = true): string =>
  buildMainPageCsp({ frameAncestors, socketSources: sameHostSocketSources(`127.0.0.1:${port}`) });
const openSources = ['https:', 'http:', 'wss:', 'ws:', '*', "'unsafe-inline'", "'unsafe-eval'", 'blob:', 'data:'];

const request = (query = '', path = '/', method = 'GET') => ({ method, path, query: Object.fromEntries(new URLSearchParams(query)) }) as Parameters<typeof isMainPageRequest>[0];

describe('main page security headers', () => {
  it('CS-02/CS-03: scripts from the own origin and hashed inline scripts only; connections to the own origin only', () => {
    assert.deepEqual(directives(MAIN_PAGE_CSP), [
      "script-src 'self'", "connect-src 'self'", "worker-src 'self' blob:", "frame-ancestors 'self'", "base-uri 'self'", "object-src 'none'",
    ]);
    const policy = directives(buildMainPageCsp({ frameAncestors: true, scriptHashes: ["'sha256-AAA'"], socketSources: sameHostSocketSources('ctl.example.test:8443') }));
    assert.ok(policy.includes("script-src 'self' 'sha256-AAA'"));
    assert.ok(policy.includes("connect-src 'self' ws://ctl.example.test:8443 wss://ctl.example.test:8443"));
    for (const directive of policy.filter((entry) => /^(script|connect)-src /.test(entry))) {
      for (const open of openSources) assert.ok(!directive.split(' ').includes(open), `${directive} must not allow ${open}`);
    }
    // Styles, images and fonts stay unrestricted on the main page.
    for (const untouched of ['default-src', 'style-src', 'img-src', 'font-src', 'form-action']) assert.ok(!MAIN_PAGE_CSP.includes(untouched), untouched);
  });

  it('CS-04: a Host header that is not a plain host[:port] adds no WebSocket source', () => {
    assert.deepEqual(sameHostSocketSources('127.0.0.1:3001'), ['ws://127.0.0.1:3001', 'wss://127.0.0.1:3001']);
    assert.deepEqual(sameHostSocketSources('[::1]:3001'), ['ws://[::1]:3001', 'wss://[::1]:3001']);
    for (const hostile of [undefined, '', 'a.test https:', 'a.test;script-src *', "a.test 'unsafe-inline'", 'a.test/x', 'evil.test, other.test']) {
      assert.deepEqual(sameHostSocketSources(hostile), [], String(hostile));
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
        assert.deepEqual(directives(response.headers['content-security-policy']), directives(mainPolicyFor(rig.port)), path);
        assert.equal(response.headers['x-content-type-options'], 'nosniff');
        assert.equal(response.headers['referrer-policy'], 'same-origin');
      }
      const tab = await send(rig.port, { path: '/?target=some-peer' });
      const policy = directives(tab.headers['content-security-policy']);
      assert.deepEqual(policy.filter((directive) => directive.startsWith('connect-src')), [`connect-src 'self' ws://127.0.0.1:${rig.port} wss://127.0.0.1:${rig.port}`]);
      for (const directive of directives(TARGET_PAGE_CSP).filter((entry) => !entry.startsWith('connect-src'))) assert.ok(policy.includes(directive), `the tab page lost: ${directive}`);
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
        assert.deepEqual(directives(head.headers['content-security-policy']), directives(mainPolicyFor(rig.port)), `HEAD ${path}`);
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
          assert.deepEqual(policy, directives(mainPolicyFor(rig.port, false)));
          assert.equal(response.headers['referrer-policy'], undefined);
          assert.equal(response.headers['x-content-type-options'], 'nosniff');
        }
        const tab = await send(rig.port, { path: '/?target=some-peer' });
        assert.deepEqual(directives(tab.headers['content-security-policy']).filter((directive) => directive.startsWith('connect-src')), [`connect-src 'self' ws://127.0.0.1:${rig.port} wss://127.0.0.1:${rig.port}`]);
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

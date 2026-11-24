/**
 * The CSP of pages served with `?target=` (contracts section 3): the exact policy, the SHA-256 sources of the
 * inline scripts of the built `index.html` (no `'unsafe-inline'` for scripts), and where it is applied.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { buildMainPageCsp, createMainPageSecurityHeaders } from '../../runtime/main-page-security-headers.js';
import {
  TARGET_PAGE_CSP, buildTargetPageCsp, createTargetPageCsp, readInlineScriptHashes, sameHostSocketSources,
} from '../../runtime/target-page-csp.js';
import { send } from '../support/http-test-client.js';
import { withModuleRig } from '../support/remote-module-rig.js';

const sha = (text: string): string => `'sha256-${crypto.createHash('sha256').update(text, 'utf8').digest('base64')}'`;

const withHtml = async (html: string, run: (file: string) => Promise<void> | void): Promise<void> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'target-csp-'));
  const file = path.join(dir, 'index.html');
  fs.writeFileSync(file, html);
  try {
    await run(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const SHIM = '\n      (function () { window.__CLOUDCLI_TARGET__ = true; })();\n    ';
const REGISTER = "\n      if ('serviceWorker' in navigator) { navigator.serviceWorker.register('/sw.js'); }\n    ";
const PAGE = `<!doctype html><html><head>
<script data-cloudcli-target-shim>${SHIM}</script>
<script type="module" crossorigin src="/assets/index-abc.js"></script>
<script data-src="x">${REGISTER}</script>
<script></script>
</head><body><script>${REGISTER}</script></body></html>`;

describe('target page CSP', () => {
  it('is exactly the documented policy', () => {
    assert.equal(
      TARGET_PAGE_CSP,
      "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; " +
        "worker-src 'self' blob:; frame-ancestors 'self'; base-uri 'self'; form-action 'none'; object-src 'none'",
    );
    assert.ok(!/script-src/.test(TARGET_PAGE_CSP), 'script-src falls back to default-src');
  });

  it('hashes every inline script of the page once, and nothing else (no external script, no empty one)', async () => {
    await withHtml(PAGE, (file) => {
      assert.deepEqual(readInlineScriptHashes(file).sort(), [sha(SHIM), sha(REGISTER)].sort());
    });
    assert.deepEqual(readInlineScriptHashes(path.join(os.tmpdir(), 'does-not-exist.html')), []);
  });

  it('puts script-src right after default-src, only when there is something to allow', () => {
    assert.equal(buildTargetPageCsp([]), TARGET_PAGE_CSP);
    const policy = buildTargetPageCsp(["'sha256-AAA'", "'sha256-BBB'"]);
    assert.ok(policy.startsWith("default-src 'self'; script-src 'self' 'sha256-AAA' 'sha256-BBB'; connect-src 'self'"));
    assert.ok(!policy.includes('unsafe-inline') || /style-src 'self' 'unsafe-inline'/.test(policy));
    assert.ok(!/script-src[^;]*unsafe-inline/.test(policy), 'inline scripts are allowed by hash, never by unsafe-inline');
  });

  it('CS-03/CS-04: connections only to the own origin, its WebSocket form listed explicitly; no open scheme', () => {
    const policy = buildTargetPageCsp(["'sha256-AAA'"], sameHostSocketSources('ctl.example.test'));
    const connect = policy.split('; ').find((directive) => directive.startsWith('connect-src'));
    assert.equal(connect, "connect-src 'self' ws://ctl.example.test wss://ctl.example.test");
    for (const open of ['https:', 'http:', 'wss:', 'ws:', '*']) assert.ok(!connect!.split(' ').includes(open), open);
  });

  it('CS-10: script-src never allows blob:, data: or another origin, so a module from a blob URL cannot load', () => {
    const policy = buildTargetPageCsp(["'sha256-AAA'"], sameHostSocketSources('ctl.example.test'));
    const scriptSources = policy.split('; ').find((directive) => directive.startsWith('script-src'))!.split(' ').slice(1);
    // Every source is the own origin or an inline-script hash: nothing a blob: or data: URL could match.
    assert.ok(scriptSources.every((source) => source === "'self'" || /^'sha256-[A-Za-z0-9+/=]+'$/.test(source)), scriptSources.join(' '));
    // Without hashes script-src falls back to default-src 'self', which does not match blob: either.
    assert.ok(!/(^|; )default-src [^;]*(blob:|data:)/.test(buildTargetPageCsp([])));
    assert.ok(!/script-src[^;]*(blob:|data:|https?:)/.test(policy));
  });

  it('follows the file: the plain policy without a page, the hashes with one, new hashes after the page changes', async () => {
    assert.equal(createTargetPageCsp()(), TARGET_PAGE_CSP);
    assert.equal(createTargetPageCsp()('ctl.example.test'), buildTargetPageCsp([], sameHostSocketSources('ctl.example.test')));
    assert.equal(createTargetPageCsp(path.join(os.tmpdir(), 'missing-index.html'))(), TARGET_PAGE_CSP);
    await withHtml(PAGE, (file) => {
      const policy = createTargetPageCsp(file);
      assert.ok(policy().includes(sha(SHIM)));
      fs.writeFileSync(file, '<script>1+1</script>');
      const later = new Date(Date.now() + 5000);
      fs.utimesSync(file, later, later);
      assert.ok(policy().includes(sha('1+1')));
      assert.ok(!policy().includes(sha(SHIM)));
    });
  });

  it('CS-06b: the main page hashes follow index.html as well', async () => {
    await withHtml(PAGE, (file) => {
      const middleware = createMainPageSecurityHeaders({ frameAncestors: true, referrerPolicy: true }, file);
      const policyNow = (): string => {
        const headers: Record<string, string> = {};
        const req = { method: 'GET', path: '/', query: {}, headers: { host: 'ctl.example.test' } };
        middleware(req as never, { setHeader: (name: string, value: string) => { headers[name] = value; } } as never, () => undefined);
        return headers['Content-Security-Policy'];
      };
      assert.ok(policyNow().includes(sha(SHIM)));
      fs.writeFileSync(file, '<script>2+2</script>');
      const later = new Date(Date.now() + 5000);
      fs.utimesSync(file, later, later);
      assert.ok(policyNow().includes(sha('2+2')));
      assert.ok(!policyNow().includes(sha(SHIM)));
      assert.ok(!/script-src[^;]*(unsafe-inline|unsafe-eval)/.test(policyNow()));
    });
  });
});

describe('target page CSP in the module', () => {
  it('is sent with the inline-script hashes of the configured index.html on ?target= pages only', async () => {
    await withHtml(PAGE, async (file) => {
      await withModuleRig({ moduleOptions: { indexHtmlPath: file } }, async (rig) => {
        const sockets = sameHostSocketSources(`127.0.0.1:${rig.port}`);
        const expected = buildTargetPageCsp(readInlineScriptHashes(file), sockets);
        assert.ok(expected.includes('script-src'));
        assert.equal((await send(rig.port, { path: '/?target=peer-1' })).headers['content-security-policy'], expected);
        // CS-02: the plain page gets the main-page policy with the same inline-script hashes, never the target-page one.
        assert.equal(
          (await send(rig.port, { path: '/' })).headers['content-security-policy'],
          buildMainPageCsp({ frameAncestors: true, scriptHashes: readInlineScriptHashes(file), socketSources: sockets }),
        );
        assert.equal((await send(rig.port, { path: '/assets/app.js?target=peer-1' })).headers['content-security-policy'], undefined);
      });
    });
  });

  it('also covers a request that repeats target (the first one wins in the page), not only a single value', async () => {
    await withModuleRig({}, async (rig) => {
      const expected = buildTargetPageCsp([], sameHostSocketSources(`127.0.0.1:${rig.port}`));
      assert.equal((await send(rig.port, { path: '/?target=a&target=b' })).headers['content-security-policy'], expected);
      assert.equal((await send(rig.port, { path: '/?target=' })).headers['content-security-policy'], expected);
    });
  });
});

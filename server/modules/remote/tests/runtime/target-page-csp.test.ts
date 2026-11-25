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

const scriptSrc = (policy: string): string[] =>
  policy.split('; ').find((directive) => directive.startsWith('script-src'))!.split(' ').slice(1);

describe('blob: scripts follow the plugin switch, on the main app pages only', () => {
  it('CS-11a: plugins on: the main page allows blob: scripts, the ?target= page does not', async () => {
    await withHtml(PAGE, async (file) => {
      await withModuleRig({ moduleOptions: { indexHtmlPath: file, pluginScripts: true } }, async (rig) => {
        const main = scriptSrc((await send(rig.port, { path: '/' })).headers['content-security-policy'] as string);
        assert.ok(main.includes('blob:'), main.join(' '));
        assert.ok(main.every((source) => ["'self'", 'blob:'].includes(source) || /^'sha256-/.test(source)), main.join(' '));
        const target = (await send(rig.port, { path: '/?target=peer-1' })).headers['content-security-policy'] as string;
        assert.ok(!scriptSrc(target).includes('blob:'), target);
      });
    });
  });

  it('CS-11b: plugins off: neither page allows blob: scripts', async () => {
    await withHtml(PAGE, async (file) => {
      for (const moduleOptions of [{ indexHtmlPath: file, pluginScripts: false }, { indexHtmlPath: file }]) {
        await withModuleRig({ moduleOptions }, async (rig) => {
          for (const page of ['/', '/settings', '/?target=peer-1']) {
            const policy = (await send(rig.port, { path: page })).headers['content-security-policy'] as string;
            assert.ok(!scriptSrc(policy).includes('blob:'), `${page}: ${policy}`);
          }
        });
      }
    });
  });

  it('CS-11: blob: is the only addition: no data:, no unsafe-inline, no unsafe-eval anywhere in script-src', () => {
    const policy = buildMainPageCsp({ frameAncestors: true, scriptHashes: ["'sha256-AAA'"], blobScripts: true });
    assert.deepEqual(scriptSrc(policy), ["'self'", "'sha256-AAA'", 'blob:']);
  });
});

describe('static pages of the build carry their own script hashes', () => {
  const API_DOCS_SCRIPT = "\n  document.querySelectorAll('.api-url');\n";
  const withBuild = async (run: (indexHtml: string) => Promise<void>): Promise<void> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-page-csp-'));
    try {
      fs.writeFileSync(path.join(dir, 'index.html'), PAGE);
      fs.writeFileSync(path.join(dir, 'api-docs.html'), `<!doctype html><body><script>${API_DOCS_SCRIPT}</script></body>`);
      fs.writeFileSync(path.join(dir, 'plain.html'), '<!doctype html><body>no script</body>');
      await run(path.join(dir, 'index.html'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it('CS-07: a static page allows only its own inline scripts, never blob:; other routes keep the app hashes', async () => {
    await withBuild(async (indexHtml) => {
      await withModuleRig({ moduleOptions: { indexHtmlPath: indexHtml, pluginScripts: true } }, async (rig) => {
        const policyOf = async (page: string) => (await send(rig.port, { path: page })).headers['content-security-policy'] as string;
        assert.deepEqual(scriptSrc(await policyOf('/api-docs.html')), ["'self'", sha(API_DOCS_SCRIPT)]);
        assert.deepEqual(scriptSrc(await policyOf('/plain.html')), ["'self'"]);
        const app = scriptSrc(await policyOf('/'));
        assert.deepEqual(app, ["'self'", ...readInlineScriptHashes(indexHtml), 'blob:']);
        // A name that is not a file of the build gets the app policy, never a policy read from elsewhere.
        assert.deepEqual(scriptSrc(await policyOf('/missing.html')), app);
        assert.deepEqual(scriptSrc(await policyOf('/index.html')), app);
      });
    });
  });
});

describe('the Host header never adds anything but its own WebSocket sources', () => {
  const HOSTILE_HOSTS = [
    'ctl.example.test evil.test', 'ctl.example.test;script-src *', 'ctl.example.test,evil.test', 'ctl.example.test\nX: y',
    'ctl.example.test\r\n', 'ctl.exämple.test', 'ctl.example.test:3001 ', 'ctl.example.test/path', '*', "'self'", '',
  ];

  it('CS-03: an invalid Host is left out; the page keeps connect-src \'self\'', () => {
    for (const host of HOSTILE_HOSTS) {
      assert.deepEqual(sameHostSocketSources(host), [], JSON.stringify(host));
      const middleware = createMainPageSecurityHeaders({ frameAncestors: true, referrerPolicy: true });
      const headers: Record<string, string> = {};
      const req = { method: 'GET', path: '/', query: {}, headers: { host } };
      middleware(req as never, { setHeader: (name: string, value: string) => { headers[name] = value; } } as never, () => undefined);
      assert.ok(headers['Content-Security-Policy'].includes("connect-src 'self'; "), JSON.stringify(host));
      assert.ok(!/connect-src[^;]*ws/.test(headers['Content-Security-Policy']), JSON.stringify(host));
      assert.equal(createTargetPageCsp()(host), buildTargetPageCsp([]), JSON.stringify(host));
    }
    assert.equal(sameHostSocketSources(undefined).length, 0);
  });

  it('CS-03: a plain host, host:port and [ipv6]:port are listed as ws:// and wss://', () => {
    for (const host of ['ctl.example.test', 'ctl.example.test:3001', '127.0.0.1:3001', '[::1]:3001', 'localhost']) {
      assert.deepEqual(sameHostSocketSources(host), [`ws://${host}`, `wss://${host}`]);
    }
  });
});

/**
 * The one request the Controller accepts with the browser's session cookie instead of a tab token: a signed-in
 * browser loading the HTML preview page into a frame. Covers who may do it, what the Host sees, what the browser
 * gets back (headers set by the Controller, never by the Host), every refusal, and what ends a response in flight.
 * The production route table is used, so the real path is exercised.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getSessionRuntime } from '@/modules/auth/index.js';
import { getConnection } from '@/modules/database/index.js';
import { HTML_PREVIEW_CSP } from '@/modules/file-tree/index.js';

import { SANDBOX_CSP } from '../../policy/header-filter.js';
import { open, send } from '../support/http-test-client.js';
import { waitUntil, withHarness, type ProxyHarness } from '../support/proxy-harness.js';

const FRAME = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' };
const previewPath = (h: ProxyHarness, query = '?path=index.html'): string => `/r/${h.peerId}/api/file-tree/projects/p-1/files/html-preview${query}`;
const cookie = (secret: string): Record<string, string> => ({ cookie: `remotecli_session=${secret}` });
const frameLoad = (h: ProxyHarness, extra: Record<string, string> = {}): Record<string, string> => ({ ...FRAME, ...cookie(h.mainJwt), ...extra });
const errorCode = (body: string): string | undefined => (JSON.parse(body) as { error?: { code?: string } }).error?.code;
const session = (h: ProxyHarness) => getSessionRuntime().store.authenticate(h.mainJwt)!;

/** A session can be locked only while its account has TOTP enabled; the session itself then counts as verified. */
const enableTotp = (userId: number, sessionId: string): void => {
  const db = getConnection();
  db.exec('CREATE TABLE IF NOT EXISTS auth_totp (user_id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0)');
  db.prepare('INSERT OR REPLACE INTO auth_totp (user_id, enabled) VALUES (?, 1)').run(userId);
  db.prepare('UPDATE auth_sessions SET mfa_verified_at = ? WHERE id = ?').run(Date.now(), sessionId);
};

describe('Preview frame load: what the Host sees and what the browser gets', () => {
  it('forwards the canonical path with no cookie, token or conditional header, and answers with the headers the Controller sets', async () => {
    await withHarness({ productionPolicy: true }, async (h) => {
      // A hostile Host sends each of these policies in turn, with every header the browser must never take from it.
      for (const [index, hostilePolicy] of ['', 'script-src *'].entries()) {
        const pending = send(h.port, {
          path: previewPath(h),
          headers: frameLoad(h, { range: 'bytes=0-9', 'if-none-match': '"a"', 'if-modified-since': 'Wed, 21 Oct 2015 07:28:00 GMT' }),
        });
        const stream = await h.nextStream(index);
        assert.equal(stream.open.kind, 'http');
        const meta = (stream.open as { meta: { method: string; path: string; headers: Record<string, string> } }).meta;
        assert.equal(meta.method, 'GET');
        assert.equal(meta.path, '/api/file-tree/projects/p-1/files/html-preview?path=index.html');
        for (const name of ['cookie', 'authorization', 'range', 'if-none-match', 'if-modified-since']) {
          assert.equal(meta.headers[name], undefined, `${name} reached the Host`);
        }
        stream.respond({
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-length': '5',
            'content-security-policy': hostilePolicy,
            'content-disposition': 'attachment; filename=x.html',
            'set-cookie': 'remotecli_session=evil; Path=/',
            etag: '"evil"',
            'access-control-allow-origin': '*',
            'access-control-allow-credentials': 'true',
            'x-request-id': 'req-1',
          },
        });
        stream.body('hello', true);
        const res = await pending;
        assert.equal(res.status, 200);
        assert.equal(res.text(), 'hello');
        assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
        assert.equal(res.headers['content-security-policy'], HTML_PREVIEW_CSP, `Host policy ${JSON.stringify(hostilePolicy)}`);
        assert.equal(res.headers['x-content-type-options'], 'nosniff');
        assert.equal(res.headers['cache-control'], 'no-store');
        assert.equal(res.headers['referrer-policy'], 'no-referrer');
        assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin');
        assert.equal(res.headers['x-request-id'], 'req-1');
        for (const name of ['set-cookie', 'content-disposition', 'etag', 'access-control-allow-origin', 'access-control-allow-credentials']) {
          assert.equal(res.headers[name], undefined, `${name} reached the browser`);
        }
      }
    });
  });

  it('keeps the script-enabled policy for a 200 only: a 206, a 304 and an error answer get the plain sandbox', async () => {
    await withHarness({ productionPolicy: true }, async (h) => {
      const answers = [
        { status: 206, headers: { 'content-type': 'text/html', 'content-security-policy': HTML_PREVIEW_CSP } },
        { status: 304, headers: { 'content-security-policy': HTML_PREVIEW_CSP } },
        { status: 404, headers: { 'content-type': 'application/json', 'content-security-policy': HTML_PREVIEW_CSP } },
      ];
      for (const [index, answer] of answers.entries()) {
        const pending = send(h.port, { path: previewPath(h), headers: frameLoad(h) });
        const stream = await h.nextStream(index);
        stream.respond(answer);
        stream.body('', true);
        const res = await pending;
        assert.equal(res.status, answer.status);
        assert.equal(res.headers['content-security-policy'], SANDBOX_CSP, `status ${answer.status}`);
        assert.ok(!String(res.headers['content-security-policy']).includes('allow-scripts'));
      }
    });
  });

  it('never grants the script-enabled policy to a tab-token request for the same path', async () => {
    await withHarness({ productionPolicy: true }, async (h) => {
      const fetchHeaders = { ...h.auth(), 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };
      const pending = send(h.port, { path: previewPath(h), headers: fetchHeaders });
      const stream = await h.nextStream();
      stream.respond({ status: 200, headers: { 'content-type': 'text/html', 'content-security-policy': HTML_PREVIEW_CSP } });
      stream.body('<script>1</script>', true);
      const res = await pending;
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-security-policy'], SANDBOX_CSP);
    });
  });

  it('refuses a tab-token status check of the page that carries no Fetch Metadata, without opening a stream', async () => {
    await withHarness({ productionPolicy: true }, async (h) => {
      for (const missing of ['sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest']) {
        const headers: Record<string, string> = { ...h.auth(), 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };
        delete headers[missing];
        const res = await send(h.port, { path: previewPath(h), headers });
        assert.equal(res.status, 400, missing);
        assert.equal(errorCode(res.text()), 'HTML_PREVIEW_FETCH_METADATA_REQUIRED');
        assert.equal(res.headers['content-security-policy'], SANDBOX_CSP, missing);
      }
      assert.equal(h.link.streams.length, 0);
    });
  });

  it('does not let the cookie reach any other route, even with the frame-load headers', async () => {
    await withHarness({ productionPolicy: true }, async (h) => {
      for (const path of [`/r/${h.peerId}/api/projects`, `/r/${h.peerId}/api/file-tree/projects/p-1/files/content?path=index.html`, `/r/${h.peerId}/health`, `/r/${h.peerId}/api/auth/user`]) {
        const res = await send(h.port, { path, headers: frameLoad(h) });
        assert.equal(res.status, 401, path);
        assert.equal(errorCode(res.text()), 'AUTH_TOKEN_INVALID');
      }
      assert.equal(h.link.streams.length, 0);
    });
  });

  it('sends no credentialed cross-origin permission and no cookie back', async () => {
    await withHarness({ productionPolicy: true }, async (h) => {
      const pending = send(h.port, { path: previewPath(h), headers: frameLoad(h) });
      const stream = await h.nextStream();
      stream.respond({ status: 200, headers: { 'content-type': 'text/html' } });
      stream.body('x', true);
      const res = await pending;
      assert.equal(res.headers['access-control-allow-credentials'], undefined);
      assert.equal(res.headers['access-control-allow-origin'], undefined);
      assert.equal(res.headers['set-cookie'], undefined);
    });
  });
});

describe('Preview frame load: refusals', () => {
  const refusedAsUnauthenticated = async (h: ProxyHarness, request: { method?: string; path: string; headers: Record<string, string> }, what: string, closed = true): Promise<void> => {
    const res = await send(h.port, request);
    assert.equal(res.status, 401, what);
    // The Controller's own JSON answer for the page route carries the plain sandbox (a look-alike path is not that route).
    assert.equal(res.headers['content-security-policy'], closed ? SANDBOX_CSP : undefined, what);
    assert.equal(errorCode(res.text()), 'AUTH_TOKEN_INVALID', what);
    assert.equal(res.headers['cache-control'], 'no-store', what);
    assert.equal(res.headers['x-auth-error'], undefined, what);
    assert.equal(res.headers['set-cookie'], undefined, what);
  };

  it('refuses a frame load with no cookie, a wrong cookie or an unknown session', async () => {
    await withHarness({ productionPolicy: true }, async (h) => {
      await refusedAsUnauthenticated(h, { path: previewPath(h), headers: { ...FRAME } }, 'no cookie');
      await refusedAsUnauthenticated(h, { path: previewPath(h), headers: { ...FRAME, ...cookie('A'.repeat(43)) } }, 'unknown session');
      await refusedAsUnauthenticated(h, { path: previewPath(h), headers: { ...FRAME, cookie: 'remotecli_session=short' } }, 'malformed cookie');
      assert.equal(h.link.streams.length, 0);
    });
  });

  it('refuses a frame load that also carries an Authorization header, with no fallback to it', async () => {
    await withHarness({ productionPolicy: true }, async (h) => {
      await refusedAsUnauthenticated(h, { path: previewPath(h), headers: frameLoad(h, h.auth()) }, 'cookie and a valid tab token');
      await refusedAsUnauthenticated(h, { path: previewPath(h), headers: { ...FRAME, ...h.auth() } }, 'a valid tab token and no cookie');
      assert.equal(h.link.streams.length, 0);
    });
  });

  it('does not read a token or a session secret from the URL', async () => {
    await withHarness({ productionPolicy: true }, async (h) => {
      await refusedAsUnauthenticated(h, { path: previewPath(h, `?path=index.html&token=${h.tabToken}`), headers: { ...FRAME } }, 'tab token in the URL');
      await refusedAsUnauthenticated(h, { path: previewPath(h, `?path=index.html&session=${h.mainJwt}`), headers: { ...FRAME } }, 'session secret in the URL');
      assert.equal(h.link.streams.length, 0);
    });
  });

  it('is not a frame load when a Fetch Metadata header is missing or has another value, or the Origin is foreign', async () => {
    await withHarness({ productionPolicy: true }, async (h) => {
      for (const name of Object.keys(FRAME)) {
        const missing = frameLoad(h);
        delete missing[name];
        await refusedAsUnauthenticated(h, { path: previewPath(h), headers: missing }, `missing ${name}`);
        await refusedAsUnauthenticated(h, { path: previewPath(h), headers: frameLoad(h, { [name]: 'cross-site' }) }, `wrong ${name}`);
      }
      await refusedAsUnauthenticated(h, { path: previewPath(h), headers: frameLoad(h, { origin: 'https://evil.example' }) }, 'foreign origin');
      assert.equal(h.link.streams.length, 0);
    });
  });

  it('is not a frame load for a method other than GET', async () => {
    await withHarness({ productionPolicy: true }, async (h) => {
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']) {
        const res = await send(h.port, { method, path: previewPath(h), headers: frameLoad(h) });
        assert.equal(res.status, 401, method);
      }
      assert.equal(h.link.streams.length, 0);
    });
  });

  it('is not a frame load for a look-alike path: encoded slash, trailing slash, other case, dot segments, sub-path', async () => {
    await withHarness({ productionPolicy: true }, async (h) => {
      const base = `/r/${h.peerId}/api/file-tree/projects/p-1/files`;
      // [path, whether the Controller still treats it as the preview page route (its own refusal then carries the plain sandbox)]
      const variants: Array<[string, boolean]> = [
        [`${base}%2Fhtml-preview?path=index.html`, false],
        [`${base}/html-preview/?path=index.html`, false],
        [`${base}/HTML-Preview?path=index.html`, true],
        [`/r/${h.peerId}/API/file-tree/projects/p-1/files/html-preview?path=index.html`, true],
        [`${base}/../files/html-preview?path=index.html`, false],
        [`${base}/html-preview/extra?path=index.html`, false],
        [`${base}/html-previewx?path=index.html`, false],
        [`/r/${h.peerId}/api/file-tree/projects/p%2F1/files/html-preview?path=index.html`, true],
      ];
      for (const [path, closed] of variants) await refusedAsUnauthenticated(h, { path, headers: frameLoad(h) }, path, closed);
      assert.equal(h.link.streams.length, 0);
    });
  });
});

describe('Preview frame load: the session decides', () => {
  it('answers 423 to a locked session and learns nothing about the pairing', async () => {
    await withHarness({ productionPolicy: true }, async (h) => {
      const current = session(h);
      enableTotp(current.userId, current.id);
      assert.equal(getSessionRuntime().store.lock(current.id), true);
      const res = await send(h.port, { path: previewPath(h), headers: frameLoad(h) });
      assert.equal(res.status, 423);
      assert.equal(errorCode(res.text()), 'AUTH_SESSION_LOCKED');
      assert.equal(res.headers['content-security-policy'], SANDBOX_CSP);
      assert.equal(res.headers['set-cookie'], undefined);
      assert.equal(h.link.streams.length, 0);
      // Even for a pairing that does not exist: nothing about it is told to a locked session.
      const unknown = await send(h.port, { path: `/r/${'u'.repeat(20)}/api/file-tree/projects/p-1/files/html-preview?path=index.html`, headers: frameLoad(h) });
      assert.equal(unknown.status, 423);
    });
  });

  it('answers 401 to a revoked session, an expired session, and after "log out everywhere"', async () => {
    await withHarness({ productionPolicy: true }, async (h) => {
      const current = session(h);
      getConnection().prepare('UPDATE auth_sessions SET expires_at = 1 WHERE id = ?').run(current.id);
      const expired = await send(h.port, { path: previewPath(h), headers: frameLoad(h) });
      assert.equal(expired.status, 401, 'expired');
      assert.equal(errorCode(expired.text()), 'AUTH_TOKEN_INVALID');
    });
    await withHarness({ productionPolicy: true }, async (h) => {
      const current = session(h);
      assert.equal(getSessionRuntime().store.revoke(current.id, current.userId), true);
      assert.equal((await send(h.port, { path: previewPath(h), headers: frameLoad(h) })).status, 401, 'revoked');
    });
    await withHarness({ productionPolicy: true }, async (h) => {
      await h.logoutEverywhere();
      assert.equal((await send(h.port, { path: previewPath(h), headers: frameLoad(h) })).status, 401, 'logged out everywhere');
      assert.equal(h.link.streams.length, 0);
    });
  });

  it('cuts a response in flight when the session is locked or revoked', async () => {
    for (const how of ['lock', 'revoke'] as const) {
      await withHarness({ productionPolicy: true }, async (h) => {
        const current = session(h);
        if (how === 'lock') enableTotp(current.userId, current.id);
        const opened = open(h.port, { path: previewPath(h), headers: frameLoad(h) });
        const stream = await h.nextStream();
        stream.respond({ status: 200, headers: { 'content-type': 'text/html', 'content-length': '100' } });
        const { res } = await opened;
        stream.body('partial');
        const completed = new Promise<boolean>((resolve) => {
          res.on('error', () => resolve(false));
          res.on('close', () => resolve(res.complete));
          res.resume();
        });
        const { store } = getSessionRuntime();
        assert.equal(how === 'lock' ? store.lock(current.id) : store.revoke(current.id, current.userId), true, how);
        assert.equal(await completed, false, `${how}: the response must not complete`);
      });
    }
  });
});

describe('Preview frame load: the pairing decides', () => {
  it('answers 404 for a pairing that was forgotten, 410 for an expired one and 503 when the link was revoked or is down', async () => {
    await withHarness({ productionPolicy: true }, async (h) => {
      h.registry.forget(h.peerId);
      const res = await send(h.port, { path: previewPath(h), headers: frameLoad(h) });
      assert.equal(res.status, 404);
      assert.equal(errorCode(res.text()), 'REMOTE_PEER_NOT_FOUND');
      assert.equal(res.headers['content-security-policy'], SANDBOX_CSP);
    });
    await withHarness({ productionPolicy: true, peerExpiresAt: Date.now() + 60_000 }, async (h) => {
      h.clock.advance(61_000);
      const res = await send(h.port, { path: previewPath(h), headers: frameLoad(h) });
      assert.equal(res.status, 410);
      assert.equal(errorCode(res.text()), 'REMOTE_PEER_EXPIRED');
      assert.equal(res.headers['content-security-policy'], SANDBOX_CSP);
    });
    await withHarness({ productionPolicy: true }, async (h) => {
      h.link.setStatus({ state: 'revoked', peerState: 'offline' });
      h.link.setSession(false);
      const res = await send(h.port, { path: previewPath(h), headers: frameLoad(h) });
      assert.equal(res.status, 503);
      assert.equal(errorCode(res.text()), 'REMOTE_LINK_DOWN');
      assert.equal(res.headers['content-security-policy'], SANDBOX_CSP);
      assert.equal(h.link.streams.length, 0);
    });
  });

  it('keeps the other pairing out of reach: the cookie names a session, the path names the pairing', async () => {
    await withHarness({ productionPolicy: true }, async (h) => {
      const pending = send(h.port, { path: `/r/${h.otherPeerId}/api/file-tree/projects/p-1/files/html-preview?path=index.html`, headers: frameLoad(h) });
      await waitUntil(() => h.link.streams.length > 0, 'a stream for the second pairing');
      const stream = h.link.streams[0];
      stream.respond({ status: 200, headers: { 'content-type': 'text/html' } });
      stream.body('x', true);
      assert.equal((await pending).status, 200);
    });
  });
});

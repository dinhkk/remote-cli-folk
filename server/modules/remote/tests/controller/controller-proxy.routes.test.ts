/**
 * The Controller's `/r/<peerId>/**` HTTP proxy (contracts sections 1, 6, 7, 9) with a scripted link:
 * auth by tab token only, local answers for `/health` and `/api/auth/user|status`, policy pre-check,
 * request/response streaming (incl. SSE), error mapping, limits, the receive-side budget and cleanup.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RemoteErrorCode } from '@/shared/types.js';

import { RemoteLinkDownError } from '../../link/relay-link.js';
import { open, send } from '../support/http-test-client.js';
import { waitUntil, withHarness } from '../support/proxy-harness.js';

describe('Controller HTTP proxy: authentication', () => {
  it('refuses a request without a token, with garbage, with another peer\'s token and with the main JWT (AC-25)', async () => {
    await withHarness({}, async (h) => {
      const path = `/r/${h.peerId}/api/projects`;
      for (const headers of [{}, h.auth('garbage'), h.auth(h.otherPeerToken), h.auth(h.mainJwt)]) {
        const res = await send(h.port, { path, headers });
        assert.equal(res.status, 401);
        assert.equal(res.headers['x-auth-error'], undefined, 'a tab 401 must never look like a Local session end');
        assert.equal(res.json<{ error: { code: string } }>().error.code, 'AUTH_TOKEN_INVALID');
      }
      assert.equal(h.link.streams.length, 0);
    });
  });

  it('does not accept the token in the query string', async () => {
    await withHarness({}, async (h) => {
      const res = await send(h.port, { path: `/r/${h.peerId}/api/projects?token=${h.tabToken}` });
      assert.equal(res.status, 401);
    });
  });

  it('refuses a malformed peer id, and answers 404 for a peer that was forgotten while its token was still valid', async () => {
    await withHarness({}, async (h) => {
      assert.equal((await send(h.port, { path: `/r/${'x'.repeat(65)}/api/projects`, headers: h.auth() })).status, 404);
      assert.equal((await send(h.port, { path: '/r/bad%20id/api/projects', headers: h.auth() })).status, 404);
      h.registry.forget(h.peerId);
      const res = await send(h.port, { path: `/r/${h.peerId}/api/projects`, headers: h.auth() });
      assert.equal(res.status, 404, 'the token is still valid but the peer is gone');
      assert.equal(res.json<{ error: { code: string } }>().error.code, 'REMOTE_PEER_NOT_FOUND');
    });
  });

  it('refuses a token issued before "log out everywhere"', async () => {
    await withHarness({}, async (h) => {
      await h.logoutEverywhere();
      const res = await send(h.port, { path: `/r/${h.peerId}/api/projects`, headers: h.auth() });
      assert.equal(res.status, 401);
    });
  });
});

describe('Controller HTTP proxy: answered locally', () => {
  it('answers /health, /api/auth/user and /api/auth/status itself without opening a stream', async () => {
    await withHarness({}, async (h) => {
      const health = await send(h.port, { path: `/r/${h.peerId}/health`, headers: h.auth() });
      assert.equal(health.status, 200);
      assert.equal(health.json<{ status: string }>().status, 'ok');

      const user = await send(h.port, { path: `/r/${h.peerId}/api/auth/user`, headers: h.auth() });
      assert.equal(user.status, 200);
      assert.equal(user.json<{ user: { username: string } }>().user.username, 'alice');

      const status = await send(h.port, { path: `/r/${h.peerId}/api/auth/status`, headers: h.auth() });
      assert.deepEqual(status.json(), { needsSetup: false, isAuthenticated: true });
      assert.equal(h.link.streams.length, 0);
    });
  });

  it('local answers need the tab token too and work while the link is down', async () => {
    await withHarness({ online: false }, async (h) => {
      assert.equal((await send(h.port, { path: `/r/${h.peerId}/api/auth/user` })).status, 401);
      assert.equal((await send(h.port, { path: `/r/${h.peerId}/api/auth/user`, headers: h.auth() })).status, 200);
    });
  });

  it('other /api/auth/** routes are never forwarded: 403 before any stream (the Host would refuse them anyway)', async () => {
    await withHarness({}, async (h) => {
      for (const [method, path] of [['POST', '/api/auth/login'], ['POST', '/api/auth/refresh'], ['POST', '/api/auth/logout-all'], ['GET', '/api/auth/user/x']]) {
        const res = await send(h.port, { method, path: `/r/${h.peerId}${path}`, headers: { ...h.auth(), 'content-type': 'application/json' }, body: '{}' });
        assert.equal(res.status, 403, `${method} ${path}`);
        assert.equal(res.json<{ error: { code: string } }>().error.code, 'REMOTE_FORBIDDEN');
      }
      assert.equal(h.link.streams.length, 0);
    });
  });
});

describe('Controller HTTP proxy: request path', () => {
  it('sends the canonical target and only allow-listed headers; the tab token never leaves the Controller', async () => {
    await withHarness({}, async (h) => {
      const pending = send(h.port, {
        path: `/r/${h.peerId}/api/projects//x/../list?limit=5&token=${h.tabToken}`,
        headers: { ...h.auth(), accept: 'application/json', cookie: 'a=b', 'x-forwarded-for': '1.2.3.4', 'x-request-id': 'rid-1' },
      });
      const stream = await h.nextStream();
      assert.equal(stream.open.kind, 'http');
      const meta = stream.open.kind === 'http' ? stream.open.meta : null;
      assert.ok(meta);
      assert.equal(meta.method, 'GET');
      assert.ok(meta.path.startsWith('/api/projects'), meta.path);
      assert.ok(!meta.path.includes('token='), 'the tab token must not travel to the Host');
      assert.ok(!JSON.stringify(meta).includes(h.tabToken));
      assert.deepEqual(Object.keys(meta.headers).sort(), ['accept', 'x-request-id']);
      assert.deepEqual(stream.written.map((entry) => entry.fin), [true], 'a body-less request still ends its body');
      stream.respond({ status: 200, headers: { 'content-type': 'application/json' } });
      stream.body('{"ok":true}', true);
      const res = await pending;
      assert.equal(res.status, 200);
    });
  });

  it('refuses a request the Host policy would refuse, with 403, before opening a stream', async () => {
    await withHarness({}, async (h) => {
      for (const path of ['/api/agent', '/api/%2e%2e/health', '/api/projects/%5cwindows', '/../etc/passwd', '/nope']) {
        const res = await send(h.port, { path: `/r/${h.peerId}${path}`, headers: h.auth() });
        assert.ok(res.status === 403, `${path} -> ${res.status}`);
      }
      const post = await send(h.port, { method: 'TRACE', path: `/r/${h.peerId}/api/projects`, headers: h.auth() });
      assert.equal(post.status, 403);
      assert.equal(h.link.streams.length, 0);
    });
  });

  it('forwards a JSON body intact and in order, then ends the body', async () => {
    await withHarness({}, async (h) => {
      const payload = JSON.stringify({ text: 'a'.repeat(100_000) });
      const pending = send(h.port, {
        method: 'POST',
        path: `/r/${h.peerId}/api/projects/create-project`,
        headers: { ...h.auth(), 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
        body: [Buffer.from(payload.slice(0, 30_000)), Buffer.from(payload.slice(30_000))],
      });
      const stream = await h.nextStream();
      await waitUntil(() => stream.written.some((entry) => entry.fin), 'end of request body');
      assert.equal(Buffer.concat(stream.written.map((entry) => entry.chunk)).toString(), payload);
      stream.respond({ status: 201, headers: { 'content-type': 'application/json' } });
      stream.body('{}', true);
      assert.equal((await pending).status, 201);
    });
  });

  it('streams a chunked upload with no declared length', async () => {
    await withHarness({}, async (h) => {
      const pending = send(h.port, {
        method: 'POST',
        path: `/r/${h.peerId}/api/projects/create-project`,
        headers: { ...h.auth(), 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
        body: [Buffer.from('{"a":'), Buffer.from('1}')],
      });
      const stream = await h.nextStream();
      await waitUntil(() => stream.written.some((entry) => entry.fin), 'end of request body');
      assert.equal(Buffer.concat(stream.written.map((entry) => entry.chunk)).toString(), '{"a":1}');
      const meta = stream.open.kind === 'http' ? stream.open.meta : null;
      assert.equal(meta?.headers['transfer-encoding'], undefined, 'framing is the Host bridge\'s business');
      stream.respond({ status: 200, headers: {} });
      stream.body('', true);
      await pending;
    });
  });

  it('answers 413 at once for a declared length over the limit, and for a streamed body that grows past it', async () => {
    await withHarness({ maxRequestBodyBytes: 1000 }, async (h) => {
      const declared = await send(h.port, {
        method: 'POST',
        path: `/r/${h.peerId}/api/projects/create-project`,
        headers: { ...h.auth(), 'content-type': 'application/json', 'content-length': '5000' },
        body: Buffer.alloc(5000, 1),
      });
      assert.equal(declared.status, 413);
      assert.equal(declared.json<{ error: { code: string } }>().error.code, 'REMOTE_TOO_LARGE');
      assert.equal(h.link.streams.length, 0, 'nothing was opened for an oversized declared body');

      const streaming = await send(h.port, {
        method: 'POST',
        path: `/r/${h.peerId}/api/projects/create-project`,
        headers: { ...h.auth(), 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
        body: [Buffer.alloc(600, 1), Buffer.alloc(600, 1)],
      });
      assert.equal(streaming.status, 413);
      const stream = h.link.streams[0];
      assert.ok(stream.closed, 'the stream was ended');
      assert.equal(stream.failure?.code, 'REMOTE_TOO_LARGE');
    });
  });

  it('the 413 reaches a browser that is still uploading: the refusal does not reset the connection under it', async () => {
    await withHarness({ maxRequestBodyBytes: 1000 }, async (h) => {
      const body = Buffer.alloc(24 * 1024 * 1024, 1);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const refused = await send(h.port, {
          method: 'POST',
          path: `/r/${h.peerId}/api/projects/create-project`,
          headers: { ...h.auth(), 'content-type': 'application/octet-stream' },
          body,
          timeoutMs: 30_000,
        });
        assert.equal(refused.status, 413, `attempt ${attempt}`);
        assert.equal(refused.json<{ error: { code: string } }>().error.code, 'REMOTE_TOO_LARGE');
      }
      assert.equal(h.link.streams.length, 0, 'nothing was opened for an oversized declared body');
    });
  });
});

describe('Controller HTTP proxy: response path', () => {
  it('relays status, filtered headers and the body; Host-controlled headers and cookies are dropped, content is sandboxed', async () => {
    await withHarness({}, async (h) => {
      const pending = send(h.port, { path: `/r/${h.peerId}/api/assets/files/readme`, headers: h.auth() });
      const stream = await h.nextStream();
      stream.respond({
        status: 200,
        headers: {
          'content-type': 'text/html',
          'set-cookie': 'sid=1',
          'x-auth-error': 'session-expired',
          'x-refreshed-token': 'jwt',
          location: 'https://evil.example',
          'access-control-allow-origin': 'https://evil.example',
          'content-disposition': 'attachment; filename="a.html"',
        },
      });
      stream.body('<script>1</script>', true);
      const res = await pending;
      assert.equal(res.status, 200);
      assert.equal(res.text(), '<script>1</script>');
      assert.equal(res.headers['set-cookie'], undefined);
      assert.equal(res.headers['x-auth-error'], undefined);
      assert.equal(res.headers['x-refreshed-token'], undefined);
      assert.equal(res.headers.location, undefined);
      assert.equal(res.headers['access-control-allow-origin'], undefined);
      assert.equal(res.headers['content-disposition'], 'attachment; filename="a.html"');
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.equal(res.headers['content-security-policy'], "sandbox; default-src 'none'");
    });
  });

  it('JSON responses are not sandboxed', async () => {
    await withHarness({}, async (h) => {
      const pending = send(h.port, { path: `/r/${h.peerId}/api/projects`, headers: h.auth() });
      const stream = await h.nextStream();
      stream.respond({ status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
      stream.body('[]', true);
      const res = await pending;
      assert.equal(res.headers['content-security-policy'], undefined);
      assert.deepEqual(res.json(), []);
    });
  });

  it('forwards each SSE chunk as it arrives, without waiting for the end', async () => {
    await withHarness({}, async (h) => {
      const opened = open(h.port, { path: `/r/${h.peerId}/api/projects/events`, headers: { ...h.auth(), accept: 'text/event-stream' } });
      const stream = await h.nextStream();
      stream.respond({ status: 200, headers: { 'content-type': 'text/event-stream' } });
      const { res, status, headers } = await opened;
      assert.equal(status, 200);
      assert.equal(headers['content-type'], 'text/event-stream');

      const received: string[] = [];
      res.on('data', (chunk: Buffer) => received.push(chunk.toString()));
      stream.body('data: one\n\n');
      await waitUntil(() => received.join('').includes('one'), 'first event');
      stream.body('data: two\n\n');
      await waitUntil(() => received.join('').includes('two'), 'second event');
      assert.equal(res.complete, false, 'the response is still open');
      stream.body('', true);
      await waitUntil(() => res.complete, 'end of stream');
    });
  });

  it('maps every mux error code to its HTTP status (contracts section 9) and never sets X-Auth-Error', async () => {
    const expected: Array<[RemoteErrorCode, number]> = [
      ['REMOTE_LINK_DOWN', 503],
      ['REMOTE_FORBIDDEN', 403],
      ['REMOTE_UPSTREAM_AUTH', 502],
      ['REMOTE_QUOTA', 429],
      ['REMOTE_TOO_LARGE', 413],
      ['REMOTE_PROTOCOL', 426],
      ['REMOTE_UNSUPPORTED_MODE', 409],
      ['REMOTE_INTERNAL', 502],
    ];
    await withHarness({}, async (h) => {
      let index = 0;
      for (const [code, status] of expected) {
        const pending = send(h.port, { path: `/r/${h.peerId}/api/projects`, headers: h.auth() });
        const stream = await h.nextStream(index);
        index += 1;
        stream.end({ cause: 'error', origin: 'peer', code, message: 'host says no' });
        const res = await pending;
        assert.equal(res.status, status, code);
        assert.equal(res.json<{ error: { code: string } }>().error.code, code);
        assert.equal(res.headers['x-auth-error'], undefined, code);
      }
    });
  });

  it('a Host 401 (REMOTE_UPSTREAM_AUTH) reaches the tab as 502 with no auth marker', async () => {
    await withHarness({}, async (h) => {
      const pending = send(h.port, { path: `/r/${h.peerId}/api/projects`, headers: h.auth() });
      const stream = await h.nextStream();
      stream.end({ cause: 'error', origin: 'peer', code: 'REMOTE_UPSTREAM_AUTH', message: 'The Host answered 401.' });
      const res = await pending;
      assert.equal(res.status, 502);
      assert.equal(res.headers['x-auth-error'], undefined);
      assert.equal(res.headers['www-authenticate'], undefined);
    });
  });

  it('a response head with status 401 or 403 (a Host that skipped its own bridge) is a 502 REMOTE_UPSTREAM_AUTH, never a 401 for the browser', async () => {
    await withHarness({}, async (h) => {
      for (const [index, status] of [401, 403].entries()) {
        const pending = send(h.port, { path: `/r/${h.peerId}/api/projects`, headers: h.auth() });
        const stream = await h.nextStream(index);
        stream.respond({ status, headers: { 'content-type': 'application/json', 'x-auth-error': 'invalid-token' } });
        const res = await pending;
        assert.equal(res.status, 502, `Host status ${status}`);
        assert.equal(res.json<{ error: { code: string } }>().error.code, 'REMOTE_UPSTREAM_AUTH');
        assert.equal(res.headers['x-auth-error'], undefined);
      }
    });
  });

  it('a link that goes down before the response head is a 503; after the head the response is cut', async () => {
    await withHarness({}, async (h) => {
      const early = send(h.port, { path: `/r/${h.peerId}/api/projects`, headers: h.auth() });
      const first = await h.nextStream();
      first.end({ cause: 'link-down', reason: 'peer-down' });
      const res = await early;
      assert.equal(res.status, 503);
      assert.equal(res.json<{ error: { code: string } }>().error.code, 'REMOTE_LINK_DOWN');

      const opened = open(h.port, { path: `/r/${h.peerId}/api/projects/events`, headers: h.auth() });
      const second = await h.nextStream(1);
      second.respond({ status: 200, headers: { 'content-type': 'text/event-stream' } });
      const { res: late } = await opened;
      const aborted = new Promise<void>((resolve) => late.on('error', () => resolve()).on('close', () => resolve()));
      second.body('data: x\n\n');
      second.end({ cause: 'link-down', reason: 'peer-down' });
      await aborted;
      assert.equal(late.complete, false, 'a cut stream must not look like a finished one');
    });
  });

  it('refuses a response body that arrives before the head and a status below 200', async () => {
    await withHarness({}, async (h) => {
      const bodyFirst = send(h.port, { path: `/r/${h.peerId}/api/projects`, headers: h.auth() });
      const first = await h.nextStream();
      first.body('surprise');
      const res = await bodyFirst;
      assert.equal(res.status, 502);
      assert.ok(first.closed);

      const informational = send(h.port, { path: `/r/${h.peerId}/api/projects`, headers: h.auth() });
      const second = await h.nextStream(1);
      second.respond({ status: 101, headers: {} });
      assert.equal((await informational).status, 502);
    });
  });
});

describe('Controller HTTP proxy: link state', () => {
  it('is 503 REMOTE_LINK_DOWN while the session is down and when no relay secret is saved', async () => {
    await withHarness({ online: false }, async (h) => {
      const res = await send(h.port, { path: `/r/${h.peerId}/api/projects`, headers: h.auth() });
      assert.equal(res.status, 503);
      assert.equal(res.json<{ error: { code: string } }>().error.code, 'REMOTE_LINK_DOWN');
      assert.equal(h.link.streams.length, 0);
    });
    await withHarness({ secret: null }, async (h) => {
      const res = await send(h.port, { path: `/r/${h.peerId}/api/projects`, headers: h.auth() });
      assert.equal(res.status, 503);
    });
  });

  it('opening a stream on a link that dropped in between is 503 too', async () => {
    await withHarness({}, async (h) => {
      h.link.onOpen = () => {
        throw new RemoteLinkDownError();
      };
      const res = await send(h.port, { path: `/r/${h.peerId}/api/projects`, headers: h.auth() });
      assert.equal(res.status, 503);
    });
  });
});

describe('Controller HTTP proxy: limits and cleanup', () => {
  it('cancels the stream when the Host sends faster than the browser reads (receive budget) with REMOTE_QUOTA', async () => {
    await withHarness({ receiveBudgetBytes: 256 * 1024 }, async (h) => {
      const opened = open(h.port, { path: `/r/${h.peerId}/api/assets/files/big`, headers: h.auth() });
      const stream = await h.nextStream();
      stream.respond({ status: 200, headers: { 'content-type': 'application/octet-stream' } });
      const { res } = await opened;
      res.pause(); // a browser that stopped reading
      const chunk = Buffer.alloc(64 * 1024, 7);
      for (let i = 0; i < 400 && !stream.closed; i += 1) {
        stream.body(chunk);
        if (i % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      }
      assert.ok(stream.closed, 'the stream was ended once the unread bytes passed the budget');
      assert.equal(stream.failure?.code, 'REMOTE_QUOTA');
      res.destroy();
    });
  });

  it('cancels the stream when the browser goes away mid-response', async () => {
    await withHarness({}, async (h) => {
      const opened = open(h.port, { path: `/r/${h.peerId}/api/projects/events`, headers: h.auth() });
      const stream = await h.nextStream();
      stream.respond({ status: 200, headers: { 'content-type': 'text/event-stream' } });
      const { res } = await opened;
      res.destroy();
      await waitUntil(() => stream.closed, 'stream cancelled after the client left');
      assert.ok(stream.calls.includes('cancel'));
    });
  });

  it('ends open streams when the registry closes its connections (forget, auth epoch) and untracks finished requests', async () => {
    await withHarness({}, async (h) => {
      const opened = open(h.port, { path: `/r/${h.peerId}/api/projects/events`, headers: h.auth() });
      const stream = await h.nextStream();
      stream.respond({ status: 200, headers: { 'content-type': 'text/event-stream' } });
      const { res } = await opened;
      const gone = new Promise<void>((resolve) => res.on('close', () => resolve()));
      assert.equal(h.registry.closeConnections(), 1);
      await gone;
      assert.ok(stream.calls.includes('cancel'));

      // A request that completed normally is no longer tracked.
      const done = send(h.port, { path: `/r/${h.peerId}/api/projects`, headers: h.auth() });
      const second = await h.nextStream(1);
      second.respond({ status: 200, headers: { 'content-type': 'application/json' } });
      second.body('{}', true);
      await done;
      assert.equal(h.registry.closeConnections(), 0);
    });
  });

  it('pauses reading the browser body while the stream cannot take more (backpressure) and resumes it', async () => {
    await withHarness({}, async (h) => {
      h.link.autoPauseAfterBytes = 200_000; // like a mux queue that filled up
      const pending = open(h.port, {
        method: 'POST',
        path: `/r/${h.peerId}/api/projects/create-project`,
        headers: { ...h.auth(), 'content-type': 'application/json', 'content-length': String(3 * 1024 * 1024) },
        body: Buffer.alloc(3 * 1024 * 1024, 2),
      });
      const stream = await h.nextStream();
      await waitUntil(() => stream.paused, 'the stream to pause');
      await new Promise((resolve) => setTimeout(resolve, 50));
      const frozen = stream.written.length;
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(stream.written.length, frozen, 'nothing more is read while paused');
      assert.ok(!stream.written.some((entry) => entry.fin));
      stream.resumeWrites();
      await waitUntil(() => stream.written.some((entry) => entry.fin), 'end of body after resume');
      assert.equal(stream.written.reduce((sum, entry) => sum + entry.chunk.length, 0), 3 * 1024 * 1024);
      stream.respond({ status: 200, headers: {} });
      stream.body('', true);
      const { res } = await pending;
      res.resume();
    });
  });
});

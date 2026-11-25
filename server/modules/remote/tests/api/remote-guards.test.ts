/**
 * Transport guards of the management API (contracts section 2, NFR-7), exercised with the real auth
 * middleware, the real `verifyPassword` and a throwaway database: JSON only, same-origin only, 4 KB
 * body ceiling, full JWT only (a tab token is refused), and the password re-check of sensitive endpoints.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import express from 'express';
import { getSessionRuntime } from '@/modules/auth/index.js';

import { authenticateToken, issueTabToken, validateApiKey, verifyPassword } from '@/modules/auth/index.js';

import { remoteErrorHandler } from '../../api/remote-api-errors.js';
import { createManagementGuards } from '../../api/remote-guards.js';
import { TEST_PASSWORD as PASSWORD, createTestAccount } from '../support/auth-test-session.js';
import { send, serve } from '../support/http-test-client.js';
import { withTempDatabase } from '../support/temp-database.js';

const withGuardedApp = async (
  run: (ctx: { port: number; jwt: string; tabToken: string; passwords: string[] }) => Promise<void>,
): Promise<void> =>
  withTempDatabase(async () => {
    const user = await createTestAccount();
    const passwords: string[] = [];
    const guards = createManagementGuards({
      authenticateToken,
      validateApiKey,
      verifyPassword: (userId, password, clientIp) => {
        passwords.push(password);
        return verifyPassword(userId, password, clientIp);
      },
    });

    const app = express();
    app.use('/api/remote', ...guards.chain);
    app.get('/api/remote/ping', (req, res) => res.json({ ok: true, user: (req as unknown as { user: { username: string } }).user.username }));
    app.post('/api/remote/echo', (req, res) => res.json({ body: req.body }));
    app.post('/api/remote/sensitive', guards.requirePassword, (req, res) => res.json({ ok: true, bodyKeys: Object.keys(req.body) }));
    app.use(remoteErrorHandler);
    const running = await serve(app);
    try {
      await run({
        port: running.port,
        jwt: user.jwt,
        tabToken: issueTabToken({ sessionId: getSessionRuntime().store.authenticate(user.jwt)!.id, userId: user.id, username: user.username, peerId: 'peer-1' }),
        passwords,
      });
    } finally {
      await running.close();
    }
  });

const json = (token: string | null, extra: Record<string, string> = {}): Record<string, string> => ({
  'content-type': 'application/json',
  'x-remotecli-request': '1',
  'sec-fetch-site': 'same-origin',
  ...(token ? { cookie: `remotecli_session=${token}` } : {}),
  ...extra,
});

describe('management API guards', () => {
  it('C-02/C-03: accepts a session cookie on a same-origin JSON request', async () => {
    await withGuardedApp(async ({ port, jwt }) => {
      const res = await send(port, { path: '/api/remote/ping', headers: json(jwt) });
      assert.equal(res.status, 200);
      assert.match(res.json<{ user: string }>().user, /^account\d+$/);
    });
  });

  it('refuses a request without credentials, with a bad token, and with the token in the query string', async () => {
    await withGuardedApp(async ({ port, jwt }) => {
      assert.equal((await send(port, { path: '/api/remote/ping', headers: json(null) })).status, 401);
      assert.equal((await send(port, { path: '/api/remote/ping', headers: json('nonsense') })).status, 401);
      // The token must travel in the Authorization header: a URL ends up in logs and history.
      assert.equal((await send(port, { path: `/api/remote/ping?token=${jwt}`, headers: json(null) })).status, 401);
    });
  });

  it('refuses a tab token on every management route (AC-33)', async () => {
    await withGuardedApp(async ({ port, tabToken }) => {
      const get = await send(port, { path: '/api/remote/ping', headers: json(tabToken) });
      assert.equal(get.status, 401);
      const post = await send(port, { method: 'POST', path: '/api/remote/echo', headers: json(tabToken), body: '{}' });
      assert.equal(post.status, 401);
    });
  });

  it('refuses a write without Content-Type: application/json with 415', async () => {
    await withGuardedApp(async ({ port, jwt }) => {
      const missing = await send(port, { method: 'POST', path: '/api/remote/echo', headers: { cookie: `remotecli_session=${jwt}`, 'x-remotecli-request': '1', 'sec-fetch-site': 'same-origin' }, body: '{}' });
      assert.equal(missing.status, 415);
      const wrong = await send(port, { method: 'POST', path: '/api/remote/echo', headers: json(jwt, { 'content-type': 'text/plain' }), body: '{}' });
      assert.equal(wrong.status, 415);
      assert.equal(wrong.json<{ code: string }>().code, 'AUTH_UNSUPPORTED_MEDIA');
      const form = await send(port, {
        method: 'POST',
        path: '/api/remote/echo',
        headers: json(jwt, { 'content-type': 'application/x-www-form-urlencoded' }),
        body: 'a=1',
      });
      assert.equal(form.status, 415);
    });
  });

  it('refuses a cross-site or same-site browser request with 403 and lets same-origin and direct requests through', async () => {
    await withGuardedApp(async ({ port, jwt }) => {
      for (const site of ['cross-site', 'same-site', 'none']) {
        const res = await send(port, { path: '/api/remote/ping', headers: json(jwt, { 'sec-fetch-site': site }) });
        assert.equal(res.status, 403, site);
        assert.equal(res.json<{ code: string }>().code, 'AUTH_REQUEST_FORBIDDEN');
      }
      for (const site of ['same-origin']) {
        assert.equal((await send(port, { path: '/api/remote/ping', headers: json(jwt, { 'sec-fetch-site': site }) })).status, 200, site);
      }
    });
  });

  it('without Sec-Fetch-Site, an Origin that is not this server is refused', async () => {
    await withGuardedApp(async ({ port, jwt }) => {
      const foreign = await send(port, { path: '/api/remote/ping', headers: json(jwt, { origin: 'https://evil.example', host: `127.0.0.1:${port}` }) });
      assert.equal(foreign.status, 403);
      const opaque = await send(port, { path: '/api/remote/ping', headers: json(jwt, { origin: 'null', host: `127.0.0.1:${port}` }) });
      assert.equal(opaque.status, 403, 'a sandboxed frame (origin "null") is never the management UI');
      const own = await send(port, { path: '/api/remote/ping', headers: json(jwt, { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` }) });
      assert.equal(own.status, 200);
    });
  });

  it('refuses a body over 4 KB with 413 and a JSON error, and accepts one just under it', async () => {
    await withGuardedApp(async ({ port, jwt }) => {
      const big = JSON.stringify({ pad: 'x'.repeat(5 * 1024) });
      const res = await send(port, { method: 'POST', path: '/api/remote/echo', headers: json(jwt), body: big });
      assert.equal(res.status, 413);
      assert.equal(res.json<{ error: { code: string } }>().error.code, 'REMOTE_TOO_LARGE');
      const small = JSON.stringify({ pad: 'x'.repeat(3 * 1024) });
      assert.equal((await send(port, { method: 'POST', path: '/api/remote/echo', headers: json(jwt), body: small })).status, 200);
    });
  });

  it('does not read the body of an unauthenticated request', async () => {
    await withGuardedApp(async ({ port }) => {
      const res = await send(port, { method: 'POST', path: '/api/remote/echo', headers: json(null), body: JSON.stringify({ pad: 'x'.repeat(6000) }) });
      assert.equal(res.status, 401, 'authentication comes before the parser');
    });
  });

  it('answers malformed JSON with 400', async () => {
    await withGuardedApp(async ({ port, jwt }) => {
      const res = await send(port, { method: 'POST', path: '/api/remote/echo', headers: json(jwt), body: '{nope' });
      assert.equal(res.status, 400);
      assert.equal(res.json<{ error: { code: string } }>().error.code, 'REMOTE_BAD_REQUEST');
    });
  });

  it('treats a body-less POST (empty body, JSON content type) as an empty object', async () => {
    await withGuardedApp(async ({ port, jwt }) => {
      const res = await send(port, { method: 'POST', path: '/api/remote/echo', headers: json(jwt) });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json(), { body: {} });
    });
  });

  it('a sensitive endpoint without a password is refused with 401 and never calls verifyPassword', async () => {
    await withGuardedApp(async ({ port, jwt, passwords }) => {
      for (const body of ['{}', JSON.stringify({ password: '' }), JSON.stringify({ password: 42 })]) {
        const res = await send(port, { method: 'POST', path: '/api/remote/sensitive', headers: json(jwt), body });
        assert.equal(res.status, 401);
        assert.equal(res.json<{ error: { code: string } }>().error.code, 'AUTH_PASSWORD_REQUIRED');
        assert.equal(res.headers['x-auth-error'], undefined, 'a missing password must not end the Local session');
      }
      assert.deepEqual(passwords, []);
    });
  });

  it('a wrong password is 403 AUTH_INVALID_CREDENTIALS (not 401, which clients read as session end) and the handler never runs', async () => {
    await withGuardedApp(async ({ port, jwt }) => {
      const res = await send(port, { method: 'POST', path: '/api/remote/sensitive', headers: json(jwt), body: JSON.stringify({ password: 'wrong' }) });
      assert.equal(res.status, 403);
      assert.equal(res.json<{ error: { code: string } }>().error.code, 'AUTH_INVALID_CREDENTIALS');
      assert.equal(res.headers['x-auth-error'], undefined);
    });
  });

  it('wrong passwords count toward the login limiter: the fifth locks with 429 AUTH_RATE_LIMITED and Retry-After, even for the right password', async () => {
    await withGuardedApp(async ({ port, jwt }) => {
      const wrong = JSON.stringify({ password: 'wrong' });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const res = await send(port, { method: 'POST', path: '/api/remote/sensitive', headers: json(jwt), body: wrong });
        assert.equal(res.status, 403, `attempt ${attempt + 1}`);
      }
      const locked = await send(port, { method: 'POST', path: '/api/remote/sensitive', headers: json(jwt), body: JSON.stringify({ password: PASSWORD }) });
      assert.equal(locked.status, 429);
      assert.equal(locked.json<{ error: { code: string } }>().error.code, 'AUTH_RATE_LIMITED');
      assert.ok(Number(locked.headers['retry-after']) > 0);
    });
  });

  it('the right password reaches the handler, which never sees the password', async () => {
    await withGuardedApp(async ({ port, jwt }) => {
      const res = await send(port, {
        method: 'POST',
        path: '/api/remote/sensitive',
        headers: json(jwt),
        body: JSON.stringify({ password: PASSWORD, extra: 1 }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json(), { ok: true, bodyKeys: ['extra'] });
    });
  });

  it('passes the client address to verifyPassword so lockouts are per address', async () => {
    await withTempDatabase(async () => {
      const seen: string[] = [];
      const guards = createManagementGuards({
        authenticateToken: (req, _res, next) => {
          (req as unknown as { user: unknown }).user = { id: 1, username: 'alice' };
          next();
        },
        validateApiKey: (_req, _res, next) => next(),
        verifyPassword: async (_userId, _password, clientIp) => {
          seen.push(clientIp);
          return true;
        },
      });
      const app = express();
      app.use(...guards.chain);
      app.post('/s', guards.requirePassword, (_req, res) => res.json({ ok: true }));
      const running = await serve(app);
      try {
        await send(running.port, { method: 'POST', path: '/s', headers: json('x'), body: JSON.stringify({ password: 'p' }) });
        assert.equal(seen.length, 1);
        assert.match(seen[0], /127\.0\.0\.1/);
      } finally {
        await running.close();
      }
    });
  });

  it('an API_KEY configured on the server is still required (parity with every other /api route)', async () => {
    const previous = process.env.API_KEY;
    process.env.API_KEY = 'shared-key';
    try {
      await withGuardedApp(async ({ port, jwt }) => {
        assert.equal((await send(port, { path: '/api/remote/ping', headers: json(jwt) })).status, 401);
        assert.equal((await send(port, { path: '/api/remote/ping', headers: json(jwt, { 'x-api-key': 'shared-key' }) })).status, 200);
      });
    } finally {
      if (previous === undefined) delete process.env.API_KEY;
      else process.env.API_KEY = previous;
    }
  });
});

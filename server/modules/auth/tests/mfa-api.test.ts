import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

import express from 'express';
import { TOTP } from 'otpauth';

import { AppError } from '../../../shared/utils.js';
import { getConnection } from '../../database/index.js';
import { authRoutes } from '../auth.module.js';
import { authenticateToken } from '../auth.middleware.js';
import { createApiSessionGuard } from '../services/api-session-guard.service.js';
import { getSessionRuntime } from '../services/session-runtime.service.js';

import { withIsolatedAuthDatabase } from './with-isolated-auth-database.js';

const bcrypt = createRequire(import.meta.url)('bcryptjs');
const password = 'synthetic-owner-password';
const otp = (secret: string) => new TOTP({ secret }).generate({ timestamp: Date.now() });
async function fixture(run: (base: string) => Promise<void>) {
  const old = process.env.REMOTECLI_MASTER_KEY;
  try {
    process.env.REMOTECLI_MASTER_KEY = randomBytes(32).toString('base64');
    await withIsolatedAuthDatabase(async (user) => {
      getConnection().prepare('UPDATE users SET password_hash=? WHERE id=?').run(await bcrypt.hash(password, 4), user.id);
      const app = express();
      app.use('/api', createApiSessionGuard(authenticateToken)); app.use(express.json());
      app.use('/api/auth', authRoutes);
      app.get('/api/private', (_req, res) => res.json({ ok: true }));
      app.post('/api/settings/api-keys', (_req, res) => res.json({ ok: true }));
      app.post('/api/remote/peers/join', (_req, res) => res.json({ ok: true }));
      app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        const known = error instanceof AppError;
        res.status(known ? error.statusCode : 500).json({ code: known ? error.code : 'INTERNAL' });
      });
      const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
      try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
      finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    });
  } finally {
    if (old === undefined) delete process.env.REMOTECLI_MASTER_KEY; else process.env.REMOTECLI_MASTER_KEY = old;
  }
}
function request(base: string, path: string, body?: unknown, cookie?: string, method = body === undefined ? 'GET' : 'POST') {
  return fetch(base + '/api' + path, { method,
    headers: { Origin: base, 'X-RemoteCLI-Request': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const cookieOf = (response: Response) => response.headers.get('set-cookie')?.split(';', 1)[0];
async function login(base: string) {
  const response = await request(base, '/auth/login', { username: 'alice', password });
  assert.equal(response.status, 200); return response;
}
async function enroll(base: string, cookie: string) {
  const response = await request(base, '/auth/mfa/enroll', { password }, cookie);
  assert.equal(response.status, 200);
  const enrollment = await response.json();
  const activation = await request(base, '/auth/mfa/activate', { code: otp(enrollment.secret) }, cookie);
  assert.equal(activation.status, 200);
  return { ...enrollment, ...await activation.json() } as { secret: string; recoveryCodes: string[] };
}

test('A-01/A-02/A-04/K-02/K-08: password alone issues no MFA session; two simultaneous code submissions issue exactly one', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  await fixture(async base => {
    const a = cookieOf(await login(base))!, b = cookieOf(await login(base))!;
    const e = await enroll(base, a);
    assert.equal((await request(base, '/private', undefined, b)).status, 401);
    t.mock.timers.tick(30_000);
    const response = await login(base);
    assert.equal(cookieOf(response), undefined);
    const body = await response.json(); assert.equal(body.user, undefined); assert.equal(body.token, undefined);
    assert.equal((await request(base, '/private', undefined, `remotecli_session=${body.challenge}`)).status, 401);
    const otherChallenge = await (await login(base)).json();
    const responses = await Promise.all([body.challenge, otherChallenge.challenge].map(challenge => request(base, '/auth/mfa/verify', { challenge, code: otp(e.secret) })));
    assert.deepEqual(responses.map(r => r.status).sort(), [200,403]);
    const cookie = cookieOf(responses.find(r => r.status === 200)!)!;
    assert.ok(cookie && cookie !== a);
    assert.equal((await request(base, '/private', undefined, cookie)).status, 200);
    assert.equal((await request(base, '/auth/user', undefined, cookie)).status, 200, 'reload does not need another OTP');
  });
});

test('T-06/K-09: two simultaneous logins cannot consume one recovery code twice', async () => {
  await fixture(async base => {
    const a = cookieOf(await login(base))!; const e = await enroll(base, a);
    const challenges = await Promise.all([login(base),login(base)]).then(rs => Promise.all(rs.map(r => r.json())));
    const replies = await Promise.all(challenges.map(c => request(base, '/auth/mfa/verify', { challenge: c.challenge, code: e.recoveryCodes[0], recovery: true })));
    assert.deepEqual(replies.map(r => r.status).sort(), [200,403]);
    const cookie = cookieOf(replies.find(r => r.status === 200)!)!;
    assert.equal((await request(base, '/settings/api-keys', {}, cookie)).status, 403, 'recovery is not fresh TOTP');
  });
});

test('C-09/K-10: sensitive operations require reauthentication at ten minutes; activation requires a fresh password', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  await fixture(async base => {
    const a = cookieOf(await login(base))!;
    assert.equal((await request(base, '/auth/mfa/enroll', { password: 'wrong' }, a)).status, 403);
    const e = await enroll(base, a);
    t.mock.timers.tick(599_999);
    assert.equal((await request(base, '/settings/api-keys', {}, a)).status, 200);
    t.mock.timers.tick(1);
    for (const path of ['/settings/api-keys','/remote/peers/join','/REMOTE/PEERS/JOIN','/auth/mfa/disable','/auth/mfa/recovery-codes']) {
      assert.equal((await request(base, path, {}, a)).status, 403, path);
    }
    const reauth = await request(base, '/auth/mfa/reauth', { code: otp(e.secret) }, a);
    assert.equal(reauth.status, 200);
    assert.equal((await request(base, '/settings/api-keys', {}, a)).status, 200);
    assert.equal((await request(base, '/remote/peers/join', {}, a)).status, 200);
  });
});

test('T-08/T-10/K-24: password change and disabling MFA preserve this session and revoke others', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  await fixture(async base => {
    const a = cookieOf(await login(base))!; const e = await enroll(base, a); t.mock.timers.tick(30_000);
    const challenge = await (await login(base)).json();
    const b = cookieOf(await request(base, '/auth/mfa/verify', { challenge: challenge.challenge, code: otp(e.secret) }))!;
    const changed = await request(base, '/auth/password', { password, newPassword: 'synthetic-new-owner-password' }, a);
    assert.equal(changed.status, 200);
    assert.equal((await request(base, '/private', undefined, a)).status, 200);
    assert.equal((await request(base, '/private', undefined, b)).status, 401);
    const { store } = getSessionRuntime();
    const other = store.create(1, '', Date.now());
    getConnection().prepare('UPDATE auth_sessions SET locked_at=1 WHERE id=?').run(other.session.id);
    assert.equal((await request(base, '/auth/mfa/disable', {}, a)).status, 200);
    assert.equal(store.authenticate(other.secret), null);
    assert.equal((await request(base, '/private', undefined, a)).status, 200);
    const newLogin = await request(base, '/auth/login', { username: 'alice', password: 'synthetic-new-owner-password' });
    assert.ok(cookieOf(newLogin));
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';

import jwt from 'jsonwebtoken';

import { authenticateToken, authenticateWebSocket, getJwtSecret } from '../auth.middleware.js';
import { issueLoopbackToken } from '../services/remote-token.service.js';
import { authenticateLoopback } from '../services/loopback-token.service.js';

import { runAuthenticateToken, withIsolatedAuthDatabase } from './with-isolated-auth-database.js';

test('H-01/H-02/K-14: typed process-local bridge credentials live at most five minutes', async () => {
  await withIsolatedAuthDatabase((user) => {
    const token = issueLoopbackToken();
    const claims = jwt.decode(token) as jwt.JwtPayload;
    assert.equal(claims.typ, 'host-loopback');
    assert.equal(claims.userId, user.id);
    assert.ok(claims.exp! - claims.iat! <= 300);
    assert.notEqual(token, issueLoopbackToken());
    assert.throws(() => jwt.verify(token, getJwtSecret()));
    const legacy = jwt.sign({ typ: 'host-loopback', userId: user.id }, getJwtSecret(), { expiresIn: 300 });
    assert.equal(authenticateLoopback(legacy, '127.0.0.1'), null);
  });
});

test('H-03/H-04/K-14: bridge bearer works on loopback without Origin, never from a remote address', async () => {
  await withIsolatedAuthDatabase(async (user) => {
    const token = issueLoopbackToken();
    const result = await runAuthenticateToken(authenticateToken, token);
    assert.equal(result.accepted, true);
    assert.equal(result.headers['x-refreshed-token'], undefined);
    const req = { headers: { authorization: `Bearer ${token}` }, socket: { remoteAddress: '127.0.0.1' } };
    assert.equal(authenticateWebSocket(req)?.userId, user.id);
    assert.equal(authenticateWebSocket({ ...req, socket: { remoteAddress: '192.0.2.10' } }), null);
  });
});

test('H-02/H-05: bridge expiry uses the server clock and cannot be refreshed', async (t) => {
  await withIsolatedAuthDatabase(() => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const token = issueLoopbackToken();
    t.mock.timers.tick(300_000);
    assert.equal(authenticateLoopback(token, '::1'), null);
    t.mock.timers.reset();
  });
});

test('H-04: bridge requires an existing active account', async () => {
  await withIsolatedAuthDatabase(async () => {
    const token = issueLoopbackToken();
    const { getConnection } = await import('../../database/index.js');
    getConnection().prepare('DELETE FROM users').run();
    assert.equal(authenticateLoopback(token, '127.0.0.1'), null);
    assert.throws(() => issueLoopbackToken(), /no user/i);
  });
});

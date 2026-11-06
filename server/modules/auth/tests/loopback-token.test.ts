import assert from 'node:assert/strict';
import test from 'node:test';

import jwt from 'jsonwebtoken';

import { authenticateToken, authenticateWebSocket, generateToken } from '../auth.middleware.js';
import { issueLoopbackToken } from '../services/remote-token.service.js';

import { runAuthenticateToken, withIsolatedAuthDatabase } from './with-isolated-auth-database.js';

test('a loopback token is an ordinary JWT that lives at most 5 minutes', async () => {
  await withIsolatedAuthDatabase((user) => {
    const claims = jwt.decode(issueLoopbackToken()) as Record<string, number | string>;

    assert.equal(claims.userId, user.id);
    assert.equal(claims.username, 'alice');
    assert.equal(claims.typ, undefined, 'no special typ: the stock middleware must accept it as is');
    assert.ok((claims.exp as number) - (claims.iat as number) <= 300);
  });
});

test('every call returns a different token, even within the same second', async () => {
  await withIsolatedAuthDatabase(() => {
    const tokens = new Set(Array.from({ length: 20 }, () => issueLoopbackToken()));
    assert.equal(tokens.size, 20);
  });
});

test('the real authenticateToken and authenticateWebSocket accept a loopback token', async () => {
  await withIsolatedAuthDatabase(async () => {
    const token = issueLoopbackToken();

    const rest = await runAuthenticateToken(authenticateToken, token);
    assert.equal(rest.accepted, true);
    assert.equal(rest.user?.username, 'alice');
    assert.equal(authenticateWebSocket(token)?.username, 'alice');
  });
});

test('an aged loopback token is never swapped for a 7 day token via X-Refreshed-Token', async () => {
  await withIsolatedAuthDatabase(async (user) => {
    const realNow = Date.now;
    try {
      const loopback = issueLoopbackToken();
      const ordinary = generateToken(user);
      Date.now = () => realNow() + 200_000; // past the 150 s half-life of a 5 minute token

      const loopbackResult = await runAuthenticateToken(authenticateToken, loopback);
      assert.equal(loopbackResult.accepted, true, 'still valid');
      assert.equal(loopbackResult.headers['x-refreshed-token'], undefined);

      // Control: ordinary tokens past half-life are still refreshed as before (7 day token, so
      // age it beyond 3.5 days).
      Date.now = () => realNow() + 4 * 24 * 3600 * 1000;
      const ordinaryResult = await runAuthenticateToken(authenticateToken, ordinary);
      assert.equal(ordinaryResult.accepted, true);
      assert.ok(ordinaryResult.headers['x-refreshed-token'], 'ordinary auto-refresh unchanged');
    } finally {
      Date.now = realNow;
    }
  });
});

test('issuing a loopback token fails loudly when there is no user yet', async () => {
  await withIsolatedAuthDatabase(async () => {
    const { getConnection } = await import('@/modules/database/index.js');
    getConnection().prepare('DELETE FROM users').run();

    assert.throws(() => issueLoopbackToken(), /no user/i);
  });
});

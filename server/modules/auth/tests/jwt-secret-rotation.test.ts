import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';
import { userDb } from '@/modules/database/index.js';
import { getSessionRuntime } from '../services/session-runtime.service.js';

import {
  authenticateToken,
  authenticateWebSocket,
  generateToken,
  rotateJwtSecret,
} from '../auth.middleware.js';
import { createAuthService } from '../auth.service.js';
import { bumpAuthEpoch, getAuthEpoch, onAuthEpochChange } from '../services/auth-epoch.service.js';
import { createLoginRateLimiter } from '../services/login-rate-limit.service.js';
import {
  issueLoopbackToken,
  issueTabToken,
  verifyTabToken,
} from '../services/remote-token.service.js';

import { runAuthenticateToken, withIsolatedAuthDatabase } from './with-isolated-auth-database.js';

/** The real service wired to the real secret/epoch functions; only bcrypt is replaced. */
function createRealisticService() {
  return createAuthService({
    users: {
      hasUsers: () => userDb.hasUsers(),
      createUser: (username, passwordHash) => userDb.createUser(username, passwordHash),
      getUserByUsername: (username) => userDb.getUserByUsername(username),
      updateLastLogin: (userId) => userDb.updateLastLogin(userId),
    },
    transaction: { begin: () => undefined, commit: () => undefined, rollback: () => undefined },
    hashPassword: async (password) => `hash:${password}`,
    comparePassword: async (password, hash) => hash === `hash:${password}`,
    generateToken,
    loginLimiter: createLoginRateLimiter(),
    dummyPasswordHash: 'hash:dummy',
    getSetupToken: () => undefined,
    revokeSessions: (userId) => getSessionRuntime().store.revokeAll(userId),
    bumpAuthEpoch,
  });
}

test('K-11: signing-key rotation leaves cookie sessions and process-local bridge credentials independent', async () => {
  await withIsolatedAuthDatabase((user) => {
    const { store } = getSessionRuntime();
    const { secret, session } = store.create(user.id);
    const tab = issueTabToken({ userId: user.id, username: user.username, peerId: 'peer-1', sessionId: session.id });
    const bridge = issueLoopbackToken();
    assert.deepEqual(rotateJwtSecret(), { rotated: true });
    assert.ok(store.authenticate(secret));
    assert.equal(verifyTabToken(tab, 'peer-1').ok, false);
    assert.ok(authenticateWebSocket({ headers: { authorization: `Bearer ${bridge}` }, socket: { remoteAddress: '127.0.0.1' } }));
  });
});

for (const pinned of [false, true]) {
  test(`K-11: logout-all revokes sessions and tab tokens with pinned signing key = ${pinned}`, async () => {
    await withIsolatedAuthDatabase(async (user) => {
      const { getConnection } = await import('../../database/index.js');
      getConnection().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run('hash:correct-horse-battery', user.id);
      if (pinned) process.env.JWT_SECRET = 'synthetic-pinned-key';
      const { store } = getSessionRuntime();
      const a = store.create(user.id), b = store.create(user.id);
      const tab = issueTabToken({ userId: user.id, username: user.username, peerId: 'peer-1', sessionId: a.session.id });
      const result = await createRealisticService().logoutAll(user, 'correct-horse-battery');
      assert.deepEqual(result, { success: true, revoked: 2 });
      assert.equal(store.authenticate(a.secret), null);
      assert.equal(store.authenticate(b.secret), null);
      assert.equal(verifyTabToken(tab, 'peer-1').ok, false);
    });
  });
}

test('K-20: migrated auth epoch increments by one and listeners can unsubscribe', async () => {
  await withIsolatedAuthDatabase(() => {
    getSessionRuntime();
    const initial = getAuthEpoch();
    assert.equal(initial, 1);
    const seen: number[] = [];
    const stop = onAuthEpochChange((epoch) => seen.push(epoch));

    assert.equal(bumpAuthEpoch(), initial + 1);
    stop();
    assert.equal(bumpAuthEpoch(), initial + 2);

    assert.deepEqual(seen, [initial + 1]);
    assert.equal(getAuthEpoch(), initial + 2);
  });
});

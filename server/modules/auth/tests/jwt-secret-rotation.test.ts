import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';
import { userDb } from '@/modules/database/index.js';

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
    rotateJwtSecret,
    bumpAuthEpoch,
  });
}

test('rotating the secret kills ordinary, tab and loopback tokens; new tokens work', async () => {
  await withIsolatedAuthDatabase(async (user) => {
    const ordinary = generateToken(user);
    const tab = issueTabToken({ userId: user.id, username: user.username, peerId: 'peer-1' });
    const loopback = issueLoopbackToken();
    assert.equal((await runAuthenticateToken(authenticateToken, ordinary)).accepted, true, 'control');

    assert.deepEqual(rotateJwtSecret(), { rotated: true });

    assert.equal((await runAuthenticateToken(authenticateToken, ordinary)).accepted, false);
    assert.equal((await runAuthenticateToken(authenticateToken, loopback)).accepted, false);
    assert.equal(authenticateWebSocket(ordinary), null);
    assert.equal(verifyTabToken(tab, 'peer-1').ok, false);

    assert.equal((await runAuthenticateToken(authenticateToken, generateToken(user))).accepted, true);
    assert.equal(
      verifyTabToken(issueTabToken({ userId: user.id, username: user.username, peerId: 'peer-1' }), 'peer-1').ok,
      true,
    );
  });
});

test('the rotated secret is persisted, not just cached', async () => {
  await withIsolatedAuthDatabase(async (user) => {
    rotateJwtSecret();
    const token = generateToken(user);

    const { invalidateJwtSecretCache } = await import('../auth.middleware.js');
    invalidateJwtSecretCache();

    assert.equal((await runAuthenticateToken(authenticateToken, token)).accepted, true);
  });
});

test('logoutAll through the real wiring: epoch +1, listener called once, old tokens dead', async () => {
  await withIsolatedAuthDatabase(async (user) => {
    const { getConnection } = await import('@/modules/database/index.js');
    getConnection().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run('hash:correct-horse-battery', user.id);

    const service = createRealisticService();
    const ordinary = generateToken(user);
    const tab = issueTabToken({ userId: user.id, username: user.username, peerId: 'peer-1' });
    const epochBefore = getAuthEpoch();
    const seen: number[] = [];
    const stop = onAuthEpochChange((epoch) => seen.push(epoch));

    const result = await service.logoutAll({ id: user.id, username: 'alice' }, 'correct-horse-battery', '10.0.0.1');
    stop();

    assert.deepEqual(result, { success: true, rotated: true });
    assert.equal(getAuthEpoch(), epochBefore + 1);
    assert.deepEqual(seen, [epochBefore + 1]);
    assert.equal((await runAuthenticateToken(authenticateToken, ordinary)).accepted, false);
    assert.equal(verifyTabToken(tab, 'peer-1').ok, false);
  });
});

test('with JWT_SECRET pinned by env: epoch still bumps and tab tokens die, ordinary JWTs survive, response is 409', async () => {
  await withIsolatedAuthDatabase(async (user) => {
    const { getConnection } = await import('@/modules/database/index.js');
    getConnection().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run('hash:correct-horse-battery', user.id);
    process.env.JWT_SECRET = 'pinned-secret-for-this-test-only';

    const service = createRealisticService();
    const ordinary = generateToken(user);
    const tab = issueTabToken({ userId: user.id, username: user.username, peerId: 'peer-1' });
    const epochBefore = getAuthEpoch();
    const seen: number[] = [];
    const stop = onAuthEpochChange((epoch) => seen.push(epoch));

    assert.deepEqual(rotateJwtSecret(), { rotated: false });
    await assert.rejects(
      service.logoutAll({ id: user.id, username: 'alice' }, 'correct-horse-battery', '10.0.0.1'),
      (error: unknown) => error instanceof AppError && error.code === 'AUTH_SECRET_PINNED' && error.statusCode === 409,
    );
    stop();

    assert.equal(getAuthEpoch(), epochBefore + 1);
    assert.deepEqual(seen, [epochBefore + 1]);
    assert.equal(verifyTabToken(tab, 'peer-1').ok, false);
    assert.equal((await runAuthenticateToken(authenticateToken, ordinary)).accepted, true);
  });
});

test('auth epoch starts at 0, increments by one, and listeners can unsubscribe', async () => {
  await withIsolatedAuthDatabase(() => {
    assert.equal(getAuthEpoch(), 0);
    const seen: number[] = [];
    const stop = onAuthEpochChange((epoch) => seen.push(epoch));

    assert.equal(bumpAuthEpoch(), 1);
    stop();
    assert.equal(bumpAuthEpoch(), 2);

    assert.deepEqual(seen, [1]);
    assert.equal(getAuthEpoch(), 2);
  });
});

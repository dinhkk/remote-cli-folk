import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import { createAuthService } from '../auth.service.js';
import { createLoginRateLimiter } from '../services/login-rate-limit.service.js';

type AuthDependencies = Parameters<typeof createAuthService>[0];

function createDependencies(overrides: Partial<AuthDependencies> = {}): AuthDependencies {
  return {
    users: {
      hasUsers: () => false,
      createUser: (username, passwordHash) => ({ id: 1, username, password_hash: passwordHash }),
      getUserByUsername: () => undefined,
      updateLastLogin: () => undefined,
    },
    transaction: {
      begin: () => undefined,
      commit: () => undefined,
      rollback: () => undefined,
    },
    hashPassword: async () => 'hashed-password',
    comparePassword: async () => false,
    generateToken: () => 'signed-token',
    loginLimiter: createLoginRateLimiter(),
    dummyPasswordHash: 'dummy-hash',
    getSetupToken: () => undefined,
    rotateJwtSecret: () => ({ rotated: true }),
    bumpAuthEpoch: () => 1,
    ...overrides,
  };
}

function alice(passwordHash = 'hash') {
  return { id: 1, username: 'alice', password_hash: passwordHash };
}

async function assertAppError(promise: Promise<unknown>, code: string, statusCode: number) {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof AppError && error.code === code && error.statusCode === statusCode,
  );
}

test('register hashes credentials and commits through injected dependencies', async () => {
  const operations: string[] = [];
  const service = createAuthService(createDependencies({
    transaction: {
      begin: () => operations.push('begin'),
      commit: () => operations.push('commit'),
      rollback: () => operations.push('rollback'),
    },
    hashPassword: async (password) => {
      operations.push(`hash:${password}`);
      return 'hash';
    },
    users: {
      hasUsers: () => false,
      createUser: (username, passwordHash) => {
        operations.push(`create:${username}:${passwordHash}`);
        return { id: 1, username, password_hash: passwordHash };
      },
      getUserByUsername: () => undefined,
      updateLastLogin: (userId) => operations.push(`login:${userId}`),
    },
  }));

  const result = await service.register('alice', 'secret-pass-12');

  assert.equal(result.token, 'signed-token');
  assert.deepEqual(operations, ['begin', 'hash:secret-pass-12', 'create:alice:hash', 'commit', 'login:1']);
});

test('register rejects an 11 character password and accepts 12', async () => {
  const service = createAuthService(createDependencies());

  await assertAppError(service.register('alice', '12345678901'), 'AUTH_CREDENTIALS_TOO_SHORT', 400);
  const result = await service.register('alice', '123456789012');
  assert.equal(result.success, true);
});

test('login rejects an invalid password without issuing a token', async () => {
  let tokenIssued = false;
  const service = createAuthService(createDependencies({
    users: {
      hasUsers: () => true,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: () => alice(),
      updateLastLogin: () => undefined,
    },
    comparePassword: async () => false,
    generateToken: () => {
      tokenIssued = true;
      return 'token';
    },
  }));

  await assert.rejects(
    service.login('alice', 'wrong-password'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_INVALID_CREDENTIALS',
  );
  assert.equal(tokenIssued, false);
});

test('refreshSession issues a replacement token for the authenticated user', () => {
  let tokenUser: { id: number | bigint; username: string } | undefined;
  const service = createAuthService(createDependencies({
    generateToken: (user) => {
      tokenUser = user;
      return 'replacement-token';
    },
  }));

  const result = service.refreshSession({ id: 7, username: 'alice' });

  assert.deepEqual(result, { token: 'replacement-token' });
  assert.deepEqual(tokenUser, { id: 7, username: 'alice' });
});

test('login with a legacy password shorter than 12 succeeds and reports passwordWeak', async () => {
  const service = createAuthService(createDependencies({
    users: { ...createDependencies().users, getUserByUsername: () => alice() },
    comparePassword: async () => true,
  }));

  const weak = await service.login('alice', 'short1');
  const strong = await service.login('alice', 'a-long-enough-password');

  assert.equal(weak.success, true);
  assert.equal(weak.passwordWeak, true);
  assert.equal(strong.passwordWeak, undefined);
});

test('login for an unknown username still spends a bcrypt comparison on the dummy hash', async () => {
  const compared: string[] = [];
  const service = createAuthService(createDependencies({
    dummyPasswordHash: 'dummy-hash-value',
    comparePassword: async (_password, passwordHash) => {
      compared.push(passwordHash);
      return false;
    },
  }));

  await assertAppError(service.login('nobody', 'whatever-password'), 'AUTH_INVALID_CREDENTIALS', 401);
  assert.deepEqual(compared, ['dummy-hash-value']);
});

test('five wrong passwords lock the pair: the sixth attempt gets 429 with Retry-After details and skips bcrypt', async () => {
  let comparisons = 0;
  const service = createAuthService(createDependencies({
    loginLimiter: createLoginRateLimiter({ now: () => 5_000_000 }),
    users: { ...createDependencies().users, getUserByUsername: () => alice() },
    comparePassword: async (password) => {
      comparisons += 1;
      return password === 'the-right-password';
    },
  }));

  for (let i = 0; i < 5; i += 1) {
    await assertAppError(service.login('alice', 'wrong', '10.0.0.1'), 'AUTH_INVALID_CREDENTIALS', 401);
  }
  const before = comparisons;

  await assert.rejects(
    service.login('alice', 'the-right-password', '10.0.0.1'),
    (error: unknown) => error instanceof AppError
      && error.code === 'AUTH_RATE_LIMITED'
      && error.statusCode === 429
      && (error.details as { retryAfterSeconds: number }).retryAfterSeconds === 900,
  );
  assert.equal(comparisons, before, 'a locked attempt must not reach bcrypt');

  const otherIp = await service.login('alice', 'the-right-password', '10.0.0.2');
  assert.equal(otherIp.success, true);
});

test('a burst of concurrent wrong passwords cannot out-run the limit, and a late correct one is refused', async () => {
  let comparisons = 0;
  const service = createAuthService(createDependencies({
    users: { ...createDependencies().users, getUserByUsername: () => alice() },
    comparePassword: async (password) => {
      comparisons += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return password === 'the-right-password';
    },
  }));

  const attempts = Array.from({ length: 51 }, (_, index) =>
    service.login('alice', index === 30 ? 'the-right-password' : 'wrong', '10.0.0.1').then(
      () => 'ok',
      (error: unknown) => (error instanceof AppError ? error.code : 'other'),
    ));
  const outcomes = await Promise.all(attempts);

  assert.equal(comparisons, 5, 'only five bcrypt checks may run before the lock');
  assert.equal(outcomes[30], 'AUTH_RATE_LIMITED', 'the correct password arrived after the lock');
  assert.equal(outcomes.filter((code) => code === 'AUTH_RATE_LIMITED').length, 46);
});

test('a correct login that is the fifth attempt is not locked out by its own reservation', async () => {
  const service = createAuthService(createDependencies({
    users: { ...createDependencies().users, getUserByUsername: () => alice() },
    comparePassword: async (password) => password === 'the-right-password',
  }));

  for (let i = 0; i < 4; i += 1) {
    await assertAppError(service.login('alice', 'wrong', '10.0.0.1'), 'AUTH_INVALID_CREDENTIALS', 401);
  }
  assert.equal((await service.login('alice', 'the-right-password', '10.0.0.1')).success, true);
  assert.equal((await service.login('alice', 'the-right-password', '10.0.0.1')).success, true, 'and the pair is clean afterwards');
});

test('guessing the setup token is rate limited per client, not per username', async () => {
  const service = createAuthService(createDependencies({ getSetupToken: () => 'setup-secret' }));

  for (let i = 0; i < 5; i += 1) {
    await assertAppError(service.register(`user-${i}-name`, 'secret-pass-12', `guess-${i}`, '10.0.0.1'), 'AUTH_SETUP_TOKEN_INVALID', 403);
  }
  await assertAppError(service.register('another-name', 'secret-pass-12', 'setup-secret', '10.0.0.1'), 'AUTH_RATE_LIMITED', 429);

  const otherClient = await service.register('another-name', 'secret-pass-12', 'setup-secret', '10.0.0.2');
  assert.equal(otherClient.success, true);
});

test('a successful login resets the failure counter for that pair', async () => {
  const service = createAuthService(createDependencies({
    users: { ...createDependencies().users, getUserByUsername: () => alice() },
    comparePassword: async (password) => password === 'the-right-password',
  }));

  for (let i = 0; i < 4; i += 1) {
    await assertAppError(service.login('alice', 'wrong', '10.0.0.1'), 'AUTH_INVALID_CREDENTIALS', 401);
  }
  await service.login('alice', 'the-right-password', '10.0.0.1');
  for (let i = 0; i < 4; i += 1) {
    await assertAppError(service.login('alice', 'wrong', '10.0.0.1'), 'AUTH_INVALID_CREDENTIALS', 401);
  }
  const result = await service.login('alice', 'the-right-password', '10.0.0.1');
  assert.equal(result.success, true);
});

test('register requires CLOUDCLI_SETUP_TOKEN when one is configured', async () => {
  const service = createAuthService(createDependencies({ getSetupToken: () => 'setup-secret' }));

  await assertAppError(service.register('alice', 'secret-pass-12'), 'AUTH_SETUP_TOKEN_INVALID', 403);
  await assertAppError(service.register('alice', 'secret-pass-12', 'wrong'), 'AUTH_SETUP_TOKEN_INVALID', 403);
  await assertAppError(service.register('alice', 'secret-pass-12', 42), 'AUTH_SETUP_TOKEN_INVALID', 403);
  const ok = await service.register('alice', 'secret-pass-12', 'setup-secret');
  assert.equal(ok.success, true);
});

test('register needs no setup token when none is configured', async () => {
  const service = createAuthService(createDependencies({ getSetupToken: () => undefined }));
  const result = await service.register('alice', 'secret-pass-12');
  assert.equal(result.success, true);
});

test('logoutAll with a wrong password is refused and rotates nothing', async () => {
  const calls: string[] = [];
  const service = createAuthService(createDependencies({
    users: { ...createDependencies().users, getUserByUsername: () => alice() },
    comparePassword: async () => false,
    rotateJwtSecret: () => { calls.push('rotate'); return { rotated: true }; },
    bumpAuthEpoch: () => { calls.push('epoch'); return 2; },
  }));

  await assertAppError(service.logoutAll({ id: 1, username: 'alice' }, 'nope', '10.0.0.1'), 'AUTH_INVALID_CREDENTIALS', 403);
  assert.deepEqual(calls, []);
});

test('logoutAll with the right password bumps the epoch and rotates the secret', async () => {
  const calls: string[] = [];
  const service = createAuthService(createDependencies({
    users: { ...createDependencies().users, getUserByUsername: () => alice() },
    comparePassword: async (password) => password === 'the-right-password',
    rotateJwtSecret: () => { calls.push('rotate'); return { rotated: true }; },
    bumpAuthEpoch: () => { calls.push('epoch'); return 2; },
  }));

  const result = await service.logoutAll({ id: 1, username: 'alice' }, 'the-right-password', '10.0.0.1');

  assert.deepEqual(result, { success: true, rotated: true });
  assert.deepEqual(calls, ['epoch', 'rotate']);
});

test('logoutAll with a secret pinned by env still bumps the epoch, then reports 409', async () => {
  const calls: string[] = [];
  const service = createAuthService(createDependencies({
    users: { ...createDependencies().users, getUserByUsername: () => alice() },
    comparePassword: async () => true,
    rotateJwtSecret: () => { calls.push('rotate'); return { rotated: false }; },
    bumpAuthEpoch: () => { calls.push('epoch'); return 3; },
  }));

  await assertAppError(service.logoutAll({ id: 1, username: 'alice' }, 'x', '10.0.0.1'), 'AUTH_SECRET_PINNED', 409);
  assert.deepEqual(calls, ['epoch', 'rotate']);
});

test('wrong logoutAll passwords count towards the same lock as login', async () => {
  const service = createAuthService(createDependencies({
    users: { ...createDependencies().users, getUserByUsername: () => alice() },
    comparePassword: async () => false,
  }));

  for (let i = 0; i < 5; i += 1) {
    await assertAppError(service.logoutAll({ id: 1, username: 'alice' }, 'nope', '10.0.0.1'), 'AUTH_INVALID_CREDENTIALS', 403);
  }
  await assertAppError(service.logoutAll({ id: 1, username: 'alice' }, 'nope', '10.0.0.1'), 'AUTH_RATE_LIMITED', 429);
  await assertAppError(service.login('alice', 'nope', '10.0.0.1'), 'AUTH_RATE_LIMITED', 429);
});

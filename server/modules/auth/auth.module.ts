import { createRequire } from 'node:module';

import { getConnection, userDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

import { authenticateToken, generateToken, rotateJwtSecret } from './auth.middleware.js';
import { createAuthRouter } from './auth.routes.js';
import { createAuthService } from './auth.service.js';
import { bumpAuthEpoch } from './services/auth-epoch.service.js';
import { createLoginRateLimiter } from './services/login-rate-limit.service.js';

type BcryptAdapter = {
  hash(password: string, saltRounds: number): Promise<string>;
  compare(password: string, passwordHash: string): Promise<boolean>;
};

// bcryptjs does not ship TypeScript declarations in this project, so the
// composition root narrows its CommonJS runtime surface before injecting it.
const require = createRequire(import.meta.url);
const bcrypt = require('bcryptjs') as BcryptAdapter;

// bcrypt (cost 12) of random data that no one knows. Compared when a login names a user that
// does not exist, so unknown and known usernames cost the same time.
export const DUMMY_PASSWORD_HASH = '$2b$12$YCZXLJezayBE/0K0/n1KtOfSzIVReTxBMC8nuSGAmE4bWgzFi4YMi';

// One limiter for login, logout-all, setup-token guesses and verifyPassword, so guesses made
// through different doors add up.
const loginLimiter = createLoginRateLimiter();

// The connection is resolved per call, not at import, so this module can be imported
// before DATABASE_PATH is final.
const authService = createAuthService({
  users: {
    hasUsers: () => userDb.hasUsers(),
    createUser: (username, passwordHash) => userDb.createUser(username, passwordHash),
    getUserByUsername: (username) => userDb.getUserByUsername(username),
    updateLastLogin: (userId) => userDb.updateLastLogin(userId),
  },
  transaction: {
    begin: () => getConnection().prepare('BEGIN').run(),
    commit: () => getConnection().prepare('COMMIT').run(),
    rollback: () => getConnection().prepare('ROLLBACK').run(),
  },
  hashPassword: (password) => bcrypt.hash(password, 12),
  comparePassword: (password, passwordHash) => bcrypt.compare(password, passwordHash),
  generateToken,
  loginLimiter,
  dummyPasswordHash: DUMMY_PASSWORD_HASH,
  getSetupToken: () => process.env.CLOUDCLI_SETUP_TOKEN || undefined,
  rotateJwtSecret,
  bumpAuthEpoch,
});

/** Auth router assembled for the server entrypoint. */
export const authRoutes = createAuthRouter(authService, authenticateToken);

/**
 * Checks a password for a user id (used by Remote management endpoints that must re-confirm
 * the owner). Unknown ids still pay one bcrypt comparison. Wrong guesses count against the same
 * limiter as login, keyed by (clientIp, user): once locked it throws AUTH_RATE_LIMITED (429)
 * instead of acting as a password oracle for someone holding a stolen token.
 */
export async function verifyPassword(userId: number, password: string, clientIp = 'unknown'): Promise<boolean> {
  const publicUser = userDb.getUserById(userId);
  const attempt = loginLimiter.attempt(clientIp, publicUser ? publicUser.username : `\u0000user-id:${userId}`);
  if (!attempt.allowed) {
    throw new AppError('Too many failed attempts. Try again later.', {
      code: 'AUTH_RATE_LIMITED',
      statusCode: 429,
      details: { retryAfterSeconds: attempt.retryAfterSeconds },
    });
  }
  const stored = publicUser ? userDb.getUserByUsername(publicUser.username) : undefined;
  const matches = await bcrypt.compare(password, stored ? stored.password_hash : DUMMY_PASSWORD_HASH);
  if (stored && matches) {
    attempt.succeeded();
    return true;
  }
  return false;
}

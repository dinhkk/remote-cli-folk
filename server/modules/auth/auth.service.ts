import { createHash, timingSafeEqual } from 'node:crypto';

import { AppError } from '@/shared/utils.js';

import type { LoginRateLimiter } from './services/login-rate-limit.service.js';

type AuthUser = {
  id: number | bigint;
  username: string;
};

type AuthLoginUser = AuthUser & { password_hash: string };

type AuthDependencies = {
  users: {
    hasUsers(): boolean;
    createUser(username: string, passwordHash: string): AuthUser;
    getUserByUsername(username: string): AuthLoginUser | undefined;
    updateLastLogin(userId: number): void;
  };
  transaction: {
    begin(): void;
    commit(): void;
    rollback(): void;
  };
  hashPassword(password: string): Promise<string>;
  comparePassword(password: string, passwordHash: string): Promise<boolean>;
  generateToken(user: AuthUser): string;
  loginLimiter: LoginRateLimiter;
  /** bcrypt hash compared when a username does not exist, so timing does not reveal it. */
  dummyPasswordHash: string;
  /** Read at call time so tests and operators can change the env without a restart. */
  getSetupToken(): string | undefined;
  rotateJwtSecret(): { rotated: boolean };
  bumpAuthEpoch(): number;
};

/** Limiter "username" under which all setup-token guesses from one client are counted. */
const SETUP_TOKEN_BUCKET = '\u0000setup-token';

/** Minimum length for new passwords. Older, shorter passwords still log in but are flagged weak. */
export const MIN_PASSWORD_LENGTH = 12;

function numericUserId(userId: number | bigint): number {
  return Number(userId);
}

function readAuthUser(user: unknown): AuthUser {
  if (
    typeof user !== 'object'
    || user === null
    || !('id' in user)
    || !('username' in user)
    || (typeof user.id !== 'number' && typeof user.id !== 'bigint')
    || typeof user.username !== 'string'
  ) {
    throw new AppError('Authenticated user is required', {
      code: 'AUTH_USER_REQUIRED',
      statusCode: 401,
    });
  }
  return { id: user.id, username: user.username };
}

/** Constant-time string comparison that does not leak the expected length. */
function secretsMatch(expected: string, provided: unknown): boolean {
  if (typeof provided !== 'string') {
    return false;
  }
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(expected), digest(provided));
}

function rateLimitedError(retryAfterSeconds: number): AppError {
  return new AppError('Too many failed attempts. Try again later.', {
    code: 'AUTH_RATE_LIMITED',
    statusCode: 429,
    details: { retryAfterSeconds },
  });
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/**
 * Creates the Auth application service around explicit persistence, crypto,
 * transaction, and token dependencies.
 */
export function createAuthService(dependencies: AuthDependencies) {
  return {
    getStatus() {
      return {
        needsSetup: !dependencies.users.hasUsers(),
        isAuthenticated: false,
      };
    },

    async register(
      usernameInput: unknown,
      passwordInput: unknown,
      setupTokenInput?: unknown,
      clientIp = 'unknown',
    ) {
      const username = typeof usernameInput === 'string' ? usernameInput : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';

      if (!username || !password) {
        throw new AppError('Username and password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED',
          statusCode: 400,
        });
      }
      if (username.length < 3 || password.length < MIN_PASSWORD_LENGTH) {
        throw new AppError(
          `Username must be at least 3 characters, password at least ${MIN_PASSWORD_LENGTH} characters`,
          { code: 'AUTH_CREDENTIALS_TOO_SHORT', statusCode: 400 },
        );
      }

      // On a fresh VPS the first registrant becomes the owner; the operator can pin that to
      // whoever knows REMOTECLI_SETUP_TOKEN (or legacy CLOUDCLI_SETUP_TOKEN).
      // Guessing the token is rate limited per client (shared bucket, not per username).
      const setupToken = dependencies.getSetupToken();
      if (setupToken) {
        const attempt = dependencies.loginLimiter.attempt(clientIp, SETUP_TOKEN_BUCKET);
        if (!attempt.allowed) {
          throw rateLimitedError(attempt.retryAfterSeconds);
        }
        if (!secretsMatch(setupToken, setupTokenInput)) {
          throw new AppError('A valid setup token is required to register', {
            code: 'AUTH_SETUP_TOKEN_INVALID',
            statusCode: 403,
          });
        }
        attempt.succeeded();
      }

      dependencies.transaction.begin();
      try {
        if (dependencies.users.hasUsers()) {
          throw new AppError('User already exists. This is a single-user system.', {
            code: 'AUTH_USER_ALREADY_CONFIGURED',
            statusCode: 403,
          });
        }

        const passwordHash = await dependencies.hashPassword(password);
        const user = dependencies.users.createUser(username, passwordHash);
        const token = dependencies.generateToken(user);
        dependencies.transaction.commit();
        dependencies.users.updateLastLogin(numericUserId(user.id));

        return {
          success: true,
          user: { id: user.id, username: user.username },
          token,
        };
      } catch (error) {
        dependencies.transaction.rollback();
        if (isUniqueConstraintError(error)) {
          throw new AppError('Username already exists', {
            code: 'AUTH_USERNAME_CONFLICT',
            statusCode: 409,
          });
        }
        throw error;
      }
    },

    async login(usernameInput: unknown, passwordInput: unknown, clientIp = 'unknown') {
      const username = typeof usernameInput === 'string' ? usernameInput : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';
      if (!username || !password) {
        throw new AppError('Username and password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED',
          statusCode: 400,
        });
      }

      // The slot is reserved here, before the slow bcrypt call, so a burst of concurrent
      // requests cannot all be admitted under the limit; success refunds it.
      const attempt = dependencies.loginLimiter.attempt(clientIp, username);
      if (!attempt.allowed) {
        throw rateLimitedError(attempt.retryAfterSeconds);
      }

      const user = dependencies.users.getUserByUsername(username);
      // An unknown username still pays for one bcrypt comparison so response time does not
      // reveal which usernames exist.
      const passwordMatches = await dependencies.comparePassword(
        password,
        user ? user.password_hash : dependencies.dummyPasswordHash,
      );
      if (!user || !passwordMatches) {
        throw new AppError('Invalid username or password', {
          code: 'AUTH_INVALID_CREDENTIALS',
          statusCode: 401,
        });
      }

      attempt.succeeded();
      dependencies.users.updateLastLogin(numericUserId(user.id));
      return {
        success: true,
        user: { id: user.id, username: user.username },
        token: dependencies.generateToken(user),
        // Passwords created before the 12 character rule keep working; the client nudges a change.
        ...(password.length < MIN_PASSWORD_LENGTH ? { passwordWeak: true } : {}),
      };
    },

    getCurrentUser(user: unknown) {
      return { user };
    },

    refreshSession(user: unknown) {
      return { token: dependencies.generateToken(readAuthUser(user)) };
    },

    logout() {
      return { success: true, message: 'Logged out successfully' };
    },

    /**
     * "Log out everywhere": needs the account password (a stolen JWT alone is not enough),
     * bumps the auth epoch (kills Remote tab tokens and streams) and rotates the JWT secret
     * (kills every ordinary token). The epoch moves first so Remote is cut off even if the
     * secret is pinned by env, in which case the caller gets 409 for the part that cannot happen.
     */
    async logoutAll(userInput: unknown, passwordInput: unknown, clientIp = 'unknown') {
      const authUser = readAuthUser(userInput);
      const password = typeof passwordInput === 'string' ? passwordInput : '';
      if (!password) {
        throw new AppError('Password is required', {
          code: 'AUTH_CREDENTIALS_REQUIRED',
          statusCode: 400,
        });
      }

      const attempt = dependencies.loginLimiter.attempt(clientIp, authUser.username);
      if (!attempt.allowed) {
        throw rateLimitedError(attempt.retryAfterSeconds);
      }

      const stored = dependencies.users.getUserByUsername(authUser.username);
      const passwordMatches = await dependencies.comparePassword(
        password,
        stored ? stored.password_hash : dependencies.dummyPasswordHash,
      );
      if (!stored || !passwordMatches) {
        // 403, not 401: a 401 makes the client treat its own session as expired.
        throw new AppError('Password is incorrect', {
          code: 'AUTH_INVALID_CREDENTIALS',
          statusCode: 403,
        });
      }
      attempt.succeeded();

      dependencies.bumpAuthEpoch();
      const { rotated } = dependencies.rotateJwtSecret();
      if (!rotated) {
        throw new AppError(
          'Remote sessions were ended, but JWT_SECRET is set in the environment so existing logins stay valid. Remove JWT_SECRET to rotate it.',
          { code: 'AUTH_SECRET_PINNED', statusCode: 409 },
        );
      }
      return { success: true as const, rotated: true as const };
    },
  };
}

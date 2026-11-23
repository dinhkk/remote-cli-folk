/** The management API shares the browser session guard and keeps its 4 KB parser. */

import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';

import { createApiSessionGuard } from '@/modules/auth/index.js';
import { AppError } from '@/shared/utils.js';

/** Largest management request body. Everything the UI sends (URL, secret, password) fits in a fraction of it. */
const MANAGEMENT_BODY_LIMIT = '4kb';

export type ManagementGuardDeps = {
  authenticateToken: RequestHandler;
  validateApiKey: RequestHandler;
  verifyPassword(userId: number, password: string, clientIp: string): Promise<boolean>;
};

/** The user the JWT middleware attached (`id`/`username` of the account row). */
export type ManagementUser = { id: number; username: string };

/** Request after the guard chain ran: `user` is the authenticated owner. */
export type ManagementRequest = Request & { user: ManagementUser; authSession: { id: string } };

/** Address used to key the password lock-out (Express applies `trust proxy`). */
const clientIpOf = (req: Request): string => req.ip ?? req.socket.remoteAddress ?? 'unknown';

const refuse = (next: NextFunction, status: number, code: string, message: string): void => {
  next(new AppError(message, { statusCode: status, code }));
};

/**
 * Builds the guard chain and the password guard of the management API.
 * Consumed by: the management routes.
 */
export function createManagementGuards(deps: ManagementGuardDeps): { chain: RequestHandler[]; requirePassword: RequestHandler } {
  const parseJson = express.json({ limit: MANAGEMENT_BODY_LIMIT, type: 'application/json', strict: true });

  const requirePassword: RequestHandler = async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const body = (req.body ?? {}) as { password?: unknown };
      const { password } = body;
      if (typeof password !== 'string' || password === '') {
        // 401 without `X-Auth-Error`: the client must not read a missing field as the end of its session.
        return refuse(next, 401, 'AUTH_PASSWORD_REQUIRED', 'This action needs your account password.');
      }
      const user = (req as ManagementRequest).user;
      // The handler works on the rest of the body; the password stops here.
      delete body.password;
      if (!(await deps.verifyPassword(user.id, password, clientIpOf(req)))) {
        // 403, not 401: clients treat 401 as an expired session (contracts section 10).
        return refuse(next, 403, 'AUTH_INVALID_CREDENTIALS', 'Incorrect password.');
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };

  return {
    chain: [deps.validateApiKey, createApiSessionGuard(deps.authenticateToken), parseJson],
    requirePassword,
  };
}

/**
 * Transport guards of `/api/remote/**` (contracts section 2, NFR-7). The chain runs in this order so a
 * caller learns as little as possible and the cheapest refusals come first:
 *
 *   API_KEY (parity with every other `/api` route) -> same-origin -> full JWT in the Authorization
 *   header (a tab token fails here: it is signed with another key, AC-33) -> `Content-Type:
 *   application/json` on writes -> JSON body of at most 4 KB.
 *
 * Authentication runs BEFORE the body parser, so an unauthenticated caller can make the server read
 * nothing. Sensitive endpoints add `requirePassword`: the account password is re-checked through the
 * auth module with the caller's address (so wrong guesses share the login lock-out), and the handler
 * never sees it.
 */

import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';

import { AppError } from '@/shared/utils.js';

/** Largest management request body. Everything the UI sends (URL, secret, password) fits in a fraction of it. */
const MANAGEMENT_BODY_LIMIT = '4kb';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** `Sec-Fetch-Site` values of a request the user's own page made (or typed in the address bar). */
const SAME_ORIGIN_SITES = new Set(['same-origin', 'none']);

export type ManagementGuardDeps = {
  authenticateToken: RequestHandler;
  validateApiKey: RequestHandler;
  verifyPassword(userId: number, password: string, clientIp: string): Promise<boolean>;
};

/** The user the JWT middleware attached (`id`/`username` of the account row). */
export type ManagementUser = { id: number; username: string };

/** Request after the guard chain ran: `user` is the authenticated owner. */
export type ManagementRequest = Request & { user: ManagementUser };

/** Address used to key the password lock-out (Express applies `trust proxy`). */
const clientIpOf = (req: Request): string => req.ip ?? req.socket.remoteAddress ?? 'unknown';

const refuse = (next: NextFunction, status: number, code: string, message: string): void => {
  next(new AppError(message, { statusCode: status, code }));
};

const requireSameOrigin: RequestHandler = (req, _res, next) => {
  const site = req.get('sec-fetch-site');
  if (site !== undefined) {
    if (SAME_ORIGIN_SITES.has(site)) return next();
    return refuse(next, 403, 'REMOTE_FORBIDDEN', 'The management API only answers requests from its own page.');
  }
  // Clients that send no Sec-Fetch-* (scripts, old browsers) must not claim a foreign origin.
  const origin = req.get('origin');
  if (origin === undefined) return next();
  try {
    if (origin !== 'null' && new URL(origin).host === req.get('host')) return next();
  } catch {
    // Unparseable origin: refused below.
  }
  return refuse(next, 403, 'REMOTE_FORBIDDEN', 'The management API only answers requests from its own page.');
};

/** The token must come in the Authorization header: a URL lands in logs, history and referrers. */
const requireBearerHeader: RequestHandler = (req, res, next) => {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.split(' ')[1]) return next();
  res.setHeader('X-Auth-Error', 'invalid-token');
  return refuse(next, 401, 'AUTH_TOKEN_INVALID', 'Access denied. No token provided.');
};

const requireJsonOnWrites: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  const mediaType = (req.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (mediaType === 'application/json') return next();
  return refuse(next, 415, 'REMOTE_UNSUPPORTED_MEDIA', 'Send the request as application/json.');
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
    chain: [deps.validateApiKey, requireSameOrigin, requireBearerHeader, deps.authenticateToken, requireJsonOnWrites, parseJson],
    requirePassword,
  };
}

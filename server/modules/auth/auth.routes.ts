import express from 'express';
import type { NextFunction, RequestHandler, Response } from 'express';

import { AppError } from '@/shared/utils.js';

import type { createAuthService } from './auth.service.js';

type AuthenticatedRequest = express.Request & { user?: unknown };

/** Express fills `req.ip` honouring the `trust proxy` setting; 'unknown' keeps the limiter keyed. */
function clientIp(req: express.Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/**
 * Forwards an error to the global handler. The handler cannot set headers, so a rate-limit
 * error gets its `Retry-After` header here first.
 */
function forwardError(res: Response, next: NextFunction, error: unknown): void {
  if (error instanceof AppError && error.code === 'AUTH_RATE_LIMITED') {
    const retryAfterSeconds = (error.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
    if (typeof retryAfterSeconds === 'number') {
      res.setHeader('Retry-After', String(retryAfterSeconds));
    }
  }
  next(error);
}

/**
 * Creates the Auth transport adapter. Handlers only parse request data and
 * delegate authentication behavior to the injected application service.
 */
export function createAuthRouter(
  service: ReturnType<typeof createAuthService>,
  authenticateToken: RequestHandler,
): express.Router {
  const router = express.Router();

  router.get('/status', (_req, res, next) => {
    try {
      res.json(service.getStatus());
    } catch (error) {
      next(error);
    }
  });

  router.post('/register', async (req, res, next) => {
    try {
      const body = req.body as { username?: unknown; password?: unknown; setupToken?: unknown };
      const setupToken = body.setupToken ?? req.get('x-setup-token');
      res.json(await service.register(body.username, body.password, setupToken, clientIp(req)));
    } catch (error) {
      forwardError(res, next, error);
    }
  });

  router.post('/login', async (req, res, next) => {
    try {
      const body = req.body as { username?: unknown; password?: unknown };
      res.json(await service.login(body.username, body.password, clientIp(req)));
    } catch (error) {
      forwardError(res, next, error);
    }
  });

  router.get('/user', authenticateToken, (req, res) => {
    res.json(service.getCurrentUser((req as AuthenticatedRequest).user));
  });

  router.post('/refresh', authenticateToken, (req, res) => {
    res.json(service.refreshSession((req as AuthenticatedRequest).user));
  });

  router.post('/logout', authenticateToken, (_req, res) => {
    res.json(service.logout());
  });

  router.post('/logout-all', authenticateToken, async (req, res, next) => {
    try {
      const body = req.body as { password?: unknown };
      res.json(await service.logoutAll((req as AuthenticatedRequest).user, body.password, clientIp(req)));
    } catch (error) {
      forwardError(res, next, error);
    }
  });

  return router;
}

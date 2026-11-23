import express from 'express';
import type { NextFunction, RequestHandler, Response } from 'express';

import { AppError } from '@/shared/utils.js';

import { getSessionRuntime } from './services/session-runtime.service.js';
import { clearSessionCookie, sessionCookie, isLocalSessionRequest, readAuthTransportConfig } from './services/session-transport.service.js';
import type { AuthSession } from './services/session-store.service.js';
import type { createAuthService } from './auth.service.js';

type AuthenticatedRequest = express.Request & { user?: { id: number; username: string }; authSession?: AuthSession; releaseAuthConnection?: () => void };

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
  const deliverLogin = (req: express.Request, res: Response, result: Awaited<ReturnType<typeof service.login>>) => {
    const { token, ...publicResult } = result;
    const store = getSessionRuntime().store;
    const session = store.authenticate(token);
    if (!session) throw new Error('Session issuance failed');
    store.touch(session.id, req.get('user-agent'));
    res.setHeader('Set-Cookie', sessionCookie(req, token, session.expiresAt));
    res.setHeader('Cache-Control', 'no-store');
    if (!req.secure && !isLocalSessionRequest(req, readAuthTransportConfig(process.env))) {
      console.warn('[auth] Login over HTTP outside loopback; use HTTPS to protect the session in transit.');
    }
    res.json(publicResult);
  };

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
      deliverLogin(req, res, await service.register(body.username, body.password, setupToken, clientIp(req)));
    } catch (error) {
      forwardError(res, next, error);
    }
  });

  router.post('/login', async (req, res, next) => {
    try {
      const body = req.body as { username?: unknown; password?: unknown };
      deliverLogin(req, res, await service.login(body.username, body.password, clientIp(req)));
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

  router.post('/logout', authenticateToken, (req, res) => {
    const auth = req as AuthenticatedRequest;
    auth.releaseAuthConnection?.();
    if (auth.authSession) getSessionRuntime().store.revoke(auth.authSession.id, auth.authSession.userId, 'logout');
    res.setHeader('Set-Cookie', clearSessionCookie(req));
    res.json(service.logout());
  });

  router.post('/logout-all', authenticateToken, async (req, res, next) => {
    try {
      const body = req.body as { password?: unknown };
      (req as AuthenticatedRequest).releaseAuthConnection?.();
      const result = await service.logoutAll((req as AuthenticatedRequest).user, body.password, clientIp(req));
      res.setHeader('Set-Cookie', clearSessionCookie(req));
      res.json(result);
    } catch (error) {
      forwardError(res, next, error);
    }
  });

  router.get('/sessions', authenticateToken, (req, res) => {
    const auth = req as AuthenticatedRequest;
    res.json({ sessions: getSessionRuntime().store.list(auth.user!.id).map((session) => ({
      id: session.id, browser: session.browser, createdAt: session.createdAt,
      lastSeenAt: getSessionRuntime().store.lastActivity(session.id), expiresAt: session.expiresAt,
      current: session.id === auth.authSession?.id,
    })) });
  });

  router.delete('/sessions/:sessionId', authenticateToken, (req, res) => {
    const auth = req as AuthenticatedRequest;
    const id = String(req.params.sessionId);
    if (id === auth.authSession?.id) {
      auth.releaseAuthConnection?.();
      res.setHeader('Set-Cookie', clearSessionCookie(req));
    }
    getSessionRuntime().store.revoke(id, auth.user!.id);
    res.json({ success: true });
  });

  return router;
}

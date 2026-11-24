import type { RequestHandler } from 'express';

import { isLockedSessionRouteAllowed } from './session-lock-policy.service.js';
import { requireRecentMfa } from './mfa-runtime.service.js';
import type { AuthSession } from './session-store.service.js';
import { getSessionRuntime } from './session-runtime.service.js';
import {
  isHtmlPreviewDocumentRequest, isSessionHttpRequestAllowed, readAuthTransportConfig, readSessionCookie,
} from './session-transport.service.js';

const PUBLIC_ROUTES = new Set([
  'GET /api/auth/status',
  'POST /api/auth/login',
  'POST /api/auth/register',
  'POST /api/auth/mfa/verify',
]);

/** C-04b: the complete multipart exception list, matched by method and entire path. */
export const MULTIPART_UPLOAD_ROUTES = [
  /^\/api\/assets\/images\/?$/,
  /^\/api\/assets\/files\/?$/,
  /^\/api\/file-tree\/projects\/[^/]+\/files\/upload\/?$/,
  /^\/api\/voice\/transcribe\/?$/,
] as const;

export function isSessionContentTypeAllowed(method: string, path: string, contentType = ''): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return true;
  const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
  if (mediaType === 'application/json') return true;
  return method === 'POST' && mediaType === 'multipart/form-data'
    && MULTIPART_UPLOAD_ROUTES.some((route) => route.test(path));
}

/** Mount before every /api router AND body parser; independent credentials keep their own guards. */
export function createApiSessionGuard(authenticate: RequestHandler): RequestHandler {
  const config = readAuthTransportConfig(process.env);
  return (req, res, next) => {
    const path = req.originalUrl.split('?', 1)[0];
    if (/^\/api\/(agent|browser-use-mcp)(\/|$)/.test(path)) return next();
    const checkBrowser: RequestHandler = (request, response, proceed) => {
      if ((request as typeof request & { authKind?: string }).authKind === 'loopback') return proceed();
      // The HTML preview frame is the one browser load that cannot send the request header; every other
      // check below still applies to it.
      if (!isHtmlPreviewDocumentRequest(request, path) && !isSessionHttpRequestAllowed(request, config)) {
        response.status(403).json({ error: 'Request origin or header is not allowed', code: 'AUTH_REQUEST_FORBIDDEN' });
        return;
      }
      if (!isSessionContentTypeAllowed(request.method, path, request.get('content-type'))) {
        response.status(415).json({ error: 'Unsupported request content type', code: 'AUTH_UNSUPPORTED_MEDIA' });
        return;
      }
      const auth = request as typeof request & { authSession?: AuthSession; user?: { id: number } };
      const cookie = PUBLIC_ROUTES.has(`${request.method} ${path}`) ? readSessionCookie(request) : null;
      const session = auth.authSession ?? (cookie ? getSessionRuntime().store.authenticate(cookie, true) : null);
      if (session?.lockedAt != null && !isLockedSessionRouteAllowed(request.method, path)) {
        response.status(423).json({ code: 'AUTH_SESSION_LOCKED', error: 'Unlock this session to continue' });
        return;
      }
      if (auth.user && isSensitiveAction(request.method, path)) {
        try { requireRecentMfa(auth.user.id, session ?? undefined); } catch (error) { return proceed(error); }
      }
      if (session) getSessionRuntime().store.touch(session.id, request.get('user-agent'));
      proceed();
    };
    if (PUBLIC_ROUTES.has(`${req.method} ${path}`)) return checkBrowser(req, res, next);
    return authenticate(req, res, (error?: unknown) => {
      if (error) return next(error);
      return checkBrowser(req, res, next);
    });
  };
}


/** C-09: explicit management operations, including pairing confirmation and credential creation. */
export function isSensitiveAction(method: string, path: string): boolean {
  path = path.toLowerCase();
  if (method === 'POST' && ['/api/auth/logout-all', '/api/settings/api-keys', '/api/remote/host/pairings/start', '/api/remote/peers/join'].includes(path.replace(/\/$/, ''))) return true;
  if (method === 'POST' && /^\/api\/remote\/host\/pairings\/[^/]+\/confirm\/?$/.test(path)) return true;
  if (method === 'DELETE' && /^\/api\/remote\/(host\/pairings|peers)\/[^/]+\/?$/.test(path)) return true;
  // Updating the relay configuration revokes all pairings as part of that operation.
  return method === 'PUT' && path.replace(/\/$/, '') === '/api/remote/relay-config';
}

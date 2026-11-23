import type { RequestHandler } from 'express';

import { getSessionRuntime } from './session-runtime.service.js';
import { isSessionHttpRequestAllowed, readAuthTransportConfig } from './session-transport.service.js';

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
      if (!isSessionHttpRequestAllowed(request, config)) {
        response.status(403).json({ error: 'Request origin or header is not allowed', code: 'AUTH_REQUEST_FORBIDDEN' });
        return;
      }
      if (!isSessionContentTypeAllowed(request.method, path, request.get('content-type'))) {
        response.status(415).json({ error: 'Unsupported request content type', code: 'AUTH_UNSUPPORTED_MEDIA' });
        return;
      }
      const session = (request as typeof request & { authSession?: { id: string } }).authSession;
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

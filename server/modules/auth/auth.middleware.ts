// @ts-nocheck -- Express request augmentation is narrowed by Auth route contracts.
import crypto from 'node:crypto';

import { IS_PLATFORM } from '@/shared/utils.js';
import { authenticateLoopback } from './services/loopback-token.service.js';
import { isLockedSessionRouteAllowed } from './services/session-lock-policy.service.js';
import { getSessionRuntime } from './services/session-runtime.service.js';
import { isSessionOriginAllowed, readAuthTransportConfig, readSessionCookie } from './services/session-transport.service.js';


import { userDb, appConfigDb } from '../database/index.js';

// The stored secret is read lazily (never at import) so tests and tools can choose
// DATABASE_PATH after importing this module, and cached until it is rotated.
let cachedJwtSecret = null;

// Env var wins when set (and is then read on every call); otherwise a unique secret per
// installation is generated once and stored in app_config.
const getJwtSecret = () => {
  if (process.env.JWT_SECRET) {
    return process.env.JWT_SECRET;
  }
  cachedJwtSecret ??= appConfigDb.getOrCreateJwtSecret();
  return cachedJwtSecret;
};

const invalidateJwtSecretCache = () => {
  cachedJwtSecret = null;
};

// Replaces the stored secret so every previously issued token stops verifying. A secret
// pinned through the JWT_SECRET env var cannot be rotated from here.
const rotateJwtSecret = () => {
  if (process.env.JWT_SECRET) {
    return { rotated: false };
  }
  const secret = crypto.randomBytes(64).toString('hex');
  appConfigDb.set('jwt_secret', secret);
  cachedJwtSecret = secret;
  return { rotated: true };
};

/** Constant-time comparison for independently authenticated endpoints. */
const secretsMatch = (expected, actual) => typeof actual === 'string' && crypto.timingSafeEqual(
  crypto.createHash('sha256').update(expected).digest(),
  crypto.createHash('sha256').update(actual).digest(),
);

const validateApiKey = (req, res, next) => {
  if (!process.env.API_KEY || secretsMatch(process.env.API_KEY, req.headers['x-api-key'])) return next();
  return res.status(401).json({ error: 'Invalid API key' });
};

const authenticateToken = (req, res, next) => {
  try {
    if (req.authKind) return next();
    const bridge = authenticateLoopback(req.headers.authorization?.replace(/^Bearer /, ''), req.socket.remoteAddress);
    if (bridge) {
      req.user = bridge;
      req.authKind = 'loopback';
      return next();
    }
    if (IS_PLATFORM) {
      const user = userDb.getFirstUser();
      if (!user) return res.status(401).json({ code: 'AUTH_USER_REQUIRED' });
      req.user = user;
      req.authKind = 'platform';
      return next();
    }
    const runtime = getSessionRuntime();
    const secret = readSessionCookie(req);
    const session = secret ? runtime.store.authenticate(secret, true) : null;
    const user = session && userDb.getUserById(session.userId);
    if (!session || !user) {
      // Only a request that still carried a session cookie can have lost a session; a browser
      // with no cookie at all is told it must sign in, so it does not read as an ended session.
      res.setHeader('X-Auth-Error', secret ? 'session-expired' : 'session-required');
      return res.status(401).json({ error: 'Please log in again', code: 'AUTH_TOKEN_INVALID' });
    }
    if (session.lockedAt !== null && !isLockedSessionRouteAllowed(req.method, req.originalUrl)) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(423).json({ error: 'Unlock this session to continue', code: 'AUTH_SESSION_LOCKED' });
    }
    req.user = user;
    req.authSession = session;
    req.authKind = 'session';
    res.setHeader('Cache-Control', 'no-store');
    if (session.lockedAt !== null) return next();
    const release = runtime.connections.track(session.id, () => res.destroy());
    req.releaseAuthConnection = release;
    res.once('finish', release);
    res.once('close', release);
    return next();
  } catch (error) { return next(error); }
};

// Kept as an internal issuance adapter; this value is delivered only in Set-Cookie.
const generateToken = (user, userAgent = '') => getSessionRuntime().store.create(Number(user.id), userAgent).secret;

/** A browser upgrade uses cookies; only the process-local Host bridge uses a bearer. */
const authenticateWebSocket = (request, secure = false) => {
  if (!request || typeof request !== 'object' || !request.headers || !request.socket) return null;
  const bridge = authenticateLoopback(request.headers.authorization?.replace(/^Bearer /, ''), request.socket.remoteAddress);
  if (bridge) return { userId: bridge.id, username: bridge.username, authKind: 'loopback' };
  const transport = { headers: request.headers, socket: request.socket, secure };
  if (!isSessionOriginAllowed(transport, readAuthTransportConfig(process.env))) return null;
  if (IS_PLATFORM) {
    const user = userDb.getFirstUser();
    return user ? { userId: user.id, username: user.username, authKind: 'platform' } : null;
  }
  const secret = readSessionCookie(transport);
  const session = secret ? getSessionRuntime().store.authenticate(secret) : null;
  const user = session && userDb.getUserById(session.userId);
  return user ? { userId: user.id, username: user.username, sessionId: session.id, authKind: 'session' } : null;
};

export {
  validateApiKey, authenticateToken, generateToken, authenticateWebSocket,
  getJwtSecret, rotateJwtSecret, invalidateJwtSecretCache, secretsMatch,
};

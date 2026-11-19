import type { VerifyClientCallbackSync } from 'ws';

import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

type WebSocketAuthDependencies = {
  isPlatform: boolean;
  authenticateWebSocket: (token: string | null) => {
    id?: string | number;
    userId?: string | number;
    username?: string;
    [key: string]: unknown;
  } | null;
};

/**
 * Only the browser-facing sockets are origin-checked. Plugin sockets live in
 * sandboxed frames (origin "null"), and the Host bridge connects from Node
 * without an Origin header at all; both are authenticated by their own tokens.
 */
const ORIGIN_CHECKED_PATHS = new Set(['/ws', '/shell']);

const configuredOrigins = (): string[] =>
  (process.env.REMOTECLI_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

/**
 * A browser always sends Origin on a WebSocket upgrade, so a cross-site page
 * cannot open `/ws` or `/shell` with the user's implicit credentials. The
 * default policy is same-origin (Origin host equals the Host header, which
 * nginx forwards as `$host`); extra origins can be allowed with
 * REMOTECLI_ALLOWED_ORIGINS for split deployments. A missing Origin means a
 * non-browser client and is left to token authentication.
 */
export function isWebSocketOriginAllowed(
  origin: string | undefined,
  host: string | undefined,
  pathname: string
): boolean {
  if (!ORIGIN_CHECKED_PATHS.has(pathname) || !origin) {
    return true;
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  const allowed = configuredOrigins();
  if (allowed.includes(origin) || allowed.includes(parsed.origin)) {
    return true;
  }
  return typeof host === 'string' && parsed.host.toLowerCase() === host.toLowerCase();
}

/**
 * Authenticates websocket upgrade requests before the `connection` handler runs.
 */
export function verifyWebSocketClient(
  info: Parameters<VerifyClientCallbackSync<AuthenticatedWebSocketRequest>>[0],
  dependencies: WebSocketAuthDependencies
): boolean {
  const request = info.req as AuthenticatedWebSocketRequest;
  const upgradeUrl = new URL(request.url ?? '/', 'http://localhost');
  const loggedUrl = new URL(upgradeUrl);
  if (loggedUrl.searchParams.has('token')) {
    loggedUrl.searchParams.set('token', 'REDACTED');
  }

  console.log('WebSocket connection attempt to:', `${loggedUrl.pathname}${loggedUrl.search}`);

  if (!isWebSocketOriginAllowed(request.headers.origin, request.headers.host, upgradeUrl.pathname)) {
    console.warn(
      '[WARN] WebSocket upgrade rejected: origin',
      request.headers.origin,
      'does not match host',
      request.headers.host
    );
    return false;
  }

  // Platform mode: use the first DB user and skip token checks.
  if (dependencies.isPlatform) {
    const user = dependencies.authenticateWebSocket(null);
    if (!user) {
      console.log('[WARN] Platform mode: No user found in database');
      return false;
    }

    request.user = user;
    console.log('[OK] Platform mode WebSocket authenticated for user:', user.username);
    return true;
  }

  // OSS mode: read JWT from query string first, then Authorization header.
  const token =
    upgradeUrl.searchParams.get('token') ??
    request.headers.authorization?.split(' ')[1] ??
    null;

  const user = dependencies.authenticateWebSocket(token);
  if (!user) {
    console.log('[WARN] WebSocket authentication failed');
    return false;
  }

  request.user = user;
  console.log('[OK] WebSocket authenticated for user:', user.username);
  return true;
}

import { isIP } from 'node:net';

export const SESSION_HEADER_NAME = 'x-remotecli-request';
export const SESSION_HEADER_VALUE = '1';
const COOKIE_NAME = 'remotecli_session';
const SECURE_COOKIE_NAME = '__Host-remotecli_session';

export type SessionRequest = {
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string | undefined };
  /** Set by the trusted HTTP adapter, never directly from an arbitrary forwarded header. */
  secure: boolean;
};

export type AuthTransportConfig = {
  origins: readonly string[];
  trustProxyConfigured: boolean;
  serverPort: number;
  vitePort: number;
};

function origin(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

function port(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  if (!/^\d+$/.test(value)) throw new Error('Invalid authentication transport port');
  const parsed = Number(value);
  if (parsed < 1 || parsed > 65535) throw new Error('Invalid authentication transport port');
  return parsed;
}

/** Parse once at startup; wildcard and malformed allow-lists fail closed. */
export function readAuthTransportConfig(env: NodeJS.ProcessEnv): AuthTransportConfig {
  const origins = (env.REMOTECLI_ALLOWED_ORIGINS ?? '').split(',').map((item) => item.trim()).filter(Boolean).map((item) => {
    const parsed = origin(item);
    if (!parsed || item.includes('*')) throw new Error('REMOTECLI_ALLOWED_ORIGINS requires explicit HTTP(S) origins');
    return parsed;
  });
  return {
    origins: [...new Set(origins)],
    trustProxyConfigured: Boolean(env.TRUST_PROXY?.trim()),
    serverPort: port(env.SERVER_PORT || env.PORT, 3001),
    vitePort: port(env.VITE_PORT, 5173),
  };
}

function header(req: SessionRequest, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function requestOrigin(req: SessionRequest): string | null {
  const host = header(req, 'host');
  if (!host || /[\s/@\\?#]/.test(host)) return null;
  return origin(`${req.secure ? 'https' : 'http'}://${host}`);
}

function isLoopbackAddress(address = ''): boolean {
  const ipv4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  return address === '::1' || (isIP(ipv4) === 4 && ipv4.startsWith('127.'));
}

export function isLocalSessionRequest(req: SessionRequest, config: AuthTransportConfig): boolean {
  const currentOrigin = requestOrigin(req);
  if (!currentOrigin || config.trustProxyConfigured || !isLoopbackAddress(req.socket.remoteAddress)) return false;
  return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(currentOrigin).hostname);
}

export function isSessionOriginAllowed(req: SessionRequest, config: AuthTransportConfig): boolean {
  const supplied = header(req, 'origin');
  if (!supplied || supplied === 'null') return false;
  const incoming = origin(supplied);
  const current = requestOrigin(req);
  if (!incoming || !current) return false;
  if (incoming === current || config.origins.includes(incoming)) return true;
  if (!isLocalSessionRequest(req, config)) return false;
  const url = new URL(incoming);
  return url.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    && [config.serverPort, config.vitePort].includes(Number(url.port || '80'));
}

/** HTTP browser guard; loopback bridge authentication is classified separately by the caller. */
export function isSessionHttpRequestAllowed(req: SessionRequest, config: AuthTransportConfig): boolean {
  if (header(req, SESSION_HEADER_NAME) !== SESSION_HEADER_VALUE) return false;
  if (req.headers.origin !== undefined && !isSessionOriginAllowed(req, config)) return false;
  const fetchSite = header(req, 'sec-fetch-site');
  if (req.headers['sec-fetch-site'] !== undefined) return fetchSite === 'same-origin';
  return isSessionOriginAllowed(req, config);
}

export function readSessionCookie(req: SessionRequest): string | null {
  const name = req.secure ? SECURE_COOKIE_NAME : COOKIE_NAME;
  const cookies = header(req, 'cookie');
  if (!cookies) return null;
  const values = cookies.split(';').map((part) => part.trim()).filter((part) => part.startsWith(name + '='));
  if (values.length !== 1) return null;
  const secret = values[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(secret) ? secret : null;
}

export function sessionCookie(req: SessionRequest, secret: string, expiresAt: number, now = Date.now()): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('Invalid session credential');
  const name = req.secure ? SECURE_COOKIE_NAME : COOKIE_NAME;
  const seconds = Math.max(0, Math.floor((expiresAt - now) / 1000));
  return `${name}=${secret}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${seconds}${req.secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(req: SessionRequest): string {
  const name = req.secure ? SECURE_COOKIE_NAME : COOKIE_NAME;
  return `${name}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${req.secure ? '; Secure' : ''}`;
}

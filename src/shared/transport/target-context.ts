import { TAB_TOKEN_REQUEST_MIN_INTERVAL_MS } from '@/shared/constants';

/**
 * The "target" a frame is acting for: which paired Host a Remote tab belongs to,
 * the short-lived tab token the Controller page issued for it, and the URL
 * helpers that turn every request into `/r/<peerId>/...`.
 *
 * Plain module state rather than React state on purpose. The token is read at
 * the moment a request or socket is made and renewed in the background, so
 * keeping it in a ref-like store means a renewal never changes the identity of
 * `connect` callbacks and never reconnects a WebSocket. No token is ever
 * written to a storage object.
 *
 * Nothing here runs in Local mode: `initTargetContext` finds no target and
 * every helper degrades to the unchanged URL/behaviour.
 */

/** WebSocket subprotocol that announces a tab token (contracts.md section 1). */
export const TAB_TOKEN_SUBPROTOCOL = 'remotecli-tab';

/** What a frame knows about its target: the Host's pairing id and, on a fresh load only, the one-time handshake nonce. */
export type TargetInfo = { peerId: string; nonce: string | null };

/** What a Remote tab reports about its connection to the Host, for the status overlay. */
export type TargetLinkEvent =
  | { kind: 'link-error'; code: string; status: number }
  | { kind: 'session-expired' }
  | { kind: 'session-restored' };

const TARGET_QUERY_PARAM = 'target';
const NONCE_HASH_PARAM = 'n';
// window.name survives navigate() and reloads inside the frame; the query and hash do not.
const WINDOW_NAME_PREFIX = 'remotecli-target:';
const LEGACY_WINDOW_NAME_PREFIX = 'cloudcli-target:';
const PEER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

let target: TargetInfo | null = null;
let tabToken: string | null = null;
let lastTokenRequestAt = Number.NEGATIVE_INFINITY;
let sessionExpired = false;

const tokenChangeListeners = new Set<(token: string | null) => void>();
const tokenExpiredListeners = new Set<() => void>();
const linkEventListeners = new Set<(event: TargetLinkEvent) => void>();

/** Peer ids come from the Controller but end up inside URL paths, so only plain tokens are accepted. */
const isValidPeerId = (value: unknown): value is string =>
  typeof value === 'string' && PEER_ID_PATTERN.test(value);

/**
 * Decides, once at start-up, whether this document is a Remote tab.
 *
 * The target comes from `?target=<peerId>` on first load and from `window.name`
 * afterwards, and only in a framed document (the inline shim in index.html
 * applies the same rule). The nonce comes from `#n=` and is removed from the address bar; it
 * is deliberately not stored in window.name, which any document later loaded in
 * this frame could read. Used by the transport bootstrap and by tests.
 */
export const initTargetContext = (win: Window = window): TargetInfo | null => {
  target = null;

  // A Remote tab is always a frame of the Controller page. A top-level document
  // (a stranger's window.open(url, 'cloudcli-target:x') or a link to /?target=x)
  // stays Local, and a stale tab name is dropped so reloads do not stay broken.
  if (win.parent === win) {
    if (win.name.startsWith(WINDOW_NAME_PREFIX) || win.name.startsWith(LEGACY_WINDOW_NAME_PREFIX)) {
      win.name = '';
    }
    return null;
  }

  const queryTarget = new URLSearchParams(win.location.search).get(TARGET_QUERY_PARAM);
  let peerId: string | null = null;
  let fromUrl = false;

  if (queryTarget !== null) {
    // A malformed query is refused outright; falling back to window.name would let it be ignored silently.
    if (!isValidPeerId(queryTarget)) {
      return null;
    }
    peerId = queryTarget;
    fromUrl = true;
  } else if (win.name.startsWith(WINDOW_NAME_PREFIX)) {
    const remembered = win.name.slice(WINDOW_NAME_PREFIX.length);
    peerId = isValidPeerId(remembered) ? remembered : null;
  } else if (win.name.startsWith(LEGACY_WINDOW_NAME_PREFIX)) {
    const remembered = win.name.slice(LEGACY_WINDOW_NAME_PREFIX.length);
    peerId = isValidPeerId(remembered) ? remembered : null;
  }

  if (!peerId) {
    return null;
  }

  let nonce: string | null = null;
  if (fromUrl) {
    const hashNonce = new URLSearchParams(win.location.hash.replace(/^#/, '')).get(NONCE_HASH_PARAM);
    nonce = hashNonce !== null && NONCE_PATTERN.test(hashNonce) ? hashNonce : null;
    win.name = `${WINDOW_NAME_PREFIX}${peerId}`;
    if (win.location.hash) {
      win.history.replaceState(win.history.state, '', `${win.location.pathname}${win.location.search}`);
    }
  }

  target = { peerId, nonce };
  return { ...target };
};

/** True when this document is a Remote tab; read lazily so one call site works in both modes. */
export const isTargetMode = (): boolean => target !== null;

/** Thrown in a Remote tab for a request path that is not a plain absolute `/api/...`-style path. */
export class TargetUrlError extends Error {
  constructor(path: string) {
    super(`Refused request path in a Remote tab: ${JSON.stringify(path.slice(0, 80))}`);
    this.name = 'TargetUrlError';
  }
}

// What a tab may address: the API, the health probe and the two sockets. Nothing else is a place to send a token.
const ALLOWED_FIRST_SEGMENTS = new Set(['api', 'health', 'ws', 'shell']);

/**
 * True for absolute paths that stay below their own prefix: no `//host`, no
 * scheme, no backslash (browsers read it as `/`), no relative path and no `.` or
 * `..` segment, literal or percent-encoded.
 */
const isPlainAbsolutePath = (path: string, peerId: string): boolean => {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return false;
  const cut = path.search(/[?#]/);
  const pathname = cut === -1 ? path : path.slice(0, cut);
  const segments = pathname.slice(1).split('/');

  let decoded: string[];
  try {
    decoded = segments.map((segment) => decodeURIComponent(segment));
  } catch {
    return false;
  }
  if (decoded.some((segment) => segment === '.' || segment === '..' || segment.includes('\\'))) return false;

  // An already prefixed path is accepted only for this tab's own prefix.
  if (segments[0] === 'r') {
    return segments[1] === peerId && ALLOWED_FIRST_SEGMENTS.has(segments[2] ?? '');
  }
  return ALLOWED_FIRST_SEGMENTS.has(segments[0] ?? '');
};

/**
 * Prefixes an absolute path with `/r/<peerId>` in a Remote tab; identity in
 * Local mode. Idempotent, so URL builders and `authenticatedFetch` can both
 * apply it. In a Remote tab anything that is not a plain absolute path under
 * `/api`, `/health`, `/ws` or `/shell` throws a TargetUrlError: the tab token
 * must never be sent to `//host`, an absolute URL, or a path that climbs out of
 * its prefix.
 */
export const httpUrl = (path: string): string => {
  if (!target) {
    return path;
  }
  if (!isPlainAbsolutePath(path, target.peerId)) {
    throw new TargetUrlError(path);
  }
  const prefix = `/r/${target.peerId}`;
  if (path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`)) {
    return path;
  }
  return `${prefix}${path}`;
};

/** Absolute ws(s) URL for a socket path such as `/ws` or `/shell`, prefixed in a Remote tab. */
export const wsUrl = (path: string, location: Pick<Location, 'protocol' | 'host'> = window.location): string => {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}${httpUrl(path)}`;
};

// ─── Tab token ──────────────────────────────────────────────────────────────

type TokenClaims = Record<string, unknown>;

const decodeClaims = (token: unknown): TokenClaims | null => {
  if (typeof token !== 'string' || !JWT_PATTERN.test(token)) {
    return null;
  }
  try {
    const encoded = (token.split('.')[1] as string).replace(/-/g, '+').replace(/_/g, '/');
    const padded = encoded.padEnd(encoded.length + ((4 - (encoded.length % 4)) % 4), '=');
    const payload: unknown = JSON.parse(atob(padded));
    return payload && typeof payload === 'object' ? (payload as TokenClaims) : null;
  } catch {
    return null;
  }
};

// When the current token stops being usable on THIS browser's clock. The token's
// `exp` is on the server's clock, which can be far from ours, so a token that also
// carries `iat` is trusted for `exp - iat` from the moment it arrived instead.
// (authToken.ts has its own reader, but it imports this module, so no sharing.)
let tabTokenUsableUntil: number | null = null;

const computeUsableUntil = (token: string): number | null => {
  const claims = decodeClaims(token);
  const exp = claims?.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  const iat = claims?.iat;
  return typeof iat === 'number' && Number.isFinite(iat) && exp > iat ? Date.now() + (exp - iat) * 1000 : exp * 1000;
};

const isTabTokenExpired = (): boolean => tabTokenUsableUntil !== null && Date.now() >= tabTokenUsableUntil;

/** Stores (or clears) the tab token and tells subscribers; anything that is not JWT-shaped is ignored. */
export const setTabToken = (token: string | null): void => {
  if (token !== null && !JWT_PATTERN.test(token)) {
    return;
  }
  tabToken = token;
  tabTokenUsableUntil = token === null ? null : computeUsableUntil(token);
  for (const listener of tokenChangeListeners) {
    listener(token);
  }
};

/**
 * The tab token to put on the wire right now, or null when there is none or it
 * ran out. A missing or lapsed token asks the Controller page for a new one
 * (at most once a minute) instead of ending any session.
 */
export const getTabToken = (): string | null => {
  if (!target) {
    return null;
  }
  if (tabToken && !isTabTokenExpired()) {
    return tabToken;
  }
  requestTabToken();
  return null;
};

/** The signed-in user a tab shows, taken from the tab token's claims; display only, never an authority. */
export const readTabTokenUser = (): { id?: string | number; username: string } | null => {
  const claims = decodeClaims(tabToken);
  if (!claims || typeof claims.username !== 'string' || !claims.username) {
    return null;
  }
  const id = claims.userId;
  return typeof id === 'string' || typeof id === 'number'
    ? { id, username: claims.username }
    : { username: claims.username };
};

/** Subscribes to token swaps; returns the unsubscribe function. Used by the frame's channel and the auth context. */
export const onTabTokenChange = (listener: (token: string | null) => void): (() => void) => {
  tokenChangeListeners.add(listener);
  return () => {
    tokenChangeListeners.delete(listener);
  };
};

/** Subscribes to "I need a new token" requests, which the frame's channel forwards to the page. */
export const onTokenExpired = (listener: () => void): (() => void) => {
  tokenExpiredListeners.add(listener);
  return () => {
    tokenExpiredListeners.delete(listener);
  };
};

/**
 * Asks the Controller page for a fresh tab token. Rate limited to one request
 * per minute so a failing token cannot turn into a request storm; returns
 * whether a request was actually sent.
 */
export const requestTabToken = (): boolean => {
  const now = Date.now();
  if (now - lastTokenRequestAt < TAB_TOKEN_REQUEST_MIN_INTERVAL_MS) {
    return false;
  }
  lastTokenRequestAt = now;
  for (const listener of tokenExpiredListeners) {
    listener();
  }
  return true;
};

/**
 * WebSocket subprotocols that carry the tab token (`['remotecli-tab', token]`),
 * or undefined in Local mode and while no usable token exists. The token goes in
 * a subprotocol, never the URL, so it stays out of proxy logs. The one place
 * that assembles the subprotocol list; used when the chat and shell sockets open.
 */
export const wsProtocols = (): string[] | undefined => {
  const token = getTabToken();
  return token ? [TAB_TOKEN_SUBPROTOCOL, token] : undefined;
};

// ─── Link status ────────────────────────────────────────────────────────────

/** Announces a link or session problem; `session-expired` stays set until `session-restored`, so late subscribers still see it. */
export const emitLinkEvent = (event: TargetLinkEvent): void => {
  if (event.kind === 'session-expired') sessionExpired = true;
  if (event.kind === 'session-restored') sessionExpired = false;
  for (const listener of linkEventListeners) {
    listener(event);
  }
};

/** Subscribes to link events for the status overlay; returns the unsubscribe function. */
export const onLinkEvent = (listener: (event: TargetLinkEvent) => void): (() => void) => {
  linkEventListeners.add(listener);
  return () => {
    linkEventListeners.delete(listener);
  };
};

/** True while the tab has no usable session, even if the event fired before the overlay mounted. */
export const isSessionExpired = (): boolean => sessionExpired;

/**
 * Request-target canonicalizer: the first gate of the Host policy (FR-37, contracts section 3).
 *
 * The Controller is untrusted. Whatever path it sends is turned into ONE canonical form that is both
 * (a) what the allow-list matches on and (b) the only thing the bridge ever puts in a loopback URL, so
 * the policy and the Host's router can never disagree about what is being requested. A target that
 * cannot be canonicalized without guessing is refused, never repaired:
 *
 * - percent-decoding happens exactly once, per segment; anything that decodes to a separator
 *   (`%2f`, `%5c`), a dot segment (`%2e%2e`), `;`, a control/format character or a second layer of
 *   encoding (`%252e`) is refused;
 * - literal `.`/`..` segments and `//` are normalised (`..` above the root is refused); a leading `//`
 *   (protocol-relative URL), absolute URLs and anything not starting with `/` are refused;
 * - the forwarded path re-encodes each decoded segment, keeping the case the Controller used (file
 *   names such as `Report.PDF` reach the Host unchanged);
 * - query: every key that mentions `token` once decoded (`token`, `TOKEN`, `token[x]`, `[token]`,
 *   `%5Btoken%5D`, `tok%65n`, `access_token`...) is removed, because the stock WebSocket/SSE
 *   authentication reads `?token` before the Authorization header and qs (Express's parser) maps all of
 *   those spellings to `req.query.token`; a key encoded twice is refused (`bad-query`).
 */

import type { RemoteCanonicalizeResult, RemoteTargetRejection } from '@/shared/types.js';

import { MAX_PATH_CHARS as MAX_TARGET_CHARS } from '../mux/frames.js';

/** Path part alone (the whole target, query included, is capped by the mux codec's own ceiling above). */
const MAX_PATH_CHARS = 4096;
const MAX_SEGMENTS = 64;

/** Printable ASCII only: browsers percent-encode everything else, so anything else is hostile or broken. */
const RAW_TARGET_ALLOWED = /^[\x21-\x7e]*$/;
/** A decoded segment must not contain control (Cc), format (Cf: bidi overrides, zero width, BOM) or line/paragraph separators. */
const FORBIDDEN_DECODED = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
/** Two layers of encoding leave a `%hh` behind after the single decode. */
const LEFTOVER_ESCAPE = /%[0-9A-Fa-f]{2}/;
const SEGMENT_UNSAFE = /[^A-Za-z0-9\-._~!$&'()*+,:=@]/gu;

// ignoreBOM keeps a BOM in the text so it is refused as a format character.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const refuse = (reason: RemoteTargetRejection): RemoteCanonicalizeResult => ({ ok: false, reason });

const isHex = (code: number): boolean => (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);

/** Decodes the percent escapes of one raw (ASCII) segment exactly once; a rejection reason on failure. */
function decodeSegment(raw: string): { text: string } | { reason: RemoteTargetRejection } {
  if (!raw.includes('%')) return { text: raw };
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code !== 0x25) {
      bytes.push(code);
      continue;
    }
    // charCodeAt past the end is NaN, which isHex rejects: `%`, `%4` and `%zz` are all malformed.
    if (!isHex(raw.charCodeAt(i + 1)) || !isHex(raw.charCodeAt(i + 2))) return { reason: 'bad-percent-encoding' };
    bytes.push(Number.parseInt(raw.slice(i + 1, i + 3), 16));
    i += 2;
  }
  try {
    return { text: utf8.decode(Uint8Array.from(bytes)) };
  } catch {
    return { reason: 'invalid-utf8' };
  }
}

/** Percent-encodes one decoded segment for the forwarded path; sub-delimiters legal in a path segment stay literal. */
const encodeSegment = (segment: string): string => segment.replace(SEGMENT_UNSAFE, (character) => encodeURIComponent(character));

/** Decodes a query key the way `qs` does: `+` is a space, one pass, a malformed escape leaves the key as written. */
function decodeQueryKey(rawKey: string): string {
  const spaced = rawKey.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
}

/**
 * The key `qs` reads from one `&` part: everything before the first `]=` (the `]` included), else
 * before the first `=`, else the whole part. Taking the same cut keeps this check from disagreeing with
 * the parser about where the key ends (`a=1]=x` has the key `a=1]`).
 */
function queryKeyOf(part: string): string {
  const bracketEquals = part.indexOf(']=');
  const end = bracketEquals >= 0 ? bracketEquals + 1 : part.indexOf('=');
  return end < 0 ? part : part.slice(0, end);
}

/**
 * Removes every key that mentions `token` from a raw query string; null when the query itself is
 * hostile. This is deliberately broader than "the keys qs maps to `req.query.token`" (`token`,
 * `token[x]`, `[token]`, `%5Btoken%5D`, `tok%65n`...): the stock authentication reads `req.query.token`,
 * and a list of spellings is exactly what bracket and percent forms outwit. The key is decoded once; a
 * key that still holds an escape was encoded twice and is refused, as in the path.
 */
function sanitizeQuery(rawQuery: string | undefined): string | null {
  if (!rawQuery) return '';
  if (/%00/i.test(rawQuery)) return null;
  const kept: string[] = [];
  for (const part of rawQuery.split('&')) {
    if (part === '') continue;
    const key = decodeQueryKey(queryKeyOf(part));
    if (LEFTOVER_ESCAPE.test(key)) return null;
    if (key.toLowerCase().includes('token')) continue;
    kept.push(part);
  }
  return kept.length > 0 ? `?${kept.join('&')}` : '';
}

/**
 * Canonicalizes a request target (`/path?query`) from the Controller. Used by the route allow-list
 * (matching) and, through it, by the Host bridge (the only path that reaches the loopback URL).
 */
export function canonicalizeRequestTarget(target: string): RemoteCanonicalizeResult {
  if (typeof target !== 'string') return refuse('not-origin-form');
  if (target.length > MAX_TARGET_CHARS) return refuse('too-long');
  if (!RAW_TARGET_ALLOWED.test(target) || target.includes('#')) return refuse('illegal-character');

  const questionMark = target.indexOf('?');
  const rawPath = questionMark < 0 ? target : target.slice(0, questionMark);
  const rawQuery = questionMark < 0 ? undefined : target.slice(questionMark + 1);

  if (!rawPath.startsWith('/')) return refuse('not-origin-form');
  if (rawPath.startsWith('//')) return refuse('protocol-relative');
  if (rawPath.length > MAX_PATH_CHARS) return refuse('too-long');
  if (rawPath.includes('\\')) return refuse('backslash');
  if (rawPath.includes(';')) return refuse('path-parameter');

  const segments: string[] = [];
  for (const rawSegment of rawPath.slice(1).split('/')) {
    if (rawSegment === '' || rawSegment === '.') continue;
    if (rawSegment === '..') {
      if (segments.pop() === undefined) return refuse('traversal-above-root');
      continue;
    }
    const decoded = decodeSegment(rawSegment);
    if ('reason' in decoded) return refuse(decoded.reason);
    const { text } = decoded;
    if (text === '.' || text === '..') return refuse('encoded-dot-segment');
    if (text.includes('/') || text.includes('\\')) return refuse('encoded-separator');
    if (text.includes(';')) return refuse('path-parameter');
    if (FORBIDDEN_DECODED.test(text)) return refuse('control-character');
    if (LEFTOVER_ESCAPE.test(text)) return refuse('double-encoding');
    // Windows (and some Host file APIs) ignore trailing dots and spaces, which would alias another name.
    if (text.endsWith('.') || text.endsWith(' ')) return refuse('trailing-dot');
    segments.push(text);
    if (segments.length > MAX_SEGMENTS) return refuse('too-long');
  }

  const query = sanitizeQuery(rawQuery);
  if (query === null) return refuse('bad-query');

  return {
    ok: true,
    canonical: { path: segments.length === 0 ? '/' : `/${segments.map(encodeSegment).join('/')}`, segments, query },
  };
}

/**
 * Two-way header allow-lists of the Host bridge (FR-36, contracts section 7). Nothing but the listed
 * headers crosses in either direction; everything else (cookies, Authorization, Origin, forwarding
 * and hop-by-hop headers, Set-Cookie, X-Refreshed-Token, X-Auth-Error, Location, the Host's own CSP,
 * ...) is dropped by construction, not by a deny-list that can fall behind.
 *
 * Controller -> Host: the Controller supplies a handful of content/negotiation headers. The bridge
 * sets `Host`, `Authorization` and `x-api-key` itself; `Transfer-Encoding` is never forwarded, and
 * `Content-Length` must be a plain decimal, so a request cannot be desynchronised on the loopback
 * connection. Ambiguity (a header spelled twice, several values) is refused rather than guessed.
 *
 * Host -> Controller: `cache-control` is always `no-store` (one pairing's content must not be cached
 * for another). Content the Host serves is untrusted in the Controller's origin: EVERY response is
 * forced to `X-Content-Type-Options: nosniff`, and unless it is JSON or an event stream it also gets
 * `Content-Security-Policy: sandbox; default-src 'none'` so an HTML/SVG file opened top-level cannot
 * run script.
 */

import type { IncomingHttpHeaders } from 'node:http';

import type { RemoteMuxHeaders } from '@/shared/types.js';

import { MAX_HEADER_VALUE_CHARS } from '../mux/frames.js';

/** Request headers a Controller may send (contracts section 7). */
// Consumed by: header-filter, header tests.
export const REQUEST_HEADER_ALLOW_LIST: readonly string[] = [
  'content-type',
  'content-length',
  'accept',
  'accept-language',
  'if-none-match',
  'if-modified-since',
  'range',
  'x-request-id',
];

/** Response headers the Host may return (contracts section 7); `cache-control` is overridden. */
// Consumed by: header-filter, header tests.
export const RESPONSE_HEADER_ALLOW_LIST: readonly string[] = [
  'content-type',
  'content-length',
  'content-disposition',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
  'cache-control',
  'x-request-id',
];

/** CSP forced on every Host response that is not JSON or an event stream (`nosniff` is forced on all of them). No `allow-*` token: no scripts, no forms, no popups. */
// Consumed by: header-filter, header tests, the Controller proxy tests.
export const SANDBOX_CSP = "sandbox; default-src 'none'";

/** Visible ASCII plus space and tab: no CR/LF/NUL/DEL, nothing that could end a header line. */
const SAFE_REQUEST_VALUE = /^[\t\x20-\x7e]*$/;
const CONTENT_LENGTH = /^(?:0|[1-9]\d{0,14})$/;
const JSON_OR_SSE = /^(?:application\/(?:[a-z0-9.!#$&^_-]+\+)?json|text\/event-stream)$/i;

const REQUEST_ALLOWED = new Set(REQUEST_HEADER_ALLOW_LIST);
const RESPONSE_ALLOWED = new Set(RESPONSE_HEADER_ALLOW_LIST);

/**
 * Outcome of filtering the Controller's headers: the headers to send, or why the request is refused.
 * Consumed by: the Host bridge (`bridge-http-stream`), the Controller proxy's early checks, header tests.
 */
export type RequestHeaderVerdict =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: 'duplicate-header' | 'invalid-header-value' | 'invalid-content-length' };

/**
 * Filters the headers of a Controller HTTP request. Consumed by: the Host bridge, which adds its own
 * `Host`, `Authorization` and `x-api-key` after this.
 */
export function filterRequestHeaders(headers: RemoteMuxHeaders): RequestHeaderVerdict {
  const forwarded: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (!REQUEST_ALLOWED.has(name)) continue;
    if (Object.hasOwn(forwarded, name)) return { ok: false, reason: 'duplicate-header' };
    const value = Array.isArray(rawValue) ? (rawValue.length === 1 ? rawValue[0] : undefined) : rawValue;
    if (typeof value !== 'string' || value.length > MAX_HEADER_VALUE_CHARS || !SAFE_REQUEST_VALUE.test(value)) {
      return { ok: false, reason: 'invalid-header-value' };
    }
    if (name === 'content-length' && !CONTENT_LENGTH.test(value)) return { ok: false, reason: 'invalid-content-length' };
    forwarded[name] = value;
  }
  return { ok: true, headers: forwarded };
}

/**
 * True for JSON (`application/json`, `application/*+json`) and Server-Sent Events: the only response
 * types that need no sandbox. Parameters are ignored; the media type itself must match exactly, so
 * `text/html; x=application/json` is not JSON. Consumed by: filterResponseHeaders.
 */
export function isJsonOrEventStream(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  return JSON_OR_SSE.test(contentType.split(';', 1)[0].trim());
}

/**
 * Filters the headers of a Host response before they travel to the Controller. Consumed by: the Host
 * bridge when it builds `HTTP_RES`.
 */
export function filterResponseHeaders(upstream: IncomingHttpHeaders): RemoteMuxHeaders {
  const forwarded: RemoteMuxHeaders = {};
  for (const name of RESPONSE_HEADER_ALLOW_LIST) {
    if (name === 'cache-control') continue;
    const raw = upstream[name];
    const value = Array.isArray(raw) ? (raw.length > 0 ? raw.join(', ') : undefined) : raw;
    if (value === undefined || value.length > MAX_HEADER_VALUE_CHARS) continue;
    if (name === 'content-length' && !CONTENT_LENGTH.test(value)) continue;
    forwarded[name] = value;
  }
  forwarded['cache-control'] = 'no-store';
  // nosniff costs nothing and keeps JSON/SSE safe even if the exemption below were ever loosened.
  forwarded['x-content-type-options'] = 'nosniff';
  if (!isJsonOrEventStream(typeof forwarded['content-type'] === 'string' ? forwarded['content-type'] : undefined)) {
    forwarded['content-security-policy'] = SANDBOX_CSP;
  }
  return forwarded;
}

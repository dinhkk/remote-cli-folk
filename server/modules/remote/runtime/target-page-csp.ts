/**
 * The Content-Security-Policy of the HTML served with `?target=` (contracts section 3).
 *
 * A Remote tab is the Local app running in a sandboxed iframe, so script that gets into it (through text the
 * Host controls) holds the tab token. The policy keeps that script from sending the token anywhere but the
 * Controller itself: every fetch type defaults to the page's own origin (`default-src 'self'`), which for an
 * opaque-origin sandboxed document is the URL the page was loaded from, and the channels that need no fetch
 * to leave (forms, `<base>`, plugins, framing by another site) are closed. Images and fonts may also be
 * `data:` (the app inlines small ones), images and workers `blob:`, and styles may be inline (the UI libraries
 * set `style` attributes).
 *
 * `index.html` carries small inline scripts (the Remote tab storage shim, which must run before anything else,
 * the stale-asset notice and the service-worker registration). `script-src` therefore lists their SHA-256
 * hashes, read from the built `index.html` when the policy is first needed (and again if the file changes):
 * no `'unsafe-inline'`, no `blob:`, no other origin.
 *
 * `connect-src` allows the Controller's own origin only. `'self'` covers its http(s) URLs; the page's
 * WebSocket URLs (`ws:`/`wss:` on the same host) are listed explicitly, because some WebKit versions do not
 * match `'self'` against WebSocket schemes.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';

/** The policy without the inline-script hashes. */
// Consumed by: the Remote module's `?target=` middleware, the tests.
export const TARGET_PAGE_CSP = [
  "default-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

const HOST_HEADER = /^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/**
 * `ws://<host> wss://<host>` for the host the page was requested with: the WebSocket form of the page's own
 * origin. Anything that is not a plain host[:port] (or `[ipv6]:port`) yields nothing, so a header can never
 * add another source to the policy.
 */
// Consumed by: the target and main page policies, the tests.
export const sameHostSocketSources = (host: string | undefined): string[] =>
  typeof host === 'string' && HOST_HEADER.test(host) ? [`ws://${host}`, `wss://${host}`] : [];

/**
 * Adds `script-src 'self' <hashes>` right after `default-src` (only when there are hashes) and the page's own
 * WebSocket sources to `connect-src`.
 */
// Consumed by: createTargetPageCsp, the tests.
export const buildTargetPageCsp = (scriptHashes: readonly string[], socketSources: readonly string[] = []): string => {
  let policy = TARGET_PAGE_CSP;
  if (scriptHashes.length > 0) policy = policy.replace("default-src 'self'", `default-src 'self'; script-src 'self' ${scriptHashes.join(' ')}`);
  if (socketSources.length > 0) policy = policy.replace("connect-src 'self'", `connect-src 'self' ${socketSources.join(' ')}`);
  return policy;
};

/** `'sha256-...'` sources for every inline `<script>` of the HTML file (empty when it cannot be read). */
// Consumed by: createTargetPageCsp, the tests.
export const readInlineScriptHashes = (htmlPath: string): string[] => {
  let html: string;
  try {
    html = fs.readFileSync(htmlPath, 'utf8');
  } catch {
    return [];
  }
  const hashes = new Set<string>();
  for (const [, attributes, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/(?:^|\s)src\s*=/i.test(attributes) || body.trim() === '') continue;
    hashes.add(`'sha256-${crypto.createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }
  return [...hashes];
};

/**
 * Returns the inline-script hashes of `index.html`, read again only when the file changes. Without a path or
 * a readable file (development) there is nothing inline to allow.
 */
// Consumed by: createTargetPageCsp, the main page headers.
export function createInlineScriptHashReader(indexHtmlPath?: string): () => string[] {
  let cached: { mtimeMs: number; hashes: string[] } | undefined;
  return () => {
    if (!indexHtmlPath) return [];
    try {
      const { mtimeMs } = fs.statSync(indexHtmlPath);
      if (cached?.mtimeMs !== mtimeMs) cached = { mtimeMs, hashes: readInlineScriptHashes(indexHtmlPath) };
      return cached.hashes;
    } catch {
      return [];
    }
  };
}

/**
 * Creates the function that returns the policy for the next `?target=` page, given the Host header the page
 * was requested with. With an `index.html` path the inline-script hashes are included and refreshed when the
 * file changes.
 */
// Consumed by: the Remote module.
export function createTargetPageCsp(indexHtmlPath?: string): (host?: string) => string {
  const hashes = createInlineScriptHashReader(indexHtmlPath);
  return (host) => buildTargetPageCsp(hashes(), sameHostSocketSources(host));
}

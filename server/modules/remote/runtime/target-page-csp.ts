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
 * `index.html` carries two small inline scripts (the Remote tab storage shim, which must run before anything
 * else, and the service-worker registration). `script-src` therefore lists their SHA-256 hashes, read from the
 * built `index.html` when the policy is first needed (and again if the file changes): no `'unsafe-inline'`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';

/** The policy without the inline-script hashes. */
// Consumed by: the Remote module's `?target=` middleware, the tests.
export const TARGET_PAGE_CSP = [
  "default-src 'self'",
  "connect-src 'self' https: wss: http: ws:",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

/** Adds `script-src 'self' <hashes>` right after `default-src`; unchanged when there are no hashes. */
// Consumed by: createTargetPageCsp, the tests.
export const buildTargetPageCsp = (scriptHashes: readonly string[]): string =>
  scriptHashes.length === 0 ? TARGET_PAGE_CSP : TARGET_PAGE_CSP.replace("default-src 'self'", `default-src 'self'; script-src 'self' ${scriptHashes.join(' ')}`);

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
 * Creates the function that returns the policy for the next `?target=` page. With an `index.html` path the
 * inline-script hashes are included and refreshed when the file changes; without one it is the plain policy.
 */
// Consumed by: the Remote module.
export function createTargetPageCsp(indexHtmlPath?: string): () => string {
  let cached: { mtimeMs: number; policy: string } | undefined;
  return () => {
    if (!indexHtmlPath) return TARGET_PAGE_CSP;
    try {
      const { mtimeMs } = fs.statSync(indexHtmlPath);
      if (cached?.mtimeMs !== mtimeMs) cached = { mtimeMs, policy: buildTargetPageCsp(readInlineScriptHashes(indexHtmlPath)) };
      return cached.policy;
    } catch {
      return TARGET_PAGE_CSP; // no built page (development): nothing inline to allow
    }
  };
}

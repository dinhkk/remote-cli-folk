/**
 * Security headers for the Controller's main page (NFR-12, phase 13). The Controller serves the remotecli UI
 * to a browser and, in a Remote tab, to a sandboxed iframe, so the page must not be framed by another site,
 * must not take over its base URL and must not embed plugins. Scripts may come from the page's own origin
 * and the inline scripts of the built `index.html` (by SHA-256 hash, as on the tab page), and the page may
 * connect only to its own origin, its WebSocket form included. Styles, images and fonts are not restricted.
 *
 * - every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`;
 * - document requests (GET/HEAD of an HTML route: `/`, `/index.html`, SPA routes; not `/api`, `/r`, files,
 *   not `?target=` pages): `Content-Security-Policy: script-src 'self' <hashes>; connect-src 'self' ws://<host>
 *   wss://<host>; worker-src 'self' blob:; frame-ancestors 'self'; base-uri 'self'; object-src 'none'`.
 *
 * This changes the Local UI for everybody on the server, Remote user or not: the UI can no longer be framed by
 * another origin (a dashboard/portal, an IDE's simple browser, a reverse-proxy portal that frames it) and
 * outbound requests carry no referrer to other sites. `REMOTECLI_REMOTE_MAIN_PAGE_HEADERS=0` (or legacy `CLOUDCLI_REMOTE_MAIN_PAGE_HEADERS=0`) (default on) drops
 * exactly those two changes (`frame-ancestors` and `Referrer-Policy`) and keeps `nosniff`, `base-uri` and
 * `object-src`, without turning Remote off.
 *
 * With `REMOTECLI_REMOTE_DISABLED=1` (or legacy `CLOUDCLI_REMOTE_DISABLED=1`) the module mounts nothing, so the server answers exactly as before.
 */

import type { NextFunction, Request, Response } from 'express';

import { createInlineScriptHashReader, sameHostSocketSources } from './target-page-csp.js';

export type MainPageHeaderOptions = {
  /** Add `frame-ancestors 'self'` to the main page policy. */
  frameAncestors: boolean;
  /** Send `Referrer-Policy: same-origin`. */
  referrerPolicy: boolean;
};

export type MainPageCspInput = Pick<MainPageHeaderOptions, 'frameAncestors'> & {
  /** `'sha256-…'` sources of the inline scripts of the built `index.html`. */
  scriptHashes?: readonly string[];
  /** The page's own WebSocket sources (`ws://<host> wss://<host>`). */
  socketSources?: readonly string[];
};

/** The policy of the main page; `frame-ancestors` is left out when framing protection is turned off. */
export const buildMainPageCsp = ({ frameAncestors, scriptHashes = [], socketSources = [] }: MainPageCspInput = { frameAncestors: true }): string =>
  [
    ['script-src', "'self'", ...scriptHashes].join(' '),
    ['connect-src', "'self'", ...socketSources].join(' '),
    "worker-src 'self' blob:",
    ...(frameAncestors ? ["frame-ancestors 'self'"] : []),
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; ');

export const MAIN_PAGE_CSP = buildMainPageCsp();

/** `REMOTECLI_REMOTE_MAIN_PAGE_HEADERS` (or legacy `CLOUDCLI_...`): on unless it is 0, false, off or no. */
export const resolveMainPageHeaderOptions = (env: NodeJS.ProcessEnv): MainPageHeaderOptions => {
  const headerEnv = env.REMOTECLI_REMOTE_MAIN_PAGE_HEADERS ?? env.CLOUDCLI_REMOTE_MAIN_PAGE_HEADERS;
  const off = ['0', 'false', 'off', 'no'].includes(headerEnv?.trim().toLowerCase() ?? '');
  return { frameAncestors: !off, referrerPolicy: !off };
};

const API_PREFIXES = ['/api/', '/r/', '/ws', '/shell', '/plugin-ws/', '/health'];

/** True for a request that is answered with an HTML page of the app (not an API call, an asset or a `?target=` tab page). */
// Consumed by: the middleware below, the tests.
export const isMainPageRequest = (req: Pick<Request, 'method' | 'path' | 'query'>): boolean => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (req.query.target !== undefined) return false; // tab pages keep their own, stricter policy
  const path = req.path.toLowerCase();
  if (API_PREFIXES.some((prefix) => path === prefix.replace(/\/$/, '') || path.startsWith(prefix))) return false;
  return !/\.[a-z0-9]+$/.test(path.replace(/\.html$/, ''));
};

/**
 * Express middleware: mount before the static handler and the SPA fallback. With an `index.html` path its
 * inline-script hashes are allowed (and refreshed when the file changes).
 */
// Consumed by: the Remote module's `mount`.
export const createMainPageSecurityHeaders = (
  options: MainPageHeaderOptions = { frameAncestors: true, referrerPolicy: true },
  indexHtmlPath?: string,
) => {
  const scriptHashes = createInlineScriptHashReader(indexHtmlPath);
  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (options.referrerPolicy) res.setHeader('Referrer-Policy', 'same-origin');
    if (isMainPageRequest(req)) {
      res.setHeader('Content-Security-Policy', buildMainPageCsp({
        frameAncestors: options.frameAncestors, scriptHashes: scriptHashes(), socketSources: sameHostSocketSources(req.headers.host),
      }));
    }
    next();
  };
};

export const mainPageSecurityHeaders = createMainPageSecurityHeaders();

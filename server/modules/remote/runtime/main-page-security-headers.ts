/**
 * Minimal security headers for the Controller's main page (NFR-12, phase 13). The Controller serves the
 * remotecli UI to a browser and, in a Remote tab, to a sandboxed iframe, so the page must not be framed by
 * another site, must not take over its base URL and must not embed plugins. Nothing else is restricted: a
 * full script/style policy would break the Local UI (inline bootstrap scripts, third-party fonts, plugin
 * UIs) for little gain, and the tab page (`?target=`) already has the strict policy of contracts section 3.
 *
 * - every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`;
 * - document requests (GET/HEAD of an HTML route: `/`, `/index.html`, SPA routes; not `/api`, `/r`, files,
 *   not `?target=` pages): `Content-Security-Policy: frame-ancestors 'self'; base-uri 'self'; object-src 'none'`.
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

export type MainPageHeaderOptions = {
  /** Add `frame-ancestors 'self'` to the main page policy. */
  frameAncestors: boolean;
  /** Send `Referrer-Policy: same-origin`. */
  referrerPolicy: boolean;
};

/** The policy of the main page; without framing protection it only keeps `base-uri` and `object-src`. */
export const buildMainPageCsp = (options: Pick<MainPageHeaderOptions, 'frameAncestors'> = { frameAncestors: true }): string =>
  [...(options.frameAncestors ? ["frame-ancestors 'self'"] : []), "base-uri 'self'", "object-src 'none'"].join('; ');

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

/** Express middleware: mount before the static handler and the SPA fallback. */
// Consumed by: the Remote module's `mount`.
export const createMainPageSecurityHeaders = (options: MainPageHeaderOptions = { frameAncestors: true, referrerPolicy: true }) => {
  const csp = buildMainPageCsp(options);
  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (options.referrerPolicy) res.setHeader('Referrer-Policy', 'same-origin');
    if (isMainPageRequest(req)) res.setHeader('Content-Security-Policy', csp);
    next();
  };
};

export const mainPageSecurityHeaders = createMainPageSecurityHeaders();

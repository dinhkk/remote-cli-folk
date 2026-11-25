/**
 * Policy of the HTML preview document: a sandbox without `allow-same-origin` (opaque origin: no cookie, no
 * storage, no access to the app), inline script and style only, no network source of any kind.
 */
export const HTML_PREVIEW_CSP = [
  'sandbox allow-scripts',
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join('; ');

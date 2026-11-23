/** Exact method/path allowlist; a locked browser session cannot use other APIs. */
export function isLockedSessionRouteAllowed(method: string, url: string): boolean {
  const path = url.split('?', 1)[0];
  return (method === 'GET' && (path === '/api/auth/status' || path === '/api/auth/session-status'))
    || (method === 'POST' && (path === '/api/auth/unlock' || path === '/api/auth/logout'));
}

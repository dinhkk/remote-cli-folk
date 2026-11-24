/**
 * Routes a Remote tab must never ask the Host for.
 *
 * The Host's allow-list is the real gate (it answers 403 and writes an audit
 * line); this is the client-side mirror that keeps a booting tab from producing
 * a wall of refused requests. `authenticatedFetch` answers a blocked call with a
 * local 403 instead of sending it, so every current and future caller of the
 * `api.*` helpers is covered without being edited one by one.
 *
 * The list mirrors the Host's deny rules (`server/modules/remote/policy/route-rules.ts`,
 * settled against the mounted routes by the route inventory test). It is only a courtesy:
 * the Host decides.
 */

const BLOCKED_PREFIXES = [
  '/api/plugins',
  '/api/taskmaster',
  '/api/settings',
  '/api/voice',
  '/api/notifications',
  '/api/browser-use',
  '/api/browser-use-mcp',
  '/api/system',
  '/api/agent',
  '/api/remote',
  '/api/user/git-config',
  // The tab keeps its preferences in its own storage; the Host's are neither read nor written.
  '/api/user/preferences',
  // The Host's own provider administration (MCP definitions carry commands and secrets).
  '/api/providers/mcp',
] as const;

// TaskMaster details of one project (`/api/projects/:id/taskmaster`) are part of
// the taskmaster family, which a tab never shows.
const PROJECT_TASKMASTER = /^\/api\/projects\/[^/]+\/taskmaster(\/|$)/;

// Provider login status (`/api/providers/:id/auth/status`) and CLI install/update, MCP server
// configuration and the Claude settings-file rules are Host administration. The Host answers 403 to
// all of them; refusing here keeps the settings panels from producing a wall of refused requests
// (the agent login panel would otherwise poll the Host's auth status for every provider).
// The Local HTML preview page runs the file's script; a tab only displays HTML and never loads it.
const HTML_PREVIEW = /^\/api\/file-tree\/projects\/[^/]+\/files\/html-preview(\/|$)/;

const PROVIDER_ADMIN = /^\/api\/providers\/[^/]+\/(auth|cli|mcp|settings-permissions)(\/|$)/;

const stripQuery = (path: string): string => {
  const cut = path.search(/[?#]/);
  return cut === -1 ? path : path.slice(0, cut);
};

const decodeForMatch = (path: string): string => {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};

/**
 * Tells whether a request would be refused by the Host before it is sent.
 * Used by authenticatedFetch in a Remote tab; `path` is the unprefixed
 * `/api/...` path, matched case-insensitively like the Host does.
 */
export const isBlockedInTargetMode = (path: string): boolean => {
  // Matched on the decoded path, so `/api/%70lugins` is the plugins route too.
  const lowered = decodeForMatch(stripQuery(path)).toLowerCase();

  if (BLOCKED_PREFIXES.some((prefix) => lowered === prefix || lowered.startsWith(`${prefix}/`))) {
    return true;
  }
  return PROJECT_TASKMASTER.test(lowered) || PROVIDER_ADMIN.test(lowered) || HTML_PREVIEW.test(lowered);
};

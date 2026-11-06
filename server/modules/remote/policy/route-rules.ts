/**
 * The Host's route table for a remote Controller (FR-37, AC-13, contracts section 7): data only.
 * `route-allow-list.ts` matches against it; the route inventory test (`route-inventory.test.ts`) proves
 * that every route the server mounts is covered by exactly this table, and the report
 * `reports/route-inventory-261104.md` is generated from it.
 *
 * ALLOW is an exact list: one rule per (method, path pattern) of a route that exists on the Host. A
 * route nobody listed is refused (`route-unknown`), so adding a route to the server turns the inventory
 * test red until someone classifies it here. DENY rules win over everything and cover whole families
 * the Host keeps for itself.
 *
 * Pattern syntax: literal segments, `*` = exactly one segment (an Express `:param`), a trailing `/**` =
 * the prefix itself and anything below it.
 *
 * Both tables are SURFACE REDUCTION, not a security boundary against a hostile paired Controller, and
 * they do NOT keep secrets away from one. A paired Controller is a FULL-TRUST grant: it already has a shell
 * as the Host OS user (`/shell`), and the file read routes accept any absolute path under `WORKSPACES_ROOT`
 * (default: the home directory). So a single `GET /api/file-tree/projects/<any project id>/file?filePath=<absolute>`
 * (or `/files/content?path=`), with an id from `GET /api/projects`, returns `~/.cloudcli/auth.db` (JWT secret,
 * API keys, GitHub tokens), `~/.cloudcli/remote-master.key`, `~/.ssh/*` and `~/.aws/*`: no `create-project`
 * is needed first. On a Host paired with several Controllers each of them can therefore read the others'
 * sealed pairing data. What the tables do give: the honest UI never offers the denied routes in Remote, a
 * buggy or modified Controller cannot trip them by accident, and Host-only administration (accounts, API keys,
 * provider login, MCP/agent configuration, updates) stays out of the tab. Do not describe them as "secrets
 * stay out of the tab". Whether to add a Host-side path denylist is a pending USER DECISION (contracts section 10).
 *
 * Likewise no ALLOW rule is a command-execution boundary: file PUT + `/api/git/*` can run commands through
 * a repository's own git config/hooks, skills POST writes code the next agent run loads, clone can spend a
 * stored GitHub token. The notes on those rules say so.
 */

/** One row of a table. `methods` omitted on a deny rule means every method. Consumed by: the matcher, policy tests, the inventory report. */
export type RouteRule = { pattern: string; methods?: readonly string[]; note: string };

/** The only HTTP methods a Controller may use (requirements section 6). */
// Consumed by: route-allow-list (method gate), route-allow-list tests.
export const ALLOWED_HTTP_METHODS: readonly string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * Always blocked. Evaluated before the allow rules. Consumed by: route-allow-list (matching), policy
 * tests (one case per rule), the inventory report.
 */
export const REMOTE_DENY_RULES: readonly RouteRule[] = [
  { pattern: '/api/auth/**', note: 'login, refresh, logout-all: the Controller authenticates its own users, and the Host session is not minted from a loopback token (/refresh would return a 7-day JWT)' },
  { pattern: '/api/settings/**', note: 'API keys, stored credentials, push subscriptions: Host administration with secrets' },
  { pattern: '/api/notifications/**', note: 'notification endpoints of the Host user' },
  { pattern: '/api/plugins/**', note: 'plugin install/update/RPC run code on the Host outside the UI contract' },
  { pattern: '/plugin-ws/**', note: 'plugin WebSocket proxy' },
  { pattern: '/desktop-notifications', note: 'desktop notification socket of the Host' },
  { pattern: '/api/system/**', note: 'self-update of the Host installation' },
  { pattern: '/api/agent/**', note: 'external agent API (API-key authenticated, not a UI route)' },
  { pattern: '/api/browser-use/**', note: 'browser control is close to remote desktop (policy)' },
  { pattern: '/api/browser-use-mcp/**', note: 'browser MCP bridge (local token protected)' },
  { pattern: '/api/user/git-config', note: 'Host git identity (name/e-mail)' },
  { pattern: '/api/user/preferences', note: 'tab preferences live on the Controller (contracts section 3); the target-mode UI neither reads nor writes the Host preferences (userSettings.ts skips hydrate and server writes)' },
  { pattern: '/api/taskmaster/**', note: 'TaskMaster is out of scope for Remote' },
  { pattern: '/api/projects/*/taskmaster', methods: ['GET'], note: 'TaskMaster details of a project: part of the TaskMaster family a tab never shows' },
  { pattern: '/api/voice/**', note: 'voice endpoints are out of scope for Remote' },
  { pattern: '/api/remote/**', note: 'Remote management is local-only and never travels through the relay' },
  { pattern: '/api/providers/*/cli', note: 'global CLI install/update status of a provider' },
  { pattern: '/api/providers/*/cli/**', note: 'global CLI install/update of a provider' },
  { pattern: '/api/providers/*/auth', note: 'provider login is meant to happen on the Host itself (the tab UI does not request it; not enforced: a Controller can still run a login command through /shell)' },
  { pattern: '/api/providers/*/auth/**', note: 'provider login status/flow: the target-mode UI answers it locally (api.ts mirror) instead of polling the Host' },
  { pattern: '/api/providers/*/mcp/**', note: 'MCP server definitions carry commands and secret env/headers; listing and writing them is Host configuration' },
  { pattern: '/api/providers/mcp/**', note: 'adds an MCP server to every provider at once: global Host configuration write' },
  { pattern: '/api/providers/*/settings-permissions', note: 'contents of the Host Claude settings files; informational only (the permission panel degrades without it)' },
  { pattern: '/health', note: 'the Controller answers its own /health; the Host never serves it through the relay' },
  { pattern: '/r/**', note: 'Controller proxy mount: a Host must not be used as a hop to another Host' },
];

const allow = (method: string, pattern: string, note: string): RouteRule & { methods: readonly string[] } => ({ pattern, methods: [method], note });

const PROJECTS = 'projects and their session lists';
const FILES = 'workspace file tree';
const GIT = 'git operations of a project (git runs the repository\'s own config and hooks: with file PUT this is a command-execution path, same reach as /shell)';
const PROVIDER_SESSIONS = 'provider-neutral chat sessions';
const PROVIDER_CONFIG = 'models, capabilities and skills the chat composer needs';

/**
 * What a Controller may reach: every route of the Host UI contract except the secret/admin ones above.
 * Consumed by: route-allow-list (matching), policy tests (rule x method matrix), the inventory test
 * (every rule must still match a mounted route), the inventory report.
 */
export const REMOTE_ALLOW_RULES: ReadonlyArray<RouteRule & { methods: readonly string[] }> = [
  allow('GET', '/api/projects', PROJECTS),
  allow('GET', '/api/projects/archived', PROJECTS),
  allow('GET', '/api/projects/*/sessions', PROJECTS),
  allow('POST', '/api/projects/create-project', 'create a project for a folder on the Host'),
  allow('POST', '/api/projects/migrate-legacy-stars', 'one-time star migration the sidebar triggers'),
  allow('POST', '/api/projects/clone', 'start a clone (token travels in the body, never in a URL); with `githubTokenId` it SPENDS a GitHub token stored on the Host (github.com only, the token is never read back) and a cloned private repo is then readable through the file API'),
  allow('GET', '/api/projects/clone-progress', 'clone progress (SSE)'),
  allow('PUT', '/api/projects/*/rename', PROJECTS),
  allow('POST', '/api/projects/*/toggle-star', PROJECTS),
  allow('POST', '/api/projects/*/restore', PROJECTS),
  allow('DELETE', '/api/projects/*', 'archive or hard-delete a project (workspace lifecycle); `?force=true` also deletes its transcripts (*.jsonl)'),

  allow('GET', '/api/file-tree/browse-filesystem', 'folder picker of the new-project flow (a shell reaches the same folders)'),
  allow('POST', '/api/file-tree/create-folder', 'folder picker of the new-project flow'),
  allow('GET', '/api/file-tree/projects/*/file', `${FILES}; reads ANY absolute path under WORKSPACES_ROOT (default: home), not only the project root`),
  allow('GET', '/api/file-tree/projects/*/files/content', 'raw file bytes of ANY absolute path under WORKSPACES_ROOT (default: home); the Controller forces nosniff + sandbox CSP on non-JSON answers'),
  allow('PUT', '/api/file-tree/projects/*/file', `${FILES}; writes inside the project root, which can include a repository's .git/config or hooks (they run under /api/git/* calls)`),
  allow('GET', '/api/file-tree/projects/*/files', FILES),
  allow('POST', '/api/file-tree/projects/*/files/create', FILES),
  allow('PUT', '/api/file-tree/projects/*/files/rename', FILES),
  allow('DELETE', '/api/file-tree/projects/*/files', FILES),
  allow('POST', '/api/file-tree/projects/*/files/upload', 'multipart upload, up to 25 MiB of request body through Remote'),

  allow('GET', '/api/git/status', GIT),
  allow('POST', '/api/git/init', GIT),
  allow('GET', '/api/git/diff', GIT),
  allow('GET', '/api/git/file-with-diff', GIT),
  allow('POST', '/api/git/initial-commit', GIT),
  allow('POST', '/api/git/commit', GIT),
  allow('POST', '/api/git/stage', GIT),
  allow('POST', '/api/git/unstage', GIT),
  allow('POST', '/api/git/revert-local-commit', GIT),
  allow('GET', '/api/git/branches', GIT),
  allow('GET', '/api/git/branch-diff', GIT),
  allow('GET', '/api/git/branch-diff/file', GIT),
  allow('POST', '/api/git/checkout', GIT),
  allow('POST', '/api/git/create-branch', GIT),
  allow('POST', '/api/git/delete-branch', GIT),
  allow('GET', '/api/git/commits', GIT),
  allow('GET', '/api/git/commit-diff', GIT),
  allow('POST', '/api/git/generate-commit-message', GIT),
  allow('GET', '/api/git/remote-status', GIT),
  allow('POST', '/api/git/fetch', GIT),
  allow('POST', '/api/git/pull', GIT),
  allow('POST', '/api/git/push', GIT),
  allow('POST', '/api/git/publish', GIT),
  allow('POST', '/api/git/discard', GIT),
  allow('POST', '/api/git/delete-untracked', GIT),

  allow('GET', '/api/worktrees', 'git worktrees'),
  allow('POST', '/api/worktrees/create', 'git worktrees'),
  allow('POST', '/api/worktrees/open', 'git worktrees'),
  allow('POST', '/api/worktrees/merge', 'git worktrees'),
  allow('POST', '/api/worktrees/remove', 'git worktrees'),

  allow('POST', '/api/commands/list', 'slash command list: reads .claude/commands directories'),
  allow('POST', '/api/commands/execute', 'slash command expansion: built-ins answer data, a custom command reads a file under ~/.claude/commands or under `<context.projectPath>/.claude/commands` (projectPath comes from the Controller, so any .claude/commands directory on the Host); this handler spawns no process (that statement is about this route only)'),

  allow('GET', '/api/scheduled-messages', 'scheduled messages'),
  allow('POST', '/api/scheduled-messages', 'scheduled messages'),
  allow('DELETE', '/api/scheduled-messages/*', 'scheduled messages'),

  allow('POST', '/api/assets/images', 'chat image attachments (5 MB per file, unchanged)'),
  allow('POST', '/api/assets/files', 'chat file attachments (10 MB per file, unchanged)'),
  allow('GET', '/api/assets/images/*', 'stored image attachment (non-JSON: sandbox CSP)'),
  allow('GET', '/api/assets/files/*', 'stored file attachment (non-JSON: sandbox CSP)'),

  allow('GET', '/api/providers/capabilities', PROVIDER_CONFIG),
  allow('GET', '/api/providers/*/capabilities', PROVIDER_CONFIG),
  allow('GET', '/api/providers/*/models', PROVIDER_CONFIG),
  allow('POST', '/api/providers/*/models', 'custom model entries (names and effort levels, no secrets)'),
  allow('PUT', '/api/providers/*/models/custom-only', 'custom model entries'),
  allow('PATCH', '/api/providers/*/models/*', 'custom model entries'),
  allow('DELETE', '/api/providers/*/models/*', 'custom model entries'),
  allow('GET', '/api/providers/*/sessions/*/active-model', PROVIDER_SESSIONS),
  allow('POST', '/api/providers/*/sessions/*/active-model', PROVIDER_SESSIONS),
  allow('POST', '/api/providers/*/sessions/*/active-effort', PROVIDER_SESSIONS),
  allow('GET', '/api/providers/*/skills', PROVIDER_CONFIG),
  allow('POST', '/api/providers/*/skills', 'writes a skill into the provider skills folder, which is OUTSIDE every project root (a file write is project-bounded); a skill is code/instructions the next agent run on the Host loads'),
  allow('DELETE', '/api/providers/*/skills/*', 'removes a skill folder'),
  allow('POST', '/api/providers/sessions', PROVIDER_SESSIONS),
  allow('GET', '/api/providers/sessions/running', PROVIDER_SESSIONS),
  allow('GET', '/api/providers/sessions/recent', PROVIDER_SESSIONS),
  allow('GET', '/api/providers/sessions/archived', PROVIDER_SESSIONS),
  allow('GET', '/api/providers/sessions/*/provider-id', PROVIDER_SESSIONS),
  allow('GET', '/api/providers/sessions/*/token-usage', PROVIDER_SESSIONS),
  allow('GET', '/api/providers/sessions/*', PROVIDER_SESSIONS),
  allow('DELETE', '/api/providers/sessions/*', PROVIDER_SESSIONS),
  allow('POST', '/api/providers/sessions/*/restore', PROVIDER_SESSIONS),
  allow('POST', '/api/providers/sessions/*/fork', PROVIDER_SESSIONS),
  allow('PUT', '/api/providers/sessions/*', PROVIDER_SESSIONS),
  allow('GET', '/api/providers/sessions/*/messages', PROVIDER_SESSIONS),
  allow('GET', '/api/providers/sessions/*/workflows/*/agents/*', PROVIDER_SESSIONS),
  allow('GET', '/api/providers/search/sessions', 'conversation search (SSE)'),

  allow('GET', '/api/user/drafts', 'chat drafts'),
  allow('PUT', '/api/user/drafts', 'chat drafts'),
  allow('DELETE', '/api/user/drafts', 'chat drafts'),
  allow('POST', '/api/user/drafts/queued-message', 'queued message draft'),
  allow('DELETE', '/api/user/drafts/queued-message', 'queued message draft'),
  allow('GET', '/api/user/onboarding-status', 'onboarding status the auth gate reads'),
  allow('POST', '/api/user/complete-onboarding', 'onboarding completion'),
];

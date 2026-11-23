/**
 * The inventory side of the route sweep: which source files register routes and where they are mounted
 * (the one hand-kept table; `route-inventory.test.ts` proves it is complete against `server/index.ts` and the
 * source tree), the expansion of every registration into (method, sample path) cases, and their verdicts from
 * the production policy table. Also renders the inventory report.
 */

import path from 'node:path';

import { classifyRoute, REMOTE_ALLOW_RULES, REMOTE_DENY_RULES } from '../../policy/route-allow-list.js';

import { readServerSource, scanRouteSource, VERBS, type HttpVerb, type ScanProblem } from './route-source-scanner.js';

/**
 * One router file of the inventory. `mountedAs` = the identifier `server/index.ts` passes to `app.use(prefix, ...)`
 * (the test proves that identifier comes from this file's module directory, so two mounts cannot be swapped);
 * absent for a sub-router that shares its parent's prefix. `registrations` = how many `router.<verb>(` /
 * `router.use(` calls the scanner must find in the file, pinned so a scanner regression that drops routes (or a
 * route added/removed without a look at this table) turns the test red.
 */
export type RouteModule = { prefix: string; file: string; registrations: number; mountedAs?: string; subRouterCalls?: readonly string[] };

/** Routers mounted by `server/index.ts` (`app.use(prefix, ..., router)`). The sub-router of projects shares its prefix. */
export const ROUTE_MODULES: readonly RouteModule[] = [
  { prefix: '/api/auth', file: 'modules/auth/auth.routes.ts', mountedAs: 'authRoutes', registrations: 9 },
  { prefix: '/api/file-tree', file: 'modules/file-tree/file-tree.routes.ts', mountedAs: 'fileTreeRoutes', registrations: 10 },
  { prefix: '/api/projects', file: 'modules/projects/projects.routes.ts', mountedAs: 'projectModuleRoutes', registrations: 10, subRouterCalls: ['createProjectCloneRouter('] },
  { prefix: '/api/projects', file: 'modules/projects/project-clone.routes.ts', registrations: 2 },
  { prefix: '/api/assets', file: 'modules/assets/assets.routes.ts', mountedAs: 'assetsRoutes', registrations: 4 },
  { prefix: '/api/git', file: 'modules/git/git.routes.ts', mountedAs: 'gitRoutes', registrations: 25 },
  { prefix: '/api/worktrees', file: 'modules/worktrees/worktrees.routes.ts', mountedAs: 'worktreesRoutes', registrations: 5 },
  { prefix: '/api/taskmaster', file: 'modules/taskmaster/taskmaster.routes.ts', mountedAs: 'taskmasterRoutes', registrations: 12 },
  { prefix: '/api/commands', file: 'modules/commands/commands.routes.ts', mountedAs: 'commandsRoutes', registrations: 2 },
  { prefix: '/api/settings', file: 'modules/settings/settings.routes.ts', mountedAs: 'settingsRoutes', registrations: 13 },
  { prefix: '/api/system', file: 'modules/system/system.routes.ts', mountedAs: 'systemRoutes', registrations: 2 },
  { prefix: '/api/notifications', file: 'modules/notifications/notifications.routes.ts', mountedAs: 'notificationRoutes', registrations: 4 },
  { prefix: '/api/user', file: 'modules/user/user.routes.ts', mountedAs: 'userRoutes', registrations: 11 },
  { prefix: '/api/plugins', file: 'modules/plugins/plugins.routes.ts', mountedAs: 'pluginsRoutes', registrations: 8 },
  { prefix: '/api/browser-use-mcp', file: 'modules/browser-use/browser-use-mcp.routes.ts', mountedAs: 'browserUseMcpRoutes', registrations: 1 },
  { prefix: '/api/browser-use', file: 'modules/browser-use/browser-use.routes.ts', mountedAs: 'browserUseRoutes', registrations: 8 },
  { prefix: '/api/providers', file: 'modules/providers/provider.routes.ts', mountedAs: 'providerRoutes', registrations: 35 },
  { prefix: '/api/scheduled-messages', file: 'modules/scheduled-messages/scheduled-messages.routes.ts', mountedAs: 'scheduledMessagesRoutes', registrations: 3 },
  { prefix: '/api/agent', file: 'modules/agent/agent.routes.ts', mountedAs: 'agentRoutes', registrations: 1 },
  { prefix: '/api/voice', file: 'modules/voice/voice.routes.ts', mountedAs: 'voiceRoutes', registrations: 3 },
];

/** Routers the Remote module mounts itself (`remote.mount(app)`, see `runtime/remote.module.ts`). */
export const REMOTE_OWN_MODULES: readonly RouteModule[] = [
  { prefix: '/api/remote', file: 'modules/remote/api/remote.routes.ts', registrations: 16 },
  { prefix: '/r', file: 'modules/remote/controller/controller-proxy.routes.ts', registrations: 1 },
];

/** The module directory each imported name comes from (`import { a as b } from './modules/x/index.js'` -> b: 'modules/x'). */
const importedFrom = (source: string): Map<string, string> => {
  const imports = new Map<string, string>();
  for (const match of source.matchAll(/import\s+([^'";]+?)\s+from\s+'([^']+)'/g)) {
    const [, bindings, from] = match;
    const directory = path.posix.dirname(from.replace(/^\.\//, '').replace(/^@\//, ''));
    for (const part of bindings.replace(/[{}]/g, ',').split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.replace(/^type\s+/, '');
      if (name) imports.set(name, directory);
    }
  }
  return imports;
};

/**
 * Checks `server/index.ts` against the table: every router file with a `mountedAs` must be mounted by exactly
 * that identifier at its prefix, the identifier must come from the file's own module directory (imported from
 * it, or built by a factory imported from it), and no identifier may serve two prefixes. Returns the problems.
 */
export function mountMismatches(indexSource: string, modules: readonly RouteModule[]): string[] {
  const imports = importedFrom(indexSource);
  const built = new Map([...indexSource.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => [match[1], match[2]]));
  const mounted = new Map<string, string>();
  for (const match of indexSource.matchAll(/\bapp\.use\(\s*'([^']+)'\s*,\s*(?:[A-Za-z_$][\w$]*\s*,\s*)*([A-Za-z_$][\w$]*)\s*\)/g)) mounted.set(match[1], match[2]);

  const problems: string[] = [];
  const claimed = new Map<string, string>();
  for (const module of modules.filter((entry) => entry.mountedAs)) {
    const identifier = module.mountedAs as string;
    if (mounted.get(module.prefix) !== identifier) problems.push(`${module.prefix} must be mounted by \`${identifier}\`, index.ts mounts \`${mounted.get(module.prefix) ?? 'nothing'}\``);
    const directory = imports.get(identifier) ?? imports.get(built.get(identifier) ?? '');
    if (directory !== path.posix.dirname(module.file)) problems.push(`\`${identifier}\` (mounted at ${module.prefix}) must come from ${path.posix.dirname(module.file)}, it comes from ${directory ?? 'nowhere'}`);
    const other = claimed.get(identifier);
    if (other) problems.push(`\`${identifier}\` is the router of both ${other} and ${module.prefix}`);
    claimed.set(identifier, module.prefix);
  }
  return problems;
}

/** Rows (method x path) the whole inventory expands to: 94 allow + 95 deny. Pinned: a different number is a route change to review. */
export const EXPECTED_INVENTORY_ROWS = 195;

/** The literal-path registrations of `server/index.ts` that are not router mounts (everything else must be in ROUTE_MODULES). */
export const INDEX_OTHER_LITERALS: ReadonlyArray<{ call: string; note: string }> = [
  { call: 'use /api', note: 'validateApiKey middleware for every /api route' },
  { call: 'get /health', note: 'public health check' },
  { call: 'get /api/auth/version', note: 'authenticated version metadata' },
  { call: 'use /r', note: 'CORS for scoped Remote bearer requests' },
  { call: 'get *', note: 'SPA fallback of the Host UI' },
];

/** Registrations that are not API routes, with the reason they are not reachable (the inventory states them, the policy refuses them as unknown). */
export const NON_API_SURFACE: ReadonlyArray<{ name: string; probe: string; reason: string }> = [
  { name: 'GET * (SPA fallback)', probe: '/some/page', reason: 'the Controller serves its own UI; the Host UI HTML is never needed through Remote' },
  { name: 'express.static(public)', probe: '/api-docs.html', reason: 'static files of the Host UI' },
  { name: 'express.static(dist)', probe: '/assets/index.js', reason: 'static files of the Host UI build' },
];

export type InventoryRow = {
  method: HttpVerb;
  route: string;
  source: string;
  verdict: 'allow' | 'deny' | 'unclassified';
  rule: string;
  note: string;
};

const toSamples = (route: string, rest: boolean): string[] => {
  const base = route.replace(/:[A-Za-z0-9_]+/g, 'x1');
  if (route.includes('*')) return [base.replace(/\*/g, 'x1'), base.replace(/\*/g, 'x1/y2/z3')];
  return rest ? [base, `${base}/y2/z3`] : [base];
};

const noteOf = (method: string, rule: string): string =>
  REMOTE_ALLOW_RULES.find((entry) => entry.pattern === rule && entry.methods.includes(method))?.note ??
  REMOTE_DENY_RULES.find((entry) => entry.pattern === rule)?.note ??
  '';

/** The allow-rule pattern a registration is expected to have: Express `:param` -> `*`, ASCII lower case (the table is lower case). */
const ownShape = (route: string): string => route.replace(/:[A-Za-z0-9_]+/g, '*').replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/**
 * Verdict of every (method, sample) a registration stands for; `unclassified` when any sample is unknown or only a
 * method mismatch. An `allow` additionally needs an allow rule of the registration's OWN shape (same method, same
 * path with `:param` as `*`): a broader wildcard rule that merely happens to match (`GET /api/providers/sessions/*`
 * for a new `GET /api/providers/sessions/export-all`) must not absorb a route nobody classified. Deny families
 * (`/api/settings/**`) may cover many registrations: a route they refuse is refused whatever its shape.
 */
export const rowFor = (method: HttpVerb, route: string, rest: boolean, source: string): InventoryRow => {
  const verdicts = toSamples(route, rest).map((sample) => classifyRoute(method, sample.split('/').filter(Boolean)));
  const first = verdicts[0];
  const same = verdicts.every((verdict) => verdict.verdict === first.verdict && verdict.rule === first.rule);
  const classified = first.verdict === 'allow' || (first.verdict === 'deny' && first.reason === 'route-denied');
  if (!classified || !same) {
    const detail = verdicts.map((verdict) => `${verdict.verdict}:${verdict.rule ?? '-'}`).join(' | ');
    return { method, route, source, verdict: 'unclassified', rule: detail, note: '' };
  }
  if (first.verdict === 'allow') {
    const own = ownShape(route);
    const hasOwnRule = !rest && REMOTE_ALLOW_RULES.some((entry) => entry.pattern === own && entry.methods.includes(method));
    if (!hasOwnRule) {
      return { method, route, source, verdict: 'unclassified', rule: `covered only by wildcard rule ${first.rule}: list ${method} ${own} in route-rules.ts or deny it`, note: '' };
    }
    return { method, route, source, verdict: 'allow', rule: own, note: noteOf(method, own) };
  }
  return { method, route, source, verdict: 'deny', rule: first.rule ?? '', note: noteOf(method, first.rule ?? '') };
};

/** The rows one router file (given as source text) adds to the inventory when mounted at `module.prefix`. */
export function rowsForSource(
  module: Pick<RouteModule, 'prefix' | 'file'> & Pick<Partial<RouteModule>, 'subRouterCalls'>,
  source: string,
): { rows: InventoryRow[]; problems: ScanProblem[]; calls: number; registrations: number } {
  const scan = scanRouteSource(module.file, source, { subRouterCalls: module.subRouterCalls });
  const rows: InventoryRow[] = [];
  for (const registration of scan.registrations) {
    const route = `${module.prefix}${registration.path === '/' ? '' : registration.path}`;
    const where = `${module.file.replace(/^modules\//, '')}:${registration.line}`;
    const methods = registration.method === 'ALL' ? VERBS : [registration.method];
    for (const method of methods) rows.push(rowFor(method, route, registration.rest, where));
  }
  return { rows, problems: scan.problems, calls: scan.calls, registrations: scan.registrations.length };
}

/** Every route registration of every router file, expanded per method and classified. */
export function buildInventory(): { rows: InventoryRow[]; problems: ScanProblem[]; calls: number; registrationsByFile: Map<string, number> } {
  const rows: InventoryRow[] = [];
  const problems: ScanProblem[] = [];
  const registrationsByFile = new Map<string, number>();
  let calls = 0;
  for (const module of [...ROUTE_MODULES, ...REMOTE_OWN_MODULES]) {
    const scanned = rowsForSource(module, readServerSource(module.file));
    rows.push(...scanned.rows);
    problems.push(...scanned.problems);
    calls += scanned.calls;
    registrationsByFile.set(module.file, (registrationsByFile.get(module.file) ?? 0) + scanned.registrations);
  }
  // Routes `server/index.ts` registers itself (`/health`); its router mounts and the SPA fallback are checked by the test.
  const index = scanRouteSource('index.ts', readServerSource('index.ts'));
  for (const registration of index.registrations) {
    if (registration.method === 'GET' && registration.path.startsWith('/')) rows.push(rowFor('GET', registration.path, registration.rest, `index.ts:${registration.line}`));
  }
  return { rows, problems, calls, registrationsByFile };
}

const escapeCell = (value: string): string => value.replace(/\|/g, '\\|');

/** The route table of `reports/route-inventory-261104.md`: one line per (method, route). */
export function renderInventoryTable(rows: readonly InventoryRow[]): string {
  const lines = ['| Class | Method | Route | Rule | Reason | Source |', '|---|---|---|---|---|---|'];
  const order = (row: InventoryRow): string => `${row.verdict === 'allow' ? 0 : 1}|${row.route}|${row.method}`;
  for (const row of [...rows].sort((a, b) => order(a).localeCompare(order(b)))) {
    lines.push(`| ${row.verdict} | ${row.method} | \`${escapeCell(row.route)}\` | \`${escapeCell(row.rule)}\` | ${escapeCell(row.note)} | ${row.source} |`);
  }
  return lines.join('\n');
}

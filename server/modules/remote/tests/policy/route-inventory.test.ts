/**
 * Route inventory, fail closed (AC-13, FR-37): every route the Host mounts is classified `allow` or `deny`
 * by the Remote policy table; a route (or router file, or mount, or WebSocket path) nobody classified turns
 * this test red. `server/index.ts` listens on import, so the registrations are read from source by a strict
 * scanner (`support/route-source-scanner.ts`): a registration style it cannot read is itself a failure.
 *
 * `ROUTE_INVENTORY_REPORT=<file>` makes the last test write the markdown table of the report.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { REMOTE_ALLOW_RULES, evaluateRemoteHttpRequest, evaluateRemoteWebSocketTarget } from '../../policy/route-allow-list.js';
import {
  EXPECTED_INVENTORY_ROWS,
  INDEX_OTHER_LITERALS,
  NON_API_SURFACE,
  REMOTE_OWN_MODULES,
  ROUTE_MODULES,
  buildInventory,
  mountMismatches,
  renderInventoryTable,
  rowsForSource,
} from '../support/route-inventory-table.js';
import { SERVER_ROOT, readServerSource, scanRouteSource } from '../support/route-source-scanner.js';

const inventory = buildInventory();
const knownFiles = new Set([...ROUTE_MODULES, ...REMOTE_OWN_MODULES].map((module) => module.file));

/** Source files under `server/` (no tests, no node_modules) as paths relative to it, with `/`. */
const sourceFiles = (directory = SERVER_ROOT): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'tests' ? [] : sourceFiles(full);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path.relative(SERVER_ROOT, full).split(path.sep).join('/')] : [];
  });

test('the scanner reads every route registration of every router file (nothing it cannot understand)', () => {
  assert.deepEqual(inventory.problems, []);
  for (const file of knownFiles) assert.ok((inventory.registrationsByFile.get(file) ?? 0) > 0, `${file} yielded no route`);
});

test('the number of registrations per router file and of inventory rows is pinned (a route added, removed or lost by the scanner shows up here)', () => {
  const counts = [...ROUTE_MODULES, ...REMOTE_OWN_MODULES].map((module) => ({ file: module.file, registrations: inventory.registrationsByFile.get(module.file) }));
  assert.deepEqual(
    counts,
    [...ROUTE_MODULES, ...REMOTE_OWN_MODULES].map((module) => ({ file: module.file, registrations: module.registrations })),
    'update `registrations` in route-inventory-table.ts after classifying the change in route-rules.ts',
  );
  assert.equal(inventory.rows.length, EXPECTED_INVENTORY_ROWS, 'update EXPECTED_INVENTORY_ROWS (and the report) after classifying the change in route-rules.ts');
});

test('every mounted route is classified allow or deny (a new unclassified route turns this red)', () => {
  const unclassified = inventory.rows.filter((row) => row.verdict === 'unclassified').map((row) => `${row.method} ${row.route} (${row.source}) -> ${row.rule}`);
  assert.deepEqual(unclassified, [], 'classify these in server/modules/remote/policy/route-rules.ts (allow with exact method + path, or deny)');
});

/** Rows a router file with this source would add to the inventory, mounted at `prefix`. */
const rowsOf = (prefix: string, source: string) => rowsForSource({ prefix, file: 'synthetic.routes.ts' }, source).rows;

test('a new route that only a wildcard allow rule would cover is unclassified, not allow (the inventory pins every route to a rule of its own shape)', () => {
  const [exportAll] = rowsOf('/api/providers', "router.get('/sessions/export-all', handler);");
  assert.equal(exportAll.verdict, 'unclassified');
  assert.match(exportAll.rule, /covered only by wildcard rule \/api\/providers\/sessions\/\*/);

  const [purge] = rowsOf('/api/projects', "router.delete('/purge-all', handler);");
  assert.equal(purge.verdict, 'unclassified');
  assert.match(purge.rule, /\/api\/projects\/\*/);

  // Same for the other wildcard families, and for a new method on an existing literal path.
  assert.equal(rowsOf('/api/providers', "router.put('/sessions/bulk', handler);")[0].verdict, 'unclassified');
  assert.equal(rowsOf('/api/providers', "router.delete('/:provider/models/reset', handler);")[0].verdict, 'unclassified');
  assert.equal(rowsOf('/api/git', "router.delete('/status', handler);")[0].verdict, 'unclassified');
});

test('a registration that has its own allow rule stays allow, with that rule; a new route under a deny family stays deny', () => {
  const rows = rowsOf('/api/providers', "router.get('/sessions/:sessionId', h); router.delete('/sessions/:sessionId', h); router.get('/:provider/models', h);");
  assert.deepEqual(rows.map((row) => [row.method, row.verdict, row.rule]), [
    ['GET', 'allow', '/api/providers/sessions/*'],
    ['DELETE', 'allow', '/api/providers/sessions/*'],
    ['GET', 'allow', '/api/providers/*/models'],
  ]);
  assert.deepEqual(rowsOf('/api/settings', "router.get('/brand-new', h);").map((row) => row.verdict), ['deny']);
});

test('the exact allow rule of a shape is found even when a broader allow rule is listed before it', () => {
  const [row] = rowsOf('/api/providers', "router.get('/sessions/running', h);");
  assert.equal(row.verdict, 'allow');
  assert.equal(row.rule, '/api/providers/sessions/running');
});

test('every allow row of the committed inventory has a rule of exactly its own shape', () => {
  for (const row of inventory.rows.filter((entry) => entry.verdict === 'allow')) {
    const shape = row.route.replace(/:[A-Za-z0-9_]+/g, '*').toLowerCase();
    assert.equal(row.rule, shape, `${row.method} ${row.route} (${row.source})`);
  }
});

test('server/index.ts mounts exactly the routers of the inventory plus the known non-router registrations', () => {
  const scan = scanRouteSource('index.ts', readServerSource('index.ts'));
  assert.deepEqual(scan.problems, [], 'a root-mounted router or an unknown middleware form in index.ts');
  const found = scan.registrations.map((registration) => `${registration.method === 'ALL' ? 'use' : registration.method.toLowerCase()} ${registration.path}`).sort();
  const expected = [...new Set(ROUTE_MODULES.map((module) => `use ${module.prefix}`)), ...INDEX_OTHER_LITERALS.map((entry) => entry.call)].sort();
  assert.deepEqual(found, expected);
});

test('server/index.ts mounts each router file of the inventory at the prefix the table says, by the identifier it names', () => {
  assert.deepEqual(mountMismatches(readServerSource('index.ts'), ROUTE_MODULES), []);
});

test('a swapped or re-pointed mount in index.ts is caught (the routes would be classified under the wrong prefix)', () => {
  const source = readServerSource('index.ts');
  const swapped = source.replace("app.use('/api/user', authenticateToken, userRoutes);", "app.use('/api/user', authenticateToken, taskmasterRoutes);");
  assert.notEqual(swapped, source, 'the synthetic edit applies');
  assert.ok(mountMismatches(swapped, ROUTE_MODULES).some((line) => line.includes('/api/user')));

  const wrongModule = source.replace("import { userRoutes } from './modules/user/index.js';", "import { userRoutes } from './modules/taskmaster/index.js';");
  assert.notEqual(wrongModule, source, 'the synthetic edit applies');
  assert.ok(mountMismatches(wrongModule, ROUTE_MODULES).some((line) => line.includes('userRoutes')));

  const dropped = source.replace("app.use('/api/voice', authenticateToken, voiceRoutes);", '');
  assert.ok(mountMismatches(dropped, ROUTE_MODULES).some((line) => line.includes('/api/voice')));
});

test('the Remote module mounts exactly /api/remote and /r', () => {
  const scan = scanRouteSource('modules/remote/runtime/remote.module.ts', readServerSource('modules/remote/runtime/remote.module.ts'));
  assert.deepEqual(scan.problems, []);
  assert.deepEqual(scan.registrations.map((registration) => registration.path).sort(), REMOTE_OWN_MODULES.map((module) => module.prefix).sort());
});

test('every Express router and every *.routes.ts file of the server is in the inventory', () => {
  const files = sourceFiles();
  const routerFiles = files.filter((file) => /\bexpress\.Router\s*\(|(?<![\w.])Router\s*\(\s*\)/.test(readServerSource(file)));
  assert.deepEqual(routerFiles.filter((file) => !knownFiles.has(file)), [], 'a router file the inventory does not list');
  assert.deepEqual(files.filter((file) => file.endsWith('.routes.ts') && !knownFiles.has(file)), [], 'a *.routes.ts file the inventory does not list');
  for (const file of knownFiles) assert.ok(files.includes(file), `${file} no longer exists`);
});

test('no other source file registers a route on an injected `app` or a `router` (only the listed router files, index.ts and the Remote module do)', () => {
  const allowed = new Set([...knownFiles, 'index.ts', 'modules/remote/runtime/remote.module.ts']);
  const offenders = sourceFiles()
    .filter((file) => !allowed.has(file))
    .flatMap((file) => {
      const scan = scanRouteSource(file, readServerSource(file));
      return [...scan.registrations.map((entry) => `${file}:${entry.line} registers ${entry.method} ${entry.path}`), ...scan.problems.map((entry) => `${file}:${entry.line} ${entry.text}`)];
    });
  assert.deepEqual(offenders, [], 'a route registered outside the inventory: list the file in route-inventory-table.ts');
});

test('every WebSocket path the gateway dispatches on is known and classified', () => {
  const source = readServerSource('modules/websocket/services/websocket-server.service.ts');
  const found = [
    ...[...source.matchAll(/pathname\s*===\s*'([^']+)'/g)].map((match) => match[1]),
    ...[...source.matchAll(/pathname\.startsWith\(\s*'([^']+)'/g)].map((match) => match[1]),
  ].sort();
  assert.deepEqual(found, ['/desktop-notifications', '/plugin-ws/', '/shell', '/ws'], 'a WebSocket path nobody classified');
  for (const allowed of ['/ws', '/shell']) assert.equal(evaluateRemoteWebSocketTarget(allowed).allowed, true, allowed);
  for (const denied of ['/desktop-notifications', '/plugin-ws/some-plugin']) {
    assert.deepEqual(evaluateRemoteWebSocketTarget(denied), { allowed: false, reason: 'websocket-path' }, denied);
    assert.equal(evaluateRemoteHttpRequest('GET', denied).allowed, false, denied);
  }
});

test('the SPA fallback and the static files are not reachable through Remote', () => {
  for (const surface of NON_API_SURFACE) {
    for (const method of ['GET', 'POST']) {
      assert.deepEqual(evaluateRemoteHttpRequest(method, surface.probe), { allowed: false, reason: 'route-unknown' }, `${method} ${surface.name}`);
    }
  }
});

test('no allow rule is stale: each one still matches a route the server mounts', () => {
  for (const rule of REMOTE_ALLOW_RULES) {
    const mounted = inventory.rows.some((row) => row.verdict === 'allow' && row.rule === rule.pattern && row.method === rule.methods[0]);
    assert.ok(mounted, `${rule.methods[0]} ${rule.pattern} matches no mounted route`);
  }
});

test('writes the inventory table when ROUTE_INVENTORY_REPORT is set', { skip: !process.env.ROUTE_INVENTORY_REPORT }, () => {
  const allow = inventory.rows.filter((row) => row.verdict === 'allow').length;
  const header = `Routes found: ${inventory.rows.length} (method x path). allow ${allow}, deny ${inventory.rows.length - allow}, unclassified 0.\n\n`;
  writeFileSync(String(process.env.ROUTE_INVENTORY_REPORT), header + renderInventoryTable(inventory.rows) + '\n', 'utf8');
  assert.ok(readFileSync(String(process.env.ROUTE_INVENTORY_REPORT), 'utf8').includes('| allow |'));
});

/**
 * Ground truth for the route scanner: the registrations it reads from source must be exactly the routes the
 * REAL Express routers hold. Each router file is loaded (its factory with inert stand-in dependencies, or its
 * default export) in a throwaway HOME/database, its `router.stack` is walked, and the (method, path) pairs are
 * compared with the scanner's reading of the same file. So a registration style the scanner misreads, drops or
 * invents turns this red even though the source-only inventory test cannot see it.
 *
 * `router.use(...)` mounts and `router.all(...)` are excluded on both sides (they are middleware / catch-alls and
 * are checked by the inventory test and the scanner's own problem list).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import type express from 'express';

import { ROUTE_MODULES } from '../support/route-inventory-table.js';
import { readServerSource, scanRouteSource } from '../support/route-source-scanner.js';

type StackLayer = { route?: { path: unknown; methods: Record<string, boolean> }; name?: string; handle?: { stack?: StackLayer[] } };

/** A value that accepts any property read or call and returns itself: dependencies that must never be reached while routes are only listed. */
const inert = (): never => {
  const stub: unknown = new Proxy(function stand() {}, {
    get: (_target, property) => (property === Symbol.toPrimitive || property === 'then' ? undefined : stub),
    apply: () => stub,
    construct: () => stub as object,
  });
  return stub as never;
};

const routesOf = (stack: StackLayer[]): string[] =>
  stack.flatMap((layer) => {
    if (layer.route) {
      return Object.keys(layer.route.methods)
        .filter((method) => layer.route?.methods[method] && method !== '_all')
        .map((method) => `${method.toUpperCase()} ${String(layer.route?.path)}`);
    }
    return layer.name === 'router' && layer.handle?.stack ? routesOf(layer.handle.stack) : [];
  });

type Loader = () => Promise<express.Router>;
// This test must load the router FILES themselves: the module barrels export only the instances the server
// built with real dependencies, not the factories nor the routers of every file.
/* eslint-disable boundaries/dependencies */
const LOADERS: Record<string, Loader> = {
  'modules/providers/provider.routes.ts': async () => (await import('../../../providers/provider.routes.js')).default,
  'modules/notifications/notifications.routes.ts': async () => (await import('../../../notifications/notifications.routes.js')).default,
  'modules/assets/assets.routes.ts': async () => (await import('../../../assets/assets.routes.js')).default,
  'modules/scheduled-messages/scheduled-messages.routes.ts': async () => (await import('../../../scheduled-messages/scheduled-messages.routes.js')).default,
  'modules/browser-use/browser-use.routes.ts': async () => (await import('../../../browser-use/browser-use.routes.js')).default,
  'modules/browser-use/browser-use-mcp.routes.ts': async () => (await import('../../../browser-use/browser-use-mcp.routes.js')).default,
  'modules/git/git.routes.ts': async () => (await import('../../../git/git.routes.js')).createGitRouter(inert()),
  'modules/file-tree/file-tree.routes.ts': async () => (await import('../../../file-tree/file-tree.routes.js')).createFileTreeRouter(inert(), inert(), inert(), inert()),
  'modules/settings/settings.routes.ts': async () => (await import('../../../settings/settings.routes.js')).createSettingsRouter(inert()),
  'modules/user/user.routes.ts': async () => (await import('../../../user/user.routes.js')).createUserRouter(inert()),
  'modules/auth/mfa.routes.ts': async () => (await import('../../../auth/mfa.routes.js')).createMfaRouter(inert(), inert()),
  'modules/auth/auth.routes.ts': async () => (await import('../../../auth/auth.routes.js')).createAuthRouter(inert(), inert()),
  'modules/commands/commands.routes.ts': async () => (await import('../../../commands/commands.routes.js')).createCommandsRouter(inert()),
  'modules/worktrees/worktrees.routes.ts': async () => (await import('../../../worktrees/worktrees.routes.js')).createWorktreesRouter(inert()),
  'modules/system/system.routes.ts': async () => (await import('../../../system/system.routes.js')).createSystemRouter(inert()),
  'modules/plugins/plugins.routes.ts': async () => (await import('../../../plugins/plugins.routes.js')).createPluginsRouter(inert()),
  'modules/agent-profiles/agent-profiles.routes.ts': async () => (await import('../../../agent-profiles/agent-profiles.routes.js')).createAgentProfilesRouter(inert(), inert(), inert(), inert()),
  // The kill route exists only when a killer is given: the stand-in is one.
  'modules/agent-monitor/agent-monitor.routes.ts': async () => (await import('../../../agent-monitor/agent-monitor.routes.js')).createAgentMonitorRouter(inert(), inert()),
  'modules/taskmaster/taskmaster.routes.ts': async () => (await import('../../../taskmaster/taskmaster.routes.js')).createTaskmasterRouter(inert()),
  'modules/voice/voice.routes.ts': async () => (await import('../../../voice/voice.routes.js')).createVoiceRouter(inert()),
  'modules/agent/agent.routes.ts': async () => (await import('../../../agent/agent.routes.js')).createAgentRouter(inert()),
  'modules/projects/project-clone.routes.ts': async () => (await import('../../../projects/project-clone.routes.js')).createProjectCloneRouter(inert()),
  // The projects router mounts the clone router at its root, so its stack holds both files' routes.
  'modules/projects/projects.routes.ts': async () => (await import('../../../projects/projects.routes.js')).default,
};
/* eslint-enable boundaries/dependencies */

describe('the scanner reads the same routes the real Express routers hold', () => {
  const saved: Record<string, string | undefined> = {};
  let sandbox = '';

  before(() => {
    // Importing a router module must not reach the real home directory or database.
    sandbox = mkdtempSync(path.join(os.tmpdir(), 'route-scan-'));
    for (const key of ['HOME', 'USERPROFILE', 'DATABASE_PATH']) saved[key] = process.env[key];
    process.env.HOME = sandbox;
    process.env.USERPROFILE = sandbox;
    process.env.DATABASE_PATH = path.join(sandbox, 'auth.db');
  });
  after(async () => {
    // Some router modules open the database while they load (inside the sandbox); close it before the folder goes.
    (await import('@/modules/database/index.js')).closeConnection();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('every router file of the inventory has a loader here (a new router file must be added)', () => {
    assert.deepEqual(
      ROUTE_MODULES.map((module) => module.file).filter((file) => !(file in LOADERS)),
      [],
    );
  });

  /** `METHOD path` of every verb registration the scanner reads in `file` (no prefix; `use`/`all` excluded). */
  const scannedOf = (file: string): string[] => {
    const module = ROUTE_MODULES.find((entry) => entry.file === file);
    const scan = scanRouteSource(file, readServerSource(file), { subRouterCalls: module?.subRouterCalls });
    return scan.registrations.filter((entry) => entry.method !== 'ALL').map((entry) => `${entry.method} ${entry.path}`);
  };

  for (const [file, load] of Object.entries(LOADERS)) {
    it(`${file}`, async () => {
      const real = routesOf((await load()).stack as unknown as StackLayer[]).sort();
      // The clone router is mounted at the root of the projects router: its routes are in the real stack of the parent.
      const scanned = file === 'modules/projects/projects.routes.ts' ? [...scannedOf(file), ...scannedOf('modules/projects/project-clone.routes.ts')] : scannedOf(file);
      assert.deepEqual(real, scanned.sort(), `${file}: scanner and real router differ`);
    });
  }
});

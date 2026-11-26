import path from 'node:path';

import type { ClaudeSdkAgentInfo } from '@/shared/types.js';

import { createSnapshotStore } from '../agent-profiles.backup.js';
import { createBundleService } from '../agent-profiles.bundle.service.js';
import { createBlocksService } from '../agent-profiles.blocks.service.js';
import { createAgentProfilesService } from '../agent-profiles.service.js';
import { createAgentProfileStore } from '../agent-profiles.store.js';
import { storedShapeProblem } from '../agent-profiles.validation.js';
import { createClaudeAgentsService } from '../claude-agents.service.js';

import { makeTempDir, removeDir } from './profile-fixtures.js';

/**
 * Real store in a temp directory, real services, and an injected stand-in for the
 * SDK call (`sdkAgents` / `sdkFails`); the model is never reached. `state.projects` stands in
 * for the sidebar projects of the app database (project id -> folder).
 */
export function makeServiceRig(options: { sdkAgents?: ClaudeSdkAgentInfo[] } = {}) {
  const root = makeTempDir();
  const claudeHome = makeTempDir('claude-home-');
  const state = {
    sdkCalls: 0, sdkFails: false, sdkHangs: false, sdkAgents: options.sdkAgents ?? [], clock: 0,
    projects: new Map<string, string>(),
    /** Time the bundle snapshots are stamped with; tests move it to age a snapshot. */
    now: new Date('2026-06-01T12:00:00.000Z'),
  };
  const store = createAgentProfileStore({ rootDir: path.join(root, 'agent-profiles'), checkShape: storedShapeProblem });
  const claudeAgents = createClaudeAgentsService({
    store,
    claudeHomeDirectory: claudeHome,
    listSdkAgents: async () => {
      state.sdkCalls += 1;
      // A call that never settles, like a CLI stuck at start-up.
      if (state.sdkHangs) return new Promise<ClaudeSdkAgentInfo[]>(() => undefined);
      if (state.sdkFails) throw new Error('sdk unavailable');
      return state.sdkAgents;
    },
    builtinTimeoutMs: 50,
    now: () => state.clock,
  });
  const service = createAgentProfilesService({
    store,
    claudeAgents,
    claudeHomeDirectory: claudeHome,
    resolveProjectDirectory: (projectId) => state.projects.get(projectId) ?? null,
  });
  const blocks = createBlocksService({ store });
  const snapshots = createSnapshotStore({ directory: path.join(root, 'agent-profiles', 'backups'), now: () => state.now });
  const bundle = createBundleService({
    profiles: service, blocks, store, snapshots, now: () => state.now,
    resolveProjectDirectory: (projectId) => state.projects.get(projectId) ?? null,
  });
  return {
    root, claudeHome, state, store, claudeAgents, service, blocks, snapshots, bundle,
    cleanup: () => { removeDir(root); removeDir(claudeHome); },
  };
}

/** Body of a minimal valid template create/update request. */
export const templateBody = (overrides: Record<string, unknown> = {}) => ({
  slug: 'review-code', family: 'worker', name: 'Code reviewer', description: 'Reviews merge requests.',
  instructions: 'Review code in {{git_url}} for {{project_name}}.',
  params: [{ key: 'git_url', type: 'url', title: 'Git URL', required: false }],
  ...overrides,
});

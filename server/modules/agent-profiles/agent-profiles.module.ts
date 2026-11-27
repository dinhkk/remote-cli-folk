import os from 'node:os';
import path from 'node:path';

import { projectsDb } from '@/modules/database/index.js';
import type { SessionAgentScope, SessionAgentSnapshot } from '@/shared/types.js';

import { createSnapshotStore } from './agent-profiles.backup.js';
import { createBlocksMcpServer } from './agent-profiles.blocks.mcp.js';
import { createBlocksService, type BlocksRunContext } from './agent-profiles.blocks.service.js';
import { createBundleService } from './agent-profiles.bundle.service.js';
import { createPendingService } from './agent-profiles.pending.service.js';
import { createProfilesMcpServer, type ProfilesRunContext } from './agent-profiles.profiles.mcp.js';
import { createAgentProfilesRouter } from './agent-profiles.routes.js';
import { createSessionScopeResolver } from './agent-profiles.session-scope.js';
import { seedProfileManagerOnce } from './agent-profiles.manager-seed.js';
import { createAgentProfilesService } from './agent-profiles.service.js';
import { createAgentProfileStore } from './agent-profiles.store.js';
import { storedShapeProblem } from './agent-profiles.validation.js';
import { querySupportedClaudeAgents } from './claude-builtin-agents.sdk.js';
import { createClaudeAgentsService } from './claude-agents.service.js';

// Data lives next to the other app data (`~/.claude-code-ui/`); AGENT_PROFILES_DIR relocates it.
const rootDir = process.env.AGENT_PROFILES_DIR
  || path.join(os.homedir(), '.claude-code-ui', 'agent-profiles');
const claudeHomeDirectory = path.join(os.homedir(), '.claude');

const store = createAgentProfileStore({ rootDir, checkShape: storedShapeProblem });
const claudeAgents = createClaudeAgentsService({
  store,
  claudeHomeDirectory,
  listSdkAgents: querySupportedClaudeAgents,
});
const agentProfilesService = createAgentProfilesService({
  store,
  claudeAgents,
  claudeHomeDirectory,
  // Sidebar projects live in the app database; the scope picker resolves a project id to its folder here, server-side.
  resolveProjectDirectory: (projectId) => projectsDb.getProjectPathById(projectId),
});
const sessionScope = createSessionScopeResolver({ claudeAgents });
const blocksService = createBlocksService({ store });
// Snapshots taken before an import overwrites something live next to the records (`<root>/backups`).
const bundleService = createBundleService({
  profiles: agentProfilesService,
  blocks: blocksService,
  store,
  snapshots: createSnapshotStore({ directory: path.join(rootDir, 'backups') }),
  resolveProjectDirectory: (projectId) => projectsDb.getProjectPathById(projectId),
});

// Proposals the `profiles` tools stage for the Host user (`<root>/pending`); the allowlist is read fresh from the settings on every call.
const pendingService = createPendingService({
  directory: path.join(rootDir, 'pending'),
  bundle: bundleService,
  getManagers: () => claudeAgents.managerNames(),
});

/**
 * Offers the profile manager once per store (marker file): the `remotecli-manager` template and its skills in `~/.claude/skills`.
 * Called by the server at start-up, never at import, so tests and tools that load this module write nothing. Never throws.
 * Consumed by: server/index.ts.
 */
export function seedProfileManager(): void {
  seedProfileManagerOnce({ rootDir, skillsDirectory: path.join(claudeHomeDirectory, 'skills'), profiles: agentProfilesService });
}

/** Agent profile router assembled with the file store and the Claude SDK adapter. */
export const agentProfilesRoutes = createAgentProfilesRouter(agentProfilesService, claudeAgents, blocksService, bundleService, pendingService);

/**
 * The in-process MCP server `blocks` for one run of a session with a main agent: `directory` is the project
 * folder the run works in (its blocks plus the global ones are visible), `agentName` the session's main agent
 * (recorded as the writer of agent writes). Built for every run, resumed ones included.
 * Consumed by: the providers module's Claude runtime (attaches it to the SDK `mcpServers`).
 */
export function createBlocksMcpServerForRun(context: BlocksRunContext) {
  return createBlocksMcpServer(blocksService, context);
}

/**
 * The in-process MCP server `profiles` for one run of a session whose main agent may manage profiles (see
 * `isProfilesManagerRun`): `agentName` is the actor recorded on every proposal. Built for every run, resumed ones included.
 * Consumed by: the providers module's Claude runtime (attaches it to the SDK `mcpServers`).
 */
export function createProfilesMcpServerForRun(context: ProfilesRunContext) {
  return createProfilesMcpServer({ bundle: bundleService, pending: pendingService }, context);
}

/**
 * Whether a run of main agent `agentName` in folder `directory` may get the `profiles` tools: the name is on the allowlist AND
 * resolves to the user-level generated file `~/.claude/agents/<name>.md` (a project file of the same name shadows it and does not
 * qualify). Never throws: unreadable or malformed settings, an unreadable folder or any other error count as "no".
 * Consumed by: the providers module's Claude runtime (via claude-profiles-mcp.ts), which also requires a local run.
 */
export async function isProfilesManagerRun(agentName: string, directory: string | null | undefined): Promise<boolean> {
  try {
    if (!claudeAgents.managerNames().includes(agentName)) return false;
    return await claudeAgents.isUserGeneratedAgent(agentName, directory);
  } catch (error) {
    console.warn('[agent-profiles] could not decide whether this agent may manage profiles; running without the profiles server:', error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * Whether the folder a run works in has at least one project memory block with a content file (an empty one counts;
 * global blocks alone do not).
 * Decides if a chat without a main agent still gets the `blocks` server.
 * Consumed by: the providers module's Claude runtime (via claude-blocks-mcp.ts).
 */
export function directoryHasProjectContent(directory: string | null | undefined): boolean {
  return blocksService.hasProjectContent(directory);
}

/**
 * Moves memory blocks saved by an older version to per-folder content (idempotent, never throws). The service also runs it
 * once on first use, so nothing needs to call this at start-up.
 */
export function migrateLegacyBlocks(): void {
  blocksService.migrateLegacyBlocks();
}

/**
 * Resolves the scope a new chat session is opened with (main agent name) into what the session
 * stores: the checked agent name plus the Claude agents hidden now (see `createSessionScopeResolver`).
 * `projectPath` is the sidebar project's folder the session runs in.
 * Consumed by: the providers module's session creation route.
 */
export function resolveSessionAgentScope(scope: SessionAgentScope, projectPath: string): Promise<SessionAgentSnapshot> {
  return sessionScope.resolve(scope, projectPath);
}

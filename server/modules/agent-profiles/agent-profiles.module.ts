import os from 'node:os';
import path from 'node:path';

import { projectsDb } from '@/modules/database/index.js';
import type { SessionAgentScope, SessionAgentSnapshot } from '@/shared/types.js';

import { createBlocksMcpServer } from './agent-profiles.blocks.mcp.js';
import { createBlocksService, type BlocksRunContext } from './agent-profiles.blocks.service.js';
import { createAgentProfilesRouter } from './agent-profiles.routes.js';
import { createSessionScopeResolver } from './agent-profiles.session-scope.js';
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

/** Agent profile router assembled with the file store and the Claude SDK adapter. */
export const agentProfilesRoutes = createAgentProfilesRouter(agentProfilesService, claudeAgents, blocksService);

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

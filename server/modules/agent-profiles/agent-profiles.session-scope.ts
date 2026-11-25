import { AppError, isValidAgentProfileName } from '@/shared/utils.js';
import type { SessionAgentScope, SessionAgentSnapshot } from '@/shared/types.js';

import type { ClaudeAgentsService } from './claude-agents.service.js';

type SessionScopeDependencies = {
  claudeAgents: ClaudeAgentsService;
};

/**
 * Turns the scope a new chat is opened with into what the session remembers: the main agent's name
 * (checked to be an agent file under `<projectPath>/.claude/agents` or `~/.claude/agents`) and the Claude
 * agents hidden at this moment. The agent itself is the native file Claude Code reads on every run, so
 * nothing about its prompt, tools or model is copied here and an edit to the file applies to the next turn.
 * Errors carry a code and fixed text, never a folder path (the route is reachable from Remote).
 * Consumed by: agent-profiles.module.ts (exposed through the barrel to the session creation route).
 */
export function createSessionScopeResolver(dependencies: SessionScopeDependencies) {
  const { claudeAgents } = dependencies;

  async function resolve(scope: SessionAgentScope, projectPath: string): Promise<SessionAgentSnapshot> {
    const { agentName } = scope;
    if (agentName !== null) {
      if (!isValidAgentProfileName(agentName)) {
        throw new AppError('agentName must be 1-64 letters, digits, - or _ (starting with a letter or digit).', {
          code: 'INVALID_AGENT_NAME', statusCode: 400,
        });
      }
      if (!await claudeAgents.hasAgentFile(agentName, projectPath)) {
        throw new AppError(`Agent "${agentName}" was not found in the project's .claude/agents or in ~/.claude/agents.`, {
          code: 'AGENT_NOT_FOUND', statusCode: 404,
        });
      }
    }
    return { agentName, hiddenClaudeAgents: claudeAgents.hiddenNames() };
  }

  return { resolve };
}

import type { AgentMonitorSession } from '@/shared/types';

export type TokenShare = { key: string; label: string; tokens: number };

/**
 * The tokens each drawn agent of ONE session reported, largest first, without the agents that reported nothing. A folded
 * finished agent keeps its tokens in the session's total, not in a bar.
 */
export function agentTokenShares(session: AgentMonitorSession, limit = 6): TokenShare[] {
  return session.agents
    .map((agent) => ({ key: `${session.id}:${agent.id}`, label: agent.name, tokens: agent.tokens }))
    .filter((share) => share.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, limit);
}

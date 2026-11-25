import type { ChatMessage } from '@/shared/types';
import type { AgentTreeNode } from '@/modules/project-workspace/agents/agentTreeTypes';
import { buildAgentTree } from '@/modules/project-workspace/agents/agentTreeUtils';

/**
 * The inspector node (a sub-agent, workflow or background command with its recorded activity) for one box of the agent
 * monitor. The monitor names a box by the tool call that launched it, which is `message.toolId`; when a transcript names
 * no tool call it falls back to the agent id, which is `message.subagent.id`. The tree's own node ids are neither, so they
 * are not used. Only launch nodes are returned, never one of their tool activities. Null when nothing matches (the history
 * is not loaded yet, or the box has left the picture).
 */
export function resolveActivityNode(sessionId: string, messages: ChatMessage[], monitorNodeId: string): AgentTreeNode | null {
  if (!monitorNodeId) return null;
  const root = buildAgentTree({ id: sessionId }, messages)[0];
  if (!root) return null;
  return root.children.find((child) => child.message?.toolId === monitorNodeId || child.message?.subagent?.id === monitorNodeId) ?? null;
}

import { agentNodeId } from '@/modules/agent-monitor/graph/layoutMonitorTree';
import { openableChatId } from '@/modules/agent-monitor/graph/openableChatId';
import type { RunningFocus } from '@/modules/agent-monitor/running/RunningFocusContext';
import type { AgentMonitorSession } from '@/shared/types';

/** What the workspace needs to draw the Activity of one sub-agent: which chat holds its transcript, and which box it is. */
export type ActivityTarget = {
  /** The monitor's id of the session (the focus key). */
  sessionKey: string;
  /** The app chat that holds the transcript: the Activity reads that chat's messages. */
  chatId: string;
  /** The box's id as the monitor names it: the tool call that launched the agent (or, failing that, the agent id). */
  agentId: string;
  /** The agent is still working or waiting, so its Activity keeps changing. */
  running: boolean;
};

/**
 * The Activity a focus asks for, or null. Only a sub-agent box of a session that has an app chat has one: the main agent
 * IS the chat, a process group has no transcript, and a terminal session the app has no chat for has nothing to read.
 */
export function activityTarget(sessions: AgentMonitorSession[], focus: RunningFocus | null): ActivityTarget | null {
  if (!focus?.nodeKey) return null;
  const prefix = agentNodeId(focus.sessionKey, '');
  if (!focus.nodeKey.startsWith(prefix)) return null;
  const agentId = focus.nodeKey.slice(prefix.length);
  const session = sessions.find((candidate) => candidate.id === focus.sessionKey);
  const agent = session?.agents.find((candidate) => candidate.id === agentId);
  const chatId = openableChatId(sessions, focus.sessionKey);
  if (!agent || !chatId) return null;
  return { sessionKey: focus.sessionKey, chatId, agentId, running: agent.state === 'running' || agent.state === 'waiting' };
}

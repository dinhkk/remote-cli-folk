import { agentNodeId, orchestratorNodeId, processNodeId } from '@/modules/agent-monitor/graph/layoutMonitorTree';
import type { RunningFocus } from '@/modules/agent-monitor/running/RunningFocusContext';
import type { AgentMonitorNode, AgentMonitorProcessGroup, AgentMonitorSession, AgentMonitorSnapshot } from '@/shared/types';

/** What the focused node is, resolved against the latest snapshot. */
export type Selection =
  /** A session, or its main agent (`main`): the two share one process, so they share one detail. */
  | { kind: 'session'; session: AgentMonitorSession; main: boolean }
  | { kind: 'agent'; session: AgentMonitorSession; agent: AgentMonitorNode }
  | { kind: 'process'; session: AgentMonitorSession; group: AgentMonitorProcessGroup };

/**
 * The thing a focus points at, or null when nothing is focused or what it pointed at has left the snapshot (a finished agent
 * folded away, a process group that ended). Nodes are matched by the graph's own ids, within the focused session only.
 * The "+N finished" fold has no detail of its own: it shows its session.
 */
export function resolveSelection(snapshot: AgentMonitorSnapshot, focus: RunningFocus | null): Selection | null {
  if (!focus) return null;
  const session = snapshot.sessions.find((candidate) => candidate.id === focus.sessionKey);
  if (!session) return null;
  const { nodeKey } = focus;

  if (nodeKey === null || nodeKey === `folded:${session.id}`) return { kind: 'session', session, main: false };
  if (nodeKey === orchestratorNodeId(session.id)) return { kind: 'session', session, main: true };

  const agent = session.agents.find((candidate) => agentNodeId(session.id, candidate.id) === nodeKey);
  if (agent) return { kind: 'agent', session, agent };

  const group = (session.processes ?? []).find((candidate) => processNodeId(session.id, candidate) === nodeKey);
  return group ? { kind: 'process', session, group } : null;
}

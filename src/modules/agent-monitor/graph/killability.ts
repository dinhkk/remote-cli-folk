import { processNodeId, type GraphNode } from '@/modules/agent-monitor/graph/layoutMonitorTree';
import type { AgentMonitorSession } from '@/shared/types';

/** A first press only arms the button; it goes back to idle after this long if the second press does not come. */
export const KILL_ARM_MS = 3_000;
/** After "stop" is accepted the agent has this long, counted from the press, to end before the button offers the session kill. */
export const STOP_ESCALATE_MS = 5_000;
/** After a kill the box says "killing" until the snapshot shows the change, or this long. */
export const KILLING_MAX_MS = 8_000;
/** How long the result line stays on screen. */
export const KILL_MESSAGE_MS = 8_000;

/** What a node's button would do: `main` kills the session's whole process tree, `agent` stops the agent (then offers the tree), `process` kills one group. */
export type KillAction = { kind: 'main' | 'agent' | 'process'; name: string; count: number };

const isWorking = (state: string): boolean => state === 'running' || state === 'waiting';

/**
 * The kill button of a box, or null when it has none: the session box and the "+N finished" fold never do, a finished box
 * has nothing to kill, the unnamed "other" process group is not a thing to name, and a terminal session's agent cannot be
 * stopped (the server refuses it, so the client does not offer it). The same rules the server enforces.
 */
export function killAction(node: GraphNode): KillAction | null {
  switch (node.kind) {
    case 'orchestrator':
      return isWorking(node.state) ? { kind: 'main', name: node.session.orchestrator.name, count: 0 } : null;
    case 'agent':
      return isWorking(node.state) && !node.sessionId.startsWith('terminal:') ? { kind: 'agent', name: node.agent.name, count: 0 } : null;
    case 'process':
      // A process group is `running` while its session works; a group of an idle session is not killed from its box.
      return node.state === 'running' && node.group.name !== '' ? { kind: 'process', name: node.group.name, count: node.group.count } : null;
    default:
      return null;
  }
}

/** Whether the box `nodeId` is still something to kill in the picture: the session works, the agent works, or the group still exists. */
export function isNodeActive(sessions: readonly AgentMonitorSession[], nodeId: string): boolean {
  for (const session of sessions) {
    if (nodeId === `orch:${session.id}`) return session.state !== 'idle';
    const agentPrefix = `agent:${session.id}:`;
    if (nodeId.startsWith(agentPrefix)) {
      const agent = session.agents.find((candidate) => `${agentPrefix}${candidate.id}` === nodeId);
      return Boolean(agent) && isWorking(agent?.state ?? '');
    }
    if (nodeId.startsWith(`proc:${session.id}:`)) {
      return session.state !== 'idle' && (session.processes ?? []).some((group) => processNodeId(session.id, group) === nodeId);
    }
  }
  return false;
}

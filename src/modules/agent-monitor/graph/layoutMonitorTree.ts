import type { AgentMonitorNode, AgentMonitorProcessGroup, AgentMonitorSession, AgentMonitorState } from '@/shared/types';

/** One box of the graph. The layout only decides where it sits (the INITIAL position: the user may drag it afterwards) and how big it is. */
export type GraphNode =
  | { id: string; kind: 'session'; x: number; y: number; w: number; h: number; state: AgentMonitorState; sessionId: string; session: AgentMonitorSession }
  | { id: string; kind: 'orchestrator'; x: number; y: number; w: number; h: number; state: AgentMonitorState; sessionId: string; session: AgentMonitorSession }
  | { id: string; kind: 'agent'; x: number; y: number; w: number; h: number; state: AgentMonitorState; sessionId: string; agent: AgentMonitorNode }
  /** A group of OS processes the session's Claude process started (tools, MCP servers). No state machine: `running` while the session works, else `done`. */
  | { id: string; kind: 'process'; x: number; y: number; w: number; h: number; state: AgentMonitorState; sessionId: string; group: AgentMonitorProcessGroup }
  | { id: string; kind: 'folded'; x: number; y: number; w: number; h: number; state: AgentMonitorState; sessionId: string; count: number };

export type GraphEdge = {
  id: string;
  from: string;
  to: string;
  /** `link` joins session and orchestrator, `agent` the orchestrator and an agent, `process` the orchestrator and a process group. */
  kind: 'link' | 'agent' | 'process';
  /** The child is working: dots flow along the edge. */
  flowing: boolean;
  /** Stroke width in px; grows with the child's token rate (a process edge stays thin). */
  thickness: number;
  state: AgentMonitorState;
};

export type GraphLayout = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
  /** Agents that did not fit under the drawing cap (folded into the "+N finished" box). */
  omittedAgents: number;
  /** Process groups that did not fit under their caps (a note under the graph). */
  omittedProcesses: number;
};

/** Each session is the root of its own tree: session, then its orchestrator, then the leaves (agents, finished chip, process groups). */
const COLUMN_X = { session: 0, orchestrator: 178, leaf: 356 } as const;
const SIZE = {
  session: { w: 150, h: 58 },
  orchestrator: { w: 150, h: 58 },
  agent: { w: 172, h: 58 },
  process: { w: 172, h: 46 },
  folded: { w: 172, h: 34 },
} as const;
const ROW_GAP = 12;
const BLOCK_GAP = 22;
/** Most agent boxes drawn at once, so a very busy server stays readable and cheap to animate. */
export const MAX_DRAWN_AGENTS = 36;
/** Most process-group boxes drawn under one session. The server already sends at most 8 groups per session. */
export const MAX_DRAWN_PROCESSES_PER_SESSION = 5;
/** Most process-group boxes drawn in the whole picture (busiest sessions come first and spend it first). */
export const MAX_DRAWN_PROCESSES = 30;
/** A process edge flows only while its group uses at least this much CPU (% of the whole machine). */
export const PROCESS_ACTIVE_CPU_PERCENT = 1;
/** Stroke width of a process edge: always thin, it carries no token rate. */
const PROCESS_EDGE_THICKNESS = 1;

/** Stroke width of an edge: 1.5 px when quiet, up to 6 px at several hundred tokens per second. */
export function edgeThickness(tokensPerSecond: number): number {
  return Math.round((1.5 + Math.min(4.5, Math.log10(1 + Math.max(0, tokensPerSecond)) * 1.8)) * 10) / 10;
}

/** The id of a process-group box. The server's unnamed "other" group has no name to key on. */
export const processNodeId = (sessionId: string, group: AgentMonitorProcessGroup): string => `proc:${sessionId}:${group.name === '' ? '*other' : group.name.toLowerCase()}`;
/** The ids of the other boxes. The list in the sidebar and the graph name a node by the same id, which is how a focus finds its box. */
export const sessionNodeId = (sessionId: string): string => `session:${sessionId}`;
export const orchestratorNodeId = (sessionId: string): string => `orch:${sessionId}`;
export const agentNodeId = (sessionId: string, agentId: string): string => `agent:${sessionId}:${agentId}`;

type LeafRow =
  | { kind: 'agent'; agent: AgentMonitorNode }
  | { kind: 'folded'; count: number }
  | { kind: 'process'; group: AgentMonitorProcessGroup };

const rowHeight = (row: LeafRow): number => SIZE[row.kind].h;

/**
 * Places one tree per session, left to right: the session is the root, its orchestrator the next column, and the leaves
 * stack in the last column: agents first, then the "+N finished" chip, then the session's process groups. A session block
 * is as tall as its leaf stack; the session and orchestrator boxes sit at the block's middle. Pure: the same sessions
 * always give the same boxes. The graph component uses these positions only for nodes it has not placed yet: a box the user
 * dragged keeps the dragged position (see `nodePositions.ts`).
 * Caps: `maxAgents` agent boxes overall, and `maxProcesses` process boxes overall with at most
 * `MAX_DRAWN_PROCESSES_PER_SESSION` under each session; what is left out is counted, not drawn.
 * With `showProcesses: false` (default true) no process box or edge is drawn and none is counted as left out.
 */
export function layoutMonitorTree(
  sessions: AgentMonitorSession[],
  maxAgents = MAX_DRAWN_AGENTS,
  maxProcesses = MAX_DRAWN_PROCESSES,
  { showProcesses = true }: { showProcesses?: boolean } = {},
): GraphLayout {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let agentBudget = maxAgents;
  let processBudget = maxProcesses;
  let omittedAgents = 0;
  let omittedProcesses = 0;
  let cursor = 0;

  const blocks = sessions.map((session) => {
    // Running agents come first from the server; the budget is spent in that order across all sessions.
    const drawnAgents = session.agents.slice(0, Math.max(0, agentBudget));
    agentBudget -= drawnAgents.length;
    omittedAgents += session.agents.length - drawnAgents.length;

    const groups = showProcesses ? session.processes ?? [] : [];
    const drawnGroups = groups.slice(0, Math.max(0, Math.min(MAX_DRAWN_PROCESSES_PER_SESSION, processBudget)));
    processBudget -= drawnGroups.length;
    omittedProcesses += groups.length - drawnGroups.length;

    const rows: LeafRow[] = drawnAgents.map((agent) => ({ kind: 'agent' as const, agent }));
    const hiddenCount = session.foldedFinished + (session.agents.length - drawnAgents.length);
    if (hiddenCount > 0) rows.push({ kind: 'folded', count: hiddenCount });
    rows.push(...drawnGroups.map((group) => ({ kind: 'process' as const, group })));
    return { session, rows };
  });

  for (const { session, rows } of blocks) {
    const heights = rows.map(rowHeight);
    const stackHeight = heights.reduce((sum, h) => sum + h, 0) + Math.max(0, rows.length - 1) * ROW_GAP;
    const blockHeight = Math.max(stackHeight, SIZE.session.h);
    const middle = cursor + blockHeight / 2;

    const sessionNode: GraphNode = { id: sessionNodeId(session.id), kind: 'session', ...columnPosition(middle, 'session'), ...SIZE.session, state: session.state === 'idle' ? 'done' : session.state, sessionId: session.id, session };
    const orchestratorNode: GraphNode = { id: orchestratorNodeId(session.id), kind: 'orchestrator', ...columnPosition(middle, 'orchestrator'), ...SIZE.orchestrator, state: session.orchestrator.state, sessionId: session.id, session };
    nodes.push(sessionNode, orchestratorNode);
    edges.push(
      makeEdge(sessionNode, orchestratorNode, 'link', session.orchestrator.state === 'running' || session.orchestrator.state === 'waiting', 0, session.orchestrator.state),
    );

    // Process groups have no state of their own: they read as running while the session works.
    const processState: AgentMonitorState = session.state === 'idle' ? 'done' : 'running';
    let y = cursor + (blockHeight - stackHeight) / 2;
    rows.forEach((row, index) => {
      if (row.kind === 'agent') {
        const agentNode: GraphNode = { id: agentNodeId(session.id, row.agent.id), kind: 'agent', x: COLUMN_X.leaf, y, ...SIZE.agent, state: row.agent.state, sessionId: session.id, agent: row.agent };
        nodes.push(agentNode);
        const live = row.agent.state === 'running' || row.agent.state === 'waiting';
        edges.push(makeEdge(orchestratorNode, agentNode, 'agent', live, row.agent.tokensPerSecond, row.agent.state));
      } else if (row.kind === 'process') {
        const processNode: GraphNode = { id: processNodeId(session.id, row.group), kind: 'process', x: COLUMN_X.leaf, y, ...SIZE.process, state: processState, sessionId: session.id, group: row.group };
        nodes.push(processNode);
        const busy = row.group.cpuPercent !== null && row.group.cpuPercent >= PROCESS_ACTIVE_CPU_PERCENT;
        edges.push(makeEdge(orchestratorNode, processNode, 'process', busy, 0, processState));
      } else {
        nodes.push({ id: `folded:${session.id}`, kind: 'folded', x: COLUMN_X.leaf, y, ...SIZE.folded, state: 'done', sessionId: session.id, count: row.count });
      }
      y += heights[index] + ROW_GAP;
    });
    cursor += blockHeight + BLOCK_GAP;
  }

  const height = Math.max(0, cursor - (blocks.length > 0 ? BLOCK_GAP : 0));
  return { nodes, edges, width: COLUMN_X.leaf + SIZE.agent.w, height, omittedAgents, omittedProcesses };
}

const columnPosition = (middle: number, column: 'session' | 'orchestrator'): { x: number; y: number } => ({
  x: COLUMN_X[column],
  y: middle - SIZE[column].h / 2,
});

function makeEdge(from: GraphNode, to: GraphNode, kind: GraphEdge['kind'], flowing: boolean, tokensPerSecond: number, state: AgentMonitorState): GraphEdge {
  return {
    id: `${from.id}>${to.id}`,
    from: from.id,
    to: to.id,
    kind,
    flowing,
    thickness: kind === 'process' ? PROCESS_EDGE_THICKNESS : edgeThickness(tokensPerSecond),
    state,
  };
}

import type {
  AgentMonitorNode,
  AgentMonitorSession,
  AgentMonitorState,
  NormalizedMessage,
} from '@/shared/types.js';

import { projectKeyOf } from './agent-monitor.projects.js';
import { IDLE_SESSION_VISIBLE_MS, isLiveState as isLive, selectVisibleAgents } from './agent-monitor.visibility.js';

/** What the monitor knows about a session that the event stream does not say. */
export type MonitorSessionMeta = {
  label: string;
  projectName: string | null;
  /** The folder the chat runs in (groups it with other chats and terminal sessions of the same project). */
  projectPath?: string | null;
  provider: string;
  /** Orchestrator name from the session's agent snapshot; null for a plain chat. */
  orchestratorName: string | null;
};

type AggregatorOptions = {
  now?: () => number;
  /** Looks the session up in the app store the first time an event of it arrives. Never throws into the stream. */
  readSessionMeta?: (sessionId: string) => MonitorSessionMeta | null;
};

/** The tools that start a sub-agent (`Agent` in current SDKs, `Task` in older ones). */
const DELEGATION_TOOLS = new Set(['Agent', 'Task']);

/** A session with nothing running is forgotten this long after its last event (the in-memory history ring). */
const SESSION_RETENTION_MS = 60 * 60_000;
/** A token rate older than this reads as 0: the agent went quiet. */
const RATE_STALE_MS = 10_000;
/** Cap on remembered token deltas (≈ the 60-minute ring), so a long-lived server cannot grow without bound. */
const MAX_LEDGER_ENTRIES = 20_000;
/** Sessions drawn at most; the busiest and newest win. */
const MAX_SESSIONS = 20;

type NodeRecord = {
  key: string;
  taskId: string | null;
  /** True once a `task_started` bound a task to this node: its end then comes from the task, not from the tool result. */
  hasTask: boolean;
  kind: AgentMonitorNode['kind'];
  name: string;
  description: string;
  state: AgentMonitorState;
  startedAt: number;
  endedAt: number | null;
  tokens: number;
  reportedToolCalls: number;
  streamedToolCalls: number;
  lastToolName: string | null;
  /** The last two token readings (time, total) — enough for a rate. */
  samples: Array<[number, number]>;
  model: string | null;
};

type SessionRecord = {
  id: string;
  meta: MonitorSessionMeta | null;
  runActive: boolean;
  runStartedAt: number | null;
  lastEventAt: number;
  errored: boolean;
  nodes: Map<string, NodeRecord>;
  taskToKey: Map<string, string>;
  /** Permission prompts still waiting for the user: request id -> the tool asked for. */
  pendingPermissions: Map<string, string>;
  orchestratorToolId: string | null;
  orchestratorTool: string | null;
  contextTokens: number | null;
  contextWindow: number | null;
  cacheHitRatio: number | null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

const asString = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** Maps the words the SDK uses for the end of a task onto a state; anything else means "still going". */
function terminalState(status: string | undefined): AgentMonitorState | null {
  switch (status) {
    case 'completed':
    case 'done':
      return 'done';
    case 'failed':
    case 'error':
      return 'failed';
    case 'stopped':
    case 'killed':
    case 'cancelled':
      return 'stopped';
    default:
      return null;
  }
}

function kindOfTask(taskType: string | undefined): AgentMonitorNode['kind'] {
  const type = (taskType ?? '').toLowerCase();
  if (type.includes('workflow')) return 'workflow';
  if (type.includes('bash') || type.includes('shell') || type.includes('command')) return 'command';
  return 'agent';
}

/**
 * Turns the live event stream of every chat run into the monitor's picture: for each session its orchestrator and the
 * agents (sub-agents, workflow runs, background commands) it launched, with state, timers, token totals and tool counts.
 *
 * It only listens: events are the normalized messages the chat gateway already sends to the browser (`task_status`
 * from the SDK's task events, plus tool calls, permission prompts and `complete`), so nothing is parsed twice. All
 * state is in memory; a restart starts from an empty picture, and the transcript on disk stays the source of truth.
 */
export function createAgentActivityAggregator({ now = Date.now, readSessionMeta = () => null }: AggregatorOptions = {}) {
  const sessions = new Map<string, SessionRecord>();
  /** Every positive token increase any agent reported: the base of tokens/minute and tokens today. */
  const ledger: Array<{ at: number; tokens: number }> = [];

  function loadMeta(sessionId: string): MonitorSessionMeta | null {
    try {
      return readSessionMeta(sessionId);
    } catch {
      // A store that cannot be read only costs the label; the picture itself comes from the stream.
      return null;
    }
  }

  function sessionOf(sessionId: string): SessionRecord {
    let record = sessions.get(sessionId);
    if (!record) {
      record = {
        id: sessionId,
        meta: loadMeta(sessionId),
        runActive: false,
        runStartedAt: null,
        lastEventAt: now(),
        errored: false,
        nodes: new Map(),
        taskToKey: new Map(),
        pendingPermissions: new Map(),
        orchestratorToolId: null,
        orchestratorTool: null,
        contextTokens: null,
        contextWindow: null,
        cacheHitRatio: null,
      };
      sessions.set(sessionId, record);
    }
    return record;
  }

  function ensureNode(session: SessionRecord, key: string, init: Partial<NodeRecord> = {}): NodeRecord {
    let node = session.nodes.get(key);
    if (!node) {
      node = {
        key,
        taskId: null,
        hasTask: false,
        kind: 'agent',
        name: 'agent',
        description: '',
        state: 'running',
        startedAt: now(),
        endedAt: null,
        tokens: 0,
        reportedToolCalls: 0,
        streamedToolCalls: 0,
        lastToolName: null,
        samples: [],
        model: null,
        ...init,
      };
      session.nodes.set(key, node);
    }
    return node;
  }

  /** Finds the node a task event is about: by task id once bound, else by the launching tool call. */
  function nodeForTask(session: SessionRecord, taskId: string | null, toolUseId: string | null): NodeRecord | null {
    const boundKey = taskId ? session.taskToKey.get(taskId) : undefined;
    if (boundKey) return session.nodes.get(boundKey) ?? null;
    if (toolUseId) return session.nodes.get(toolUseId) ?? null;
    return null;
  }

  function finish(node: NodeRecord, state: AgentMonitorState): void {
    if (!isLive(node.state)) return;
    node.state = state;
    node.endedAt = now();
    node.lastToolName = null;
  }

  function recordTokens(node: NodeRecord, total: number): void {
    const at = now();
    // The SDK reports a running total; only an increase is new work (a repeated or lower reading is not).
    if (total > node.tokens) {
      ledger.push({ at, tokens: total - node.tokens });
      if (ledger.length > MAX_LEDGER_ENTRIES) ledger.splice(0, ledger.length - MAX_LEDGER_ENTRIES);
      node.tokens = total;
    }
    node.samples.push([at, node.tokens]);
    if (node.samples.length > 2) node.samples.shift();
  }

  function applyUsage(node: NodeRecord, usage: NormalizedMessage['usage']): void {
    if (!usage) return;
    recordTokens(node, usage.totalTokens);
    node.reportedToolCalls = Math.max(node.reportedToolCalls, usage.toolUses);
  }

  function onToolUse(session: SessionRecord, message: NormalizedMessage): void {
    const toolName = asString(message.toolName);
    const toolId = asString(message.toolId);
    const parent = asString(message.parentToolUseId);
    if (!toolName) return;

    if (DELEGATION_TOOLS.has(toolName) && toolId) {
      const input = asRecord(message.toolInput) ?? {};
      const description = asString(input.description) ?? '';
      const node = ensureNode(session, toolId, { startedAt: now() });
      node.name = asString(input.subagent_type) ?? (description || node.name);
      node.description = description;
      node.model = asString(input.model) ?? node.model;
      return;
    }

    if (parent) {
      const node = session.nodes.get(parent);
      if (node && isLive(node.state)) {
        node.lastToolName = toolName;
        node.streamedToolCalls += 1;
      }
      return;
    }

    session.orchestratorTool = toolName;
    session.orchestratorToolId = toolId;
  }

  function onToolResult(session: SessionRecord, message: NormalizedMessage): void {
    const toolId = asString(message.toolId);
    if (!toolId) return;

    if (toolId === session.orchestratorToolId) {
      session.orchestratorTool = null;
      session.orchestratorToolId = null;
    }

    const node = session.nodes.get(toolId);
    // A background agent's tool result is only the "launched" receipt; its end arrives as a task event.
    // A synchronous agent has no task, so its result is its end.
    if (node && !node.hasTask) {
      const failed = Boolean(message.isError) || Boolean(asRecord(message.toolResult)?.isError);
      finish(node, failed ? 'failed' : 'done');
    }
  }

  function onTaskStatus(session: SessionRecord, message: NormalizedMessage): void {
    const taskId = asString(message.taskId);
    const toolUseId = asString(message.toolUseId);
    const description = asString(message.description);
    let node = nodeForTask(session, taskId, toolUseId);

    if (message.event === 'started') {
      const kind = kindOfTask(asString(message.taskType) ?? undefined);
      node ??= ensureNode(session, toolUseId ?? taskId ?? `task-${session.nodes.size}`);
      node.hasTask = true;
      node.taskId = taskId;
      node.kind = kind;
      if (taskId) session.taskToKey.set(taskId, node.key);
      if (description) node.description = description;
      // The delegation tool call named the agent type; without one the task's own words are the best name.
      if (node.name === 'agent') node.name = asString(message.workflowName) ?? description ?? node.name;
      node.state = 'running';
      node.startedAt = now();
      return;
    }

    if (!node) {
      // Progress for a task whose start was never seen (the monitor started mid-run): attach it as a new node.
      if (!taskId && !toolUseId) return;
      node = ensureNode(session, toolUseId ?? taskId ?? '', { hasTask: true, taskId, name: description ?? 'agent' });
      if (taskId) session.taskToKey.set(taskId, node.key);
    }
    if (description && !node.description) node.description = description;

    switch (message.event) {
      case 'progress': {
        applyUsage(node, message.usage);
        const running = message.agents?.find((agent) => agent.state === 'running');
        if (running) node.lastToolName = running.lastToolName ?? running.label ?? node.lastToolName;
        break;
      }
      case 'updated': {
        const end = terminalState(asString(message.status) ?? undefined);
        if (end) finish(node, end);
        break;
      }
      case 'notification': {
        applyUsage(node, message.usage);
        finish(node, terminalState(asString(message.status) ?? undefined) ?? 'done');
        break;
      }
      default:
        break;
    }
  }

  /**
   * Names who a pending permission prompt blocks. The prompt carries only the tool, so the running agent whose latest
   * streamed tool call is that tool is the one waiting; with none, it is the orchestrator itself.
   */
  function markWaiting(session: SessionRecord): { agentKeys: Set<string>; orchestrator: boolean } {
    const agentKeys = new Set<string>();
    const tools = new Set(session.pendingPermissions.values());
    if (tools.size === 0) return { agentKeys, orchestrator: false };
    for (const node of session.nodes.values()) {
      if (node.state === 'running' && node.lastToolName && tools.has(node.lastToolName)) agentKeys.add(node.key);
    }
    return { agentKeys, orchestrator: agentKeys.size === 0 };
  }

  function toNode(node: NodeRecord, waiting: boolean): AgentMonitorNode {
    const [previous, latest] = node.samples.length === 2 ? node.samples : [null, null];
    let tokensPerSecond = 0;
    if (previous && latest && isLive(node.state) && now() - latest[0] <= RATE_STALE_MS && latest[0] > previous[0]) {
      tokensPerSecond = Math.max(0, (latest[1] - previous[1]) / ((latest[0] - previous[0]) / 1000));
    }
    return {
      id: node.key,
      name: node.name,
      kind: node.kind,
      description: node.description,
      state: waiting && node.state === 'running' ? 'waiting' : node.state,
      startedAt: node.startedAt,
      endedAt: node.endedAt,
      tokens: node.tokens,
      toolCalls: Math.max(node.reportedToolCalls, node.streamedToolCalls),
      lastToolName: isLive(node.state) ? node.lastToolName : null,
      tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
      model: node.model,
    };
  }

  function toSession(session: SessionRecord, at: number): AgentMonitorSession | null {
    const { agentKeys, orchestrator: orchestratorWaiting } = markWaiting(session);
    const all = [...session.nodes.values()];
    const { live, shown, folded } = selectVisibleAgents(all, at);

    const idle = live.length === 0 && !session.runActive;
    if (idle && at - session.lastEventAt > IDLE_SESSION_VISIBLE_MS) return null;

    const waiting = session.pendingPermissions.size > 0;
    const sessionState: AgentMonitorSession['state'] = waiting ? 'waiting' : idle ? 'idle' : 'running';
    let orchestratorState: AgentMonitorState = 'done';
    if (orchestratorWaiting) orchestratorState = 'waiting';
    else if (session.runActive || live.length > 0) orchestratorState = 'running';
    else if (session.errored) orchestratorState = 'failed';

    const meta = session.meta;
    return {
      id: session.id,
      label: meta?.label || session.id.slice(0, 8),
      projectName: meta?.projectName ?? null,
      provider: meta?.provider ?? 'claude',
      state: sessionState,
      runStartedAt: session.runStartedAt,
      lastEventAt: session.lastEventAt,
      orchestrator: {
        name: meta?.orchestratorName ?? 'Main agent',
        fromProfile: Boolean(meta?.orchestratorName),
        state: orchestratorState,
        lastToolName: session.runActive ? session.orchestratorTool : null,
        contextTokens: session.contextTokens,
        contextWindow: session.contextWindow,
      },
      agents: shown.map((node) => toNode(node, agentKeys.has(node.key))),
      foldedFinished: folded,
      agentTokens: all.reduce((sum, node) => sum + node.tokens, 0),
      cacheHitRatio: session.cacheHitRatio,
      source: 'app',
      detail: 'live',
      projectPath: meta?.projectPath ?? null,
      projectKey: projectKeyOf(meta?.projectPath),
      openSessionId: session.id,
    };
  }

  return {
    /** A run started for the session (the user sent a message, or a timer fired). */
    startRun(sessionId: string, startedAt: number): void {
      const session = sessionOf(sessionId);
      // The session may have been named since its first run.
      session.meta = loadMeta(sessionId) ?? session.meta;
      session.runActive = true;
      session.runStartedAt = startedAt;
      session.lastEventAt = now();
      session.errored = false;
      session.orchestratorTool = null;
      session.orchestratorToolId = null;
    },

    /** One live event of the session's run, as the sockets get it. */
    ingest(sessionId: string, message: NormalizedMessage): void {
      const session = sessionOf(sessionId);
      session.lastEventAt = now();

      switch (message.kind) {
        case 'task_status':
          onTaskStatus(session, message);
          break;
        case 'tool_use':
          onToolUse(session, message);
          break;
        case 'tool_result':
          onToolResult(session, message);
          break;
        case 'permission_request': {
          const requestId = asString(message.requestId);
          if (requestId) session.pendingPermissions.set(requestId, asString(message.toolName) ?? '');
          break;
        }
        case 'permission_resolved':
        case 'permission_cancelled': {
          const requestId = asString(message.requestId);
          if (requestId) session.pendingPermissions.delete(requestId);
          break;
        }
        case 'status': {
          const budget = asRecord(message.tokenBudget);
          if (message.text === 'token_budget' && budget) {
            session.contextTokens = typeof budget.used === 'number' ? budget.used : session.contextTokens;
            session.contextWindow = typeof budget.total === 'number' ? budget.total : session.contextWindow;
          }
          break;
        }
        case 'complete': {
          session.runActive = false;
          session.orchestratorTool = null;
          session.orchestratorToolId = null;
          session.pendingPermissions.clear();
          // An aborted run takes its agents down with it; a normal end leaves background agents running on.
          if (message.aborted) {
            for (const node of session.nodes.values()) finish(node, 'stopped');
          }
          break;
        }
        case 'error':
          session.errored = true;
          break;
        default:
          break;
      }

      // The model of a sub-agent shows on the assistant rows it streams.
      const model = asString(message.model);
      const parent = asString(message.parentToolUseId);
      if (model && parent) {
        const node = session.nodes.get(parent);
        if (node) node.model = model;
      }
    },

    /** The SDK task id bound to a node (null when there is none). Read-only: it never creates a session. */
    taskIdOf(sessionId: string, nodeKey: string): string | null {
      return sessions.get(sessionId)?.nodes.get(nodeKey)?.taskId ?? null;
    },

    /** Whether the node exists and is working or waiting. Read-only. */
    isAgentLive(sessionId: string, nodeKey: string): boolean {
      const node = sessions.get(sessionId)?.nodes.get(nodeKey);
      return Boolean(node) && isLive((node as NodeRecord).state);
    },

    /**
     * The session's process was killed: no run is active and every agent still going has stopped. Agents that finished keep
     * their state. A session the aggregator does not know stays unknown.
     */
    settleSession(sessionId: string, state: AgentMonitorState = 'stopped'): void {
      const session = sessions.get(sessionId);
      if (!session) return;
      session.runActive = false;
      session.orchestratorTool = null;
      session.orchestratorToolId = null;
      session.pendingPermissions.clear();
      session.lastEventAt = now();
      for (const node of session.nodes.values()) finish(node, state);
    },

    /** Remembers the cache-hit ratio read from a session's transcript (the monitor refreshes it in the background). */
    setCacheHitRatio(sessionId: string, ratio: number | null): void {
      const session = sessions.get(sessionId);
      if (session) session.cacheHitRatio = ratio;
    },

    /** Sessions with a run in progress or agents still working: the ones worth reading a transcript for. */
    activeSessionIds(): string[] {
      return [...sessions.values()]
        .filter((session) => session.runActive || [...session.nodes.values()].some((node) => isLive(node.state)))
        .map((session) => session.id);
    },

    /** The picture right now: sessions worth drawing, busiest first, and the counts of the KPI strip. */
    snapshot(): { sessions: AgentMonitorSession[]; runningAgents: number; runningSessions: number } {
      const at = now();
      for (const [id, session] of sessions) {
        const quiet = !session.runActive && ![...session.nodes.values()].some((node) => isLive(node.state));
        if (quiet && at - session.lastEventAt > SESSION_RETENTION_MS) sessions.delete(id);
      }

      const drawn = [...sessions.values()]
        .map((session) => toSession(session, at))
        .filter((session): session is AgentMonitorSession => session !== null)
        .sort((a, b) => Number(b.state !== 'idle') - Number(a.state !== 'idle') || b.lastEventAt - a.lastEventAt)
        .slice(0, MAX_SESSIONS);

      return {
        sessions: drawn,
        runningAgents: drawn.reduce((sum, session) => sum + session.agents.filter((agent) => isLive(agent.state)).length, 0),
        runningSessions: drawn.filter((session) => session.state !== 'idle').length,
      };
    },

    /** Token activity: the last minute's total, today's total, and `buckets` bucket totals of `bucketMs` ending now. */
    tokenActivity(buckets = 30, bucketMs = 2000): { perMinute: number; today: number; series: number[] } {
      const at = now();
      const dayStart = new Date(at);
      dayStart.setHours(0, 0, 0, 0);
      const series = new Array<number>(buckets).fill(0);
      let perMinute = 0;
      let today = 0;
      for (const entry of ledger) {
        if (entry.at >= dayStart.getTime()) today += entry.tokens;
        if (at - entry.at <= 60_000) perMinute += entry.tokens;
        const age = at - entry.at;
        const bucket = buckets - 1 - Math.floor(age / bucketMs);
        if (age >= 0 && bucket >= 0 && bucket < buckets) series[bucket] += entry.tokens;
      }
      return { perMinute, today, series };
    },
  };
}

export type AgentActivityAggregator = ReturnType<typeof createAgentActivityAggregator>;

import type { AgentMonitorKillRequest, AgentMonitorKillResponse } from '@/shared/types.js';
import { groupKeyOf } from '@/modules/process-control/index.js';
import type { KillContext, KillOutcome } from '@/modules/process-control/index.js';

import type { AgentActivityAggregator } from './agent-monitor.aggregator.js';

/** The SDK is given this long to stop one agent; after it the answer is "no handle" and the client offers the session kill. */
export const STOP_TASK_TIMEOUT_MS = 3_000;
/** The mark that keeps a killed run quiet is taken back this long after a kill, so it can never swallow the next run's end. */
const UNMARK_AFTER_MS = 10_000;
/** Longest id or name accepted (the same bound the route puts on the body). */
const MAX_ID_LENGTH = 256;

/** What the store knows about a session id the client sent. `terminal` sessions are CLI sessions the app did not start. */
export type KillSessionInfo = { provider: string; providerSessionId: string | null; terminal: boolean; root?: { pid: number; startedAt: number } };

/** One Claude CLI process of the registry; only `pid`, `startedAt` and the session id it belongs to matter here. */
type LiveRoot = { providerSessionId: string; pid: number; startedAt: number };

type KillerDeps = {
  aggregator: Pick<AgentActivityAggregator, 'taskIdOf' | 'isAgentLive' | 'settleSession'>;
  describeSession: (sessionId: string) => KillSessionInfo | null;
  /** The CLI's registry, read FRESH on each call (never a cached list: a cached pid is how a wrong process gets killed). */
  listLive: () => Promise<LiveRoot[]>;
  processKiller: {
    killTree: (rootPid: number, context: KillContext) => Promise<KillOutcome>;
    killGroup: (rootPid: number, groupKey: string, context: KillContext) => Promise<KillOutcome>;
  };
  stopTask: (sessionId: string, taskId: string) => Promise<boolean>;
  /** Quiets the run loop (no failed-run report) and cancels pending prompts; false when there is no live run. */
  markKilled: (sessionId: string) => boolean;
  unmarkKilled: (sessionId: string) => void;
  /** Ends the chat run in the registry as aborted, when it is still running. */
  completeRun: (sessionId: string) => void;
  /** Runs `action` after `ms` (a timer in production). */
  defer?: (action: () => void, ms: number) => void;
};

type ParsedNode =
  | { kind: 'main' }
  | { kind: 'agent'; agentId: string }
  | { kind: 'process'; name: string };

/** The node an id names, by exact prefix of THIS session's id (ids may hold colons); null when it is not one of the three shapes. */
function parseNode(sessionId: string, nodeId: string): ParsedNode | null {
  if (nodeId === `orch:${sessionId}`) return { kind: 'main' };
  const agentPrefix = `agent:${sessionId}:`;
  if (nodeId.startsWith(agentPrefix) && nodeId.length > agentPrefix.length) return { kind: 'agent', agentId: nodeId.slice(agentPrefix.length) };
  const processPrefix = `proc:${sessionId}:`;
  if (nodeId.startsWith(processPrefix)) {
    const name = nodeId.slice(processPrefix.length).trim();
    // The "other" group (empty name, drawn as `*other`) and unnamed processes are never a target.
    if (name && name !== '*other' && groupKeyOf(name) !== 'unknown') return { kind: 'process', name };
  }
  return null;
}

const outcomeToResponse = ({ result, count }: KillOutcome): AgentMonitorKillResponse => (result === 'killed' ? { result, count } : { result });

/**
 * Stops or kills one node of the graph, for a request the server does not trust: the node must be one of the session's own,
 * the session a Claude one, and the pid is looked up now, from the CLI's registry, by the session. Nothing about a process id
 * is taken from the client, or given back.
 *
 * After a kill that ends a session's process the run loop is quiet, the chat run ends as aborted and every agent of the
 * aggregator's picture is stopped, so the screens do not keep a dead session "running". Two identical kills (same session, node and mode) at once run
 * once.
 */
export function createAgentMonitorKiller(deps: KillerDeps) {
  const defer = deps.defer ?? ((action: () => void, ms: number) => { setTimeout(action, ms).unref(); });
  const inFlight = new Map<string, Promise<AgentMonitorKillResponse>>();

  /** Asks the SDK to stop one agent, giving up after `STOP_TASK_TIMEOUT_MS`. Anything but a yes is "no handle". */
  async function stopAgent(sessionId: string, agentId: string): Promise<AgentMonitorKillResponse> {
    const taskId = deps.aggregator.taskIdOf(sessionId, agentId);
    if (!taskId) return { result: 'no-handle' };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const stopped = await Promise.race([
        deps.stopTask(sessionId, taskId),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), STOP_TASK_TIMEOUT_MS); }),
      ]);
      return { result: stopped ? 'stopped' : 'no-handle' };
    } catch {
      return { result: 'no-handle' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** The Claude process the registry lists for the session now (the newest entry), and every other one. */
  async function resolveRoot(info: KillSessionInfo): Promise<{ root: LiveRoot; context: KillContext } | null> {
    if (!info.providerSessionId) return null;
    let live: LiveRoot[];
    try {
      live = await deps.listLive();
    } catch {
      return null;
    }
    const mine = live.filter((entry) => entry.providerSessionId === info.providerSessionId).sort((a, b) => b.startedAt - a.startedAt || b.pid - a.pid);
    const root = info.root ? mine.find((entry) => entry.pid === info.root?.pid && entry.startedAt === info.root.startedAt) : mine[0];
    if (!root) return null;
    const otherRoots = live.filter((entry) => entry !== root).map((entry) => entry.pid).sort((a, b) => a - b);
    return { root, context: { registryStartedAt: root.startedAt, otherRoots } };
  }

  async function killProcesses(sessionId: string, node: ParsedNode, info: KillSessionInfo): Promise<AgentMonitorKillResponse> {
    const resolved = await resolveRoot(info);
    if (!resolved) return { result: 'unavailable' };
    const { root, context } = resolved;

    if (node.kind === 'process') {
      return outcomeToResponse(await deps.processKiller.killGroup(root.pid, groupKeyOf(node.name), context));
    }

    // The whole tree of the session. Set the mark BEFORE the kill: the run loop sees the dead process within milliseconds.
    const marked = !info.terminal && deps.markKilled(sessionId);
    let outcome: KillOutcome;
    try {
      outcome = await deps.processKiller.killTree(root.pid, context);
    } catch {
      outcome = { result: 'error', count: 0 };
    }
    if (outcome.result === 'killed') {
      if (!info.terminal) {
        deps.completeRun(sessionId);
        deps.aggregator.settleSession(sessionId, 'stopped');
      }
      // The run loop took the mark when it wound down; this is the net for the case where it never did.
      if (marked) defer(() => deps.unmarkKilled(sessionId), UNMARK_AFTER_MS);
    } else if (marked) {
      deps.unmarkKilled(sessionId);
    }
    return outcomeToResponse(outcome);
  }

  async function run(request: AgentMonitorKillRequest): Promise<AgentMonitorKillResponse> {
    const { sessionId, nodeId, mode } = request;
    const node = parseNode(sessionId, nodeId);
    if (!node) return { result: 'refused' };
    const info = deps.describeSession(sessionId);
    if (!info || info.provider !== 'claude') return { result: 'refused' };
    // A terminal session has no agent handle and no aggregator record: only its main process and process groups are killable.
    if (node.kind === 'agent' && info.terminal) return { result: 'refused' };

    if (node.kind === 'agent') {
      if (!deps.aggregator.isAgentLive(sessionId, node.agentId)) return { result: 'gone' };
      if (mode === 'stop') return stopAgent(sessionId, node.agentId);
    } else if (mode === 'stop') {
      // Only an agent can be stopped cooperatively here; the main node and process groups are killed.
      return { result: 'refused' };
    }
    return killProcesses(sessionId, node, info);
  }

  return {
    async kill(request: AgentMonitorKillRequest): Promise<AgentMonitorKillResponse> {
      const { sessionId, nodeId } = request;
      if (!sessionId || sessionId.length > MAX_ID_LENGTH || nodeId.length > MAX_ID_LENGTH || (request.mode !== 'stop' && request.mode !== 'kill')) {
        return { result: 'refused' };
      }
      // One request per exact target: a second ask for the same node and mode shares the answer, but a different node of the
      // same session (a group while the tree is going down) is its own request and gets its own outcome.
      const key = JSON.stringify([sessionId, nodeId, request.mode]);
      const running = inFlight.get(key);
      if (running) return running;
      const attempt = run(request).catch((): AgentMonitorKillResponse => ({ result: 'error' })).finally(() => { inFlight.delete(key); });
      inFlight.set(key, attempt);
      return attempt;
    },
  };
}

export type AgentMonitorKiller = ReturnType<typeof createAgentMonitorKiller>;

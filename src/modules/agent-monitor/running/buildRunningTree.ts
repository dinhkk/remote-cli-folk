import { agentNodeId, orchestratorNodeId, processNodeId, sessionNodeId } from '@/modules/agent-monitor/graph/layoutMonitorTree';
import type { AgentMonitorNode, AgentMonitorProcessGroup, AgentMonitorSession, Project } from '@/shared/types';

/**
 * Pure model of the Running tab's tree: Project -> Session -> Main agent -> (sub-agents, process groups).
 * The project and session levels of the app's own chats come from the sidebar's list; this adds, per session, what the
 * monitor snapshot knows below it, and folds in the terminal sessions (Claude started outside the app).
 */

/** A row under the main agent. Sub-agents and process groups are siblings: an OS process cannot be attributed to one sub-agent (they run inside the claude process). */
export type RunningChildRow =
  | { kind: 'agent'; key: string; agent: AgentMonitorNode }
  | { kind: 'process'; key: string; group: AgentMonitorProcessGroup }
  /** The "+N finished" counter: not a node, it cannot be focused. */
  | { kind: 'folded'; key: string; count: number };

export type RunningSessionNode = {
  /** The monitor's id of the session (what a focus names). */
  sessionKey: string;
  session: AgentMonitorSession;
  /** The app chat that shows the session, null for a terminal session the app has no chat for. */
  chatId: string | null;
  /** Node ids shared with the graph: the session box and the main agent box. */
  nodeKey: string;
  mainKey: string;
  /** Under the main agent: sub-agents first (the server sends running ones first), the finished counter, then the process groups. */
  children: RunningChildRow[];
  /** A working session opens one level (to its main agent); the main agent opens when it works and has something under it. */
  sessionExpandedByDefault: boolean;
  mainExpandedByDefault: boolean;
};

/** Terminal sessions whose folder is not the folder of a project the list already draws: one project row per folder. */
export type RunningTerminalGroup = {
  /** The normalised folder (`folderKey`), or `no-folder`. */
  key: string;
  /** The app project's name, else the monitor's, else the folder's name; null when nothing names it (the row says "no folder"). */
  name: string | null;
  path: string | null;
  sessions: RunningSessionNode[];
};

export type RunningTree = {
  /** The monitor's picture of an app session, by the app's session id. */
  byAppSessionId: ReadonlyMap<string, RunningSessionNode>;
  /** Terminal sessions that share the folder of a project the list draws, by the app's project id. */
  terminalByProjectId: ReadonlyMap<string, RunningSessionNode[]>;
  terminalGroups: RunningTerminalGroup[];
  /** Terminal sessions shown anywhere in the tree. */
  terminalCount: number;
};

export type BuildRunningTreeInput = {
  sessions: readonly AgentMonitorSession[];
  /** The project rows the list draws (the ones with a running app session). */
  displayedProjects: readonly Project[];
  /** Every app project, only to name a terminal folder after the app project that has it. */
  allProjects: readonly Project[];
  /** The sidebar's search text; narrows the terminal sessions (the app rows are narrowed by the list itself). */
  search: string;
  /** A session that stays in the tree while it is focused, even if it went idle. */
  keepSessionKey: string | null;
  /** Draw the child OS processes as rows under the main agent. Default true; the screens pass the user's choice. */
  showProcesses?: boolean;
};

const NO_FOLDER_KEY = 'no-folder';
const isWindowsPath = (value: string): boolean => /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\');

/** A folder as a comparable key: forward slashes, no trailing slash, lower-cased for Windows paths. The same folder always gives the same key, whichever side wrote it. */
export function folderKey(folder: string | null | undefined): string {
  const trimmed = folder?.trim().replace(/^\\\\\?\\/, '') ?? '';
  if (!trimmed) return NO_FOLDER_KEY;
  const forward = trimmed.replace(/\\/g, '/');
  const slashed = forward.length > 1 ? forward.replace(/\/+$/, '') || '/' : forward;
  return isWindowsPath(trimmed) ? slashed.toLowerCase() : slashed;
}

const folderNameOf = (folder: string | null): string | null => folder?.split(/[\\/]/).filter(Boolean).pop() ?? null;

function toNode(session: AgentMonitorSession, showProcesses: boolean): RunningSessionNode {
  const children: RunningChildRow[] = session.agents.map((agent) => ({ kind: 'agent', key: agentNodeId(session.id, agent.id), agent }));
  if (session.foldedFinished > 0) children.push({ kind: 'folded', key: `folded:${session.id}`, count: session.foldedFinished });
  for (const group of showProcesses ? session.processes ?? [] : []) children.push({ kind: 'process', key: processNodeId(session.id, group), group });

  const orchestratorLive = session.orchestrator.state === 'running' || session.orchestrator.state === 'waiting';
  return {
    sessionKey: session.id,
    session,
    chatId: session.openSessionId,
    nodeKey: sessionNodeId(session.id),
    mainKey: orchestratorNodeId(session.id),
    children,
    sessionExpandedByDefault: session.state !== 'idle',
    mainExpandedByDefault: orchestratorLive && children.length > 0,
  };
}

const matchesSearch = (session: AgentMonitorSession, needle: string): boolean =>
  [session.label, session.projectName, session.projectPath, session.orchestrator.name].some((field) => field?.toLowerCase().includes(needle));

const STATE_RANK = { waiting: 0, running: 1, idle: 2 } as const;

/**
 * Builds the tree. App sessions are matched to their monitor picture by id (an app run is drawn by the aggregator under
 * the chat's own id; a chat resumed in a terminal is a terminal session pointing at it by `openSessionId`). Terminal
 * sessions that are working (or focused) join the project row of the same folder, else get a project row of their own
 * named after the app project with that folder, else the folder. Order: the snapshot's (busiest first); folder groups
 * waiting first, then running, then the most recent.
 */
export function buildRunningTree(input: BuildRunningTreeInput): RunningTree {
  const needle = input.search.trim().toLowerCase();
  const showProcesses = input.showProcesses ?? true;
  const byAppSessionId = new Map<string, RunningSessionNode>();
  const displayedSessionIds = new Set(input.displayedProjects.flatMap((project) => (project.sessions ?? []).map((session) => String(session.id))));

  const appById = new Map<string, AgentMonitorSession>();
  const terminalByOpenId = new Map<string, AgentMonitorSession>();
  for (const session of input.sessions) {
    if (session.source === 'app') appById.set(session.id, session);
    else if (session.openSessionId && !terminalByOpenId.has(session.openSessionId)) terminalByOpenId.set(session.openSessionId, session);
  }
  const claimed = new Set<string>();
  for (const appSessionId of displayedSessionIds) {
    const monitored = appById.get(appSessionId) ?? terminalByOpenId.get(appSessionId);
    if (!monitored) continue;
    byAppSessionId.set(appSessionId, toNode(monitored, showProcesses));
    claimed.add(monitored.id);
  }

  const projectIdByFolder = new Map<string, string>();
  for (const project of input.displayedProjects) {
    const key = folderKey(project.fullPath || project.path);
    if (key !== NO_FOLDER_KEY && !projectIdByFolder.has(key)) projectIdByFolder.set(key, project.projectId);
  }
  const appNameByFolder = new Map<string, string>();
  for (const project of input.allProjects) {
    const key = folderKey(project.fullPath || project.path);
    if (key !== NO_FOLDER_KEY && !appNameByFolder.has(key)) appNameByFolder.set(key, project.displayName);
  }

  const terminalByProjectId = new Map<string, RunningSessionNode[]>();
  const groups = new Map<string, RunningTerminalGroup>();
  let terminalCount = 0;
  for (const session of input.sessions) {
    if (session.source !== 'terminal' || claimed.has(session.id)) continue;
    if (session.state === 'idle' && session.id !== input.keepSessionKey) continue;
    if (needle && !matchesSearch(session, needle)) continue;

    const node = toNode(session, showProcesses);
    terminalCount += 1;
    const key = folderKey(session.projectPath);
    const projectId = projectIdByFolder.get(key);
    if (projectId) {
      terminalByProjectId.set(projectId, [...(terminalByProjectId.get(projectId) ?? []), node]);
      continue;
    }
    const group = groups.get(key) ?? {
      key,
      name: appNameByFolder.get(key) ?? session.projectName ?? folderNameOf(session.projectPath),
      path: session.projectPath,
      sessions: [],
    };
    group.sessions.push(node);
    groups.set(key, group);
  }

  const bestRank = (group: RunningTerminalGroup) => Math.min(...group.sessions.map((node) => STATE_RANK[node.session.state]));
  const lastEvent = (group: RunningTerminalGroup) => Math.max(...group.sessions.map((node) => node.session.lastEventAt));
  const terminalGroups = [...groups.values()].sort((a, b) => bestRank(a) - bestRank(b) || lastEvent(b) - lastEvent(a) || (a.name ?? '').localeCompare(b.name ?? ''));

  return { byAppSessionId, terminalByProjectId, terminalGroups, terminalCount };
}

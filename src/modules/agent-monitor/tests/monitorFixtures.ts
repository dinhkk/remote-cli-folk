import { vi } from 'vitest';

import type { AgentMonitorNode, AgentMonitorProject, AgentMonitorResourceRow, AgentMonitorSession, AgentMonitorSnapshot } from '@/shared/types';

/** Shared builders for the agent monitor tests: a snapshot as the server sends it, and a stand-in for the snapshot endpoint. */

export const makeNode = (overrides: Partial<AgentMonitorNode> & { id: string }): AgentMonitorNode => ({
  name: overrides.id,
  kind: 'agent',
  description: '',
  state: 'running',
  startedAt: 1_000_000,
  endedAt: null,
  tokens: 0,
  toolCalls: 0,
  lastToolName: null,
  tokensPerSecond: 0,
  model: null,
  ...overrides,
});

export const makeSession = (overrides: Partial<AgentMonitorSession> & { id: string }): AgentMonitorSession => ({
  label: `Chat ${overrides.id}`,
  projectName: 'Alpha',
  provider: 'claude',
  state: 'running',
  runStartedAt: 1_000_000,
  lastEventAt: 1_000_000,
  orchestrator: { name: 'orchestrator', fromProfile: true, state: 'running', lastToolName: null, contextTokens: null, contextWindow: null },
  agents: [],
  foldedFinished: 0,
  agentTokens: 0,
  cacheHitRatio: null,
  source: 'app',
  detail: 'live',
  projectPath: 'C:\\work\\Alpha',
  projectKey: 'c:\\work\\alpha',
  openSessionId: overrides.id,
  processes: [],
  ...overrides,
});

/** Groups sessions the way the server does (a project is running only while one of its sessions is), for snapshots built in tests. */
export const makeProjects = (sessions: AgentMonitorSession[]): AgentMonitorProject[] => {
  const projects = new Map<string, AgentMonitorProject>();
  for (const session of sessions) {
    const project = projects.get(session.projectKey) ?? {
      key: session.projectKey, name: session.projectName ?? '', path: session.projectPath, state: 'idle' as const, runningSessions: 0, runningAgents: 0, tokens: 0, sessionIds: [],
    };
    project.sessionIds.push(session.id);
    project.tokens += session.agentTokens;
    project.runningAgents += session.agents.filter((agent) => agent.state === 'running' || agent.state === 'waiting').length;
    if (session.state !== 'idle') project.runningSessions += 1;
    if (session.state === 'waiting') project.state = 'waiting';
    else if (session.state === 'running' && project.state !== 'waiting') project.state = 'running';
    projects.set(session.projectKey, project);
  }
  return [...projects.values()];
};

export const makeRow = (overrides: Partial<AgentMonitorResourceRow> & { key: string }): AgentMonitorResourceRow => ({
  kind: 'session',
  label: overrides.key,
  pid: 100,
  usage: { cpuPercent: 4.2, rssBytes: 300 * 1024 * 1024, processCount: 3, top: [{ pid: 100, name: 'claude', rssBytes: 250 * 1024 * 1024, cpuPercent: 3 }] },
  cpuSeries: [1, 2, 3, 4],
  rssSeries: [100, 200, 300, 300],
  ...overrides,
});

/** The whole machine's CPU and memory in a fixture snapshot. */
export const MACHINE: AgentMonitorSnapshot['resources']['machine'] = { cpuPercent: 37.5, memoryUsedBytes: 10 * 1024 ** 3, memoryTotalBytes: 16 * 1024 ** 3 };

export const makeSnapshot =(overrides: Partial<AgentMonitorSnapshot> = {}): AgentMonitorSnapshot => ({
  generatedAt: 1_005_000,
  kpi: { runningAgents: 2, runningSessions: 1, tokensPerMinute: 1500, tokensToday: 24_000, cpuPercent: 8.4, rssBytes: 631 * 1024 * 1024, tokenSeries: [0, 100, 300], cpuSeries: [1, 8], rssSeries: [100, 200] },
  sessions: [],
  // Derived from `sessions` unless a test sets its own grouping.
  projects: makeProjects(overrides.sessions ?? []),
  resources: { sampling: true, intervalMs: 2000, lastSampleAt: 1_004_000, error: null, cores: 8, machine: MACHINE, rows: [] },
  ...overrides,
});

/** Stands in for any monitor endpoint as the global `fetch`: `answer(path)` gives the body (or a status + body, or raw text). */
export const installFakeMonitorRoutes = (answer: (path: string) => unknown | { status: number; body?: unknown; text?: string; contentType?: string }) => {
  const paths: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = String(input);
    paths.push(path);
    const result = answer(path) as { status?: number; body?: unknown; text?: string; contentType?: string } | undefined;
    const raw = result && typeof result === 'object' && ('status' in result) && ('body' in result || 'text' in result);
    if (raw) {
      const text = result.text ?? JSON.stringify(result.body);
      return new Response(text, { status: result.status, headers: { 'Content-Type': result.contentType ?? 'application/json' } });
    }
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  return { paths };
};

/**
 * Stands in for `GET /api/agent-monitor/snapshot` as the global `fetch`. `next()` answers each poll; swap it to change what the
 * screen sees. Returns the recorded request paths.
 */
export const installFakeMonitorApi = (answer: () => AgentMonitorSnapshot | { status: number; body: unknown }) => {
  const paths: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    paths.push(String(input));
    const result = answer();
    const failing = 'status' in result && 'body' in result;
    return new Response(JSON.stringify(failing ? result.body : result), { status: failing ? result.status : 200, headers: { 'Content-Type': 'application/json' } });
  }));
  return { paths };
};

/** Makes `matchMedia('(prefers-reduced-motion: reduce)')` answer `reduced`. */
export const stubReducedMotion = (reduced: boolean) => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? reduced : false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
};

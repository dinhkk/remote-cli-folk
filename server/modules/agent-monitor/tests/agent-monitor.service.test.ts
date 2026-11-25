import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import type { AgentMonitorSnapshot, NormalizedMessage } from '@/shared/types.js';

import { createAgentActivityAggregator } from '../agent-monitor.aggregator.js';
import { createAgentMonitorRouter } from '../agent-monitor.routes.js';
import { createResourceSampler } from '../agent-monitor.sampler.js';
import { createAgentMonitorService } from '../agent-monitor.service.js';
import { createTerminalSessionReader, type RegistryEntry } from '../agent-monitor.terminal-sessions.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const NO_TRANSCRIPT = { found: false, lastToolName: null, model: null, contextTokens: null, lastWriteAt: null, agents: [] };

function rig(readCacheHitRatio?: (sessionId: string) => Promise<number | null>, registry: RegistryEntry[] = []) {
  let reads = 0;
  let registryReads = 0;
  let transcriptReads = 0;
  const aggregator = createAgentActivityAggregator({
    readSessionMeta: () => ({ label: 'Alpha chat', projectName: 'Alpha', projectPath: 'C:\\work\\Alpha', provider: 'claude', orchestratorName: 'orchestrator' }),
  });
  const sampler = createResourceSampler({
    cores: 2, intervalMs: 5, leaseMs: 40,
    readProcesses: async () => { reads += 1; return [{ pid: 10, ppid: 1, name: 'node', cpuSeconds: reads * 0.01, rssBytes: 5000 }]; },
    listTargets: async () => [{ key: 'server', kind: 'server', label: 'Server', pid: 10, includeDescendants: false }],
  });
  const terminal = createTerminalSessionReader({
    listLive: async () => { registryReads += 1; return registry; },
    findAppSession: () => null,
    resolveProjectName: () => null,
    transcripts: { readSession: async () => { transcriptReads += 1; return NO_TRANSCRIPT; } },
    intervalMs: 5, leaseMs: 500, registryTtlMs: 0,
  });
  const service = createAgentMonitorService({ aggregator, terminal, sampler, cores: 2, intervalMs: 2000, readCacheHitRatio });
  const send = (message: Partial<NormalizedMessage> & { kind: NormalizedMessage['kind'] }) =>
    aggregator.ingest('s1', { id: 'm', sessionId: 's1', timestamp: '', provider: 'claude', ...message } as NormalizedMessage);
  return { aggregator, sampler, terminal, service, send, reads: () => reads, registryReads: () => registryReads, transcriptReads: () => transcriptReads };
}

test('the first snapshot starts the sampler and already carries the agent tree; the next ones carry CPU and memory', async () => {
  const { aggregator, sampler, service, send, reads } = rig();
  aggregator.startRun('s1', Date.now());
  send({ kind: 'tool_use', toolName: 'Agent', toolId: 'tu-1', toolInput: { subagent_type: 'coding--alpha', description: 'build it' } });
  send({ kind: 'task_status', event: 'started', taskId: 'k1', toolUseId: 'tu-1', taskType: 'local_agent' });
  send({ kind: 'task_status', event: 'progress', taskId: 'k1', toolUseId: 'tu-1', usage: { totalTokens: 1500, toolUses: 2, durationMs: 10 } });

  assert.equal(reads(), 0, 'nothing is sampled before somebody asks');
  const first = service.snapshot();
  assert.equal(first.resources.sampling, true);
  assert.equal(first.resources.cores, 2);
  // The whole machine's memory is there from the first answer; its CPU needs a second reading.
  assert.ok(first.resources.machine.memoryTotalBytes > 0);
  assert.ok(first.resources.machine.memoryUsedBytes <= first.resources.machine.memoryTotalBytes);
  assert.deepEqual(first.resources.rows, [], 'the first answer has no measurement yet');
  assert.equal(first.kpi.runningAgents, 1);
  assert.equal(first.kpi.tokensToday, 1500);
  assert.equal(first.sessions[0].agents[0].name, 'coding--alpha');

  // Poll for the sampler's first measurement instead of guessing a delay (a fixed 30 ms flaked on a loaded machine).
  let later = service.snapshot();
  for (let attempt = 0; attempt < 100 && later.resources.rows.length === 0; attempt += 1) {
    await sleep(10);
    later = service.snapshot();
  }
  assert.equal(later.resources.rows[0].key, 'server');
  assert.equal(later.resources.rows[0].usage.rssBytes, 5000);
  assert.equal(later.kpi.rssBytes, 5000);
  assert.ok(later.kpi.cpuSeries.length > 0);
  assert.equal(later.resources.rows[0].rssSeries.at(-1), 5000);
  sampler.dispose();
});

test('without further snapshots the sampler ends by itself, which is what closing the screen does', async () => {
  const { service, reads } = rig();
  service.snapshot();
  await sleep(150);
  const settled = reads();
  assert.ok(settled > 0);
  await sleep(80);
  assert.equal(reads(), settled);
  assert.equal(service.snapshot().resources.sampling, true, 'a new viewer starts it again');
});

test('the cache-hit ratio of running sessions is read in the background, at most once per refresh window', async () => {
  const asked: string[] = [];
  const { aggregator, sampler, service } = rig(async (sessionId) => { asked.push(sessionId); return 0.75; });
  aggregator.startRun('s1', Date.now());
  service.snapshot();
  service.snapshot();
  await sleep(10);
  assert.deepEqual(asked, ['s1']);
  assert.equal(service.snapshot().sessions[0].cacheHitRatio, 0.75);
  sampler.dispose();
});

test('a failing transcript read leaves the ratio unknown and does not break the snapshot', async () => {
  const { aggregator, sampler, service } = rig(async () => { throw new Error('no transcript'); });
  aggregator.startRun('s1', Date.now());
  service.snapshot();
  await sleep(10);
  assert.equal(service.snapshot().sessions[0].cacheHitRatio, null);
  sampler.dispose();
});

const registryEntry = (overrides: Partial<RegistryEntry> & { providerSessionId: string }): RegistryEntry => ({
  status: 'busy', startedAt: Date.now() - 60_000, cwd: 'C:\\work\\Other', entrypoint: 'cli', name: null, statusUpdatedAt: Date.now() - 5000, ...overrides,
});

test('the summary counts running app chats and terminal sessions without starting the sampler or reading a transcript', async () => {
  const { aggregator, sampler, terminal, service, reads, transcriptReads, registryReads } = rig(undefined, [
    registryEntry({ providerSessionId: 'term-1', status: 'busy' }),
    registryEntry({ providerSessionId: 'term-2', status: 'idle' }),
  ]);
  aggregator.startRun('s1', Date.now());

  const summary = await service.summary();
  assert.equal(summary.runningSessions, 2, 'the app chat and the busy terminal session; the idle one does not count');
  assert.equal(summary.waitingSessions, 0);
  assert.equal(summary.runningProjects, 2, 'two different folders');
  await sleep(60);
  assert.equal(reads(), 0, 'no CPU/RAM sampling for a summary');
  assert.equal(transcriptReads(), 0, 'no transcript is read for a summary');
  assert.ok(registryReads() > 0, 'the registry is what it reads');
  assert.deepEqual(terminal.current(), []);
  sampler.dispose();
  terminal.dispose();
});

test('a snapshot lists the terminal sessions next to the app chats, grouped by project, and counts them as running', async () => {
  const { aggregator, sampler, terminal, service } = rig(undefined, [
    registryEntry({ providerSessionId: 'term-1', status: 'busy', cwd: 'c:\\WORK\\alpha', name: 'alpha-term' }),
  ]);
  aggregator.startRun('s1', Date.now());
  service.snapshot();
  await sleep(30);
  const snapshot = service.snapshot();

  assert.deepEqual(snapshot.sessions.map((session) => [session.id, session.source, session.detail]).sort(), [
    ['s1', 'app', 'live'],
    ['terminal:term-1', 'terminal', 'transcript'],
  ]);
  assert.equal(snapshot.kpi.runningSessions, 2);
  // `C:\work\Alpha` (the chat) and `c:\WORK\alpha` (the terminal) are one folder on Windows: one project, two sessions.
  assert.equal(snapshot.projects.length, 1);
  assert.equal(snapshot.projects[0].runningSessions, 2);
  assert.equal(snapshot.projects[0].state, 'running');
  sampler.dispose();
  terminal.dispose();
});

test('a terminal entry for a chat the app already draws as running is not listed twice', async () => {
  const aggregator = createAgentActivityAggregator({ readSessionMeta: () => ({ label: 'Chat', projectName: 'Alpha', projectPath: 'C:\\work\\Alpha', provider: 'claude', orchestratorName: null }) });
  const sampler = createResourceSampler({ cores: 1, intervalMs: 5, leaseMs: 40, readProcesses: async () => [], listTargets: async () => [] });
  const terminal = createTerminalSessionReader({
    listLive: async () => [registryEntry({ providerSessionId: 'prov-1', cwd: 'C:\\work\\Alpha', entrypoint: 'remotecli' })],
    findAppSession: () => ({ sessionId: 's1', label: 'Chat' }),
    resolveProjectName: () => 'Alpha',
    transcripts: { readSession: async () => NO_TRANSCRIPT },
    registryTtlMs: 0, intervalMs: 5, leaseMs: 500,
  });
  const service = createAgentMonitorService({ aggregator, terminal, sampler, cores: 1, intervalMs: 2000 });
  aggregator.startRun('s1', Date.now());

  service.snapshot();
  await sleep(30);
  assert.deepEqual(service.snapshot().sessions.map((session) => session.id), ['s1']);
  assert.equal((await service.summary()).runningSessions, 1);
  sampler.dispose();
  terminal.dispose();
});

test('GET /summary answers the badge numbers as uncached JSON', async () => {
  const { aggregator, sampler, terminal, service } = rig();
  aggregator.startRun('s1', Date.now());
  const app = express();
  app.use('/api/agent-monitor', createAgentMonitorRouter(service));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/agent-monitor/summary`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json() as { runningSessions: number; waitingSessions: number; runningProjects: number };
    assert.deepEqual([body.runningSessions, body.waitingSessions, body.runningProjects], [1, 0, 1]);
    // Read-only: no method but GET is routed.
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/agent-monitor/summary`, { method: 'POST' })).status, 404);
  } finally {
    sampler.dispose();
    terminal.dispose();
    server.close();
  }
});

test('GET /snapshot answers the snapshot as uncached JSON', async () => {
  const { aggregator, sampler, service } = rig();
  aggregator.startRun('s1', Date.now());
  const app = express();
  app.use('/api/agent-monitor', createAgentMonitorRouter(service));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/agent-monitor/snapshot`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json() as AgentMonitorSnapshot;
    assert.equal(body.sessions[0].id, 's1');
    assert.equal(body.kpi.runningSessions, 1);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/agent-monitor/other`)).status, 404);
  } finally {
    sampler.dispose();
    server.close();
  }
});

test('each session lists the child processes of its Claude process by name, count, memory and CPU, and nothing else', async () => {
  const aggregator = createAgentActivityAggregator({ readSessionMeta: () => ({ label: 'Chat', projectName: 'Alpha', projectPath: 'C:\\work\\Alpha', provider: 'claude', orchestratorName: null }) });
  let reads = 0;
  const sampler = createResourceSampler({
    cores: 2, intervalMs: 5, leaseMs: 60,
    readProcesses: async () => {
      reads += 1;
      const cpu = reads * 0.01;
      return [
        { pid: 100, ppid: 1, name: 'claude', cpuSeconds: cpu, rssBytes: 300 },
        { pid: 101, ppid: 100, name: 'node', cpuSeconds: cpu, rssBytes: 80 },
        { pid: 102, ppid: 101, name: 'node', cpuSeconds: cpu, rssBytes: 40 },
        { pid: 103, ppid: 100, name: 'bash', cpuSeconds: cpu, rssBytes: 20 },
        { pid: 200, ppid: 1, name: 'claude', cpuSeconds: cpu, rssBytes: 250 },
        { pid: 201, ppid: 200, name: 'python', cpuSeconds: cpu, rssBytes: 60 },
        { pid: 900, ppid: 1, name: 'unrelated', cpuSeconds: cpu, rssBytes: 999 },
      ];
    },
    listTargets: async () => [{ key: 'session:s1', kind: 'session', label: 'Chat', pid: 100, includeDescendants: true }],
  });
  const terminal = createTerminalSessionReader({
    listLive: async () => [registryEntry({ providerSessionId: 'term-1', status: 'busy', pid: 200 }), registryEntry({ providerSessionId: 'term-2', status: 'busy', cwd: 'C:\\work\\No pid' })],
    findAppSession: () => null,
    resolveProjectName: () => null,
    transcripts: { readSession: async () => NO_TRANSCRIPT },
    intervalMs: 5, leaseMs: 500, registryTtlMs: 0,
  });
  const service = createAgentMonitorService({ aggregator, terminal, sampler, cores: 2, intervalMs: 2000 });
  aggregator.startRun('s1', Date.now());

  const first = service.snapshot();
  assert.deepEqual(first.sessions.map((session) => session.processes), [[]], 'before the first sample the list is empty, not missing');

  // Wait for two samples (the CPU share needs both) and for the terminal reader's first refresh, without a fixed guess.
  let later = service.snapshot();
  for (let attempt = 0; attempt < 100 && !(reads >= 2 && later.sessions.some((session) => session.id === 'terminal:term-1' && session.processes?.length)); attempt += 1) {
    await sleep(10);
    later = service.snapshot();
  }
  const byId = new Map(later.sessions.map((session) => [session.id, session]));
  assert.deepEqual(byId.get('s1')?.processes?.map((group) => [group.name, group.count, group.rssBytes]), [['node', 2, 120], ['bash', 1, 20]], 'an app chat: its tree without the claude process itself');
  assert.deepEqual(byId.get('terminal:term-1')?.processes?.map((group) => [group.name, group.count, group.rssBytes]), [['python', 1, 60]], 'a terminal session with a known pid');
  assert.deepEqual(byId.get('terminal:term-2')?.processes, [], 'a terminal session without a pid');
  for (const group of byId.get('s1')?.processes ?? []) {
    assert.deepEqual(Object.keys(group).sort(), ['count', 'cpuPercent', 'name', 'rssBytes']);
  }
  // The whole tree of the Claude process (itself included), as three numbers: no pid, no top list.
  assert.deepEqual(byId.get('s1')?.usage?.rssBytes, 300 + 80 + 40 + 20, 'an app chat: memory of its whole tree');
  assert.equal(byId.get('s1')?.usage?.processCount, 4);
  assert.deepEqual(Object.keys(byId.get('s1')?.usage ?? {}).sort(), ['cpuPercent', 'processCount', 'rssBytes']);
  assert.deepEqual(byId.get('terminal:term-1')?.usage?.rssBytes, 250 + 60, 'a terminal session with a known pid');
  assert.equal(byId.get('terminal:term-2')?.usage, undefined, 'a terminal session without a pid has no usage');
  sampler.dispose();
  terminal.dispose();
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentActivityAggregator } from '../agent-monitor.aggregator.js';
import { createAgentMonitorKiller } from '../agent-monitor.kill.js';
import { createAgentMonitorService } from '../agent-monitor.service.js';
import { createResourceSampler } from '../agent-monitor.sampler.js';
import { createTerminalSessionReader } from '../agent-monitor.terminal-sessions.js';

const roots = [
  { providerSessionId: 'provider-session', pid: 100, startedAt: 1_000 },
  { providerSessionId: 'provider-session', pid: 200, startedAt: 2_000 },
  { providerSessionId: 'other-session', pid: 300, startedAt: 3_000 },
];

test('the earlier process is visible beside the live app session and has its own descendants', async () => {
  const aggregator = createAgentActivityAggregator({ readSessionMeta: () => null });
  aggregator.startRun('app-session', Date.now());
  const terminal = createTerminalSessionReader({
    listLive: async () => roots.slice(0, 2).map((root) => ({ ...root, status: 'busy', cwd: '/tmp/project', entrypoint: 'remotecli', name: null, statusUpdatedAt: null })),
    findAppSession: () => ({ sessionId: 'app-session', label: 'Test chat' }),
    resolveProjectName: () => 'Project',
    transcripts: { readSession: async () => ({ found: false, agents: [], lastToolName: null, contextTokens: null, lastWriteAt: null }) },
  });
  const sampler = createResourceSampler({
    readProcesses: async () => [
      { pid: 100, ppid: 1, name: 'claude', cpuSeconds: 0, rssBytes: 10 },
      { pid: 101, ppid: 100, name: 'bash', cpuSeconds: 0, rssBytes: 20 },
      { pid: 200, ppid: 1, name: 'claude', cpuSeconds: 0, rssBytes: 10 },
      { pid: 201, ppid: 200, name: 'node', cpuSeconds: 0, rssBytes: 30 },
    ],
    listTargets: async () => [{ key: 'session:app-session', kind: 'session', label: 'Test chat', pid: 200, includeDescendants: true }], cores: 1,
  });
  const service = createAgentMonitorService({ aggregator, terminal, sampler, cores: 1, intervalMs: 2_000 });
  try {
    service.snapshot();
    for (let i = 0; i < 100 && terminal.current().length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    const sessions = service.snapshot().sessions;
    assert.equal(sessions.length, 2);
    const earlier = sessions.find((session) => session.id !== 'app-session');
    assert.ok(earlier);
    assert.match(earlier.orchestrator.name, /Earlier/);
    assert.equal(terminal.pidOf(earlier.id), 100);
    assert.equal(earlier.openSessionId, 'app-session');
    assert.equal(earlier.processes?.[0]?.name, 'bash');
    assert.equal(sessions.find((session) => session.id === 'app-session')?.processes?.[0]?.name, 'node');
  } finally { terminal.dispose(); sampler.dispose(); }
});

test('an earlier-process kill resolves its exact root and protects another session', async () => {
  const calls: Array<{ pid: number; otherRoots: readonly number[] }> = [];
  const killer = createAgentMonitorKiller({
    aggregator: { taskIdOf: () => null, isAgentLive: () => false, settleSession: () => {} },
    describeSession: () => ({ provider: 'claude', providerSessionId: 'provider-session', terminal: true, root: { pid: 100, startedAt: 1_000 } }),
    listLive: async () => roots,
    processKiller: {
      killTree: async (pid, context) => { calls.push({ pid, otherRoots: context.otherRoots }); return { result: 'killed', count: 2 }; },
      killGroup: async () => ({ result: 'gone', count: 0 }),
    },
    stopTask: async () => false, markKilled: () => false, unmarkKilled: () => {}, completeRun: () => {},
  });
  assert.deepEqual(await killer.kill({ sessionId: 'earlier', nodeId: 'orch:earlier', mode: 'kill' }), { result: 'killed', count: 2 });
  assert.deepEqual(calls, [{ pid: 100, otherRoots: [200, 300] }]);
});

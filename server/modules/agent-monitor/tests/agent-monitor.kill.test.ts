import assert from 'node:assert/strict';
import test from 'node:test';

import type { KillOutcome } from '@/modules/process-control/index.js';

import { createAgentActivityAggregator } from '../agent-monitor.aggregator.js';
import { createAgentMonitorKiller, STOP_TASK_TIMEOUT_MS, type KillSessionInfo } from '../agent-monitor.kill.js';

const SID = 'app-1';
const LIVE_ROOT = { providerSessionId: 'prov-1', pid: 100, startedAt: 5_000 };

type Rig = ReturnType<typeof rig>;

function rig({
  session = { provider: 'claude', providerSessionId: 'prov-1', terminal: false } as KillSessionInfo | null,
  live = [LIVE_ROOT, { providerSessionId: 'prov-2', pid: 300, startedAt: 9_000 }],
  treeOutcome = { result: 'killed', count: 4 } as KillOutcome,
  groupOutcome = { result: 'killed', count: 2 } as KillOutcome,
  stopImpl = async () => true,
  marked = true,
}: {
  session?: KillSessionInfo | null;
  live?: Array<{ providerSessionId: string; pid: number; startedAt: number }>;
  treeOutcome?: KillOutcome;
  groupOutcome?: KillOutcome;
  stopImpl?: (sessionId: string, taskId: string) => Promise<boolean>;
  marked?: boolean;
} = {}) {
  const aggregator = createAgentActivityAggregator({ readSessionMeta: () => null });
  aggregator.startRun(SID, 1);
  aggregator.ingest(SID, { id: 'm', sessionId: SID, timestamp: '', provider: 'claude', kind: 'tool_use', toolName: 'Agent', toolId: 'tu-a', toolInput: { subagent_type: 'coding--alpha', description: 'd' } } as never);
  aggregator.ingest(SID, { id: 'm', sessionId: SID, timestamp: '', provider: 'claude', kind: 'task_status', event: 'started', taskId: 'task-a', toolUseId: 'tu-a', taskType: 'local_agent', description: 'd' } as never);

  const calls: string[] = [];
  const deferred: Array<() => void> = [];
  const killer = createAgentMonitorKiller({
    aggregator,
    describeSession: (sessionId) => (sessionId === SID || sessionId.startsWith('terminal:') ? session : null),
    listLive: async () => live.map((entry) => ({ ...entry, status: 'busy', cwd: null, entrypoint: null, name: null, statusUpdatedAt: null })),
    processKiller: {
      killTree: async (pid, context) => { calls.push(`tree:${pid}:${context.registryStartedAt}:${context.otherRoots.join(',')}`); return treeOutcome; },
      killGroup: async (pid, key, context) => { calls.push(`group:${pid}:${key}:${context.registryStartedAt}`); return groupOutcome; },
    },
    stopTask: async (sessionId, taskId) => { calls.push(`stop:${sessionId}:${taskId}`); return stopImpl(sessionId, taskId); },
    markKilled: (sessionId) => { calls.push(`mark:${sessionId}`); return marked; },
    unmarkKilled: (sessionId) => { calls.push(`unmark:${sessionId}`); },
    completeRun: (sessionId) => { calls.push(`complete:${sessionId}`); },
    defer: (action) => { deferred.push(action); },
  });
  return { aggregator, killer, calls, deferred };
}

const kill = (r: Rig, nodeId: string, mode: 'stop' | 'kill' = 'kill', sessionId = SID) => r.killer.kill({ sessionId, nodeId, mode });
const agentState = (r: Rig) => r.aggregator.snapshot().sessions[0]?.agents[0]?.state;

test('a node id must be one of the three shapes of THIS session, exactly', async () => {
  const r = rig();
  for (const nodeId of ['', 'session:app-1', 'orch:other', 'orch:app-1:x', 'agent:other:tu-a', 'agent:app-1:', 'proc:app-1:', 'proc:other:node', 'proc:app-1:*other', 'proc:app-1:unknown', 'folded:app-1', 'x'.repeat(300)]) {
    assert.equal((await kill(r, nodeId)).result, 'refused', `"${nodeId}"`);
  }
  assert.deepEqual(r.calls, [], 'nothing ran for any of them');
});

test('a session the store does not know and a provider other than claude are refused', async () => {
  assert.equal((await kill(rig({ session: null }), `orch:${SID}`)).result, 'refused');
  assert.equal((await kill(rig({ session: { provider: 'codex', providerSessionId: 'p', terminal: false } }), `orch:${SID}`)).result, 'refused');
});

test('a node id may carry colons in the part after the prefix', async () => {
  const r = rig();
  r.aggregator.ingest(SID, { id: 'm', sessionId: SID, timestamp: '', provider: 'claude', kind: 'task_status', event: 'started', taskId: 't2', toolUseId: 'tu:with:colons', taskType: 'local_agent', description: 'd' } as never);
  assert.equal((await kill(r, `agent:${SID}:tu:with:colons`, 'stop')).result, 'stopped');
  assert.ok(r.calls.includes(`stop:${SID}:t2`));
});

test('killing the main node kills the whole claude tree of that session, marking the run first and settling it after', async () => {
  const r = rig();
  const outcome = await kill(r, `orch:${SID}`);
  assert.deepEqual(outcome, { result: 'killed', count: 4 });
  assert.deepEqual(r.calls, [`mark:${SID}`, 'tree:100:5000:300', `complete:${SID}`]);
  assert.equal(agentState(r), 'stopped', 'every agent stopped, so nothing is left "running"');
  assert.equal(r.aggregator.snapshot().sessions[0].state, 'idle');
  assert.equal(r.deferred.length, 1, 'the mark is taken back after a grace period, so it cannot swallow the next run');
  r.deferred[0]();
  assert.equal(r.calls.at(-1), `unmark:${SID}`);
});

test('a kill that did not happen takes the mark back and settles nothing', async () => {
  const r = rig({ treeOutcome: { result: 'error', count: 0 } });
  assert.equal((await kill(r, `orch:${SID}`)).result, 'error');
  assert.deepEqual(r.calls, [`mark:${SID}`, 'tree:100:5000:300', `unmark:${SID}`]);
  assert.equal(agentState(r), 'running');
  const refused = rig({ treeOutcome: { result: 'refused', count: 0 } });
  await kill(refused, `orch:${SID}`);
  assert.equal(refused.calls.at(-1), `unmark:${SID}`);
});

test('a session whose run is not live is still killed (nothing to mark)', async () => {
  const r = rig({ marked: false });
  assert.equal((await kill(r, `orch:${SID}`)).result, 'killed');
  assert.deepEqual(r.calls, [`mark:${SID}`, 'tree:100:5000:300', `complete:${SID}`]);
  assert.equal(r.deferred.length, 0, 'no mark was set, so none is taken back later');
});

test('a process group kill acts on the group of that session and leaves the session running', async () => {
  const r = rig();
  const outcome = await kill(r, `proc:${SID}:node`);
  assert.deepEqual(outcome, { result: 'killed', count: 2 });
  assert.deepEqual(r.calls, ['group:100:node:5000']);
  assert.equal(agentState(r), 'running');
});

test('the newest registry entry of the session is the root; none means unavailable', async () => {
  const twice = rig({ live: [{ providerSessionId: 'prov-1', pid: 90, startedAt: 1_000 }, LIVE_ROOT, { providerSessionId: 'prov-2', pid: 300, startedAt: 9_000 }] });
  await kill(twice, `orch:${SID}`);
  assert.ok(twice.calls.includes('tree:100:5000:90,300'), 'the older entry of the same session is another root to protect, not the target');

  const none = rig({ live: [{ providerSessionId: 'prov-2', pid: 300, startedAt: 9_000 }] });
  assert.equal((await kill(none, `orch:${SID}`)).result, 'unavailable');
  assert.deepEqual(none.calls, [], 'no root, so no mark and no kill');
  assert.equal((await kill(rig({ session: { provider: 'claude', providerSessionId: null, terminal: false } }), `orch:${SID}`)).result, 'unavailable');
});

test('stopping an agent asks the SDK for that agent\'s own task', async () => {
  const r = rig();
  assert.deepEqual(await kill(r, `agent:${SID}:tu-a`, 'stop'), { result: 'stopped' });
  assert.deepEqual(r.calls, [`stop:${SID}:task-a`]);
});

test('an agent with no handle, a refusing runtime, a throwing one or one that never answers is "no-handle"', async () => {
  const noTask = rig();
  noTask.aggregator.ingest(SID, { id: 'm', sessionId: SID, timestamp: '', provider: 'claude', kind: 'tool_use', toolName: 'Agent', toolId: 'tu-b', toolInput: { subagent_type: 'x', description: 'd' } } as never);
  assert.equal((await kill(noTask, `agent:${SID}:tu-b`, 'stop')).result, 'no-handle');
  assert.ok(!noTask.calls.some((call) => call.startsWith('stop:')), 'no task id, so nothing was asked of the SDK');

  assert.equal((await kill(rig({ stopImpl: async () => false }), `agent:${SID}:tu-a`, 'stop')).result, 'no-handle');
  assert.equal((await kill(rig({ stopImpl: async () => { throw new Error('boom'); } }), `agent:${SID}:tu-a`, 'stop')).result, 'no-handle');

  const hung = rig({ stopImpl: () => new Promise<boolean>(() => undefined) });
  const started = Date.now();
  assert.equal((await kill(hung, `agent:${SID}:tu-a`, 'stop')).result, 'no-handle');
  assert.ok(Date.now() - started >= STOP_TASK_TIMEOUT_MS - 50 && Date.now() - started < STOP_TASK_TIMEOUT_MS + 1500, 'gives up after the timeout, not before and not much after');
});

test('an agent that already ended, or never existed, is gone', async () => {
  const r = rig();
  r.aggregator.ingest(SID, { id: 'm', sessionId: SID, timestamp: '', provider: 'claude', kind: 'task_status', event: 'notification', taskId: 'task-a', status: 'completed' } as never);
  assert.equal((await kill(r, `agent:${SID}:tu-a`, 'stop')).result, 'gone');
  assert.equal((await kill(r, `agent:${SID}:tu-a`)).result, 'gone');
  assert.equal((await kill(rig(), `agent:${SID}:nope`)).result, 'gone');
});

test('force-killing an agent kills the session tree like the main node', async () => {
  const r = rig();
  assert.equal((await kill(r, `agent:${SID}:tu-a`)).result, 'killed');
  assert.ok(r.calls.includes('tree:100:5000:300'));
});

test('a terminal session can be killed at its main node and process groups but not at an agent', async () => {
  const terminal = { provider: 'claude', providerSessionId: 'prov-1', terminal: true } as const;
  const r = rig({ session: terminal });
  assert.equal((await kill(r, 'orch:terminal:prov-1', 'kill', 'terminal:prov-1')).result, 'killed');
  assert.ok(r.calls.includes('tree:100:5000:300'));
  assert.ok(!r.calls.some((call) => call.startsWith('mark:')), 'a terminal session has no run of ours to mark');
  assert.equal((await kill(r, 'proc:terminal:prov-1:node', 'kill', 'terminal:prov-1')).result, 'killed');
  assert.equal((await kill(r, 'agent:terminal:prov-1:tu-a', 'kill', 'terminal:prov-1')).result, 'refused');
});

test('two kills of one session at once run once and both get the answer', async () => {
  const r = rig();
  const [first, second] = await Promise.all([kill(r, `orch:${SID}`), kill(r, `orch:${SID}`)]);
  assert.deepEqual(first, second);
  assert.equal(r.calls.filter((call) => call.startsWith('tree:')).length, 1);
  await kill(r, `orch:${SID}`);
  assert.equal(r.calls.filter((call) => call.startsWith('tree:')).length, 2, 'a later kill is a new one');
});

test('kills of different nodes of one session at once each run and get their own answer', async () => {
  const r = rig({ treeOutcome: { result: 'killed', count: 3 }, groupOutcome: { result: 'gone', count: 0 } });
  const [tree, group] = await Promise.all([kill(r, `orch:${SID}`), kill(r, `proc:${SID}:node`)]);
  assert.equal(tree.result, 'killed');
  assert.equal(group.result, 'gone');
  assert.equal(r.calls.filter((call) => call.startsWith('tree:')).length, 1);
  assert.equal(r.calls.filter((call) => call.startsWith('group:')).length, 1);
});

test('a killer that throws is an error, never a crash', async () => {
  const r = rig();
  const broken = createAgentMonitorKiller({
    aggregator: r.aggregator,
    describeSession: () => ({ provider: 'claude', providerSessionId: 'prov-1', terminal: false }),
    listLive: async () => { throw new Error('registry unreadable'); },
    processKiller: { killTree: async () => { throw new Error('x'); }, killGroup: async () => { throw new Error('x'); } },
    stopTask: async () => true,
    markKilled: () => true,
    unmarkKilled: () => undefined,
    completeRun: () => undefined,
  });
  assert.equal((await broken.kill({ sessionId: SID, nodeId: `orch:${SID}`, mode: 'kill' })).result, 'unavailable');
});

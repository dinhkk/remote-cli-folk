import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from '@/shared/types.js';

import { createAgentActivityAggregator } from '../agent-monitor.aggregator.js';

const SESSION = 'app-session-1';

/** A controllable clock so timers, rates and the finished-agent fold are exact. */
function rig(meta = { label: 'Review Alpha', projectName: 'Alpha', provider: 'claude', orchestratorName: 'orchestrator' as string | null }) {
  let clock = 1_000_000;
  const aggregator = createAgentActivityAggregator({ now: () => clock, readSessionMeta: () => meta });
  return {
    aggregator,
    advance: (ms: number) => { clock += ms; },
    at: () => clock,
    send: (message: Partial<NormalizedMessage> & { kind: NormalizedMessage['kind'] }, sessionId = SESSION) =>
      aggregator.ingest(sessionId, { id: 'm', sessionId, timestamp: '', provider: 'claude', ...message } as NormalizedMessage),
  };
}

const delegate = (toolId: string, subagent: string, description = 'do the thing') => ({
  kind: 'tool_use' as const, toolName: 'Agent', toolId, toolInput: { subagent_type: subagent, description },
});
const started = (taskId: string, toolUseId: string, taskType = 'local_agent', description = 'do the thing') => ({
  kind: 'task_status' as const, event: 'started' as const, taskId, toolUseId, taskType, description,
});
const progress = (taskId: string, toolUseId: string, totalTokens: number, toolUses: number) => ({
  kind: 'task_status' as const, event: 'progress' as const, taskId, toolUseId, usage: { totalTokens, toolUses, durationMs: 1 },
});
const notification = (taskId: string, status: string, totalTokens?: number) => ({
  kind: 'task_status' as const, event: 'notification' as const, taskId, status,
  ...(totalTokens === undefined ? {} : { usage: { totalTokens, toolUses: 0, durationMs: 1 } }),
});

test('an orchestrator that delegates shows one running level-2 node per launched agent, named after its type', () => {
  const { aggregator, send, advance } = rig();
  aggregator.startRun(SESSION, 1_000_000);
  send(delegate('tu-review', 'review-code--alpha', 'Review MR 123'));
  send(delegate('tu-report', 'reporting--alpha', 'Write the report'));
  advance(1000);
  send(started('task-1', 'tu-review', 'local_agent', 'Review MR 123'));
  send(started('task-2', 'tu-report', 'local_agent', 'Write the report'));

  const { sessions, runningAgents, runningSessions } = aggregator.snapshot();
  assert.equal(sessions.length, 1);
  const [session] = sessions;
  assert.equal(session.label, 'Review Alpha');
  assert.equal(session.projectName, 'Alpha');
  assert.equal(session.state, 'running');
  assert.deepEqual(session.orchestrator, {
    name: 'orchestrator', fromProfile: true, state: 'running', lastToolName: null, contextTokens: null, contextWindow: null,
  });
  assert.deepEqual(session.agents.map((agent) => [agent.id, agent.name, agent.kind, agent.state]), [
    ['tu-review', 'review-code--alpha', 'agent', 'running'],
    ['tu-report', 'reporting--alpha', 'agent', 'running'],
  ]);
  assert.equal(session.agents[0].description, 'Review MR 123');
  assert.equal(runningAgents, 2);
  assert.equal(runningSessions, 1);
});

test('a plain chat without a profile is a "Main agent" and a task without a delegation call is named from its description', () => {
  const { aggregator, send } = rig({ label: 'Chat', projectName: null, provider: 'claude', orchestratorName: null });
  aggregator.startRun(SESSION, 1_000_000);
  send(started('task-9', 'tu-9', 'local_workflow', 'audit the repo'));

  const [session] = aggregator.snapshot().sessions;
  assert.equal(session.orchestrator.name, 'Main agent');
  assert.equal(session.orchestrator.fromProfile, false);
  assert.deepEqual(session.agents.map((agent) => [agent.name, agent.kind]), [['audit the repo', 'workflow']]);
});

test('tokens and tool calls follow the task usage, never double count a repeated total, and sum per session and overall', () => {
  const { aggregator, send, advance } = rig();
  aggregator.startRun(SESSION, 1_000_000);
  send(delegate('tu-a', 'coding--alpha'));
  send(started('task-a', 'tu-a'));
  send(delegate('tu-b', 'testing--alpha'));
  send(started('task-b', 'tu-b'));

  send(progress('task-a', 'tu-a', 1200, 3));
  advance(2000);
  send(progress('task-a', 'tu-a', 1200, 3)); // the same total again: nothing new
  send(progress('task-a', 'tu-a', 2000, 5));
  send(progress('task-b', 'tu-b', 500, 1));
  send(notification('task-a', 'completed', 2500));

  const [session] = aggregator.snapshot().sessions;
  const byId = Object.fromEntries(session.agents.map((agent) => [agent.id, agent]));
  assert.equal(byId['tu-a'].tokens, 2500);
  assert.equal(byId['tu-a'].toolCalls, 5);
  assert.equal(byId['tu-a'].state, 'done');
  assert.equal(byId['tu-b'].tokens, 500);
  assert.equal(session.agentTokens, 3000);
  assert.equal(aggregator.tokenActivity().today, 3000);
  assert.equal(aggregator.tokenActivity().perMinute, 3000);
});

test('tokens from two sessions add up in the activity totals and the per-minute window forgets old work', () => {
  const { aggregator, send, advance } = rig();
  aggregator.startRun('s1', 1_000_000);
  aggregator.startRun('s2', 1_000_000);
  send({ ...delegate('t1', 'a') }, 's1');
  send({ ...started('k1', 't1') }, 's1');
  send({ ...progress('k1', 't1', 400, 1) }, 's1');
  advance(61_000);
  send({ ...delegate('t2', 'b') }, 's2');
  send({ ...started('k2', 't2') }, 's2');
  send({ ...progress('k2', 't2', 100, 1) }, 's2');

  const activity = aggregator.tokenActivity();
  assert.equal(activity.perMinute, 100);
  assert.equal(activity.today, 500);
  assert.equal(activity.series.at(-1), 100);
  assert.equal(activity.series.length, 30);
});

test('a notification ends the agent; a late progress or "running" update does not bring it back', () => {
  const { aggregator, send } = rig();
  aggregator.startRun(SESSION, 1_000_000);
  send(delegate('tu-a', 'coding--alpha'));
  send(started('task-a', 'tu-a'));
  send(notification('task-a', 'failed'));
  send({ kind: 'task_status', event: 'updated', taskId: 'task-a', status: 'running' });

  const [session] = aggregator.snapshot().sessions;
  assert.equal(session.agents[0].state, 'failed');
  assert.notEqual(session.agents[0].endedAt, null);
});

test('a stopped task (patch status "stopped") is stopped, not done', () => {
  const { aggregator, send } = rig();
  aggregator.startRun(SESSION, 1_000_000);
  send(delegate('tu-a', 'coding--alpha'));
  send(started('task-a', 'tu-a'));
  send({ kind: 'task_status', event: 'updated', taskId: 'task-a', status: 'stopped' });
  assert.equal(aggregator.snapshot().sessions[0].agents[0].state, 'stopped');
});

test('the early tool result of a background agent is only a receipt, but a synchronous agent ends on its tool result', () => {
  const { aggregator, send } = rig();
  aggregator.startRun(SESSION, 1_000_000);
  send(delegate('tu-bg', 'coding--alpha'));
  send(started('task-bg', 'tu-bg'));
  send({ kind: 'tool_result', toolId: 'tu-bg', content: 'Async agent launched' });
  send(delegate('tu-sync', 'qa-anywhere'));
  send({ kind: 'tool_result', toolId: 'tu-sync', content: 'answer' });
  send(delegate('tu-bad', 'review-code--alpha'));
  send({ kind: 'tool_result', toolId: 'tu-bad', isError: true, content: 'boom' });

  const states = Object.fromEntries(aggregator.snapshot().sessions[0].agents.map((agent) => [agent.id, agent.state]));
  assert.deepEqual(states, { 'tu-bg': 'running', 'tu-sync': 'done', 'tu-bad': 'failed' });
});

test('the tool a sub-agent is calling shows on its node, the main thread tool on the orchestrator, and both clear when done', () => {
  const { aggregator, send } = rig();
  aggregator.startRun(SESSION, 1_000_000);
  send({ kind: 'tool_use', toolName: 'Read', toolId: 'main-read', toolInput: {} });
  assert.equal(aggregator.snapshot().sessions[0].orchestrator.lastToolName, 'Read');
  send({ kind: 'tool_result', toolId: 'main-read' });
  assert.equal(aggregator.snapshot().sessions[0].orchestrator.lastToolName, null);

  send(delegate('tu-a', 'coding--alpha'));
  send(started('task-a', 'tu-a'));
  send({ kind: 'tool_use', toolName: 'Grep', toolId: 'sub-1', parentToolUseId: 'tu-a', toolInput: {} });
  send({ kind: 'tool_use', toolName: 'Edit', toolId: 'sub-2', parentToolUseId: 'tu-a', toolInput: {} });
  const [running] = aggregator.snapshot().sessions[0].agents;
  assert.equal(running.lastToolName, 'Edit');
  assert.equal(running.toolCalls, 2, 'tool calls are counted from the stream until the SDK reports a number');

  send(notification('task-a', 'completed'));
  assert.equal(aggregator.snapshot().sessions[0].agents[0].lastToolName, null);
});

test('a pending permission prompt marks the agent calling that tool as waiting, else the orchestrator, and the answer clears it', () => {
  const { aggregator, send } = rig();
  aggregator.startRun(SESSION, 1_000_000);
  send(delegate('tu-a', 'coding--alpha'));
  send(started('task-a', 'tu-a'));
  send(delegate('tu-b', 'testing--alpha'));
  send(started('task-b', 'tu-b'));
  send({ kind: 'tool_use', toolName: 'Write', toolId: 'w1', parentToolUseId: 'tu-a', toolInput: {} });
  send({ kind: 'permission_request', requestId: 'req-1', toolName: 'Write' });

  let [session] = aggregator.snapshot().sessions;
  assert.equal(session.state, 'waiting');
  assert.deepEqual(session.agents.map((agent) => agent.state), ['waiting', 'running']);
  assert.equal(session.orchestrator.state, 'running');

  send({ kind: 'permission_resolved', requestId: 'req-1' });
  send({ kind: 'permission_request', requestId: 'req-2', toolName: 'Bash' });
  [session] = aggregator.snapshot().sessions;
  assert.deepEqual(session.agents.map((agent) => agent.state), ['running', 'running']);
  assert.equal(session.orchestrator.state, 'waiting');

  send({ kind: 'permission_cancelled', requestId: 'req-2' });
  assert.equal(aggregator.snapshot().sessions[0].state, 'running');
});

test('a normal complete leaves background agents running; an aborted one stops them', () => {
  const { aggregator, send } = rig();
  aggregator.startRun(SESSION, 1_000_000);
  send(delegate('tu-a', 'coding--alpha'));
  send(started('task-a', 'tu-a'));
  send({ kind: 'complete', exitCode: 0, aborted: false });

  let [session] = aggregator.snapshot().sessions;
  assert.equal(session.state, 'running', 'agents still working keep the session running');
  assert.equal(session.agents[0].state, 'running');

  send({ kind: 'complete', exitCode: 1, aborted: true });
  [session] = aggregator.snapshot().sessions;
  assert.equal(session.agents[0].state, 'stopped');
  assert.equal(session.state, 'idle');
  assert.equal(session.orchestrator.state, 'done');
});

test('reading a node for the kill button never creates a session and says what the node is', () => {
  const { aggregator, send } = rig();
  assert.equal(aggregator.taskIdOf('nobody', 'tu-a'), null);
  assert.equal(aggregator.isAgentLive('nobody', 'tu-a'), false);
  assert.equal(aggregator.snapshot().sessions.length, 0, 'asking about an unknown session made no record of it');

  aggregator.startRun(SESSION, 1_000_000);
  send(delegate('tu-a', 'coding--alpha'));
  assert.equal(aggregator.isAgentLive(SESSION, 'tu-a'), true);
  assert.equal(aggregator.taskIdOf(SESSION, 'tu-a'), null, 'no task started yet: no handle');
  send(started('task-a', 'tu-a'));
  assert.equal(aggregator.taskIdOf(SESSION, 'tu-a'), 'task-a');
  assert.equal(aggregator.taskIdOf(SESSION, 'tu-zzz'), null);
  send(notification('task-a', 'completed'));
  assert.equal(aggregator.isAgentLive(SESSION, 'tu-a'), false, 'a finished agent is not live');
});

test('settling a killed session ends the run and every live agent, and leaves finished ones as they were', () => {
  const { aggregator, send } = rig();
  aggregator.startRun(SESSION, 1_000_000);
  send(delegate('tu-a', 'coding--alpha'));
  send(started('task-a', 'tu-a'));
  send(delegate('tu-b', 'reporting--alpha'));
  send(started('task-b', 'tu-b'));
  send(notification('task-b', 'completed'));
  send({ kind: 'permission_request', requestId: 'r1', toolName: 'Bash' });

  aggregator.settleSession(SESSION, 'stopped');
  const [session] = aggregator.snapshot().sessions;
  assert.equal(session.state, 'idle');
  assert.deepEqual(session.agents.map((agent) => [agent.id, agent.state]), [['tu-a', 'stopped'], ['tu-b', 'done']]);
  assert.equal(session.orchestrator.state, 'done');

  aggregator.settleSession('nobody', 'stopped');
  assert.equal(aggregator.snapshot().sessions.length, 1, 'settling an unknown session creates nothing');
});

test('a session with nothing running leaves the picture after a while and its totals stay in the activity', () => {
  const { aggregator, send, advance } = rig();
  aggregator.startRun(SESSION, 1_000_000);
  send(delegate('tu-a', 'coding--alpha'));
  send(started('task-a', 'tu-a'));
  send(progress('task-a', 'tu-a', 900, 2));
  send(notification('task-a', 'completed'));
  send({ kind: 'complete', exitCode: 0 });

  assert.equal(aggregator.snapshot().sessions.length, 1);
  advance(3 * 60_000);
  assert.equal(aggregator.snapshot().sessions.length, 0);
  assert.equal(aggregator.tokenActivity().today, 900);
});

test('finished agents fold away: old ones after a while, and only the newest few while fresh', () => {
  const { aggregator, send, advance } = rig();
  aggregator.startRun(SESSION, 1_000_000);
  for (let index = 0; index < 8; index += 1) {
    send(delegate(`tu-${index}`, `agent-${index}`));
    send(started(`task-${index}`, `tu-${index}`));
    send(notification(`task-${index}`, 'completed'));
    advance(1000);
  }
  let [session] = aggregator.snapshot().sessions;
  assert.equal(session.agents.length, 6);
  assert.equal(session.foldedFinished, 2);
  assert.equal(session.agents[0].id, 'tu-7', 'newest first');

  advance(2 * 60_000);
  send({ kind: 'tool_use', toolName: 'Read', toolId: 'x', toolInput: {} }); // keeps the session itself in view
  [session] = aggregator.snapshot().sessions;
  assert.equal(session.agents.length, 0);
  assert.equal(session.foldedFinished, 8);
});

test('the token rate of a running agent comes from its last two readings and reads 0 once it goes quiet', () => {
  const { aggregator, send, advance } = rig();
  aggregator.startRun(SESSION, 1_000_000);
  send(delegate('tu-a', 'coding--alpha'));
  send(started('task-a', 'tu-a'));
  send(progress('task-a', 'tu-a', 1000, 1));
  advance(2000);
  send(progress('task-a', 'tu-a', 1600, 2));
  assert.equal(aggregator.snapshot().sessions[0].agents[0].tokensPerSecond, 300);
  advance(11_000);
  assert.equal(aggregator.snapshot().sessions[0].agents[0].tokensPerSecond, 0);
});

test('context size comes from the token budget status and is not counted as spend', () => {
  const { aggregator, send } = rig();
  aggregator.startRun(SESSION, 1_000_000);
  send({ kind: 'status', text: 'token_budget', tokenBudget: { used: 42_000, total: 200_000 } });
  const [session] = aggregator.snapshot().sessions;
  assert.equal(session.orchestrator.contextTokens, 42_000);
  assert.equal(session.orchestrator.contextWindow, 200_000);
  assert.equal(aggregator.tokenActivity().today, 0);
});

test('a sub-agent assistant row names its model; progress for a task whose start was missed still shows up', () => {
  const { aggregator, send } = rig();
  aggregator.startRun(SESSION, 1_000_000);
  send(delegate('tu-a', 'coding--alpha'));
  send(started('task-a', 'tu-a'));
  send({ kind: 'text', role: 'assistant', content: 'hi', model: 'claude-sonnet-5-5', parentToolUseId: 'tu-a' });
  send(progress('task-late', 'tu-late', 300, 1));

  const agents = aggregator.snapshot().sessions[0].agents;
  assert.equal(agents.find((agent) => agent.id === 'tu-a')?.model, 'claude-sonnet-5-5');
  assert.equal(agents.find((agent) => agent.id === 'tu-late')?.tokens, 300);
});

test('a store that cannot be read costs only the label; the cache-hit ratio is kept per session', () => {
  const aggregator = createAgentActivityAggregator({ readSessionMeta: () => { throw new Error('db closed'); } });
  aggregator.startRun('abcdef123456', Date.now());
  aggregator.setCacheHitRatio('abcdef123456', 0.8);
  const [session] = aggregator.snapshot().sessions;
  assert.equal(session.label, 'abcdef12');
  assert.equal(session.cacheHitRatio, 0.8);
  assert.deepEqual(aggregator.activeSessionIds(), ['abcdef123456']);
});

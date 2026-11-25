import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { AGENT_STALE_MS, createTranscriptReader, summariseTranscript } from '../agent-monitor.transcript-reader.js';

import { assistantLine, createFakeClaudeHome, SESSION_ID, toolResultLine, toolUse, userLine } from './agent-monitor.transcript-fixtures.js';

const CWD = 'C:\\work\\Terminal App';

test('the CLI writes one line per content block with the usage repeated: each message is counted once', () => {
  const same = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 500 };
  const final = { ...same, output_tokens: 80 };
  const activity = summariseTranscript([
    assistantLine('m1', { type: 'text', text: 'a' }, same),
    assistantLine('m1', toolUse('t1', 'Read'), final),
    assistantLine('m2', { type: 'text', text: 'b' }, { input_tokens: 5, output_tokens: 7 }),
  ]);
  assert.equal(activity.tokens, 10 + 80 + 5 + 7, 'm1 once with its final output count, plus m2');
  assert.equal(activity.toolCalls, 1);
  assert.equal(activity.contextTokens, 5, 'the last message sets the context size (input + cache read + cache creation)');
});

test('the tool being run is the last call without an answer; delegation tools do not count as the agent running a tool', () => {
  const calls = summariseTranscript([
    assistantLine('m1', toolUse('t1', 'Read')),
    toolResultLine('t1'),
    assistantLine('m2', toolUse('t2', 'Bash')),
    assistantLine('m3', toolUse('t3', 'Agent')),
  ]);
  assert.equal(calls.pendingTool, 'Bash');
  assert.equal(summariseTranscript([assistantLine('m1', toolUse('t1', 'Read')), toolResultLine('t1')]).pendingTool, null);
  assert.equal(summariseTranscript([assistantLine('m1', toolUse('t3', 'Task'))]).pendingTool, null);
});

test('a session reads its orchestrator tool and every sub-agent with state, name, tokens and start from files', async () => {
  const fake = await createFakeClaudeHome(CWD);
  try {
    await fake.writeMain([userLine('2026-11-23T02:00:00.000Z'), assistantLine('m1', toolUse('main-1', 'Bash'))]);
    await fake.writeAgent({
      id: 'run1',
      meta: { agentType: 'coding--alpha', description: 'Build it', toolUseId: 'tu-run', finished: false, model: 'claude-sonnet-5-5' },
      lines: [userLine('2026-11-23T02:01:00.000Z'), assistantLine('a1', toolUse('x1', 'Grep'), { input_tokens: 100, output_tokens: 50 })],
    });
    await fake.writeAgent({
      id: 'done1',
      meta: { agentType: 'review--alpha', description: 'Review', toolUseId: 'tu-done', finished: true },
      lines: [userLine('2026-11-23T02:00:30.000Z'), assistantLine('b1', { type: 'text', text: 'ok' }, { input_tokens: 10, output_tokens: 5 })],
    });
    await fake.writeAgent({
      id: 'stuck1',
      meta: { agentType: 'testing--alpha', description: 'Tests', toolUseId: 'tu-stuck', finished: false },
      lines: [userLine('2026-11-23T01:00:00.000Z'), assistantLine('c1', { type: 'text', text: 'hm' })],
      ageMs: AGENT_STALE_MS + 60_000,
    });

    const detail = await createTranscriptReader({ claudeHome: fake.home }).readSession(CWD, SESSION_ID);
    assert.equal(detail.found, true);
    assert.equal(detail.lastToolName, 'Bash');
    assert.equal(detail.model, 'claude-sonnet-5-5');

    const byId = Object.fromEntries(detail.agents.map((agent) => [agent.id, agent]));
    assert.deepEqual(
      [byId['tu-run'].name, byId['tu-run'].state, byId['tu-run'].tokens, byId['tu-run'].lastToolName, byId['tu-run'].endedAt],
      ['coding--alpha', 'running', 150, 'Grep', null],
    );
    assert.equal(byId['tu-run'].startedAt, Date.parse('2026-11-23T02:01:00.000Z'), 'the start is the first line of the agent transcript');
    assert.equal(byId['tu-run'].model, 'claude-sonnet-5-5');
    assert.deepEqual([byId['tu-done'].state, byId['tu-done'].lastToolName, byId['tu-done'].tokens], ['done', null, 15]);
    assert.notEqual(byId['tu-done'].endedAt, null);
    assert.equal(byId['tu-stuck'].state, 'stopped', 'never finished and silent for minutes: stopped, not running');
    assert.deepEqual(detail.agents.map((agent) => agent.id), ['tu-run', 'tu-done', 'tu-stuck'], 'newest start first');
  } finally {
    await fake.cleanup();
  }
});

test('a huge transcript is only read at its tail and a half-written last line is ignored', async () => {
  const fake = await createFakeClaudeHome(CWD);
  try {
    const filler = Array.from({ length: 3000 }, (_, index) => userLine('2026-11-23T02:00:00.000Z', `filler ${index} ${'x'.repeat(200)}`));
    await fake.writeMain([...filler, assistantLine('late', toolUse('t-late', 'Edit'))]);
    // A line the CLI is still writing: cut in the middle.
    await fsp.appendFile(path.join(fake.projectDirectory, `${SESSION_ID}.jsonl`), '{"type":"assistant","message":{"id":"cut","content":[{"type":"tool_use","id":"t-cut","na');
    const size = (await fsp.stat(path.join(fake.projectDirectory, `${SESSION_ID}.jsonl`))).size;
    assert.ok(size > 600_000, 'the fixture is much bigger than the tail that is read');

    const detail = await createTranscriptReader({ claudeHome: fake.home }).readSession(CWD, SESSION_ID);
    assert.equal(detail.lastToolName, 'Edit');
  } finally {
    await fake.cleanup();
  }
});

test('a session whose folder name does not match is found by its transcript; one with no transcript, or an unsafe id, is unknown', async () => {
  const fake = await createFakeClaudeHome(CWD);
  try {
    await fake.writeMain([assistantLine('m1', toolUse('t1', 'Glob'))]);
    const reader = createTranscriptReader({ claudeHome: fake.home });
    assert.equal((await reader.readSession('D:\\moved\\elsewhere', SESSION_ID)).lastToolName, 'Glob', 'found by scanning the project directories');
    assert.equal((await reader.readSession(CWD, 'ffffffff-0000-0000-0000-000000000000')).found, false);
    assert.equal((await reader.readSession(CWD, '..\\..\\secret')).found, false);
    assert.equal((await reader.readSession(null, '../x')).found, false);
  } finally {
    await fake.cleanup();
  }
});

test('an agent with no meta file is still listed, named from its transcript id', async () => {
  const fake = await createFakeClaudeHome(CWD);
  try {
    await fake.writeMain([userLine('2026-11-23T02:00:00.000Z')]);
    await fake.writeAgent({ id: 'abc123', lines: [userLine('2026-11-23T02:00:10.000Z')] });
    const detail = await createTranscriptReader({ claudeHome: fake.home }).readSession(CWD, SESSION_ID);
    assert.equal(detail.agents.length, 1);
    assert.equal(detail.agents[0].id, 'abc123');
    assert.equal(detail.agents[0].name, 'agent');
    assert.equal(detail.agents[0].state, 'running', 'unfinished and just written');
  } finally {
    await fake.cleanup();
  }
});

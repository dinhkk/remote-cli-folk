import assert from 'node:assert/strict';
import test from 'node:test';

import { createTerminalSessionReader, type RegistryEntry } from '../agent-monitor.terminal-sessions.js';
import { createTranscriptReader } from '../agent-monitor.transcript-reader.js';

import { assistantLine, createFakeClaudeHome, SESSION_ID, toolUse, userLine } from './agent-monitor.transcript-fixtures.js';

const CWD = 'C:\\work\\Terminal App';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const entry = (overrides: Partial<RegistryEntry> = {}): RegistryEntry => ({
  providerSessionId: SESSION_ID, status: 'busy', startedAt: Date.now() - 600_000, cwd: CWD, entrypoint: 'cli', name: 'terminal-app-1a', statusUpdatedAt: Date.now() - 20_000, ...overrides,
});

/** A reader over a fake registry and a fake Claude home; counts registry reads. */
async function rig(entries: RegistryEntry[], options: { app?: { sessionId: string; label: string | null } | null; leaseMs?: number } = {}) {
  const fake = await createFakeClaudeHome(CWD);
  await fake.writeMain([userLine('2026-11-23T02:00:00.000Z'), assistantLine('m1', toolUse('main-1', 'Bash'), { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 1000 })]);
  await fake.writeAgent({
    id: 'run1',
    meta: { agentType: 'coding--alpha', description: 'Build it', toolUseId: 'tu-run', finished: false },
    lines: [userLine('2026-11-23T02:01:00.000Z'), assistantLine('a1', toolUse('x1', 'Grep'), { input_tokens: 100, output_tokens: 50 })],
  });
  await fake.writeAgent({
    id: 'done1',
    meta: { agentType: 'review--alpha', description: 'Review', toolUseId: 'tu-done', finished: true },
    lines: [userLine('2026-11-23T02:00:30.000Z'), assistantLine('b1', { type: 'text', text: 'ok' }, { input_tokens: 10, output_tokens: 5 })],
  });
  let registryReads = 0;
  const reader = createTerminalSessionReader({
    listLive: async () => { registryReads += 1; return entries; },
    findAppSession: () => options.app ?? null,
    resolveProjectName: (cwd) => (cwd ? 'Terminal App' : null),
    transcripts: createTranscriptReader({ claudeHome: fake.home }),
    intervalMs: 5, leaseMs: options.leaseMs ?? 40, registryTtlMs: 0,
  });
  return { fake, reader, registryReads: () => registryReads };
}

test('a busy terminal session is derived from the registry and its transcript files: state, timer, tool, agents', async () => {
  const { fake, reader } = await rig([entry()]);
  try {
    await reader.refresh();
    const [session] = reader.current();
    assert.equal(session.id, `terminal:${SESSION_ID}`);
    assert.deepEqual([session.source, session.detail, session.state], ['terminal', 'transcript', 'running']);
    assert.equal(session.label, 'terminal-app-1a', 'the CLI name when the app has no chat for it');
    assert.equal(session.projectName, 'Terminal App');
    assert.equal(session.projectPath, CWD);
    assert.equal(session.openSessionId, null, 'not tappable: the app has no chat for it');
    assert.ok(session.runStartedAt !== null && Date.now() - session.runStartedAt >= 20_000, 'busy since the status changed');
    assert.deepEqual(
      [session.orchestrator.state, session.orchestrator.lastToolName, session.orchestrator.contextTokens, session.orchestrator.fromProfile],
      ['running', 'Bash', 1003, false],
    );
    assert.deepEqual(session.agents.map((agent) => [agent.name, agent.state, agent.lastToolName, agent.tokens]), [
      ['coding--alpha', 'running', 'Grep', 150],
      ['review--alpha', 'done', null, 15],
    ]);
    assert.equal(session.agentTokens, 165);
    assert.equal(session.cacheHitRatio, null, 'unknown, not guessed');
  } finally {
    reader.dispose();
    await fake.cleanup();
  }
});

test('a session the app has a chat for opens that chat and takes its name; the app\'s own entrypoint is labelled "app"', async () => {
  const { fake, reader } = await rig([entry({ entrypoint: 'remotecli' })], { app: { sessionId: 'app-chat-9', label: 'Review MR' } });
  try {
    await reader.refresh();
    const [session] = reader.current();
    assert.equal(session.openSessionId, 'app-chat-9');
    assert.equal(session.label, 'Review MR');
    assert.equal(session.source, 'app');
    assert.equal(session.detail, 'transcript');
  } finally {
    reader.dispose();
    await fake.cleanup();
  }
});

test('an entry the app itself started but has not indexed yet is skipped: the event stream covers a run that is starting', async () => {
  const { fake, reader } = await rig([entry({ entrypoint: 'remotecli' })], { app: null });
  try {
    await reader.refresh();
    assert.deepEqual(reader.current(), []);
    assert.deepEqual(await reader.peek(), []);
  } finally {
    reader.dispose();
    await fake.cleanup();
  }
});

test('an idle session stays listed for two minutes after its last turn, then leaves; an unknown status word reads as idle', async () => {
  const { fake, reader } = await rig([
    entry({ providerSessionId: SESSION_ID, status: 'idle', statusUpdatedAt: Date.now() - 30_000 }),
    entry({ providerSessionId: 'old-idle', status: 'idle', statusUpdatedAt: Date.now() - 10 * 60_000 }),
    entry({ providerSessionId: 'odd-status', status: 'thinking-hard', statusUpdatedAt: Date.now() - 30_000 }),
  ]);
  try {
    await reader.refresh();
    const sessions = reader.current();
    assert.deepEqual(sessions.map((session) => session.id).sort(), [`terminal:${SESSION_ID}`, 'terminal:odd-status'].sort());
    assert.ok(sessions.every((session) => session.state === 'idle' || session.id === `terminal:${SESSION_ID}`));
    const idle = sessions.find((session) => session.id === 'terminal:odd-status');
    assert.equal(idle?.state, 'idle');
    assert.equal(idle?.runStartedAt, null);
    assert.deepEqual(await reader.peek(), [], 'idle sessions are not running');
  } finally {
    reader.dispose();
    await fake.cleanup();
  }
});

test('an idle session whose agents are still working reads as running', async () => {
  const { fake, reader } = await rig([entry({ status: 'idle', statusUpdatedAt: Date.now() - 20_000 })]);
  try {
    await reader.refresh();
    const [session] = reader.current();
    assert.equal(session.state, 'running', 'the unfinished agent, written to just now, is still working');
    assert.equal(session.orchestrator.state, 'running');
    assert.equal(session.orchestrator.lastToolName, null, 'the orchestrator itself is not running a tool');
  } finally {
    reader.dispose();
    await fake.cleanup();
  }
});

test('a status of "waiting" shows the session and its orchestrator as waiting for the user', async () => {
  const { fake, reader } = await rig([entry({ status: 'waiting' })]);
  try {
    await reader.refresh();
    const [session] = reader.current();
    assert.deepEqual([session.state, session.orchestrator.state], ['waiting', 'waiting']);
    assert.deepEqual(await reader.peek(), [{ openSessionId: null, projectKey: 'c:\\work\\terminal app', state: 'waiting' }]);
  } finally {
    reader.dispose();
    await fake.cleanup();
  }
});

test('a session whose transcript cannot be found is still listed from the registry, with nothing invented', async () => {
  const fake = await createFakeClaudeHome(CWD);
  const reader = createTerminalSessionReader({
    listLive: async () => [entry({ providerSessionId: 'no-transcript-anywhere' })],
    findAppSession: () => null,
    resolveProjectName: () => null,
    transcripts: createTranscriptReader({ claudeHome: fake.home }),
  });
  try {
    await reader.refresh();
    const [session] = reader.current();
    assert.equal(session.state, 'running');
    assert.deepEqual([session.agents, session.agentTokens, session.orchestrator.lastToolName, session.orchestrator.contextTokens], [[], 0, null, null]);
    assert.equal(session.projectName, 'Terminal App', 'the folder name when the app has no project name');
  } finally {
    reader.dispose();
    await fake.cleanup();
  }
});

test('nothing is read until somebody asks: the transcript reading is lease-gated and the peek reads only the registry', async () => {
  const { fake, reader, registryReads } = await rig([entry()], { leaseMs: 400 });
  try {
    await sleep(60);
    assert.equal(registryReads(), 0, 'no loop without a viewer');

    assert.equal((await reader.peek()).length, 1);
    assert.deepEqual(reader.current(), [], 'a peek reads no transcript: there is no detail');
    const afterPeek = registryReads();

    reader.touch();
    await sleep(100);
    assert.ok(registryReads() > afterPeek, 'a viewer starts the loop');
    assert.equal(reader.current().length, 1);

    // The lease lapses (400 ms): the loop stops by itself and drops what it read.
    await sleep(600);
    const settled = registryReads();
    await sleep(60);
    assert.equal(registryReads(), settled, 'the loop ended with the lease');
    assert.deepEqual(reader.current(), []);
  } finally {
    reader.dispose();
    await fake.cleanup();
  }
});

test('a registry that cannot be read reads as no sessions, never as an error', async () => {
  const fake = await createFakeClaudeHome(CWD);
  const reader = createTerminalSessionReader({
    listLive: async () => { throw new Error('registry gone'); },
    findAppSession: () => null,
    resolveProjectName: () => null,
    transcripts: createTranscriptReader({ claudeHome: fake.home }),
  });
  try {
    await reader.refresh();
    assert.deepEqual(reader.current(), []);
    assert.deepEqual(await reader.peek(), []);
  } finally {
    reader.dispose();
    await fake.cleanup();
  }
});

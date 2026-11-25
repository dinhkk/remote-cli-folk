import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import {
  markClaudeSessionKilled,
  queryClaudeSDK,
  unmarkClaudeSessionKilled,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * A Claude process killed from outside (the monitor's Kill button) makes the SDK stream throw. The run loop must treat that as
 * a deliberate end when the session was marked, and as a failure otherwise. The stream is scripted through `context.createQuery`.
 */

const SESSION_ID = 'app-kill-session';
const NATIVE_ID = 'native-kill-session';

function scriptedQuery() {
  let crash: (() => void) | null = null;
  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt }) => {
    void (async () => { for await (const _message of prompt) { /* stdin */ } })();
    const iterator = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: NATIVE_ID };
      await new Promise<void>((_, reject) => { crash = () => reject(new Error('process exited with code 1')); });
    })();
    return Object.assign(iterator, { interrupt: async () => {}, stopTask: async () => {} });
  };
  return { createQuery, crash: () => crash?.() };
}

async function runKilledOrNot(markBefore: boolean) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-kill-'));
  const { createQuery, crash } = scriptedQuery();
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery,
  };
  try {
    const done = queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd }, writer as never, context);
    for (let attempt = 0; attempt < 100 && !sent.length; attempt += 1) await new Promise((resolve) => { setTimeout(resolve, 10); });
    const marked = markBefore ? markClaudeSessionKilled(SESSION_ID) : false;
    crash();
    await done;
    return { sent, marked };
  } finally {
    unmarkClaudeSessionKilled(SESSION_ID);
    await rm(cwd, { recursive: true, force: true });
  }
}

test('a session with no live run is not marked, so no flag is left to swallow a later run', () => {
  assert.equal(markClaudeSessionKilled('no-such-session'), false);
});

test('a process killed after the session was marked ends quietly: no error, no failed-run report', async () => {
  const { sent, marked } = await runKilledOrNot(true);
  assert.equal(marked, true);
  assert.ok(!sent.some((message) => message.kind === 'error'), 'no error reaches the browser');
});

test('the same crash without the mark is still reported as an error', async () => {
  const { sent, marked } = await runKilledOrNot(false);
  assert.equal(marked, false);
  assert.ok(sent.some((message) => message.kind === 'error'), 'an unmarked crash is a failure');
});

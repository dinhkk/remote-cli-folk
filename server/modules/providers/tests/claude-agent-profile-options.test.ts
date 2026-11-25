import assert from 'node:assert/strict';
import test from 'node:test';

import { mapCliOptionsToSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { SessionAgentSnapshot } from '@/shared/types.js';

function makeSnapshot(overrides: Partial<SessionAgentSnapshot> = {}): SessionAgentSnapshot {
  return { agentName: 'orchestrator', hiddenClaudeAgents: [], ...overrides };
}

const baseOptions = { cwd: '/work/alpha', model: 'claude-sonnet-5-5' };

test('without an agent profile the options carry no agent, agents or custom prompt', () => {
  const sdkOptions = mapCliOptionsToSDK({ ...baseOptions });
  assert.equal('agents' in sdkOptions, false);
  assert.equal('agent' in sdkOptions, false);
  assert.deepEqual(sdkOptions.systemPrompt, { type: 'preset', preset: 'claude_code' });
  assert.deepEqual(sdkOptions.disallowedTools, []);
});

test('an agent profile passes the main agent by name as `agent` and never an `agents` map', () => {
  const sdkOptions = mapCliOptionsToSDK({ ...baseOptions, agentProfile: makeSnapshot() });
  assert.equal(sdkOptions.agent, 'orchestrator');
  assert.equal('agents' in sdkOptions, false, 'the agent is a native .claude/agents file the CLI loads itself');
  assert.deepEqual(sdkOptions.settingSources, ['project', 'user', 'local']);
  // The agent file replaces the preset prompt; the SDK option stays the preset and the tool set is the full preset.
  assert.deepEqual(sdkOptions.tools, { type: 'preset', preset: 'claude_code' });
  assert.deepEqual(sdkOptions.systemPrompt, { type: 'preset', preset: 'claude_code' }, 'the SDK option stays the preset; `agent` supersedes its text');
  assert.equal(sdkOptions.model, 'claude-sonnet-5-5');
  assert.equal(sdkOptions.cwd, '/work/alpha');
});

test('a scoped session without a main agent sets no `agent` but still applies the hide list', () => {
  const sdkOptions = mapCliOptionsToSDK({ ...baseOptions, agentProfile: makeSnapshot({ agentName: null, hiddenClaudeAgents: ['Explore'] }) });
  assert.equal('agent' in sdkOptions, false);
  assert.equal('agents' in sdkOptions, false);
  assert.deepEqual(sdkOptions.disallowedTools, ['Task(Explore)']);
});

test('a resume run passes the same agent name again (it is sent on every run, resume included)', () => {
  const snapshot = makeSnapshot();
  const first = mapCliOptionsToSDK({ ...baseOptions, agentProfile: snapshot });
  const resumed = mapCliOptionsToSDK({ ...baseOptions, agentProfile: snapshot, providerSessionId: 'native-1' });
  assert.equal(resumed.resume, 'native-1');
  assert.equal(resumed.agent, first.agent);
  // After a stored-and-reloaded record (what the gateway really passes) the name is identical.
  const reloaded = JSON.parse(JSON.stringify(snapshot)) as SessionAgentSnapshot;
  const afterReload = mapCliOptionsToSDK({ ...baseOptions, agentProfile: reloaded, providerSessionId: 'native-1' });
  assert.equal(afterReload.agent, first.agent);
  assert.equal('agents' in afterReload, false);
});

test('hidden Claude agents become Task(<name>) disallow rules, and unhiding removes them', () => {
  const hidden = mapCliOptionsToSDK({ ...baseOptions, agentProfile: makeSnapshot({ hiddenClaudeAgents: ['Explore', 'code-reviewer'] }) });
  assert.deepEqual(hidden.disallowedTools, ['Task(Explore)', 'Task(code-reviewer)']);
  const unhidden = mapCliOptionsToSDK({ ...baseOptions, agentProfile: makeSnapshot({ hiddenClaudeAgents: [] }) });
  assert.deepEqual(unhidden.disallowedTools, []);
});

test('the client disallowedTools and the server hide list are merged, and the client cannot lift a hide rule', () => {
  const sdkOptions = mapCliOptionsToSDK({
    ...baseOptions,
    toolsSettings: { allowedTools: [], disallowedTools: ['Bash(rm:*)', 'Task(Explore)'], skipPermissions: false },
    agentProfile: makeSnapshot({ hiddenClaudeAgents: ['Explore', 'Plan'] }),
  });
  assert.deepEqual(sdkOptions.disallowedTools, ['Bash(rm:*)', 'Task(Explore)', 'Task(Plan)']);

  // A client list that simply omits the rule (or is empty) changes nothing about the server's rules.
  const emptyClientList = mapCliOptionsToSDK({
    ...baseOptions,
    toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: false },
    agentProfile: makeSnapshot({ hiddenClaudeAgents: ['Explore'] }),
  });
  assert.deepEqual(emptyClientList.disallowedTools, ['Task(Explore)']);
});

test('a client disallowedTools that is not a list is ignored instead of throwing when hide rules apply', () => {
  for (const malformed of ['Bash', 42, { 0: 'Bash' }, null]) {
    const sdkOptions = mapCliOptionsToSDK({
      ...baseOptions,
      toolsSettings: { allowedTools: [], disallowedTools: malformed, skipPermissions: false },
      agentProfile: makeSnapshot({ hiddenClaudeAgents: ['Explore'] }),
    });
    assert.deepEqual(sdkOptions.disallowedTools, ['Task(Explore)']);
  }
});

test('without an agent profile the client disallowedTools pass through untouched, duplicates included', () => {
  const sdkOptions = mapCliOptionsToSDK({
    ...baseOptions,
    toolsSettings: { allowedTools: ['Read'], disallowedTools: ['Bash', 'Bash'], skipPermissions: false },
  });
  assert.deepEqual(sdkOptions.disallowedTools, ['Bash', 'Bash']);
  assert.deepEqual(sdkOptions.allowedTools, ['Read']);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createSessionScopeResolver } from '../agent-profiles.session-scope.js';

import { makeTempDir, removeDir } from './profile-fixtures.js';
import { makeServiceRig } from './service-rig.js';

type Rig = ReturnType<typeof makeServiceRig>;

/** Rig with a real project folder (`<scratch>/alpha`) and a resolver on top of the real claude-agents service. */
async function withScopeRig(
  run: (context: { rig: Rig; resolver: ReturnType<typeof createSessionScopeResolver>; projectDirectory: string }) => Promise<void>,
): Promise<void> {
  const rig = makeServiceRig();
  const scratch = makeTempDir('scope-dirs-');
  const projectDirectory = path.join(scratch, 'alpha');
  fs.mkdirSync(projectDirectory);
  const resolver = createSessionScopeResolver({ claudeAgents: rig.claudeAgents });
  try {
    await run({ rig, resolver, projectDirectory });
  } finally {
    removeDir(scratch);
    rig.cleanup();
  }
}

const status = (code: number, errorCode?: string) => (error: { statusCode?: number; code?: string }) =>
  error.statusCode === code && (errorCode === undefined || error.code === errorCode);

/** Writes `<folder>/<file>.md` with the given front matter name. */
function writeAgentFile(folder: string, file: string, name: string): void {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `${file}.md`), `---\nname: ${name}\ndescription: ${name}\n---\nBody\n`);
}

const projectAgents = (projectDirectory: string) => path.join(projectDirectory, '.claude', 'agents');

test('a main agent that is a file of the project folder is accepted and its name returned, nothing copied', async () => {
  await withScopeRig(async ({ resolver, projectDirectory }) => {
    writeAgentFile(projectAgents(projectDirectory), 'orchestrator', 'orchestrator');
    const snapshot = await resolver.resolve({ agentName: 'orchestrator' }, projectDirectory);
    assert.deepEqual(snapshot, { agentName: 'orchestrator', hiddenClaudeAgents: [] });
  });
});

test('a main agent may also be a file of ~/.claude/agents', async () => {
  await withScopeRig(async ({ rig, resolver, projectDirectory }) => {
    writeAgentFile(path.join(rig.claudeHome, 'agents'), 'shared', 'shared');
    assert.equal((await resolver.resolve({ agentName: 'shared' }, projectDirectory)).agentName, 'shared');
  });
});

test('no main agent (null) is a scoped session without `agent`, still with the hide list', async () => {
  await withScopeRig(async ({ rig, resolver, projectDirectory }) => {
    rig.claudeAgents.setHidden({ names: ['Explore'], rev: 0 });
    assert.deepEqual(await resolver.resolve({ agentName: null }, projectDirectory), { agentName: null, hiddenClaudeAgents: ['Explore'] });
  });
});

test('an agent that is not a file is 404 AGENT_NOT_FOUND; built-ins and other projects do not count', async () => {
  await withScopeRig(async ({ rig, resolver, projectDirectory }) => {
    const other = path.join(path.dirname(projectDirectory), 'other');
    writeAgentFile(projectAgents(other), 'only-there', 'only-there');
    await assert.rejects(resolver.resolve({ agentName: 'nope' }, projectDirectory), status(404, 'AGENT_NOT_FOUND'));
    await assert.rejects(resolver.resolve({ agentName: 'only-there' }, projectDirectory), status(404, 'AGENT_NOT_FOUND'));
    await assert.rejects(resolver.resolve({ agentName: 'Explore' }, projectDirectory), status(404, 'AGENT_NOT_FOUND'));
    assert.equal(rig.state.sdkCalls, 0, 'creating a session never reaches the SDK');
  });
});

test('an agent whose file has no readable front matter name is not accepted', async () => {
  await withScopeRig(async ({ resolver, projectDirectory }) => {
    fs.mkdirSync(projectAgents(projectDirectory), { recursive: true });
    fs.writeFileSync(path.join(projectAgents(projectDirectory), 'noname.md'), '---\ndescription: x\n---\nBody');
    await assert.rejects(resolver.resolve({ agentName: 'noname' }, projectDirectory), status(404, 'AGENT_NOT_FOUND'));
  });
});

test('an invalid agent name is 400 and never touches the disk (path-like names)', async () => {
  await withScopeRig(async ({ resolver, projectDirectory }) => {
    for (const agentName of ['../etc/passwd', 'a b', '', '.hidden', 'x'.repeat(65)]) {
      await assert.rejects(resolver.resolve({ agentName }, projectDirectory), status(400, 'INVALID_AGENT_NAME'), agentName);
    }
  });
});

test('a project path that is not absolute is a 400; messages never carry a folder path', async () => {
  await withScopeRig(async ({ resolver, projectDirectory }) => {
    await assert.rejects(resolver.resolve({ agentName: 'x' }, 'relative/secret-dir'), status(400, 'INVALID_PROFILE_INPUT'));
    await assert.rejects(resolver.resolve({ agentName: 'orchestrator' }, projectDirectory), (error: { message: string }) => {
      assert.equal(error.message.includes(projectDirectory), false, error.message);
      return true;
    });
  });
});

test('the hide list is captured at creation: unhiding removes the names for new sessions', async () => {
  await withScopeRig(async ({ rig, resolver, projectDirectory }) => {
    const hidden = rig.claudeAgents.setHidden({ names: ['Explore', 'ghost'], rev: 0 });
    assert.deepEqual((await resolver.resolve({ agentName: null }, projectDirectory)).hiddenClaudeAgents, ['Explore', 'ghost']);
    rig.claudeAgents.setHidden({ names: [], rev: hidden.rev });
    assert.deepEqual((await resolver.resolve({ agentName: null }, projectDirectory)).hiddenClaudeAgents, []);
  });
});

test('editing or deleting the agent file afterwards changes what a NEW session accepts, not the returned record', async () => {
  await withScopeRig(async ({ resolver, projectDirectory }) => {
    writeAgentFile(projectAgents(projectDirectory), 'lead', 'lead');
    const taken = await resolver.resolve({ agentName: 'lead' }, projectDirectory);
    fs.rmSync(path.join(projectAgents(projectDirectory), 'lead.md'));
    assert.deepEqual(taken, { agentName: 'lead', hiddenClaudeAgents: [] }, 'the record holds the name only');
    await assert.rejects(resolver.resolve({ agentName: 'lead' }, projectDirectory), status(404, 'AGENT_NOT_FOUND'));
  });
});

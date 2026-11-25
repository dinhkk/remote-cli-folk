import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentMonitorNode, AgentMonitorSession } from '@/shared/types.js';

import { folderNameOf, groupSessionsByProject, NO_FOLDER_KEY, projectKeyOf } from '../agent-monitor.projects.js';

const agent = (id: string, state: AgentMonitorNode['state'], tokens = 0): AgentMonitorNode => ({
  id, name: id, kind: 'agent', description: '', state, startedAt: 1, endedAt: state === 'running' ? null : 2, tokens, toolCalls: 0, lastToolName: null, tokensPerSecond: 0, model: null,
});

const session = (id: string, folder: string | null, overrides: Partial<AgentMonitorSession> = {}): AgentMonitorSession => ({
  id, label: id, projectName: folder ? folderNameOf(folder) : null, provider: 'claude', state: 'running', runStartedAt: 1, lastEventAt: 100,
  orchestrator: { name: 'Main agent', fromProfile: false, state: 'running', lastToolName: null, contextTokens: null, contextWindow: null },
  agents: [], foldedFinished: 0, agentTokens: 0, cacheHitRatio: null,
  source: 'app', detail: 'live', projectPath: folder, projectKey: projectKeyOf(folder), openSessionId: id,
  ...overrides,
});

test('one folder is one key however it is written: case on Windows, separators, a trailing slash', () => {
  assert.equal(projectKeyOf('C:\\Work\\Alpha'), projectKeyOf('c:\\work\\alpha\\'));
  assert.equal(projectKeyOf('C:/Work/Alpha'), projectKeyOf('c:\\WORK\\Alpha'));
  assert.notEqual(projectKeyOf('/srv/Work'), projectKeyOf('/srv/work'), 'POSIX paths stay case-sensitive');
  assert.equal(projectKeyOf(null), NO_FOLDER_KEY);
  assert.equal(projectKeyOf(''), NO_FOLDER_KEY);
  assert.equal(folderNameOf('C:\\Work\\Alpha-ext\\'), 'Alpha-ext');
  assert.equal(folderNameOf('/srv/work/app'), 'app');
});

test('sessions are grouped by project; running counts, agents and tokens add up per project', () => {
  const projects = groupSessionsByProject([
    session('a1', 'C:\\work\\alpha', { agents: [agent('x', 'running'), agent('y', 'done')], agentTokens: 500 }),
    session('b1', 'C:\\work\\beta', { agentTokens: 40 }),
    session('a2', 'c:\\WORK\\alpha', { source: 'terminal', agents: [agent('z', 'running')], agentTokens: 250 }),
  ]);
  assert.equal(projects.length, 2);
  const alpha = projects.find((project) => project.name === 'alpha');
  assert.deepEqual(
    [alpha?.runningSessions, alpha?.runningAgents, alpha?.tokens, alpha?.sessionIds, alpha?.state],
    [2, 2, 750, ['a1', 'a2'], 'running'],
  );
});

test('a project counts as running only while one of its sessions is: an idle session does not', () => {
  const projects = groupSessionsByProject([
    session('busy', 'C:\\work\\alpha'),
    session('quiet', 'C:\\work\\beta', { state: 'idle', lastEventAt: 999 }),
    session('quiet-too', 'C:\\work\\alpha', { state: 'idle' }),
  ]);
  const byName = Object.fromEntries(projects.map((project) => [project.name, project]));
  assert.equal(byName.alpha.state, 'running');
  assert.equal(byName.alpha.runningSessions, 1, 'the idle session of the running project is listed but not counted');
  assert.deepEqual(byName.alpha.sessionIds, ['busy', 'quiet-too']);
  assert.equal(byName.beta.state, 'idle');
  assert.equal(byName.beta.runningSessions, 0);
  assert.deepEqual(projects.map((project) => project.name), ['alpha', 'beta'], 'running projects come before idle ones, even when the idle one is newer');
});

test('a session waiting for a permission answer makes its project waiting, and waiting projects come first', () => {
  const projects = groupSessionsByProject([
    session('r', 'C:\\work\\run'),
    session('w', 'C:\\work\\wait', { state: 'waiting' }),
    session('r2', 'C:\\work\\wait'),
  ]);
  assert.deepEqual(projects.map((project) => [project.name, project.state, project.runningSessions]), [['wait', 'waiting', 2], ['run', 'running', 1]]);
});

test('sessions with no known folder are grouped together under a neutral key', () => {
  const projects = groupSessionsByProject([session('n1', null), session('n2', null)]);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].key, NO_FOLDER_KEY);
  assert.equal(projects[0].path, null);
  assert.deepEqual(projects[0].sessionIds, ['n1', 'n2']);
});

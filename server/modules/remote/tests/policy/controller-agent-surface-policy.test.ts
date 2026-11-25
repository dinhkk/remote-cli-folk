import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateRemoteHttpRequest } from '../../policy/route-allow-list.js';

/**
 * What a phone (a paired Controller) may do with the agent features: pick the main agent of a new chat
 * (scope-options), watch the agents (the monitor's read-only snapshot and summary), and nothing that
 * configures or generates agents. Complements agent-profiles-policy.test.ts, which pins the whole
 * /api/agent-profiles family route by route.
 */

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const refusedFor = (methods: string[], paths: string[]): void => {
  for (const method of methods) {
    for (const path of paths) assert.equal(evaluateRemoteHttpRequest(method, path).allowed, false, `${method} ${path}`);
  }
};

test('a Controller can read the scope options of a project and the monitor snapshot and summary', () => {
  for (const path of [
    '/api/agent-profiles/scope-options?projectId=0b1f4e52-6c1a-4f5e-9d8a-2a7e5d3c9b10',
    '/api/agent-monitor/snapshot',
    '/api/agent-monitor/summary',
  ]) {
    assert.equal(evaluateRemoteHttpRequest('GET', path).allowed, true, path);
  }
});

test('those reads are read-only for a Controller: no other method is allowed on them', () => {
  refusedFor(METHODS.filter((method) => method !== 'GET'), [
    '/api/agent-profiles/scope-options', '/api/agent-monitor/snapshot', '/api/agent-monitor/summary',
  ]);
});

test('a Controller is denied Generate, the templates, and the Claude agents list and hide list, with every method', () => {
  refusedFor(METHODS, [
    '/api/agent-profiles/generate', '/api/agent-profiles/generate/preview', '/api/agent-profiles/generate/values',
    '/api/agent-profiles/generate/values?directory=C%3A%5Cwork%5Cbeta',
    '/api/agent-profiles/templates', '/api/agent-profiles/templates/t1',
    '/api/agent-profiles/claude-agents', '/api/agent-profiles/claude-agents/hidden', '/api/agent-profiles/claude-agents?directory=C%3A%5Cwork%5Cbeta',
  ]);
  // Explicit deny rules, not just "nobody listed it": a later broad allow rule cannot reopen them.
  for (const path of [
    '/api/agent-profiles/generate', '/api/agent-profiles/templates', '/api/agent-profiles/claude-agents', '/api/agent-profiles/claude-agents/hidden',
  ]) {
    assert.deepEqual(evaluateRemoteHttpRequest('POST', path), { allowed: false, reason: 'route-denied' }, path);
  }
});

test('a Controller may POST a kill and nothing else on that path: no other method, no extra segment', () => {
  assert.equal(evaluateRemoteHttpRequest('POST', '/api/agent-monitor/kill').allowed, true);
  refusedFor(METHODS.filter((method) => method !== 'POST'), ['/api/agent-monitor/kill']);
  refusedFor(METHODS, ['/api/agent-monitor/kill/extra', '/api/agent-monitor/kill/s1', '/api/agent-monitor/Kill/..']);
});

test('the monitor offers a Controller nothing beyond snapshot, summary and kill: any other path is refused until someone classifies it', () => {
  refusedFor(METHODS, [
    '/api/agent-monitor', '/api/agent-monitor/', '/api/agent-monitor/snapshot/extra', '/api/agent-monitor/sessions/s1',
    '/api/agent-monitor/unlisted-action',
  ]);
});

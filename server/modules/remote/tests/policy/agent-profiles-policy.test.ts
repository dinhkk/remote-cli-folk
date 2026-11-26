import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateRemoteHttpRequest } from '../../policy/route-allow-list.js';
import { REMOTE_DENY_RULES } from '../../policy/route-rules.js';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

test('a Controller may read the scope picker data and nothing else under /api/agent-profiles', () => {
  assert.equal(evaluateRemoteHttpRequest('GET', '/api/agent-profiles/scope-options').allowed, true);
  for (const method of METHODS.filter((candidate) => candidate !== 'GET')) {
    assert.equal(evaluateRemoteHttpRequest(method, '/api/agent-profiles/scope-options').allowed, false, method);
  }
});

test('scope-options with a project id in the query string is still the allowed route', () => {
  assert.equal(evaluateRemoteHttpRequest('GET', '/api/agent-profiles/scope-options?projectId=3f2a9c1e-0000-4000-8000-000000000001').allowed, true);
  assert.equal(evaluateRemoteHttpRequest('GET', '/api/agent-profiles/scope-options?projectId=').allowed, true);
  assert.equal(evaluateRemoteHttpRequest('GET', '/api/agent-profiles/scope-options/3f2a9c1e').allowed, false, 'the id is a query value, not a path segment');
});

test('every other agent-profiles route is refused for every method', () => {
  const paths = [
    '/api/agent-profiles', '/api/agent-profiles/',
    '/api/agent-profiles/templates', '/api/agent-profiles/templates/t1', '/api/agent-profiles/templates/t1/duplicate',
    '/api/agent-profiles/templates/from-claude-agent', '/api/agent-profiles/templates/restore-samples', '/api/agent-profiles/templates/t1/default-orchestrator',
    // The agent-profile project routes no longer exist (no deny rule either); a Controller must still get nothing from them.
    '/api/agent-profiles/projects', '/api/agent-profiles/projects/p1', '/api/agent-profiles/projects/p1/generate',
    '/api/agent-profiles/generate', '/api/agent-profiles/generate/', '/api/agent-profiles/generate/preview',
    '/api/agent-profiles/generate/values', '/api/agent-profiles/generate/values?directory=%2Fwork%2Falpha',
    // The agent store routes no longer exist; a Controller must still get nothing from them.
    '/api/agent-profiles/agents', '/api/agent-profiles/agents/a1', '/api/agent-profiles/agents/a1/resolve',
    '/api/agent-profiles/agents/a1/duplicate',
    '/api/agent-profiles/claude-agents', '/api/agent-profiles/claude-agents/hidden',
    // App-owned memory blocks: list, create, edit and delete are Host-only.
    '/api/agent-profiles/memory-blocks', '/api/agent-profiles/memory-blocks/', '/api/agent-profiles/memory-blocks/b1',
    '/API/Agent-Profiles/Memory-Blocks/b1', '/api/agent-profiles/memory-blocks/b1?x=1', '/api/agent-profiles/memory%2Dblocks/b1',
    // Per-folder content of a project block: the folder paths and texts are Host-only too.
    '/api/agent-profiles/memory-blocks/b1/contents', '/api/agent-profiles/memory-blocks/b1/contents/',
    '/api/agent-profiles/memory-blocks/b1/contents?directory=%2Fwork%2Falpha', '/api/agent-profiles/memory-blocks/b1/contents?directory=%2Fwork%2Falpha&remove=true',
    '/api/agent-profiles/memory-blocks/b1/contents?scope-options', '/api/agent-profiles/memory-blocks/b1%2Fcontents',
    '/api/agent-profiles/memory-blocks/%2e%2e/contents', '/api/agent-profiles/memory-blocks/%2E%2E/scope-options',
    '/api/agent-profiles/memory-blocks/b1/%2e%2e/%2e%2e/scope-options', '/api/agent-profiles/memory-blocks/b1/contents%00',
    '/API/Agent-Profiles/Memory-Blocks/B1/Contents',
    // Import / export bundles, snapshots and restore: prompts, block text and folder paths in, files written: Host-only.
    '/api/agent-profiles/bundle', '/api/agent-profiles/bundle/', '/api/agent-profiles/bundle/export', '/api/agent-profiles/bundle/import',
    '/api/agent-profiles/bundle/import/preview', '/api/agent-profiles/bundle/snapshots', '/api/agent-profiles/bundle/restore',
    '/api/agent-profiles/bundle/restore?snapshot=20260601T120000000Z-abcd.json', '/API/Agent-Profiles/Bundle/Restore', '/api/agent-profiles/bundle%2Frestore',
    '/api/agent-profiles/bundle/%2e%2e/scope-options', '/api/agent-profiles/bundle/export%00',
    // Proposals an agent staged, and their confirm / reject: the Host user is the only approver.
    '/api/agent-profiles/pending', '/api/agent-profiles/pending/', '/api/agent-profiles/pending/count', '/api/agent-profiles/pending/p1/confirm',
    '/api/agent-profiles/pending/p1/reject', '/API/Agent-Profiles/Pending/P1/Confirm', '/api/agent-profiles/pending%2Fp1%2Fconfirm',
    '/api/agent-profiles/pending/%2e%2e/scope-options', '/api/agent-profiles/pending/p1/confirm%00', '/api/agent-profiles/claude-agents/managers',
    '/api/agent-profiles/lint', '/api/agent-profiles/lint?projectId=p1',
    // The memory/learning routes no longer exist; a Controller must still get nothing from them.
    '/api/agent-profiles/memory', '/api/agent-profiles/memory/learning', '/api/agent-profiles/memory/session/s1',
    '/API/Agent-Profiles/Templates/T1', '/api/agent-profiles/scope-options/extra', '/api/agent-profiles/settings',
  ];
  for (const method of METHODS) {
    for (const path of paths) {
      assert.equal(evaluateRemoteHttpRequest(method, path).allowed, false, `${method} ${path}`);
    }
  }
});

test('the denied agent-profiles families are explicit deny rules (not just unknown routes)', () => {
  for (const path of ['/api/agent-profiles/templates', '/api/agent-profiles/generate', '/api/agent-profiles/generate/preview', '/api/agent-profiles/generate/values', '/api/agent-profiles/claude-agents/hidden']) {
    assert.deepEqual(evaluateRemoteHttpRequest('GET', path), { allowed: false, reason: 'route-denied' }, path);
  }
});

test('memory blocks are an explicit deny rule for every method, and the scope picker stays reachable next to it', () => {
  for (const method of METHODS) {
    for (const path of [
      '/api/agent-profiles/memory-blocks', '/api/agent-profiles/memory-blocks/b1',
      '/api/agent-profiles/memory-blocks/b1/contents', '/api/agent-profiles/memory-blocks/b1/contents?directory=%2Fwork%2Falpha&remove=true',
    ]) {
      assert.deepEqual(evaluateRemoteHttpRequest(method, path), { allowed: false, reason: 'route-denied' }, `${method} ${path}`);
    }
  }
  assert.equal(REMOTE_DENY_RULES.some((rule) => rule.pattern === '/api/agent-profiles/memory-blocks/**'), true);
  assert.equal(evaluateRemoteHttpRequest('GET', '/api/agent-profiles/scope-options').allowed, true);
});

test('the bundle family is an explicit deny rule for every method, snapshots and restore included', () => {
  for (const method of METHODS) {
    for (const path of [
      '/api/agent-profiles/bundle/export', '/api/agent-profiles/bundle/import', '/api/agent-profiles/bundle/import/preview',
      '/api/agent-profiles/bundle/snapshots', '/api/agent-profiles/bundle/restore',
    ]) {
      assert.deepEqual(evaluateRemoteHttpRequest(method, path), { allowed: false, reason: 'route-denied' }, `${method} ${path}`);
    }
  }
  assert.equal(REMOTE_DENY_RULES.some((rule) => rule.pattern === '/api/agent-profiles/bundle/**'), true);
  assert.equal(evaluateRemoteHttpRequest('GET', '/api/agent-profiles/scope-options').allowed, true);
});

test('the pending family is an explicit deny rule for every method, confirm and reject included, and the scope picker stays reachable', () => {
  for (const method of METHODS) {
    for (const path of [
      '/api/agent-profiles/pending', '/api/agent-profiles/pending/count', '/api/agent-profiles/pending/p1/confirm', '/api/agent-profiles/pending/p1/reject',
    ]) {
      assert.deepEqual(evaluateRemoteHttpRequest(method, path), { allowed: false, reason: 'route-denied' }, `${method} ${path}`);
    }
  }
  assert.equal(evaluateRemoteHttpRequest('PUT', '/api/agent-profiles/claude-agents/managers').allowed, false);
  assert.deepEqual(evaluateRemoteHttpRequest('PUT', '/api/agent-profiles/claude-agents/managers'), { allowed: false, reason: 'route-denied' });
  assert.equal(REMOTE_DENY_RULES.some((rule) => rule.pattern === '/api/agent-profiles/pending/**'), true);
  assert.equal(evaluateRemoteHttpRequest('GET', '/api/agent-profiles/scope-options').allowed, true);
});

test('the removed agent-profile project routes have no deny rule left: they are unknown routes', () => {
  assert.equal(REMOTE_DENY_RULES.some((rule) => rule.pattern.includes('agent-profiles/projects')), false);
  assert.deepEqual(evaluateRemoteHttpRequest('GET', '/api/agent-profiles/projects/p1'), { allowed: false, reason: 'route-unknown' });
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyHostWrite, createWriteProbe } from '../../bridge/bridge-write-audit.js';

/** The kill route is audited as a host write: which node of which session, in which mode, and never anything else. */

test('only POST /api/agent-monitor/kill is a monitor write; reads and other paths are not', () => {
  assert.deepEqual(classifyHostWrite('POST', '/api/agent-monitor/kill'), { event: 'host-write', area: 'monitor' });
  assert.deepEqual(classifyHostWrite('post', '/API/Agent-Monitor/Kill'), { event: 'host-write', area: 'monitor' });
  assert.equal(classifyHostWrite('GET', '/api/agent-monitor/kill'), null);
  assert.equal(classifyHostWrite('POST', '/api/agent-monitor/snapshot'), null);
  assert.equal(classifyHostWrite('POST', '/api/agent-monitor/kill/extra'), null);
});

const probeOf = (body: string) => {
  const probe = createWriteProbe('monitor', 'application/json');
  probe.push(Buffer.from(body));
  return probe.details('/api/agent-monitor/kill');
};

test('the row names the node, the mode and the session, and nothing a process id could ride on', () => {
  assert.deepEqual(probeOf(JSON.stringify({ sessionId: 's1', nodeId: 'proc:s1:node', mode: 'kill', pid: 4242 })), { node: 'proc:s1:node', mode: 'kill', session: 's1' });
});

test('a key sent twice reads as its last value, the one the Host\'s own JSON parsing keeps', () => {
  const body = '{"sessionId":"s1","nodeId":"agent:s1:innocent","mode":"stop","nodeId":"orch:s1"}';
  assert.equal(JSON.parse(body).nodeId, 'orch:s1');
  assert.equal(probeOf(body).node, 'orch:s1');
});

test('only the first 8 KiB of the body is looked at: a field pushed past it leaves the detail empty, never wrong', () => {
  const padded = `{"pad":"${'x'.repeat(9_000)}","sessionId":"s1","nodeId":"orch:s1","mode":"kill"}`;
  assert.deepEqual(probeOf(padded), {});
});

test('other areas still read their own fields (the last-occurrence rule changes none of them)', () => {
  const git = createWriteProbe('git', 'application/json');
  git.push(Buffer.from('{"project":"demo","branch":"feature/x","message":"wip"}'));
  assert.deepEqual(git.details('/api/git/checkout'), { project: 'demo', branch: 'feature/x' });
});

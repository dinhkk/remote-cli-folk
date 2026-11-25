import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import type { AgentMonitorKillRequest, AgentMonitorKillResponse, AgentMonitorKillResult } from '@/shared/types.js';

import type { AgentMonitorKiller } from '../agent-monitor.kill.js';
import { createAgentMonitorRouter } from '../agent-monitor.routes.js';
import type { AgentMonitorService } from '../agent-monitor.service.js';

const inertService = { snapshot: () => ({}), summary: async () => ({}) } as unknown as AgentMonitorService;

async function withRoute(answer: (request: AgentMonitorKillRequest) => Promise<AgentMonitorKillResponse> | AgentMonitorKillResponse, body: (post: (payload: unknown) => Promise<Response>, seen: AgentMonitorKillRequest[]) => Promise<void>) {
  const seen: AgentMonitorKillRequest[] = [];
  const killer = { kill: async (request: AgentMonitorKillRequest) => { seen.push(request); return answer(request); } } as AgentMonitorKiller;
  const app = express();
  app.use(express.json());
  app.use('/api/agent-monitor', createAgentMonitorRouter(inertService, killer));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    await body((payload) => fetch(`http://127.0.0.1:${port}/api/agent-monitor/kill`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    }), seen);
  } finally {
    server.close();
  }
}

const GOOD = { sessionId: 's1', nodeId: 'orch:s1', mode: 'kill' };

test('a result maps to its HTTP status: refused 403, error 500, everything else 200', async () => {
  const expected: Array<[AgentMonitorKillResult, number]> = [['killed', 200], ['stopped', 200], ['gone', 200], ['no-handle', 200], ['unavailable', 200], ['refused', 403], ['error', 500]];
  for (const [result, status] of expected) {
    await withRoute(() => ({ result }), async (post) => {
      const response = await post(GOOD);
      assert.equal(response.status, status, result);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal((await response.json() as AgentMonitorKillResponse).result, result);
    });
  }
});

test('the killer gets exactly the three fields, and a kill answer carries a count but no process id', async () => {
  await withRoute(() => ({ result: 'killed', count: 3 }), async (post, seen) => {
    const response = await post({ ...GOOD, pid: 4242, extra: 'x' });
    assert.deepEqual(seen, [GOOD], 'a pid or any other field in the request is dropped');
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { result: 'killed', count: 3 });
    assert.ok(!/pid/i.test(text));
  });
});

test('a body that is not a request is a 400 and never reaches the killer', async () => {
  await withRoute(() => ({ result: 'killed' }), async (post, seen) => {
    const bad: unknown[] = [
      {}, [], 'not json', { sessionId: 's1', nodeId: 'orch:s1' }, { ...GOOD, mode: 'terminate' }, { ...GOOD, sessionId: '' },
      { ...GOOD, nodeId: 7 }, { ...GOOD, nodeId: 'x'.repeat(257) }, { ...GOOD, sessionId: null },
    ];
    for (const payload of bad) assert.equal((await post(payload)).status, 400, JSON.stringify(payload).slice(0, 60));
    assert.deepEqual(seen, []);
  });
});

test('without a killer the route does not exist', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/agent-monitor', createAgentMonitorRouter(inertService));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/agent-monitor/kill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(GOOD) })).status, 404);
  } finally {
    server.close();
  }
});

test('GET on the kill path is not routed', async () => {
  const killer = { kill: async () => ({ result: 'killed' as const }) } as unknown as AgentMonitorKiller;
  const app = express();
  app.use('/api/agent-monitor', createAgentMonitorRouter(inertService, killer));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/agent-monitor/kill`)).status, 404);
  } finally {
    server.close();
  }
});

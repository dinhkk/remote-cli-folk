/**
 * What the bridge does with the Host's answers: redirects are never followed, every response is
 * forced to nosniff (the CSP sandbox only for non-JSON/SSE), and the blanket 401/403 mapping.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import type net from 'node:net';
import test from 'node:test';

import type { RemoteStreamEnd } from '@/shared/types.js';

import { createHostBridge, type HostBridge } from '../../bridge/host-bridge.js';
import { SANDBOX_CSP } from '../../policy/header-filter.js';
import { callThroughBridge, createBridgedLoopback } from '../support/bridge-test-harness.js';
import { startFakeHost, type FakeHost } from '../support/fake-loopback-host.js';
import type { MuxLoopback } from '../support/mux-loopback.js';
import { syntheticPathPolicy } from '../support/synthetic-path-policy.js';

const errorCode = (end: RemoteStreamEnd): string | undefined => (end.cause === 'error' ? end.code : undefined);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const withBridge = async (run: (context: { host: FakeHost; bridge: HostBridge; loop: MuxLoopback }) => Promise<void>): Promise<void> => {
  const host = await startFakeHost();
  const bridge = createHostBridge({ port: host.port, env: {}, issueToken: () => 'loopback-token', evaluateHttp: syntheticPathPolicy });
  const loop = createBridgedLoopback((stream, open) => bridge.handleStream(stream, open));
  try {
    await run({ host, bridge, loop });
  } finally {
    bridge.closeAll();
    await host.close();
  }
};

/** A second local listener that counts what reaches it: the place a followed redirect would land. */
const startTrap = async (): Promise<{ url: string; hits: string[]; connections: number; close(): Promise<void> }> => {
  const hits: string[] = [];
  const state = { connections: 0 };
  const server = http.createServer((request, response) => {
    hits.push(`${request.method} ${request.url} auth=${request.headers.authorization ?? ''}`);
    response.end('trap');
  });
  server.on('connection', () => {
    state.connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/landing`,
    hits,
    get connections() {
      return state.connections;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

// ---------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------

test('a Host 3xx with Location is relayed as a bare status: Location is stripped and nothing is followed', async () => {
  const trap = await startTrap();
  try {
    await withBridge(async ({ host, loop }) => {
      for (const status of [301, 302, 303, 307, 308]) {
        const outcome = await callThroughBridge(loop, { path: `/api/projects/redirect?status=${status}&to=${encodeURIComponent(trap.url)}` });
        assert.equal(outcome.response?.status, status);
        const names = Object.keys(outcome.response?.headers ?? {});
        assert.ok(!names.some((name) => /^location$/i.test(name)), `Location reached the Controller: ${JSON.stringify(outcome.response?.headers)}`);
        assert.ok(!JSON.stringify(outcome.response).includes(trap.url));
        assert.equal(outcome.end.cause, 'completed');
      }
      // Give a (wrongly) followed redirect time to arrive; it must not: the Host saw one request per call, the trap none.
      await sleep(150);
      assert.equal(host.requests.length, 5);
      assert.ok(host.requests.every((request) => request.url.startsWith('/api/projects/redirect')));
      assert.deepEqual(trap.hits, []);
      assert.equal(trap.connections, 0);
    });
  } finally {
    await trap.close();
  }
});

test('a redirect to a path on the Host itself is not followed either (the bridge never issues a second request)', async () => {
  await withBridge(async ({ host, loop }) => {
    const outcome = await callThroughBridge(loop, { path: '/api/projects/redirect?status=302&to=%2Fapi%2Fauth%2Fuser' });
    assert.equal(outcome.response?.status, 302);
    await sleep(100);
    assert.equal(host.requests.length, 1);
    assert.ok(!host.requests.some((request) => request.url.startsWith('/api/auth')));
  });
});

// ---------------------------------------------------------------------------
// nosniff and sandbox by content type, end to end
// ---------------------------------------------------------------------------

const EXEMPT_FROM_SANDBOX = ['application/json', 'application/json;charset=utf-7', 'application/problem+json', 'application/vnd.api+json; charset=utf-8', 'text/event-stream;charset=x', 'TEXT/EVENT-STREAM'];
const SANDBOXED = ['text/html', 'text/html; charset=utf-8', 'image/svg+xml', 'text/plain', 'application/octet-stream', 'text/json', 'application/jsonp', 'application/x-json', 'text/html; x=application/json'];

test('every response carries nosniff through the bridge; the CSP sandbox is absent only for JSON and SSE', async () => {
  await withBridge(async ({ loop }) => {
    for (const type of [...EXEMPT_FROM_SANDBOX, ...SANDBOXED]) {
      const outcome = await callThroughBridge(loop, { path: `/api/projects/ctype?type=${encodeURIComponent(type)}` });
      const headers = outcome.response?.headers ?? {};
      assert.equal(outcome.response?.status, 200, type);
      assert.equal(headers['x-content-type-options'], 'nosniff', type);
      assert.equal(headers['cache-control'], 'no-store', type);
      if (EXEMPT_FROM_SANDBOX.includes(type)) assert.equal(headers['content-security-policy'], undefined, type);
      else assert.equal(headers['content-security-policy'], SANDBOX_CSP, type);
    }
  });
});

test('a response without any Content-Type is sandboxed and nosniffed', async () => {
  await withBridge(async ({ loop }) => {
    const outcome = await callThroughBridge(loop, { path: '/api/projects/ctype' });
    const headers = outcome.response?.headers ?? {};
    assert.equal(outcome.response?.status, 200);
    assert.equal(headers['content-type'], undefined);
    assert.equal(headers['x-content-type-options'], 'nosniff');
    assert.equal(headers['content-security-policy'], SANDBOX_CSP);
  });
});

test('SSE and plain JSON answers from the Host get nosniff too', async () => {
  await withBridge(async ({ loop }) => {
    const json = await callThroughBridge(loop, { path: '/api/projects' });
    assert.equal(json.response?.headers['x-content-type-options'], 'nosniff');
    assert.equal(json.response?.headers['content-security-policy'], undefined);
    const sse = await callThroughBridge(loop, { path: '/api/projects/sse' });
    assert.equal(sse.response?.headers['x-content-type-options'], 'nosniff');
    assert.equal(sse.response?.headers['content-security-policy'], undefined);
  });
});

// ---------------------------------------------------------------------------
// 401/403: the blanket mapping, pinned
// ---------------------------------------------------------------------------

test('every Host 401 and 403 becomes REMOTE_UPSTREAM_AUTH with no response head, including a legitimate 403 (known: it is masked)', async () => {
  await withBridge(async ({ loop }) => {
    for (const path of ['/api/projects/status/401', '/api/projects/status/403', '/api/projects/forbidden']) {
      const outcome = await callThroughBridge(loop, { path });
      assert.equal(errorCode(outcome.end), 'REMOTE_UPSTREAM_AUTH', path);
      assert.equal(outcome.response, undefined, path);
    }
  });
});

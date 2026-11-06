import assert from 'node:assert/strict';
import test from 'node:test';

import type { RemoteBridgeViolation, RemoteRelayLink, RemoteStreamEnd } from '@/shared/types.js';

import { createHostBridge, type HostBridge, type HostBridgeOptions } from '../../bridge/host-bridge.js';
import { createLoopbackClient, resolveLoopbackPort } from '../../bridge/loopback-client.js';
import { callThroughBridge, createBridgedLoopback, createStreamStub, startHttpCall, startWsCall } from '../support/bridge-test-harness.js';
import { findClosedPort, patternBytes, sha256, startFakeHost, startSilentServer, type FakeHost } from '../support/fake-loopback-host.js';
import { createMuxLoopback, type MuxLoopback } from '../support/mux-loopback.js';
import { waitFor } from '../support/relay-link-rig.js';
import { syntheticPathPolicy } from '../support/synthetic-path-policy.js';

type Context = { host: FakeHost; bridge: HostBridge; loop: MuxLoopback; violations: RemoteBridgeViolation[] };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const errorCode = (end: RemoteStreamEnd): string | undefined => (end.cause === 'error' ? end.code : undefined);

let tokenCounter = 0;
const options = (port: number, extra: Partial<HostBridgeOptions> = {}): HostBridgeOptions => ({
  port,
  env: {},
  issueToken: () => `loopback-token-${(tokenCounter += 1)}`,
  evaluateHttp: syntheticPathPolicy,
  ...extra,
});

const withBridge = async (run: (context: Context) => Promise<void>, extra: Partial<HostBridgeOptions> = {}, gated = false): Promise<void> => {
  const host = await startFakeHost();
  const violations: RemoteBridgeViolation[] = [];
  const bridge = createHostBridge(options(host.port, { onViolation: (violation) => violations.push(violation), ...extra }));
  const loop = gated ? createMuxLoopback({ gated: true }) : createMuxLoopback();
  loop.host.handleIncoming = (stream, open) => bridge.handleStream(stream, open);
  if (gated) await loop.open('toHost');
  try {
    await run({ host, bridge, loop, violations });
  } finally {
    bridge.closeAll();
    await host.close();
  }
};

// ---------------------------------------------------------------------------
// Methods and request framing (smuggling toward the loopback server)
// ---------------------------------------------------------------------------

test('methods outside GET/POST/PUT/PATCH/DELETE are refused, with no case folding (no CONNECT, TRACE, HEAD, OPTIONS)', async () => {
  await withBridge(async ({ host, loop, violations }) => {
    for (const method of ['TRACE', 'CONNECT', 'HEAD', 'OPTIONS', 'PROPFIND', 'get', 'Get', 'patch', 'LINK']) {
      const outcome = await callThroughBridge(loop, { method, path: '/api/projects' });
      assert.equal(errorCode(outcome.end), 'REMOTE_FORBIDDEN', method);
    }
    assert.equal(host.requests.length, 0);
    assert.equal(violations.length, 9);
    assert.ok(violations.every((violation) => violation.reason === 'method-not-allowed'));
  });
});

test('a body longer than its Content-Length is never written: nothing smuggled reaches the Host', async () => {
  await withBridge(async ({ host, loop, violations }) => {
    const smuggled = 'ABCD' + 'GET /api/projects/echo?smuggled=1 HTTP/1.1\r\nHost: x\r\n\r\n';
    const outcome = await callThroughBridge(loop, {
      method: 'POST',
      path: '/api/projects/echo',
      headers: { 'content-length': '4', 'content-type': 'text/plain' },
      body: [smuggled],
    });
    assert.equal(errorCode(outcome.end), 'REMOTE_FORBIDDEN');
    await sleep(100);
    assert.ok(!host.requests.some((request) => request.url.includes('smuggled')), 'a smuggled request reached the Host');
    assert.ok(host.requests.every((request) => !request.complete), 'a request with a mismatching body completed');
    assert.deepEqual(violations.at(-1), { kind: 'request-body', reason: 'length-mismatch', method: 'POST', target: '/api/projects/echo' });
  });
});

test('a body shorter than its Content-Length is refused and never completes a request', async () => {
  await withBridge(async ({ host, loop }) => {
    const outcome = await callThroughBridge(loop, { method: 'POST', path: '/api/projects/echo', headers: { 'content-length': '10' }, body: ['abc'] });
    assert.equal(errorCode(outcome.end), 'REMOTE_FORBIDDEN');
    await sleep(100);
    assert.ok(host.requests.every((request) => !request.complete));
  });
});

test('Content-Length 0 with a body is refused', async () => {
  await withBridge(async ({ loop }) => {
    const outcome = await callThroughBridge(loop, { method: 'POST', path: '/api/projects/echo', headers: { 'content-length': '0' }, body: ['x'] });
    assert.equal(errorCode(outcome.end), 'REMOTE_FORBIDDEN');
  });
});

test('Transfer-Encoding from the Controller is ignored: the Host sees the Content-Length only', async () => {
  await withBridge(async ({ host, loop }) => {
    const outcome = await callThroughBridge(loop, {
      method: 'POST',
      path: '/api/projects/echo',
      headers: { 'content-length': '5', 'transfer-encoding': 'chunked', te: 'trailers' },
      body: ['hello'],
    });
    assert.equal(outcome.response?.status, 200);
    assert.equal(host.requests[0].headers['content-length'], '5');
    assert.equal(host.requests[0].headers['transfer-encoding'], undefined);
    assert.equal(host.requests[0].body.toString(), 'hello');
  });
});

test('a POST without Content-Length is framed as chunked by the bridge and arrives intact', async () => {
  await withBridge(async ({ host, loop }) => {
    const body = patternBytes(150_000, 11);
    const outcome = await callThroughBridge(loop, { method: 'POST', path: '/api/projects/echo', body: [body.subarray(0, 60_000), body.subarray(60_000, 120_000), body.subarray(120_000)] });
    assert.equal(outcome.response?.status, 200);
    assert.equal(host.requests[0].headers['transfer-encoding'], 'chunked');
    assert.equal(host.requests[0].headers['content-length'], undefined);
    assert.equal(sha256(host.requests[0].body), sha256(body));
  });
});

test('an empty POST without Content-Length is a valid empty chunked request', async () => {
  await withBridge(async ({ host, loop }) => {
    const outcome = await callThroughBridge(loop, { method: 'POST', path: '/api/projects/echo' });
    assert.equal(outcome.response?.status, 200);
    assert.equal(host.requests[0].body.length, 0);
  });
});

test('a GET or DELETE body without Content-Length is refused (it could be read as a second request)', async () => {
  await withBridge(async ({ host, loop, violations }) => {
    for (const method of ['GET', 'DELETE']) {
      const outcome = await callThroughBridge(loop, { method, path: '/api/projects/echo', body: ['GET /api/auth/user HTTP/1.1\r\n\r\n'] });
      assert.equal(errorCode(outcome.end), 'REMOTE_FORBIDDEN', method);
    }
    assert.deepEqual(violations.map((violation) => violation.reason), ['body-without-length', 'body-without-length']);
    await sleep(50);
    assert.ok(host.requests.every((request) => !request.complete || request.body.length === 0));
  });
});

test('a DELETE with a declared body is allowed and arrives intact', async () => {
  await withBridge(async ({ host, loop }) => {
    const outcome = await callThroughBridge(loop, { method: 'DELETE', path: '/api/projects/echo', headers: { 'content-length': '13', 'content-type': 'application/json' }, body: ['{"path":"a.c"}'.slice(0, 13)] });
    assert.equal(outcome.response?.status, 200);
    assert.equal(host.requests[0].body.length, 13);
  });
});

test('a declared body over the limit is refused before the Host is contacted', async () => {
  await withBridge(
    async ({ host, loop }) => {
      const outcome = await callThroughBridge(loop, { method: 'POST', path: '/api/projects/echo', headers: { 'content-length': '2000' }, body: [] , fin: false});
      assert.equal(errorCode(outcome.end), 'REMOTE_TOO_LARGE');
      assert.equal(host.requests.length, 0);
      assert.equal(host.connections, 0);
    },
    { limits: { maxRequestBodyBytes: 1000 } },
  );
});

test('header injection in a forwarded header value is refused before the Host is contacted', async () => {
  await withBridge(async ({ host, loop, violations }) => {
    const badHeaders: Array<Record<string, string>> = [{ accept: 'x\r\nX-Evil: 1' }, { 'content-length': '5\r\nX: y' }, { 'content-length': '5, 5' }, { 'x-request-id': 'a\u0000b' }];
    for (const headers of badHeaders) {
      const outcome = await callThroughBridge(loop, { method: 'POST', path: '/api/projects/echo', headers, body: ['hello'] });
      assert.equal(errorCode(outcome.end), 'REMOTE_FORBIDDEN', JSON.stringify(headers));
    }
    assert.equal(host.requests.length, 0);
    assert.ok(violations.every((violation) => violation.kind === 'request-headers'));
  });
});

// ---------------------------------------------------------------------------
// Cancel, timeouts, unreachable Host
// ---------------------------------------------------------------------------

test('CANCEL from the Controller aborts the loopback request and frees the stream', async () => {
  await withBridge(async ({ host, bridge, loop }) => {
    const call = startHttpCall(loop, { path: '/api/projects/silent' });
    await waitFor(() => host.requests.length === 1, 'the Host to receive the request');
    call.stream.cancel();
    await waitFor(() => host.aborted === 1, 'the loopback request to be aborted');
    await waitFor(() => bridge.activeStreams === 0, 'the bridge to release the stream');
  });
});

test('CANCEL during an upload aborts the loopback request', async () => {
  await withBridge(async ({ host, bridge, loop }) => {
    const call = startHttpCall(loop, { method: 'POST', path: '/api/projects/echo', headers: { 'content-length': '1000' }, body: ['x'.repeat(100)], fin: false });
    await waitFor(() => bridge.activeStreams === 1, 'the stream');
    await sleep(50);
    call.stream.cancel();
    await waitFor(() => bridge.activeStreams === 0, 'the bridge to release the stream');
    await sleep(100);
    assert.ok(host.requests.every((request) => !request.complete));
  });
});

test('closing the whole bridge cancels active HTTP and WebSocket streams', async () => {
  await withBridge(async ({ host, bridge, loop }) => {
    const call = startHttpCall(loop, { path: '/api/projects/silent' });
    const ws = startWsCall(loop, '/ws');
    await waitFor(() => host.requests.length === 1 && host.upgrades.length === 1 && bridge.activeStreams === 2, 'both streams');
    bridge.closeAll();
    const outcome = await call.done;
    assert.equal(outcome.end.cause, 'peer-cancel');
    assert.equal((await ws.waitForEnd()).cause, 'peer-cancel');
    await waitFor(() => bridge.activeStreams === 0, 'no active streams');
  });
});

test('slow-loris upload: a request body that stops arriving is cut after the idle limit', async () => {
  await withBridge(
    async ({ host, bridge, loop }) => {
      const call = startHttpCall(loop, { method: 'POST', path: '/api/projects/echo', headers: { 'content-length': '1000' }, body: ['x'.repeat(10)], fin: false });
      const outcome = await call.done;
      assert.equal(errorCode(outcome.end), 'REMOTE_INTERNAL');
      await waitFor(() => bridge.activeStreams === 0, 'the bridge to release the stream');
      assert.ok(host.requests.every((request) => !request.complete));
    },
    { limits: { requestBodyIdleMs: 80 } },
  );
});

test('each body chunk restarts the idle clock, so a steady slow upload survives', async () => {
  await withBridge(
    async ({ host, loop }) => {
      const call = startHttpCall(loop, { method: 'POST', path: '/api/projects/echo', headers: { 'content-length': '12' }, body: ['abcd'], fin: false });
      await sleep(60);
      call.stream.writeBody(Buffer.from('efgh'), false);
      await sleep(60);
      call.stream.writeBody(Buffer.from('ijkl'), true);
      const outcome = await call.done;
      assert.equal(outcome.response?.status, 200);
      assert.equal(host.requests[0].body.toString(), 'abcdefghijkl');
    },
    { limits: { requestBodyIdleMs: 100 } },
  );
});

test('a Host that never answers is cut after the response limit', async () => {
  await withBridge(
    async ({ bridge, loop }) => {
      const outcome = await callThroughBridge(loop, { path: '/api/projects/silent' });
      assert.equal(errorCode(outcome.end), 'REMOTE_INTERNAL');
      await waitFor(() => bridge.activeStreams === 0, 'the bridge to release the stream');
    },
    { limits: { responseHeadersMs: 80 } },
  );
});

test('a Host that answers early while the Controller keeps its upload open: the response is delivered, the stream is then cancelled', async () => {
  await withBridge(
    async ({ bridge, loop }) => {
      const call = startHttpCall(loop, { method: 'POST', path: '/api/projects/early-reply', headers: { 'content-length': '1000' }, body: ['x'.repeat(10)], fin: false });
      const outcome = await call.done;
      assert.equal(outcome.response?.status, 413);
      assert.deepEqual(JSON.parse(outcome.body.toString()), { error: 'too big' });
      assert.equal(outcome.end.cause, 'peer-cancel');
      await waitFor(() => bridge.activeStreams === 0, 'the bridge to release the stream');
    },
    { limits: { requestBodyIdleMs: 80 } },
  );
});

test('a response that stalls mid-body keeps the stream open until the Controller cancels', async () => {
  await withBridge(async ({ host, bridge, loop }) => {
    const call = startHttpCall(loop, { path: '/api/projects/stall' });
    await waitFor(() => host.requests.length === 1, 'the request');
    await sleep(100);
    call.stream.cancel();
    await waitFor(() => bridge.activeStreams === 0, 'the bridge to release the stream');
  });
});

test('an unreachable loopback port is REMOTE_INTERNAL for HTTP and WebSocket (and nothing hangs)', async () => {
  const port = await findClosedPort();
  const bridge = createHostBridge(options(port));
  const loop = createBridgedLoopback((stream, open) => bridge.handleStream(stream, open));
  try {
    assert.equal(errorCode((await callThroughBridge(loop, { path: '/api/projects' })).end), 'REMOTE_INTERNAL');
    assert.equal(errorCode(await startWsCall(loop, '/ws').waitForEnd()), 'REMOTE_INTERNAL');
    await waitFor(() => bridge.activeStreams === 0, 'no active streams');
  } finally {
    bridge.closeAll();
  }
});

test('a Host that accepts the TCP connection but never completes the WebSocket upgrade is cut after the handshake limit', async () => {
  const silent = await startSilentServer();
  const bridge = createHostBridge(options(silent.port, { limits: { websocketHandshakeMs: 100 } }));
  const loop = createBridgedLoopback((stream, open) => bridge.handleStream(stream, open));
  try {
    assert.equal(errorCode(await startWsCall(loop, '/shell').waitForEnd()), 'REMOTE_INTERNAL');
  } finally {
    bridge.closeAll();
    await silent.close();
  }
});

test('WebSocket messages sent while the upgrade is pending are kept in order; too many close the stream with 1013', async () => {
  const silent = await startSilentServer();
  const bridge = createHostBridge(options(silent.port, { limits: { websocketHandshakeMs: 30_000 } }));
  const loop = createBridgedLoopback((stream, open) => bridge.handleStream(stream, open));
  try {
    const byCount = startWsCall(loop, '/ws');
    for (let i = 0; i < 300; i += 1) byCount.stream.sendMessage(Buffer.from('{"type":"chat.abort","sessionId":"s"}'), false);
    const end = await byCount.waitForEnd();
    assert.equal(end.cause === 'peer-ws-close' && end.code, 1013);

    const bySize = startWsCall(loop, '/ws');
    const big = Buffer.from(JSON.stringify({ type: 'chat.send', content: 'x'.repeat(600_000) }));
    bySize.stream.sendMessage(big, false);
    bySize.stream.sendMessage(big, false);
    const sizeEnd = await bySize.waitForEnd();
    assert.equal(sizeEnd.cause === 'peer-ws-close' && sizeEnd.code, 1013);
  } finally {
    bridge.closeAll();
    await silent.close();
  }
});

test('a pending WebSocket message set is delivered in order once the upgrade completes', async () => {
  await withBridge(async ({ host, loop }) => {
    const call = startWsCall(loop, '/ws');
    for (let i = 0; i < 50; i += 1) call.stream.sendMessage(Buffer.from(JSON.stringify({ type: 'chat.abort', sessionId: `s${i}` })), false);
    await waitFor(() => host.wsReceived.length === 50, 'every message at the Host');
    assert.deepEqual(
      host.wsReceived.map((received) => (JSON.parse(received.data.toString()) as { sessionId: string }).sessionId),
      Array.from({ length: 50 }, (_, i) => `s${i}`),
    );
    call.stream.closeWebSocket(1000, 'done');
  });
});

test('a Host message over 1 MiB is refused by the loopback socket and the stream closes (1009)', async () => {
  await withBridge(async ({ loop }) => {
    const call = startWsCall(loop, '/ws');
    call.stream.sendMessage(Buffer.from('{"type":"chat.subscribe","fake":"burst:1:1572864"}'), false);
    const end = await call.waitForEnd();
    // The loopback socket reports the oversize close as 1009 or as an abnormal drop (mapped to 1011); never as success.
    assert.ok(end.cause === 'peer-ws-close' && (end.code === 1009 || end.code === 1011), JSON.stringify(end));
  });
});

test('close codes: a Controller application code closes the loopback socket; a Host close without a status maps to 1000', async () => {
  await withBridge(async ({ host, loop }) => {
    const byController = startWsCall(loop, '/ws');
    await waitFor(() => host.wsConnections.length === 1, 'the upgrade');
    await sleep(20);
    byController.stream.closeWebSocket(4001, 'app code');
    await waitFor(() => host.wsConnections[0].readyState === host.wsConnections[0].CLOSED, 'the loopback socket to close');

    const byHost = startWsCall(loop, '/ws');
    await waitFor(() => host.wsConnections.length === 2, 'the second upgrade');
    await sleep(20);
    host.wsConnections[1].close();
    const end = await byHost.waitForEnd();
    assert.equal(end.cause === 'peer-ws-close' && end.code, 1000, 'close frame without a status (1005) is relayed as 1000');
  });
});

// ---------------------------------------------------------------------------
// Backpressure (contracts section 6): pause at 4 MiB, resume at 1 MiB, never overflow 8 MiB
// ---------------------------------------------------------------------------

test('HTTP download over a slow link: the loopback socket is paused at the high-water mark, nothing overflows, and the body arrives intact', async () => {
  await withBridge(
    async ({ host, loop }) => {
      const total = 14 * 1024 * 1024;
      const call = startHttpCall(loop, { path: `/api/projects/big?bytes=${total}` });
      await waitFor(() => loop.host.incoming.length === 1, 'the Host stream');
      const hostStream = loop.host.incoming[0].stream;
      let peak = 0;
      const sampler = setInterval(() => {
        peak = Math.max(peak, hostStream.queuedBytes);
      }, 2);
      try {
        await waitFor(() => hostStream.paused, 'the stream to hit the high-water mark');
        const atPause = hostStream.queuedBytes;
        assert.ok(atPause >= 4 * 1024 * 1024, `paused at ${atPause}`);
        await sleep(400);
        const later = hostStream.queuedBytes;
        assert.ok(later - atPause < 1024 * 1024, `queue kept growing while paused: ${atPause} -> ${later}`);
        assert.ok(host.drainWaits >= 1, 'the Host had to wait for the loopback socket: backpressure reached it');
        assert.equal(hostStream.closed, false);
        assert.ok(peak < 6 * 1024 * 1024, `peak queue ${peak}`);

        await loop.open('toController');
        const outcome = await call.done;
        assert.equal(outcome.end.cause, 'completed');
        assert.equal(outcome.body.length, total);
        assert.equal(sha256(outcome.body), sha256(patternBytes(total, 7)));
        assert.ok(peak < 8 * 1024 * 1024);
      } finally {
        clearInterval(sampler);
      }
    },
    {},
    true,
  );
});

test('WebSocket flood over a slow link: the loopback socket is paused, nothing overflows, every message arrives in order', async () => {
  await withBridge(
    async ({ loop }) => {
      const count = 24;
      const size = 512 * 1024;
      const call = startWsCall(loop, '/ws');
      await waitFor(() => loop.host.incoming.length === 1, 'the Host stream');
      const hostStream = loop.host.incoming[0].stream;
      call.stream.sendMessage(Buffer.from(`{"type":"chat.subscribe","fake":"burst:${count}:${size}"}`), false);
      let peak = 0;
      const sampler = setInterval(() => {
        peak = Math.max(peak, hostStream.queuedBytes);
      }, 2);
      try {
        await waitFor(() => hostStream.paused, 'the stream to hit the high-water mark');
        const atPause = hostStream.queuedBytes;
        await sleep(300);
        assert.ok(hostStream.queuedBytes - atPause <= 2 * size, `queue kept growing while paused: ${atPause} -> ${hostStream.queuedBytes}`);
        assert.equal(hostStream.closed, false, 'the stream must not overflow');
        assert.ok(peak < 7 * 1024 * 1024, `peak queue ${peak}`);

        await loop.open('toController');
        await call.waitForMessages(count);
        call.messages.forEach((message, index) => {
          assert.ok(message.binary);
          assert.equal(sha256(message.payload), sha256(patternBytes(size, index + 1)), `message ${index}`);
        });
      } finally {
        clearInterval(sampler);
      }
    },
    {},
    true,
  );
});

// ---------------------------------------------------------------------------
// attach(link)
// ---------------------------------------------------------------------------

test('attach gates streams on the E2E session and returns the unsubscribe', () => {
  const bridge = createHostBridge(options(3999));
  let handler: Parameters<RemoteRelayLink['onStream']>[0] | undefined;
  let unsubscribed = false;
  const link = {
    sessionActive: false,
    onStream: (next: Parameters<RemoteRelayLink['onStream']>[0]) => {
      handler = next;
      return () => {
        unsubscribed = true;
      };
    },
  };
  const detach = bridge.attach(link);
  assert.ok(handler);

  const refused = createStreamStub('http');
  assert.equal(handler?.(refused, { kind: 'http', meta: { method: 'GET', path: '/api/projects', headers: {} } }), 'REMOTE_LINK_DOWN');
  assert.equal(refused.calls.length, 0, 'no session: the stream is refused without being touched');

  link.sessionActive = true;
  const served = createStreamStub('http');
  assert.equal(handler?.(served, { kind: 'http', meta: { method: 'GET', path: '/api/auth/user', headers: {} } }), undefined);
  assert.equal(served.failure?.code, 'REMOTE_FORBIDDEN', 'with a session the policy runs');

  detach();
  assert.equal(unsubscribed, true);
});

// ---------------------------------------------------------------------------
// Configuration and the loopback client
// ---------------------------------------------------------------------------

test('SERVER_PORT is read like the server does and validated', () => {
  assert.equal(resolveLoopbackPort({}), 3001);
  assert.equal(resolveLoopbackPort({ SERVER_PORT: '' }), 3001);
  assert.equal(resolveLoopbackPort({ SERVER_PORT: '8080' }), 8080);
  for (const value of ['abc', '0', '-1', '70000', 'NaN']) assert.throws(() => resolveLoopbackPort({ SERVER_PORT: value }), /valid port/, value);
  assert.equal(resolveLoopbackPort({ SERVER_PORT: ' 9090' }), 9090);
});

test('the bridge refuses an invalid port at creation', () => {
  for (const port of [0, -5, 70_000, 1.5, Number.NaN]) assert.throws(() => createHostBridge({ port, env: {} }), /not valid/, String(port));
  assert.doesNotThrow(() => createHostBridge({ env: { SERVER_PORT: '4567' } }));
});

test('the loopback client only builds URLs from canonical paths', () => {
  const client = createLoopbackClient({ port: 3999, env: {}, issueToken: () => 't' });
  const bad = [
    { path: '//evil.com/x', segments: [], query: '' },
    { path: '/a b', segments: [], query: '' },
    { path: '/a/../b', segments: [], query: '' },
    { path: 'http://evil/x', segments: [], query: '' },
    { path: '/x\\y', segments: [], query: '' },
    { path: '/x', segments: [], query: 'no-question-mark' },
    { path: '/x', segments: [], query: '?a b' },
    { path: '/x\r\nHost: evil', segments: [], query: '' },
  ];
  for (const target of bad) {
    assert.throws(() => client.request({ method: 'GET', target, headers: {} }), /not canonical/, JSON.stringify(target));
  }
});

test('the loopback client never lets supplied headers override Host, Authorization or x-api-key', async () => {
  const host = await startFakeHost();
  try {
    const client = createLoopbackClient({ port: host.port, env: { API_KEY: 'host-key' }, issueToken: () => 'fresh' });
    const request = client.request({
      method: 'GET',
      target: { path: '/api/projects', segments: ['api', 'projects'], query: '' },
      headers: { Host: 'evil.example', AUTHORIZATION: 'Bearer stolen', 'X-API-KEY': 'stolen', accept: 'application/json' },
    });
    await new Promise<void>((resolve, reject) => {
      request.on('response', (response) => {
        response.resume();
        response.on('end', resolve);
      });
      request.on('error', reject);
      request.end();
    });
    const received = host.requests[0].headers;
    assert.equal(received.host, `127.0.0.1:${host.port}`);
    assert.equal(received.authorization, 'Bearer fresh');
    assert.equal(received['x-api-key'], 'host-key');
    assert.equal(received.accept, 'application/json');
  } finally {
    await host.close();
  }
});

test('the bridge never writes tokens, headers or message content to the console', async () => {
  const captured: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const originals = methods.map((method) => console[method]);
  for (const method of methods) console[method] = (...args: unknown[]) => void captured.push(args.map(String).join(' '));
  try {
    await withBridge(
      async ({ loop }) => {
        await callThroughBridge(loop, { path: '/api/projects?token=SECRET-QUERY', headers: { cookie: 'SECRET-COOKIE', authorization: 'Bearer SECRET-TAB-TOKEN' } });
        await callThroughBridge(loop, { path: '/api/projects/status/401' });
        await callThroughBridge(loop, { method: 'POST', path: '/api/auth/login', body: ['{"password":"SECRET-BODY"}'] });
        const ws = startWsCall(loop, '/ws?token=SECRET-WS-QUERY', ['cloudcli-tab', 'SECRET-SUBPROTOCOL']);
        ws.stream.sendMessage(Buffer.from('{"type":"chat.permission-response","requestId":"r","allow":true,"rememberEntry":"SECRET-REMEMBER","message":"SECRET-CARD"}'), false);
        ws.stream.sendMessage(Buffer.from('{"type":"evil","x":"SECRET-BAD-MESSAGE"}'), false);
        await ws.waitForEnd();
      },
      { env: { API_KEY: 'SECRET-API-KEY' } },
    );
  } finally {
    methods.forEach((method, index) => {
      console[method] = originals[index];
    });
  }
  const output = captured.join('\n');
  for (const secret of ['loopback-token', 'Bearer', 'SECRET']) assert.ok(!output.includes(secret), `console output contains ${secret}: ${output.slice(0, 200)}`);
});

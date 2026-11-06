import assert from 'node:assert/strict';
import test from 'node:test';

import type { RemoteBridgeViolation, RemoteStreamEnd } from '@/shared/types.js';

import { createHostBridge, type HostBridge, type HostBridgeOptions } from '../../bridge/host-bridge.js';
import { callThroughBridge, createBridgedLoopback, createStreamStub, startHttpCall, startWsCall } from '../support/bridge-test-harness.js';
import { patternBytes, sha256, startFakeHost, type FakeHost } from '../support/fake-loopback-host.js';
import type { MuxLoopback } from '../support/mux-loopback.js';
import { waitFor } from '../support/relay-link-rig.js';
import { syntheticPathPolicy } from '../support/synthetic-path-policy.js';

type Context = { host: FakeHost; bridge: HostBridge; loop: MuxLoopback; tokens: string[]; violations: RemoteBridgeViolation[] };

/** A bridge in front of the fake Host. Tokens are `loopback-token-<n>` so a test can see how often one was issued. */
const withBridge = async (run: (context: Context) => Promise<void>, options: Partial<HostBridgeOptions> = {}): Promise<void> => {
  const host = await startFakeHost();
  const tokens: string[] = [];
  const violations: RemoteBridgeViolation[] = [];
  const bridge = createHostBridge({
    port: host.port,
    env: {},
    issueToken: () => {
      const token = `loopback-token-${tokens.length + 1}`;
      tokens.push(token);
      return token;
    },
    onViolation: (violation) => violations.push(violation),
    evaluateHttp: syntheticPathPolicy,
    ...options,
  });
  const loop = createBridgedLoopback((stream, open) => bridge.handleStream(stream, open));
  try {
    await run({ host, bridge, loop, tokens, violations });
  } finally {
    bridge.closeAll();
    await host.close();
  }
};

const errorCode = (end: RemoteStreamEnd): string | undefined => (end.cause === 'error' ? end.code : undefined);

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

test('HTTP: the bridge authenticates with its own loopback token, fresh for every request', async () => {
  await withBridge(async ({ host, loop, tokens }) => {
    const first = await callThroughBridge(loop, { path: '/api/projects', headers: { accept: 'application/json' } });
    const second = await callThroughBridge(loop, { path: '/api/projects' });
    assert.equal(first.response?.status, 200);
    assert.deepEqual(JSON.parse(first.body.toString()), { projects: [{ name: 'demo' }] });
    assert.equal(second.response?.status, 200);

    assert.equal(host.requests.length, 2);
    assert.equal(host.requests[0].headers.authorization, 'Bearer loopback-token-1');
    assert.equal(host.requests[1].headers.authorization, 'Bearer loopback-token-2');
    assert.deepEqual(tokens, ['loopback-token-1', 'loopback-token-2']);
  });
});

test('HTTP: the Controller cannot override Authorization, x-api-key, Host or forward cookies/origin/forwarding headers', async () => {
  await withBridge(async ({ host, loop }) => {
    const outcome = await callThroughBridge(loop, {
      path: '/api/projects',
      headers: {
        Authorization: 'Bearer controller-chosen',
        'x-api-key': 'attacker-key',
        Host: 'evil.example',
        Cookie: 'sid=stolen',
        Origin: 'https://evil.example',
        Forwarded: 'for=1.2.3.4',
        'X-Forwarded-For': '1.2.3.4',
        'Sec-Fetch-Site': 'cross-site',
        'x-browser-use-mcp-token': 'mcp',
        'Proxy-Authorization': 'Basic abc',
        Connection: 'upgrade',
        Upgrade: 'websocket',
        Accept: 'application/json',
        'X-Request-Id': 'req-77',
      },
    });
    assert.equal(outcome.response?.status, 200);
    const received = host.requests[0].headers;
    assert.equal(received.authorization, 'Bearer loopback-token-1');
    assert.equal(received.host, `127.0.0.1:${host.port}`);
    for (const name of ['x-api-key', 'cookie', 'origin', 'forwarded', 'x-forwarded-for', 'sec-fetch-site', 'x-browser-use-mcp-token', 'proxy-authorization', 'upgrade']) {
      assert.equal(received[name], undefined, `${name} reached the Host`);
    }
    assert.equal(received.accept, 'application/json');
    assert.equal(received['x-request-id'], 'req-77');
  });
});

test('HTTP: the query `token` key is dropped before the Host is called, the other keys and the path case are kept', async () => {
  await withBridge(async ({ host, loop }) => {
    await callThroughBridge(loop, { path: '/api/projects/echo?a=1&token=TABTOKEN&Token=X&tok%65n=Y&b=%C3%A1' });
    await callThroughBridge(loop, { path: '/API/Projects/Echo/?token=TABTOKEN' });
    assert.equal(host.requests[0].url, '/api/projects/echo?a=1&b=%C3%A1');
    assert.equal(host.requests[1].url, '/API/Projects/Echo');
    for (const request of host.requests) assert.ok(!request.url.includes('TABTOKEN'));
  });
});

test('HTTP: the path is forwarded canonical and keeps its case (Report.PDF reaches the Host as Report.PDF)', async () => {
  await withBridge(async ({ host, loop }) => {
    const outcome = await callThroughBridge(loop, { path: '/api//assets/./files/Report%20Final.PDF' });
    assert.equal(host.requests[0].url, '/api/assets/files/Report%20Final.PDF');
    assert.equal(outcome.response?.status, 200);
    // Host content is untrusted in the Controller origin: sandboxed, no sniffing, Host's own disposition kept.
    assert.equal(outcome.response?.headers['content-security-policy'], "sandbox; default-src 'none'");
    assert.equal(outcome.response?.headers['x-content-type-options'], 'nosniff');
    assert.equal(outcome.response?.headers['content-disposition'], 'inline; filename="Report Final.PDF"');
  });
});

test('HTTP: SSRF attempts and hostile targets never produce a request to the Host (and are reported)', async () => {
  await withBridge(async ({ host, loop, violations }) => {
    const targets = [
      '//evil.com/api/projects',
      '//evil',
      '/api/%2e%2e/auth',
      '/api/%252e%252e/auth',
      '/api/auth/login',
      '/api/%61uth/login',
      '/api//auth/login',
      '/api/projects/../auth/login',
      '/api/projects;x=1',
      '/api/%2fauth',
      '/api/%5cauth',
      '/api/%00',
      '/api/projects.',
      '/api/settings/api-keys',
      '/health',
      '/',
      '/index.html',
      `/api/${'a'.repeat(5000)}`,
    ];
    for (const path of targets) {
      const outcome = await callThroughBridge(loop, { method: path.includes('login') ? 'POST' : 'GET', path, body: path.includes('login') ? ['{}'] : [] });
      assert.equal(errorCode(outcome.end), 'REMOTE_FORBIDDEN', path);
      assert.equal(outcome.response, undefined, `${path} produced a response head`);
    }
    assert.equal(host.requests.length, 0, 'the Host must not have been called at all');
    assert.equal(host.connections, 0);
    assert.equal(violations.length, targets.length);
    assert.ok(violations.every((violation) => violation.kind === 'http-request'));
  });
});

test('HTTP: targets the mux codec would not even carry are refused by the bridge too', async () => {
  await withBridge(async ({ host, bridge, violations }) => {
    for (const path of ['http://127.0.0.1:1/api/projects', 'https://evil.com/api', 'api/projects', '', '*', '\\\\evil\\share']) {
      const stream = createStreamStub('http');
      bridge.handleStream(stream, { kind: 'http', meta: { method: 'GET', path, headers: {} } });
      assert.equal(stream.failure?.code, 'REMOTE_FORBIDDEN', JSON.stringify(path));
    }
    assert.equal(host.requests.length, 0);
    assert.equal(violations.length, 6);
  });
});

test('HTTP: a 100 KB JSON body reaches the Host intact', async () => {
  await withBridge(async ({ host, loop }) => {
    const body = patternBytes(100 * 1024, 3);
    const outcome = await callThroughBridge(loop, {
      method: 'POST',
      path: '/api/projects/echo',
      headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
      body: [body.subarray(0, 30_000), body.subarray(30_000, 70_000), body.subarray(70_000)],
    });
    assert.equal(outcome.response?.status, 200);
    const echoed = JSON.parse(outcome.body.toString()) as { length: number; sha256: string; headers: Record<string, string> };
    assert.equal(echoed.length, body.length);
    assert.equal(echoed.sha256, sha256(body));
    assert.equal(echoed.headers['content-length'], String(body.length));
    assert.equal(echoed.headers['content-type'], 'application/json');
    assert.equal(host.requests[0].headers.authorization, 'Bearer loopback-token-1');
  });
});

test('HTTP: Server-Sent Events pass through with their own content type (no sandbox headers)', async () => {
  await withBridge(async ({ loop }) => {
    const outcome = await callThroughBridge(loop, { path: '/api/projects/sse', headers: { accept: 'text/event-stream' } });
    assert.equal(outcome.response?.status, 200);
    assert.equal(outcome.response?.headers['content-type'], 'text/event-stream');
    assert.equal(outcome.response?.headers['content-security-policy'], undefined);
    assert.equal(outcome.response?.headers['cache-control'], 'no-store');
    assert.equal(outcome.response?.headers.connection, undefined);
    const text = outcome.body.toString();
    for (const n of [1, 2, 3]) assert.ok(text.includes(`data: event-${n}\n\n`), text);
    assert.equal(outcome.end.cause, 'completed');
  });
});

test('HTTP: a 3 MiB download arrives intact with its Content-Length', async () => {
  await withBridge(async ({ loop }) => {
    const total = 3 * 1024 * 1024;
    const outcome = await callThroughBridge(loop, { path: `/api/projects/big?bytes=${total}` }, 30_000);
    assert.equal(outcome.response?.headers['content-length'], String(total));
    assert.equal(outcome.body.length, total);
    assert.equal(sha256(outcome.body), sha256(patternBytes(total, 7)));
    assert.equal(outcome.response?.headers['x-content-type-options'], 'nosniff');
  });
});

test('HTTP: only allow-listed response headers reach the Controller; the Host auth/cookie/redirect/CSP headers do not (AC-26)', async () => {
  await withBridge(async ({ loop }) => {
    const outcome = await callThroughBridge(loop, { path: '/api/projects/status/200' });
    assert.equal(outcome.response?.status, 200);
    const names = Object.keys(outcome.response?.headers ?? {}).sort();
    // The Host's headers on the allow-list, plus the nosniff the bridge forces on every response (JSON included).
    assert.deepEqual(names, ['cache-control', 'content-length', 'content-type', 'etag', 'x-content-type-options', 'x-request-id']);
    assert.equal(outcome.response?.headers['cache-control'], 'no-store');
    const serialized = JSON.stringify(outcome.response);
    for (const leaked of ['eyJhbGciOi', 'session-expired', 'sid=abc', 'evil.example', 'unsafe-inline', 'Express']) {
      assert.ok(!serialized.includes(leaked), `${leaked} leaked`);
    }
  });
});

test('HTTP: a Host 401 or 403 becomes REMOTE_UPSTREAM_AUTH (502) with no response head, so no X-Auth-Error ever reaches the tab (AC-26)', async () => {
  await withBridge(async ({ loop }) => {
    for (const status of [401, 403]) {
      const outcome = await callThroughBridge(loop, { path: `/api/projects/status/${status}` });
      assert.equal(errorCode(outcome.end), 'REMOTE_UPSTREAM_AUTH', String(status));
      assert.equal(outcome.response, undefined);
      assert.equal(outcome.body.length, 0);
    }
  });
});

test('HTTP: other statuses pass through unchanged (404, 500, 204 without body)', async () => {
  await withBridge(async ({ loop }) => {
    assert.equal((await callThroughBridge(loop, { path: '/api/projects/nothing-here' })).response?.status, 404);
    assert.equal((await callThroughBridge(loop, { path: '/api/projects/status/500' })).response?.status, 500);
    const empty = await callThroughBridge(loop, { path: '/api/projects/empty' });
    assert.equal(empty.response?.status, 204);
    assert.equal(empty.body.length, 0);
    assert.equal(empty.end.cause, 'completed');
  });
});

test('HTTP: a Host that dies mid-body ends the stream with an error instead of a clean end', async () => {
  await withBridge(async ({ loop }) => {
    const outcome = await callThroughBridge(loop, { path: '/api/projects/break' });
    assert.equal(outcome.end.cause, 'error');
    assert.equal(errorCode(outcome.end), 'REMOTE_INTERNAL');
  });
});

test('HTTP: 20 concurrent requests each get their own token and the bridge ends with no open streams', async () => {
  await withBridge(async ({ host, bridge, loop, tokens }) => {
    const outcomes = await Promise.all(Array.from({ length: 20 }, (_, i) => callThroughBridge(loop, { path: `/api/projects/echo?i=${i}` })));
    assert.ok(outcomes.every((outcome) => outcome.response?.status === 200));
    assert.equal(new Set(tokens).size, 20);
    assert.equal(new Set(host.requests.map((request) => request.headers.authorization)).size, 20);
    await waitFor(() => bridge.activeStreams === 0, 'the bridge to release every stream');
  });
});

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

test('WS: /ws upgrades with a fresh loopback token, no ?token, no cookies/origin and no subprotocol; messages flow both ways in order', async () => {
  await withBridge(async ({ host, loop, tokens }) => {
    const call = startWsCall(loop, '/ws?token=TABTOKEN', ['cloudcli-tab', 'TABTOKEN']);
    for (let i = 0; i < 20; i += 1) call.stream.sendMessage(Buffer.from(JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: `s${i}` }] })), false);
    await call.waitForMessages(20);

    assert.equal(host.upgrades.length, 1);
    assert.equal(host.upgrades[0].url, '/ws', 'path only: query dropped');
    assert.equal(host.upgrades[0].headers.authorization, `Bearer ${tokens[0]}`);
    assert.equal(host.upgrades[0].headers.host, `127.0.0.1:${host.port}`);
    assert.equal(host.upgrades[0].headers['sec-websocket-protocol'], undefined, 'the tab token travels in the subprotocol: it must never be forwarded');
    for (const name of ['cookie', 'origin', 'x-api-key']) assert.equal(host.upgrades[0].headers[name], undefined);
    assert.ok(!JSON.stringify(host.upgrades[0]).includes('TABTOKEN'));

    const echoed = call.messages.map((message) => (JSON.parse(message.payload.toString()) as { sessions: Array<{ sessionId: string }> }).sessions[0].sessionId);
    assert.deepEqual(echoed, Array.from({ length: 20 }, (_, i) => `s${i}`));
    assert.ok(call.messages.every((message) => !message.binary));
    call.stream.closeWebSocket(1000, 'done');
  });
});

test('WS: every WebSocket gets its own token', async () => {
  await withBridge(async ({ host, loop, tokens }) => {
    const calls = [startWsCall(loop, '/ws'), startWsCall(loop, '/shell'), startWsCall(loop, '/ws')];
    await waitFor(() => host.upgrades.length === 3, 'three upgrades');
    assert.deepEqual(new Set(host.upgrades.map((upgrade) => upgrade.headers.authorization)).size, 3);
    assert.equal(tokens.length, 3);
    for (const call of calls) call.stream.closeWebSocket(1000, 'done');
  });
});

test('WS: allowed messages are forwarded byte for byte, binary and text from the Host come back with their frame type', async () => {
  await withBridge(async ({ host, loop }) => {
    const call = startWsCall(loop, '/ws');
    const exact = [
      '{ "type" : "chat.send",\n  "sessionId":"s-é\u{1F600}", "content": "x  y" }',
      '{"type":"chat.edit-send","anchorId":"a","content":"c"}',
      '{"type":"chat.abort","sessionId":"s"}',
      '{"type":"chat.stop-task","sessionId":"s","taskId":"t"}',
      '{"type":"chat.subscribe","sessions":[{"sessionId":"s","lastSeq":4}]}',
    ];
    for (const text of exact) call.stream.sendMessage(Buffer.from(text), false);
    await waitFor(() => host.wsReceived.length === exact.length, 'the Host to receive every message');
    exact.forEach((text, index) => assert.equal(host.wsReceived[index].data.toString('utf8'), text));
    assert.ok(host.wsReceived.every((received) => !received.binary));

    // Host -> Controller: binary frames keep their type (the fake Host answers "burst" with binary messages).
    await call.waitForMessages(exact.length);
    call.messages.length = 0;
    call.stream.sendMessage(Buffer.from('{"type":"chat.subscribe","fake":"burst:3:1000"}'), false);
    await waitFor(() => host.wsReceived.length === exact.length + 1, 'burst request');
    await call.waitForMessages(3);
    assert.ok(call.messages.every((message) => message.binary && message.payload.length === 1000));
    call.stream.closeWebSocket(1000, 'done');
  });
});

test('WS: chat.permission-response loses rememberEntry on the way to the Host; its other fields are intact', async () => {
  await withBridge(async ({ host, loop }) => {
    const call = startWsCall(loop, '/ws');
    call.stream.sendMessage(
      Buffer.from(JSON.stringify({ type: 'chat.permission-response', requestId: 'r-1', allow: true, updatedInput: { answers: { Other: 'Chọn phương án B' } }, message: 'ok', rememberEntry: 'Bash' })),
      false,
    );
    await waitFor(() => host.wsReceived.length === 1, 'the Host to receive the response');
    assert.deepEqual(JSON.parse(host.wsReceived[0].data.toString('utf8')), {
      type: 'chat.permission-response',
      requestId: 'r-1',
      allow: true,
      updatedInput: { answers: { Other: 'Chọn phương án B' } },
      message: 'ok',
    });
    call.stream.closeWebSocket(1000, 'done');
  });
});

test('WS: a message type outside the list closes the stream with 4403, is reported, and never reaches the Host socket', async () => {
  await withBridge(async ({ host, loop, violations }) => {
    const cases: Array<[string, string | Buffer, boolean]> = [
      ['/ws', '{"type":"chat.unknown"}', false],
      ['/ws', '{"type":"init"}', false],
      ['/shell', '{"type":"chat.send"}', false],
      ['/ws', 'not json', false],
      ['/ws', '[1,2]', false],
      ['/ws', Buffer.from('{"type":"chat.send"}'), true],
      ['/shell', Buffer.from([1, 2, 3]), true],
    ];
    for (const [path, payload, binary] of cases) {
      const call = startWsCall(loop, path);
      call.stream.sendMessage(Buffer.from(payload), binary);
      const end = await call.waitForEnd();
      assert.deepEqual(end.cause === 'peer-ws-close' && end.code, 4403, `${path} ${String(payload).slice(0, 20)}`);
    }
    assert.equal(host.wsReceived.length, 0, 'a refused message must not reach the Host');
    assert.equal(violations.length, cases.length);
    assert.ok(violations.every((violation) => violation.kind === 'websocket-message'));
    await waitFor(() => host.wsConnections.every((socket) => socket.readyState === socket.CLOSED || socket.readyState === socket.CLOSING), 'loopback sockets to close');
  });
});

test('WS: paths other than /ws and /shell are refused with 4403 before any upgrade', async () => {
  await withBridge(async ({ host, loop, violations }) => {
    for (const path of ['/plugin-ws/p', '/desktop-notifications', '/api/ws', '/WS', '/ws/extra', '//evil.com/ws', '/%2e%2e/ws', '/ws;x']) {
      const call = startWsCall(loop, path);
      const end = await call.waitForEnd();
      assert.equal(end.cause === 'peer-ws-close' && end.code, 4403, path);
    }
    assert.equal(host.upgrades.length, 0);
    assert.equal(violations.length, 8);
    assert.ok(violations.every((violation) => violation.kind === 'websocket-open'));
  });
});

test('WS: when the Host closes, the Controller stream closes with the Host code; an abrupt drop maps to 1011', async () => {
  await withBridge(async ({ host, loop }) => {
    const graceful = startWsCall(loop, '/ws');
    graceful.stream.sendMessage(Buffer.from('{"type":"chat.subscribe","sessions":[]}'), false);
    await graceful.waitForMessages(1);
    host.wsConnections[0].close(1001, 'going away');
    const end = await graceful.waitForEnd();
    assert.deepEqual(end.cause === 'peer-ws-close' && [end.code, end.reason], [1001, 'going away']);

    const abrupt = startWsCall(loop, '/shell');
    abrupt.stream.sendMessage(Buffer.from('{"type":"resize","cols":80,"rows":24}'), false);
    await abrupt.waitForMessages(1);
    host.wsConnections[1].terminate();
    const abruptEnd = await abrupt.waitForEnd();
    assert.equal(abruptEnd.cause === 'peer-ws-close' && abruptEnd.code, 1011);
  });
});

test('WS: when the Controller closes the stream, the loopback socket is closed', async () => {
  await withBridge(async ({ host, bridge, loop }) => {
    const call = startWsCall(loop, '/ws');
    await waitFor(() => host.wsConnections.length === 1, 'the upgrade');
    call.stream.closeWebSocket(1000, 'tab closed');
    await waitFor(() => host.wsConnections[0].readyState === host.wsConnections[0].CLOSED, 'the loopback socket to close');
    await waitFor(() => bridge.activeStreams === 0, 'the bridge to release the stream');
  });
});

test('WS: a Host that refuses the upgrade with 401/403 is REMOTE_UPSTREAM_AUTH; other refusals are REMOTE_INTERNAL', async () => {
  await withBridge(async ({ host, loop }) => {
    for (const [status, code] of [[401, 'REMOTE_UPSTREAM_AUTH'], [403, 'REMOTE_UPSTREAM_AUTH'], [500, 'REMOTE_INTERNAL']] as const) {
      host.rejectUpgradeWith = status;
      const call = startWsCall(loop, '/ws');
      const end = await call.waitForEnd();
      assert.equal(errorCode(end), code, String(status));
    }
  });
});

// ---------------------------------------------------------------------------
// Host API_KEY, unsupported mode, reports
// ---------------------------------------------------------------------------

test('API_KEY of the Host is attached as x-api-key (HTTP and WebSocket) and replaces anything the Controller sent', async () => {
  await withBridge(
    async ({ host, loop }) => {
      await callThroughBridge(loop, { path: '/api/projects', headers: { 'x-api-key': 'attacker' } });
      const call = startWsCall(loop, '/ws');
      await waitFor(() => host.upgrades.length === 1, 'the upgrade');
      assert.equal(host.requests[0].headers['x-api-key'], 'host-key');
      assert.equal(host.upgrades[0].headers['x-api-key'], 'host-key');
      call.stream.closeWebSocket(1000, 'done');
    },
    { env: { API_KEY: 'host-key' } },
  );
});

test('without an API_KEY no x-api-key is sent, even if the Controller supplied one', async () => {
  await withBridge(async ({ host, loop }) => {
    await callThroughBridge(loop, { path: '/api/projects', headers: { 'x-api-key': 'attacker' } });
    assert.equal(host.requests[0].headers['x-api-key'], undefined);
  });
});

test('platform mode: every stream is refused with REMOTE_UNSUPPORTED_MODE and the Host is never called', async () => {
  await withBridge(
    async ({ host, loop }) => {
      const http = await callThroughBridge(loop, { path: '/api/projects' });
      assert.equal(errorCode(http.end), 'REMOTE_UNSUPPORTED_MODE');
      const ws = startWsCall(loop, '/ws');
      assert.equal(errorCode(await ws.waitForEnd()), 'REMOTE_UNSUPPORTED_MODE');
      assert.equal(host.requests.length + host.upgrades.length, 0);
    },
    { env: { VITE_IS_PLATFORM: 'true' } },
  );
});

test('a failing token source is REMOTE_INTERNAL for HTTP and WebSocket and nothing is sent to the Host', async () => {
  await withBridge(
    async ({ host, loop }) => {
      assert.equal(errorCode((await callThroughBridge(loop, { path: '/api/projects' })).end), 'REMOTE_INTERNAL');
      assert.equal(errorCode(await startWsCall(loop, '/ws').waitForEnd()), 'REMOTE_INTERNAL');
      assert.equal(host.requests.length + host.upgrades.length, 0);
    },
    {
      issueToken: () => {
        throw new Error('Cannot issue a loopback token: no user exists yet');
      },
    },
  );
});

test('violation reports carry the reason and a short path only: no query, no token, no message content, no headers', async () => {
  await withBridge(async ({ loop, violations }) => {
    await callThroughBridge(loop, { path: '/api/auth/login?token=SECRET-QUERY&x=1', headers: { cookie: 'SECRET-COOKIE' }, method: 'POST', body: ['{"password":"SECRET-BODY"}'] });
    await callThroughBridge(loop, { path: `/api/${'z'.repeat(3000)}/nothing` });
    const call = startWsCall(loop, '/ws');
    call.stream.sendMessage(Buffer.from('{"type":"evil","secret":"SECRET-MESSAGE"}'), false);
    await call.waitForEnd();
    const text = JSON.stringify(violations);
    for (const secret of ['SECRET-QUERY', 'SECRET-COOKIE', 'SECRET-BODY', 'SECRET-MESSAGE']) assert.ok(!text.includes(secret), secret);
    assert.deepEqual(violations[0], { kind: 'http-request', reason: 'route-denied', method: 'POST', target: '/api/auth/login' });
    assert.ok(violations[1].target && violations[1].target.length <= 200);
    assert.deepEqual(violations[2], { kind: 'websocket-message', reason: 'type-not-allowed', target: '/ws' });
  });
});

test('a violation reporter that throws does not break the bridge', async () => {
  await withBridge(
    async ({ loop }) => {
      const outcome = await callThroughBridge(loop, { path: '/api/auth/login' });
      assert.equal(errorCode(outcome.end), 'REMOTE_FORBIDDEN');
      assert.equal((await callThroughBridge(loop, { path: '/api/projects' })).response?.status, 200);
    },
    {
      onViolation: () => {
        throw new Error('reporter exploded');
      },
    },
  );
});

test('startHttpCall without a body finishes the request (the Controller sends an empty chunk with fin)', async () => {
  await withBridge(async ({ loop }) => {
    const call = startHttpCall(loop, { path: '/api/projects' });
    const outcome = await call.done;
    assert.equal(outcome.response?.status, 200);
  });
});

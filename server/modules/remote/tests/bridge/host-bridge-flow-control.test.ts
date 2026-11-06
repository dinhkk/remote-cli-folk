/**
 * Controller -> Host direction with a slow or stuck Host. The mux has no receive-side flow control
 * toward the Controller, so the bridge bounds what it leaves unsent on the loopback socket
 * (`maxUpstreamBufferedBytes`) and cancels the stream with REMOTE_QUOTA past it; a Host that stops
 * reading an upload is also cut by the response-head timer, and a Controller cancel frees everything.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import type net from 'node:net';
import test from 'node:test';

import { WebSocketServer } from 'ws';

import type { RemoteMuxStream, RemoteStreamEnd } from '@/shared/types.js';

import { DEFAULT_HOST_BRIDGE_LIMITS } from '../../bridge/bridge-limits.js';
import { createHostBridge, type HostBridgeOptions } from '../../bridge/host-bridge.js';
import { createBridgedLoopback, startHttpCall, startWsCall } from '../support/bridge-test-harness.js';
import { sha256, patternBytes, startFakeHost, startSilentServer } from '../support/fake-loopback-host.js';
import { waitFor } from '../support/relay-link-rig.js';
import { syntheticPathPolicy } from '../support/synthetic-path-policy.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const errorCode = (end: RemoteStreamEnd): string | undefined => (end.cause === 'error' ? end.code : undefined);

const options = (port: number, extra: Partial<HostBridgeOptions> = {}): HostBridgeOptions => ({
  port,
  env: {},
  issueToken: () => 'loopback-token',
  evaluateHttp: syntheticPathPolicy,
  ...extra,
});

const MIB = 1024 * 1024;

/** Fails the test (instead of hanging the run) when `promise` does not settle in time. */
const within = async <T>(promise: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/** A server that is not reading cannot see the client hang up: drain it, then it must be gone. */
const expectLoopbackSocketReleased = async (silent: Awaited<ReturnType<typeof startSilentServer>>): Promise<void> => {
  silent.drain();
  await waitFor(() => silent.openConnections === 0, 'the loopback socket to be destroyed');
};

/**
 * Writes `totalBytes` of request body in 64 KiB chunks as a well-behaved Controller would: it yields
 * between chunks and waits while its own stream is paused, so only the loopback side can be the
 * bottleneck. Returns how many bytes were written before the stream closed.
 */
const pumpBody = async (stream: RemoteMuxStream, totalBytes: number, chunkBytes = 64 * 1024): Promise<number> => {
  const chunk = Buffer.alloc(chunkBytes, 0x61);
  let sent = 0;
  while (sent < totalBytes && !stream.closed) {
    const size = Math.min(chunkBytes, totalBytes - sent);
    stream.writeBody(size === chunkBytes ? chunk : chunk.subarray(0, size), sent + size >= totalBytes);
    sent += size;
    const deadline = Date.now() + 10_000;
    do {
      await new Promise((resolve) => setImmediate(resolve));
    } while (stream.paused && !stream.closed && Date.now() < deadline);
  }
  return sent;
};

test('a Host that stops reading a request body: the stream is cancelled with REMOTE_QUOTA and the loopback socket is released', async () => {
  const silent = await startSilentServer();
  const bridge = createHostBridge(options(silent.port, { limits: { maxUpstreamBufferedBytes: 256 * 1024 } }));
  const loop = createBridgedLoopback((stream, open) => bridge.handleStream(stream, open));
  try {
    const total = 20 * MIB;
    const call = startHttpCall(loop, { method: 'POST', path: '/api/projects/echo', headers: { 'content-length': String(total) }, body: [], fin: false });
    const sent = await pumpBody(call.stream, total);
    const outcome = await within(call.done, 20_000, 'the stream to end');
    assert.equal(errorCode(outcome.end), 'REMOTE_QUOTA');
    assert.equal(outcome.response, undefined);
    assert.ok(sent < total, `the whole ${total} bytes were accepted (${sent}): nothing bounded the backlog`);
    await waitFor(() => bridge.activeStreams === 0, 'the bridge to release the stream');
    await expectLoopbackSocketReleased(silent);
  } finally {
    bridge.closeAll();
    await silent.close();
  }
});

test('the backlog cap is configurable and the default is 8 MiB', async () => {
  const silent = await startSilentServer();
  // A cap larger than the whole upload: a stalled Host is never mistaken for a slow one, the upload is simply held.
  const bridge = createHostBridge(options(silent.port, { limits: { maxUpstreamBufferedBytes: 64 * MIB } }));
  const loop = createBridgedLoopback((stream, open) => bridge.handleStream(stream, open));
  try {
    const total = 4 * MIB;
    const call = startHttpCall(loop, { method: 'POST', path: '/api/projects/echo', headers: { 'content-length': String(total) }, body: [], fin: false });
    assert.equal(await pumpBody(call.stream, total), total);
    await sleep(100);
    assert.equal(call.stream.closed, false, 'under the cap nothing is cancelled');
    call.stream.cancel();
    await waitFor(() => bridge.activeStreams === 0, 'the bridge to release the stream');
  } finally {
    bridge.closeAll();
    await silent.close();
  }
});

test('Controller CANCEL while the Host is not reading frees the stream and the loopback socket', async () => {
  const silent = await startSilentServer();
  const bridge = createHostBridge(options(silent.port));
  const loop = createBridgedLoopback((stream, open) => bridge.handleStream(stream, open));
  try {
    const total = 6 * MIB;
    const call = startHttpCall(loop, { method: 'POST', path: '/api/projects/echo', headers: { 'content-length': String(total) }, body: [], fin: false });
    await pumpBody(call.stream, 2 * MIB);
    await waitFor(() => silent.openConnections === 1, 'the loopback connection');
    call.stream.cancel();
    await waitFor(() => bridge.activeStreams === 0, 'the bridge to release the stream');
    await expectLoopbackSocketReleased(silent);
  } finally {
    bridge.closeAll();
    await silent.close();
  }
});

test('a Host that never reads a fully sent upload is cut by the response-head timer (the clock starts at the last body byte)', async () => {
  const silent = await startSilentServer();
  const bridge = createHostBridge(options(silent.port, { limits: { responseHeadersMs: 250, maxUpstreamBufferedBytes: 64 * MIB } }));
  const loop = createBridgedLoopback((stream, open) => bridge.handleStream(stream, open));
  try {
    const total = 12 * MIB; // well past what the kernel buffers absorb, so the request never "finishes" on its own
    const call = startHttpCall(loop, { method: 'POST', path: '/api/projects/echo', headers: { 'content-length': String(total) }, body: [], fin: false });
    assert.equal(await pumpBody(call.stream, total), total);
    const outcome = await within(call.done, 20_000, 'the stream to end');
    assert.equal(errorCode(outcome.end), 'REMOTE_INTERNAL');
    await waitFor(() => bridge.activeStreams === 0, 'the bridge to release the stream');
    await expectLoopbackSocketReleased(silent);
  } finally {
    bridge.closeAll();
    await silent.close();
  }
});

test('the documented defaults: response head 10 minutes (raise it for long git operations), backlog cap 8 MiB', () => {
  assert.equal(DEFAULT_HOST_BRIDGE_LIMITS.responseHeadersMs, 10 * 60 * 1000);
  assert.equal(DEFAULT_HOST_BRIDGE_LIMITS.maxUpstreamBufferedBytes, 8 * MIB);
});

test('a Host that answers after a long wait is served when responseHeadersMs is raised above the default wait', async () => {
  const host = await startFakeHost();
  // The limit is read from the options of each bridge: this one waits far longer than the 60 ms the Host takes.
  const bridge = createHostBridge(options(host.port, { limits: { responseHeadersMs: 3_600_000 } }));
  const loop = createBridgedLoopback((stream, open) => bridge.handleStream(stream, open));
  try {
    const call = startHttpCall(loop, { path: '/api/projects/sse' });
    const outcome = await within(call.done, 20_000, 'the stream to end');
    assert.equal(outcome.response?.status, 200);
    assert.equal(outcome.body.toString().split('\n\n').filter(Boolean).length, 3);
  } finally {
    bridge.closeAll();
    await host.close();
  }
});

test('a fast 16 MiB upload to a healthy Host is never mistaken for a stalled one (default cap)', async () => {
  const host = await startFakeHost();
  const bridge = createHostBridge(options(host.port));
  const loop = createBridgedLoopback((stream, open) => bridge.handleStream(stream, open));
  try {
    const total = 16 * MIB;
    const body = patternBytes(total, 5);
    const call = startHttpCall(loop, { method: 'POST', path: '/api/projects/echo', headers: { 'content-length': String(total) }, body: [], fin: false });
    for (let offset = 0; offset < total; offset += 64 * 1024) {
      call.stream.writeBody(body.subarray(offset, offset + 64 * 1024), offset + 64 * 1024 >= total);
      await new Promise((resolve) => setImmediate(resolve));
      while (call.stream.paused) await sleep(1);
    }
    const outcome = await within(call.done, 20_000, 'the stream to end');
    assert.equal(outcome.response?.status, 200);
    assert.equal(host.requests[0].body.length, total);
    assert.equal(sha256(host.requests[0].body), sha256(body));
  } finally {
    bridge.closeAll();
    await host.close();
  }
});

// ---------------------------------------------------------------------------
// WebSocket: the Host handler stops reading
// ---------------------------------------------------------------------------

/** A WebSocket Host that accepts the upgrade and then stops reading the socket (a stuck handler). */
const startStuckWebSocketHost = async (): Promise<{ port: number; close(): Promise<void> }> => {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => {
    (socket as unknown as { _socket: net.Socket })._socket.pause();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

const chatMessage = (bytes: number): Buffer => Buffer.from(JSON.stringify({ type: 'chat.send', content: 'x'.repeat(bytes) }));

test('a WebSocket Host that stops reading: the stream is cancelled with REMOTE_QUOTA past the cap', async () => {
  const stuck = await startStuckWebSocketHost();
  const bridge = createHostBridge(options(stuck.port, { limits: { maxUpstreamBufferedBytes: 512 * 1024 } }));
  const loop = createBridgedLoopback((stream, open) => bridge.handleStream(stream, open));
  try {
    const call = startWsCall(loop, '/ws');
    await waitFor(() => bridge.activeStreams === 1, 'the stream');
    await sleep(50); // let the loopback upgrade finish: messages sent earlier take the bounded pending path instead
    const message = chatMessage(200 * 1024);
    let sent = 0;
    for (; sent < 400 && !call.stream.closed; sent += 1) {
      call.stream.sendMessage(message, false);
      await new Promise((resolve) => setImmediate(resolve));
      while (call.stream.paused && !call.stream.closed) await sleep(1);
    }
    assert.equal(errorCode(await call.waitForEnd()), 'REMOTE_QUOTA');
    assert.ok(sent < 400, 'the backlog was never bounded');
    await waitFor(() => bridge.activeStreams === 0, 'the bridge to release the stream');
  } finally {
    bridge.closeAll();
    await stuck.close();
  }
});

test('a WebSocket Host that keeps up never trips the backlog cap, even under a fast flood of large messages', async () => {
  const host = await startFakeHost();
  const bridge = createHostBridge(options(host.port));
  const loop = createBridgedLoopback((stream, open) => bridge.handleStream(stream, open));
  try {
    const call = startWsCall(loop, '/ws');
    await waitFor(() => host.wsConnections.length === 1, 'the upgrade');
    const message = chatMessage(200 * 1024);
    for (let i = 0; i < 40; i += 1) {
      call.stream.sendMessage(message, false);
      await new Promise((resolve) => setImmediate(resolve));
      while (call.stream.paused) await sleep(1);
    }
    await waitFor(() => host.wsReceived.length === 40, 'every message at the Host');
    assert.equal(call.stream.closed, false);
    call.stream.closeWebSocket(1000, 'done');
  } finally {
    bridge.closeAll();
    await host.close();
  }
});

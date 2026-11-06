import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import type { RemoteMuxFrame, RemoteMuxStream, RemoteStreamEnd } from '@/shared/types.js';

import { MAX_BODY_CHUNK_BYTES, MAX_WS_MESSAGE_BYTES, MuxFrameError, encodeFrame } from '../../mux/frames.js';
import { createMuxLoopback, tick, type LoopbackSide } from '../support/mux-loopback.js';
import { createFlowControl, framesOfType, rawFrame } from '../support/mux-test-helpers.js';

const EMPTY = Buffer.alloc(0);
const GET = { kind: 'http', meta: { method: 'GET', path: '/api/ping', headers: {} } } as const;
const WS = { kind: 'ws', meta: { path: '/ws' } } as const;

/** Collects what a stream reports. */
const recorder = () => {
  const record = {
    status: undefined as number | undefined,
    chunks: [] as Buffer[],
    fin: false,
    messages: [] as Array<{ payload: string; binary: boolean }>,
    end: undefined as RemoteStreamEnd | undefined,
    ends: 0,
  };
  const handlers = {
    onResponse: (meta: { status: number }) => {
      record.status = meta.status;
    },
    onBody: (chunk: Buffer, fin: boolean) => {
      record.chunks.push(chunk);
      record.fin = record.fin || fin;
    },
    onMessage: (payload: Buffer, binary: boolean) => {
      record.messages.push({ payload: payload.toString('latin1'), binary });
    },
    onClosed: (end: RemoteStreamEnd) => {
      record.end = end;
      record.ends += 1;
    },
  };
  return { record, handlers };
};

const bodyText = (chunks: Buffer[]) => Buffer.concat(chunks).toString();

/** Makes a side answer every incoming HTTP request with `status` and `text` once its body ended. */
const serveText = (side: LoopbackSide, status: number, text: string) => {
  side.handleIncoming = (stream) => {
    stream.setHandlers({
      onBody: (_chunk, fin) => {
        if (!fin) return;
        stream.sendResponse({ status, headers: { 'content-type': 'text/plain' } });
        stream.writeBody(Buffer.from(text), true);
      },
    });
  };
};

const expectNoLeaks = (...sides: LoopbackSide[]) => {
  for (const side of sides) {
    assert.equal(side.table.size, 0, `${side.role} stream table`);
    assert.equal(side.table.pendingFrames, 0, `${side.role} send queue`);
  }
};

test('an HTTP exchange completes on both sides and leaves nothing behind', async () => {
  const { controller, host } = createMuxLoopback();
  serveText(host, 200, 'hello');
  const { record, handlers } = recorder();
  const stream = controller.table.openStream(GET, handlers);
  stream.writeBody(EMPTY, true);
  await tick();

  assert.equal(stream.id % 2, 1, 'Controller streams use odd ids');
  assert.equal(record.status, 200);
  assert.equal(bodyText(record.chunks), 'hello');
  assert.deepEqual(record.end, { cause: 'completed' });
  assert.equal(host.incoming.length, 1);
  assert.deepEqual(host.incoming[0].open, GET);
  expectNoLeaks(controller, host);
});

test('three streams interleave their chunks instead of one monopolizing the link', async () => {
  const loop = createMuxLoopback({ gated: true });
  const received = new Map<number, Buffer[]>();
  loop.host.handleIncoming = (stream) => {
    received.set(stream.id, []);
    stream.setHandlers({ onBody: (chunk) => received.get(stream.id)?.push(chunk) });
  };
  const payloads = new Map<number, Buffer>();
  const streams: RemoteMuxStream[] = [];
  for (let i = 0; i < 3; i += 1) streams.push(loop.controller.table.openStream({ kind: 'http', meta: { method: 'POST', path: '/up', headers: {} } }, {}));
  for (const stream of streams) {
    const payload = crypto.randomBytes(3 * MAX_BODY_CHUNK_BYTES);
    payloads.set(stream.id, payload);
    stream.writeBody(payload, true);
  }
  await loop.open('toHost');
  await tick();

  const bulk = framesOfType(loop.controller.transmitted, 'REQ_BODY').map((frame) => frame.streamId);
  assert.equal(bulk.length, 9);
  for (let i = 0; i + 2 < bulk.length; i += 1) {
    assert.equal(new Set(bulk.slice(i, i + 3)).size, 3, `chunks ${i}..${i + 2} came from ${bulk.slice(i, i + 3)}`);
  }
  for (const stream of streams) {
    assert.ok(Buffer.concat(received.get(stream.id) ?? []).equals(payloads.get(stream.id) as Buffer), `stream ${stream.id} body`);
  }
});

test('a 25 MiB upload arrives intact in chunks of at most 64 KiB, with the sender pacing itself', async () => {
  const loop = createMuxLoopback();
  const size = 25 * 1024 * 1024;
  const data = crypto.randomBytes(size);
  const hash = crypto.createHash('sha256');
  let received = 0;
  let largest = 0;
  let chunks = 0;
  let finSeen = false;
  loop.host.handleIncoming = (stream) => {
    stream.setHandlers({
      onBody: (chunk, fin) => {
        hash.update(chunk);
        received += chunk.length;
        largest = Math.max(largest, chunk.length);
        chunks += 1;
        finSeen = finSeen || fin;
        if (fin) {
          stream.sendResponse({ status: 200, headers: {} });
          stream.writeBody(EMPTY, true);
        }
      },
    });
  };
  const flow = createFlowControl();
  let stream: RemoteMuxStream | undefined;
  const { record, handlers } = recorder();
  stream = loop.controller.table.openStream(
    { kind: 'http', meta: { method: 'PUT', path: '/api/upload', headers: {} } },
    { ...handlers, ...flow.handlers(() => stream), onClosed: handlers.onClosed },
  );
  const slice = 1024 * 1024;
  for (let offset = 0; offset < size; offset += slice) {
    stream.writeBody(data.subarray(offset, offset + slice), offset + slice >= size);
    await flow.untilWritable(stream);
  }
  await tick();

  assert.equal(received, size);
  assert.ok(finSeen);
  assert.ok(largest <= MAX_BODY_CHUNK_BYTES, `largest chunk ${largest}`);
  assert.ok(chunks >= size / MAX_BODY_CHUNK_BYTES);
  assert.equal(hash.digest('hex'), crypto.createHash('sha256').update(data).digest('hex'));
  assert.equal(record.status, 200);
  assert.deepEqual(record.end, { cause: 'completed' });
  expectNoLeaks(loop.controller, loop.host);
});

test('a request body over the receiver limit is refused with REMOTE_TOO_LARGE on both ends', async () => {
  const loop = createMuxLoopback({ hostLimits: { maxRequestBodyBytes: 1024 * 1024 } });
  const hostSide = recorder();
  loop.host.handleIncoming = (stream) => stream.setHandlers(hostSide.handlers);
  const { record, handlers } = recorder();
  const stream = loop.controller.table.openStream({ kind: 'http', meta: { method: 'POST', path: '/up', headers: {} } }, handlers);
  const chunk = Buffer.alloc(MAX_BODY_CHUNK_BYTES, 1);
  for (let i = 0; i < 32; i += 1) {
    stream.writeBody(chunk, i === 31);
    await tick();
  }

  assert.deepEqual(record.end, { cause: 'error', origin: 'peer', code: 'REMOTE_TOO_LARGE', message: record.end && 'message' in record.end ? record.end.message : '' });
  assert.equal(hostSide.record.end?.cause, 'error');
  assert.equal(hostSide.record.end?.cause === 'error' && hostSide.record.end.origin, 'local');
  assert.equal(hostSide.record.end?.cause === 'error' && hostSide.record.end.code, 'REMOTE_TOO_LARGE');
  const delivered = hostSide.record.chunks.reduce((sum, c) => sum + c.length, 0);
  assert.ok(delivered <= 1024 * 1024, `delivered ${delivered}`);
  assert.equal(stream.writeBody(chunk), false, 'writes after the stream closed are ignored');
  expectNoLeaks(loop.controller, loop.host);
});

test('a body exactly at the limit is accepted', async () => {
  const loop = createMuxLoopback({ hostLimits: { maxRequestBodyBytes: 3 * MAX_BODY_CHUNK_BYTES } });
  serveText(loop.host, 204, '');
  const { record, handlers } = recorder();
  const stream = loop.controller.table.openStream({ kind: 'http', meta: { method: 'POST', path: '/up', headers: {} } }, handlers);
  stream.writeBody(Buffer.alloc(3 * MAX_BODY_CHUNK_BYTES), true);
  await tick();
  assert.equal(record.status, 204);
  assert.deepEqual(record.end, { cause: 'completed' });
});

test('cancelling mid-upload frees the queue, stops the data and tells the peer', async () => {
  const loop = createMuxLoopback({ gated: true });
  const hostSide = recorder();
  loop.host.handleIncoming = (stream) => stream.setHandlers(hostSide.handlers);
  const { record, handlers } = recorder();
  const stream = loop.controller.table.openStream({ kind: 'http', meta: { method: 'POST', path: '/up', headers: {} } }, handlers);
  stream.writeBody(Buffer.alloc(2 * 1024 * 1024), false);
  assert.ok(stream.queuedBytes > 1024 * 1024);

  stream.cancel();
  assert.equal(stream.closed, true);
  assert.equal(stream.queuedBytes, 0);
  assert.deepEqual(record.end, { cause: 'local-cancel' });
  assert.equal(loop.controller.table.size, 0);
  assert.ok(loop.controller.table.pendingFrames <= 1, 'only the CANCEL frame is left to send');

  await loop.open('toHost');
  await tick();
  assert.deepEqual(hostSide.record.end, { cause: 'peer-cancel' });
  assert.ok(hostSide.record.chunks.length <= 1, 'at most the chunk already in flight arrived');
  assert.equal(framesOfType(loop.controller.transmitted, 'CANCEL').length, 1);
  stream.cancel(); // idempotent
  assert.equal(record.ends, 1);
  expectNoLeaks(loop.controller, loop.host);
});

test('a stream whose queue passes 8 MiB is closed with 1013 and the close is not a violation', async () => {
  const loop = createMuxLoopback({ gated: true });
  const hostSide = recorder();
  loop.host.handleIncoming = (stream) => stream.setHandlers(hostSide.handlers);
  const flow = createFlowControl();
  let stream: RemoteMuxStream | undefined;
  const { record, handlers } = recorder();
  stream = loop.controller.table.openStream(WS, { ...handlers, ...flow.handlers(() => stream), onClosed: handlers.onClosed });
  const message = Buffer.alloc(4096, 5);
  let maxQueued = 0;
  // A source that ignores backpressure: it keeps writing after the pause signal.
  for (let i = 0; i < 4000 && !stream.closed; i += 1) {
    stream.sendMessage(message, true);
    maxQueued = Math.max(maxQueued, stream.queuedBytes);
  }

  assert.equal(stream.closed, true);
  assert.deepEqual(record.end, { cause: 'queue-overflow' });
  assert.equal(flow.counters.pauses, 1, 'the pause signal fired once, before the overflow');
  assert.ok(flow.counters.queuedAtPause[0] >= 4 * 1024 * 1024);
  assert.ok(maxQueued <= 8 * 1024 * 1024 + 8192, `queue peaked at ${maxQueued}`);
  assert.equal(stream.queuedBytes, 0);

  await loop.open('toHost');
  await tick();
  assert.deepEqual(hostSide.record.end, { cause: 'peer-ws-close', code: 1013, reason: hostSide.record.end && 'reason' in hostSide.record.end ? hostSide.record.end.reason : '' });
  expectNoLeaks(loop.controller, loop.host);
});

test('an HTTP stream that overflows is failed with an ERROR instead of a WS close', async () => {
  const loop = createMuxLoopback({ gated: true, controllerLimits: { maxQueuedBytes: 256 * 1024, pauseHighWaterBytes: 128 * 1024, resumeLowWaterBytes: 32 * 1024 } });
  const hostSide = recorder();
  loop.host.handleIncoming = (stream) => stream.setHandlers(hostSide.handlers);
  const { record, handlers } = recorder();
  const stream = loop.controller.table.openStream({ kind: 'http', meta: { method: 'POST', path: '/up', headers: {} } }, handlers);
  stream.writeBody(Buffer.alloc(1024 * 1024), false);
  assert.deepEqual(record.end, { cause: 'queue-overflow' });
  await loop.open('toHost');
  await tick();
  assert.equal(hostSide.record.end?.cause, 'error');
  assert.equal(hostSide.record.end?.cause === 'error' && hostSide.record.end.code, 'REMOTE_INTERNAL');
});

test('a failing stream of the peer does not disturb the other streams of this side', async () => {
  const loop = createMuxLoopback();
  const first = recorder();
  const second = recorder();
  loop.host.handleIncoming = (stream) => {
    if (stream.id === 1) {
      stream.fail('REMOTE_FORBIDDEN', 'not allowed');
    } else {
      stream.setHandlers({
        onBody: (_chunk, fin) => {
          if (!fin) return;
          stream.sendResponse({ status: 200, headers: {} });
          stream.writeBody(Buffer.from('fine'), true);
        },
      });
    }
  };
  const one = loop.controller.table.openStream(GET, first.handlers);
  const two = loop.controller.table.openStream(GET, second.handlers);
  two.writeBody(EMPTY, true);
  await tick();

  assert.equal(first.record.end?.cause, 'error');
  assert.equal(first.record.end?.cause === 'error' && first.record.end.origin, 'peer');
  assert.equal(first.record.end?.cause === 'error' && first.record.end.code, 'REMOTE_FORBIDDEN');
  assert.equal(one.closed, true);
  assert.equal(bodyText(second.record.chunks), 'fine');
  assert.deepEqual(second.record.end, { cause: 'completed' });
});

test('WebSocket streams carry messages both ways in order and close cleanly', async () => {
  const loop = createMuxLoopback();
  const hostSide = recorder();
  loop.host.handleIncoming = (stream) => {
    stream.setHandlers({
      ...hostSide.handlers,
      onMessage: (payload, binary) => {
        hostSide.handlers.onMessage(payload, binary);
        stream.sendMessage(Buffer.from(`echo:${payload.toString()}`), binary);
      },
    });
  };
  const { record, handlers } = recorder();
  const stream = loop.controller.table.openStream({ kind: 'ws', meta: { path: '/shell', protocols: ['cloudcli'] } }, handlers);
  for (const text of ['a', 'b', 'c']) stream.sendMessage(Buffer.from(text), false);
  stream.sendMessage(Buffer.from([1, 2]), true);
  await tick();
  loop.clock.advance(100); // Host replies are batched for 50 ms
  await tick();
  assert.deepEqual(hostSide.record.messages.map((m) => m.payload), ['a', 'b', 'c', '\u0001\u0002']);
  assert.deepEqual(record.messages.map((m) => m.payload), ['echo:a', 'echo:b', 'echo:c', 'echo:\u0001\u0002']);
  assert.deepEqual(record.messages.map((m) => m.binary), [false, false, false, true]);

  stream.sendMessage(Buffer.from('last'), false);
  stream.closeWebSocket(1000, 'bye');
  await tick();
  assert.deepEqual(record.end, { cause: 'local-ws-close', code: 1000, reason: 'bye' });
  assert.deepEqual(hostSide.record.end, { cause: 'peer-ws-close', code: 1000, reason: 'bye' });
  assert.equal(hostSide.record.messages.at(-1)?.payload, 'last', 'messages queued before the close still arrive first');
  expectNoLeaks(loop.controller, loop.host);
});

test('a WebSocket message above the mux limit closes that stream with 1009 and nothing else', async () => {
  const loop = createMuxLoopback();
  const hostSide = recorder();
  loop.host.handleIncoming = (stream) => stream.setHandlers(hostSide.handlers);
  const { record, handlers } = recorder();
  const stream = loop.controller.table.openStream(WS, handlers);
  const other = loop.controller.table.openStream(WS, {});
  assert.equal(stream.sendMessage(Buffer.alloc(MAX_WS_MESSAGE_BYTES + 1), true), false);
  await tick();
  assert.equal(record.end?.cause, 'local-ws-close');
  assert.equal(record.end?.cause === 'local-ws-close' && record.end.code, 1009);
  assert.equal(hostSide.record.end?.cause === 'peer-ws-close' && hostSide.record.end.code, 1009);
  assert.equal(other.closed, false);
});

test('stream ids: Controller streams are odd, Host streams even, and wrong-parity opens are refused', async () => {
  const loop = createMuxLoopback();
  const ids = [1, 2, 3].map(() => loop.controller.table.openStream(WS, {}).id);
  assert.deepEqual(ids, [1, 3, 5]);
  const hostIds = [1, 2].map(() => loop.host.table.openStream(WS, {}).id);
  assert.deepEqual(hostIds, [2, 4], 'the Host numbers its own ids evenly');
  await tick();
  assert.equal(loop.controller.incoming.length, 0, 'but a Controller never accepts a peer-opened stream');
  assert.equal(loop.host.incoming.length, 3);

  // A peer opening a stream with an id of the wrong parity gets an ERROR and no stream appears.
  const before = loop.host.incoming.length;
  loop.host.table.receive(encodeFrame({ type: 'WS_OPEN', streamId: 8, meta: { path: '/ws' }, body: EMPTY }));
  await tick();
  assert.equal(loop.host.incoming.length, before);
  const refusal = framesOfType(loop.host.transmitted, 'ERROR').at(-1);
  assert.equal(refusal?.streamId, 8);
  assert.equal(refusal?.meta.code, 'REMOTE_PROTOCOL');

  loop.controller.table.receive(encodeFrame({ type: 'HTTP_REQ', streamId: 7, meta: GET.meta, body: EMPTY }));
  assert.equal(loop.controller.incoming.length, 0);
  assert.equal(framesOfType(loop.controller.transmitted, 'ERROR').at(-1)?.streamId, 7);
});

test('an id that was already used cannot be opened again', async () => {
  const loop = createMuxLoopback();
  serveText(loop.host, 200, 'x');
  const stream = loop.controller.table.openStream(GET, {});
  stream.writeBody(EMPTY, true);
  await tick();
  assert.equal(loop.host.table.size, 0);

  const incomingBefore = loop.host.incoming.length;
  loop.host.table.receive(encodeFrame({ type: 'WS_OPEN', streamId: stream.id, meta: { path: '/ws' }, body: EMPTY }));
  await tick();
  assert.equal(loop.host.incoming.length, incomingBefore);
  assert.equal(framesOfType(loop.host.transmitted, 'ERROR').at(-1)?.meta.code, 'REMOTE_PROTOCOL');
  expectNoLeaks(loop.controller, loop.host);
});

test('frames for unknown streams get an ERROR, except cancels, errors and stragglers of closed streams', async () => {
  const loop = createMuxLoopback();
  const sendToHost = (frame: RemoteMuxFrame) => loop.host.table.receive(encodeFrame(frame));
  const errorsSent = () => framesOfType(loop.host.transmitted, 'ERROR');

  sendToHost({ type: 'REQ_BODY', streamId: 9, meta: { fin: true }, body: EMPTY }); // never opened
  await tick();
  assert.equal(errorsSent().length, 1);
  assert.equal(errorsSent()[0].streamId, 9);
  assert.equal(errorsSent()[0].meta.code, 'REMOTE_PROTOCOL');

  sendToHost({ type: 'CANCEL', streamId: 11, meta: {}, body: EMPTY });
  sendToHost({ type: 'ERROR', streamId: 13, meta: { code: 'REMOTE_INTERNAL', message: 'x' }, body: EMPTY });
  sendToHost({ type: 'WS_MSG', streamId: 2, meta: { binary: false }, body: EMPTY }); // an id of the Host's own range, never opened
  await tick();
  assert.equal(errorsSent().length, 2, 'only the own-range frame earned another ERROR');

  // Stragglers after a stream is gone are expected (they were in flight) and are dropped silently.
  const stream = loop.controller.table.openStream(WS, {});
  stream.cancel();
  await tick();
  const count = errorsSent().length;
  sendToHost({ type: 'WS_MSG', streamId: stream.id, meta: { binary: false }, body: Buffer.from('late') });
  await tick();
  assert.equal(errorsSent().length, count);
});

test('undecodable frames answer with an ERROR for their stream or are ignored when no stream is known', async () => {
  const loop = createMuxLoopback();
  const hostSide = recorder();
  loop.host.handleIncoming = (stream) => stream.setHandlers(hostSide.handlers);
  const stream = loop.controller.table.openStream(WS, {});
  await tick();

  // Meta far above the limit, aimed at the open stream: the stream is failed, not the link.
  const huge = Buffer.alloc(9);
  huge[0] = 0x21;
  huge.writeUInt32BE(stream.id, 1);
  huge.writeUInt32BE(10 * 1024 * 1024, 5);
  loop.host.table.receive(huge);
  await tick();
  assert.equal(hostSide.record.end?.cause === 'error' && hostSide.record.end.code, 'REMOTE_PROTOCOL');
  const sent = framesOfType(loop.host.transmitted, 'ERROR');
  assert.equal(sent.at(-1)?.streamId, stream.id);
  assert.equal(loop.host.table.size, 0);

  const before = loop.host.transmitted.length;
  loop.host.table.receive(Buffer.from([1, 2, 3])); // too short to even name a stream
  loop.host.table.receive(rawFrame(0x77, 0, {})); // unknown type on the connection stream
  loop.host.table.receive(rawFrame(0x30, 21, {}, EMPTY, Buffer.from('{bad'))); // a broken CANCEL must not be answered
  loop.host.table.receive(rawFrame(0x31, 23, {}, EMPTY, Buffer.from('{bad'))); // neither a broken ERROR
  await tick();
  assert.equal(loop.host.transmitted.length, before);
  assert.equal(loop.host.handlerErrors.length, 0);
});

test('frames that do not fit the stream (wrong kind, wrong direction, wrong order) fail only that stream', async () => {
  const cases: Array<{ name: string; make: (id: number) => RemoteMuxFrame; open: 'http' | 'ws'; side: 'host' | 'controller' }> = [
    { name: 'WS message on an HTTP stream', open: 'http', side: 'host', make: (id) => ({ type: 'WS_MSG', streamId: id, meta: { binary: false }, body: EMPTY }) },
    { name: 'request body on a WS stream', open: 'ws', side: 'host', make: (id) => ({ type: 'REQ_BODY', streamId: id, meta: { fin: false }, body: EMPTY }) },
    { name: 'response head sent to the responder', open: 'http', side: 'host', make: (id) => ({ type: 'HTTP_RES', streamId: id, meta: { status: 200, headers: {} }, body: EMPTY }) },
    { name: 'response body before the response head', open: 'http', side: 'controller', make: (id) => ({ type: 'RES_BODY', streamId: id, meta: { fin: false }, body: EMPTY }) },
    { name: 'request body sent to the initiator', open: 'http', side: 'controller', make: (id) => ({ type: 'REQ_BODY', streamId: id, meta: { fin: false }, body: EMPTY }) },
    { name: 'a second open for a live id', open: 'http', side: 'host', make: (id) => ({ type: 'HTTP_REQ', streamId: id, meta: GET.meta, body: EMPTY }) },
  ];
  for (const { name, make, open, side } of cases) {
    const loop = createMuxLoopback();
    const hostSide = recorder();
    loop.host.handleIncoming = (stream) => stream.setHandlers(hostSide.handlers);
    const { record, handlers } = recorder();
    const stream = loop.controller.table.openStream(open === 'http' ? GET : WS, handlers);
    await tick();
    const bystander = loop.controller.table.openStream(WS, {});
    await tick();
    const target = side === 'host' ? loop.host : loop.controller;
    target.table.receive(encodeFrame(make(stream.id)));
    await tick();
    const ended = side === 'host' ? hostSide.record.end : record.end;
    assert.equal(ended?.cause, 'error', name);
    assert.equal(ended?.cause === 'error' && ended.code, 'REMOTE_PROTOCOL', name);
    assert.equal(bystander.closed, false, `${name}: other streams are untouched`);
  }
});

test('request bodies and responses must come in order: nothing after fin, no second response head', async () => {
  const loop = createMuxLoopback();
  const hostSide = recorder();
  loop.host.handleIncoming = (stream) => stream.setHandlers(hostSide.handlers);
  const stream = loop.controller.table.openStream({ kind: 'http', meta: { method: 'POST', path: '/x', headers: {} } }, {});
  stream.writeBody(Buffer.from('abc'), true);
  await tick();
  loop.host.table.receive(encodeFrame({ type: 'REQ_BODY', streamId: stream.id, meta: { fin: false }, body: Buffer.from('extra') }));
  await tick();
  assert.equal(hostSide.record.end?.cause === 'error' && hostSide.record.end.code, 'REMOTE_PROTOCOL');

  const { record, handlers } = recorder();
  const second = loop.controller.table.openStream(GET, handlers);
  loop.controller.table.receive(encodeFrame({ type: 'HTTP_RES', streamId: second.id, meta: { status: 200, headers: {} }, body: EMPTY }));
  loop.controller.table.receive(encodeFrame({ type: 'HTTP_RES', streamId: second.id, meta: { status: 201, headers: {} }, body: EMPTY }));
  assert.equal(record.status, 200);
  assert.equal(record.end?.cause === 'error' && record.end.code, 'REMOTE_PROTOCOL');
});

test('the Host can refuse a stream (quota hook) and the Controller sees the code', async () => {
  const loop = createMuxLoopback();
  loop.host.handleIncoming = () => 'REMOTE_QUOTA';
  const { record, handlers } = recorder();
  const stream = loop.controller.table.openStream(GET, handlers);
  await tick();
  assert.equal(stream.closed, true);
  assert.equal(record.end?.cause === 'error' && record.end.code, 'REMOTE_QUOTA');
  assert.equal(record.end?.cause === 'error' && record.end.origin, 'peer');
  expectNoLeaks(loop.controller, loop.host);
});

test('streams are refused until the table accepts them (before APP_HELLO)', async () => {
  const loop = createMuxLoopback();
  loop.host.table.acceptStreams(false);
  const { record, handlers } = recorder();
  loop.controller.table.openStream(GET, handlers);
  await tick();
  assert.equal(loop.host.incoming.length, 0);
  assert.equal(record.end?.cause === 'error' && record.end.code, 'REMOTE_PROTOCOL');
  loop.host.table.acceptStreams(true);
  const after = loop.controller.table.openStream(GET, {});
  await tick();
  assert.equal(loop.host.incoming.length, 1);
  assert.equal(after.closed, false);
});

test('a throwing handler fails its stream with REMOTE_INTERNAL and is reported, without breaking the table', async () => {
  const loop = createMuxLoopback();
  loop.host.handleIncoming = (stream) => {
    stream.setHandlers({
      onMessage: () => {
        throw new Error('bridge bug');
      },
      onClosed: () => {
        throw new Error('bug while closing');
      },
    });
  };
  const { record, handlers } = recorder();
  const stream = loop.controller.table.openStream(WS, handlers);
  const healthy = recorder();
  loop.controller.table.openStream(WS, healthy.handlers);
  stream.sendMessage(Buffer.from('boom'), false);
  await tick();
  assert.equal(record.end?.cause === 'error' && record.end.code, 'REMOTE_INTERNAL');
  assert.equal(loop.host.handlerErrors.length, 2);
  assert.equal(loop.host.table.size, 1, 'the healthy stream survives');

  // A host side without an incoming handler refuses streams instead of crashing.
  loop.host.handleIncoming = () => {
    throw new Error('handler exploded');
  };
  const refused = recorder();
  loop.controller.table.openStream(WS, refused.handlers);
  await tick();
  assert.equal(refused.record.end?.cause === 'error' && refused.record.end.code, 'REMOTE_INTERNAL');
});

test('1,000 opened and closed streams leave no state behind', async () => {
  const loop = createMuxLoopback();
  serveText(loop.host, 200, 'ok');
  for (let i = 0; i < 500; i += 1) {
    const stream = loop.controller.table.openStream(GET, {});
    stream.writeBody(EMPTY, true);
  }
  for (let i = 0; i < 250; i += 1) loop.controller.table.openStream(WS, {}).cancel();
  for (let i = 0; i < 250; i += 1) loop.controller.table.openStream(WS, {}).closeWebSocket(1000, '');
  await tick();
  await tick();
  expectNoLeaks(loop.controller, loop.host);
});

test('closeAll ends every stream with link-down, drops queued frames and refuses new streams', async () => {
  const loop = createMuxLoopback({ gated: true });
  const a = recorder();
  const b = recorder();
  const one = loop.controller.table.openStream(WS, a.handlers);
  loop.controller.table.openStream({ kind: 'http', meta: { method: 'POST', path: '/x', headers: {} } }, b.handlers).writeBody(Buffer.alloc(500_000), false);
  one.sendMessage(Buffer.from('queued'), false);

  loop.controller.table.closeAll('desync');
  assert.deepEqual(a.record.end, { cause: 'link-down', reason: 'desync' });
  assert.deepEqual(b.record.end, { cause: 'link-down', reason: 'desync' });
  assert.equal(loop.controller.table.size, 0);
  assert.equal(loop.controller.table.pendingFrames, 0);
  assert.throws(() => loop.controller.table.openStream(WS, {}), /closed/);
  loop.controller.table.receive(encodeFrame({ type: 'WS_MSG', streamId: 1, meta: { binary: false }, body: EMPTY })); // ignored
  loop.controller.table.sendConnectionFrame('PING', {}); // ignored, no throw
  loop.controller.table.closeAll('desync'); // idempotent
});

test('a transmit failure is reported once and stops the send queue', async () => {
  const loop = createMuxLoopback();
  loop.controller.table.openStream(WS, {});
  await tick();
  loop.failNextTransmit('controller', new Error('socket gone'));
  const stream = loop.controller.table.openStream(WS, {});
  stream.sendMessage(Buffer.from('x'), false);
  stream.sendMessage(Buffer.from('y'), false);
  await loop.controller.table.drain();
  assert.equal(loop.controller.transmitErrors.length, 1);
  assert.equal((loop.controller.transmitErrors[0] as Error).message, 'socket gone');
});

test('openStream validates its meta before creating anything', () => {
  const loop = createMuxLoopback();
  assert.throws(
    () => loop.controller.table.openStream({ kind: 'http', meta: { method: 'GET', path: 'relative', headers: {} } }, {}),
    (error: unknown) => error instanceof MuxFrameError && error.code === 'bad-meta',
  );
  assert.equal(loop.controller.table.size, 0);
  assert.equal(loop.controller.table.pendingFrames, 0);
});

test('connection frames go to the link, and the connection stream never opens a stream', async () => {
  const loop = createMuxLoopback();
  loop.controller.table.sendConnectionFrame('APP_HELLO', { protocolVersion: 1, appVersion: 'c', role: 'controller' });
  loop.controller.table.sendConnectionFrame('PING', {});
  loop.host.table.sendConnectionFrame('PONG', {});
  loop.host.table.sendConnectionFrame('ERROR', { code: 'REMOTE_PROTOCOL', message: 'version' });
  await tick();
  assert.deepEqual(loop.host.connectionFrames.map((f) => f.type), ['APP_HELLO', 'PING']);
  assert.deepEqual(loop.controller.connectionFrames.map((f) => f.type), ['PONG', 'ERROR']);
  assert.equal(loop.host.table.size, 0);
  // Stream-bound frames addressed to stream 0 are dropped by the decoder, not delivered.
  loop.host.table.receive(rawFrame(0x21, 0, { binary: false }));
  assert.equal(loop.host.connectionFrames.length, 2);
});

test('1000 streams opened and finished, cancelled or failed leave both tables and queues empty', async () => {
  const { controller, host } = createMuxLoopback();
  serveText(host, 200, 'ok');
  let completed = 0;
  for (let i = 0; i < 1000; i += 1) {
    const { record, handlers } = recorder();
    const stream = controller.table.openStream(GET, handlers);
    if (i % 3 === 0) {
      stream.cancel();
    } else if (i % 3 === 1) {
      stream.writeBody(EMPTY, true);
      await tick();
      if (record.end?.cause === 'completed') completed += 1;
    } else {
      stream.fail('REMOTE_INTERNAL', 'gave up');
    }
    if (i % 50 === 0) await tick();
  }
  await tick();
  assert.equal(completed, 333);
  expectNoLeaks(controller, host);
});

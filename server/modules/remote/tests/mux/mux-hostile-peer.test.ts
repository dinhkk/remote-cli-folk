/**
 * A hostile but authenticated peer must not be able to exhaust the memory or CPU of this side:
 * per-link ceilings on open streams, queued bytes and self-generated replies, plus role enforcement,
 * the re-entrancy of `writeBody`, and the invariant that opening frames are never reordered.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { RemoteMuxStream, RemoteStreamEnd } from '@/shared/types.js';

import { MAX_BODY_CHUNK_BYTES } from '../../mux/frames.js';
import { DEFAULT_MUX_LIMITS, createStreamTable } from '../../mux/stream-table.js';
import { createManualClock } from '../support/manual-clock.js';
import { createMuxLoopback, tick } from '../support/mux-loopback.js';
import { framesOfType, rawFrame } from '../support/mux-test-helpers.js';
import { createSeededRandom } from '../support/seeded-random.js';

const EMPTY = Buffer.alloc(0);
const GET = { kind: 'http', meta: { method: 'GET', path: '/api/ping', headers: {} } } as const;
const WS = { kind: 'ws', meta: { path: '/ws' } } as const;
const MIB = 1024 * 1024;

const httpRequest = (id: number) => rawFrame(0x10, id, { method: 'GET', path: '/x', headers: {} });
const requestBody = (id: number) => rawFrame(0x11, id, { fin: false }, Buffer.from('x'));

const recordEnds = () => {
  const ends: RemoteStreamEnd[] = [];
  return { ends, handlers: { onClosed: (end: RemoteStreamEnd) => void ends.push(end) } };
};

test('the defaults are documented: 64 open streams, 32 MiB queued, 64 pending replies, 4 PINGs per second', () => {
  assert.equal(DEFAULT_MUX_LIMITS.maxOpenStreams, 64);
  assert.equal(DEFAULT_MUX_LIMITS.maxTotalQueuedBytes, 32 * MIB);
  assert.equal(DEFAULT_MUX_LIMITS.maxPendingReplies, 64);
  assert.equal(DEFAULT_MUX_LIMITS.maxPingsPerSecond, 4);
});

// ---------------------------------------------------------------------------
// Open streams
// ---------------------------------------------------------------------------

test('10,000 opening frames leave at most 64 streams and a bounded reply queue; excess frames get REMOTE_QUOTA', async () => {
  const loop = createMuxLoopback({ gated: true });
  for (let i = 0; i < 10_000; i += 1) loop.host.table.receive(httpRequest(2 * i + 1));

  assert.equal(loop.host.table.size, 64);
  assert.equal(loop.host.incoming.length, 64, 'the stream hook only ever saw the accepted ones');
  assert.ok(loop.host.table.pendingFrames <= 64, `pending frames ${loop.host.table.pendingFrames}`);

  await loop.open('toController');
  const errors = framesOfType(loop.host.transmitted, 'ERROR');
  assert.ok(errors.length >= 1 && errors.length <= 65, `${errors.length} errors`);
  assert.ok(errors.every((frame) => frame.meta.code === 'REMOTE_QUOTA'));
  // Frames of the refused streams that follow are stragglers: dropped, never answered again.
  const answered = loop.host.transmitted.length;
  loop.host.table.receive(requestBody(2 * 9_999 + 1));
  await tick();
  assert.equal(loop.host.transmitted.length, answered);
});

test('a cancelled stream frees a slot, and the limit is configurable', async () => {
  const loop = createMuxLoopback({ hostLimits: { maxOpenStreams: 3 } });
  for (const id of [1, 3, 5, 7]) loop.host.table.receive(httpRequest(id));
  assert.equal(loop.host.table.size, 3);
  loop.host.table.receive(rawFrame(0x30, 1, {})); // the peer cancels stream 1
  assert.equal(loop.host.table.size, 2);
  loop.host.table.receive(httpRequest(9));
  assert.equal(loop.host.table.size, 3);
  assert.equal(loop.host.incoming.length, 4);
});

test('a well-behaved client over the limit is told per stream: REMOTE_QUOTA closes exactly the excess streams', async () => {
  const loop = createMuxLoopback({ hostLimits: { maxOpenStreams: 4 } });
  const outcomes = Array.from({ length: 7 }, () => recordEnds());
  const streams = outcomes.map(({ handlers }) => loop.controller.table.openStream(GET, handlers));
  await tick();
  assert.deepEqual(streams.map((stream) => stream.closed), [false, false, false, false, true, true, true]);
  for (const { ends } of outcomes.slice(4)) {
    assert.deepEqual(ends.map((end) => end.cause === 'error' && [end.origin, end.code]), [['peer', 'REMOTE_QUOTA']]);
  }
  assert.equal(loop.controller.table.size, 4);
  assert.equal(streams[5].writeBody(Buffer.from('late'), true), false, 'writes on a refused stream are ignored');
});

// ---------------------------------------------------------------------------
// Replies the table generates itself
// ---------------------------------------------------------------------------

test('floods of bad ids (unknown streams, wrong parity, undecodable frames) cannot grow the reply queue', async () => {
  const loop = createMuxLoopback({ gated: true });
  for (let i = 0; i < 10_000; i += 1) {
    loop.host.table.receive(requestBody(2 * i + 1)); // body for a stream that was never opened
    loop.host.table.receive(httpRequest(2 * i + 2)); // opening frame with the wrong parity
    loop.host.table.receive(rawFrame(0x11, 2 * i + 1, { fin: 'maybe' })); // undecodable meta for an unused id
  }
  assert.equal(loop.host.table.size, 0);
  assert.ok(loop.host.table.pendingFrames <= 64, `pending frames ${loop.host.table.pendingFrames}`);
  assert.ok(loop.host.table.queuedBytes <= 64 * 1024, `queued bytes ${loop.host.table.queuedBytes}`);
  await loop.open('toController');
  assert.ok(loop.host.transmitted.length <= 65, `${loop.host.transmitted.length} replies left the process`);
});

test('PONGs are coalesced: a hundred pongs requested while the link is busy leave at most one queued', () => {
  const loop = createMuxLoopback({ gated: true });
  for (let i = 0; i < 100; i += 1) loop.host.table.sendConnectionFrame('PONG', {});
  assert.ok(loop.host.table.pendingFrames <= 1, `pending frames ${loop.host.table.pendingFrames}`);
  assert.ok(loop.host.table.pendingFrames + loop.host.transmitted.length <= 2);
});

test('the reply queue limit is configurable and a drop is silent (nothing throws)', () => {
  const loop = createMuxLoopback({ gated: true, hostLimits: { maxPendingReplies: 3 } });
  for (let i = 0; i < 50; i += 1) assert.doesNotThrow(() => loop.host.table.receive(requestBody(2 * i + 1)));
  assert.ok(loop.host.table.pendingFrames <= 3);
});

// ---------------------------------------------------------------------------
// Queued bytes per link
// ---------------------------------------------------------------------------

test('responses that nobody reads: the stream that crosses the link-wide byte cap is failed with REMOTE_QUOTA, the others live on', async () => {
  const loop = createMuxLoopback({ gated: true, hostLimits: { maxTotalQueuedBytes: 3 * MIB } });
  const hostStreams: RemoteMuxStream[] = [];
  const hostEnds = new Map<number, RemoteStreamEnd[]>();
  loop.host.handleIncoming = (stream) => {
    hostStreams.push(stream);
    const { ends, handlers } = recordEnds();
    hostEnds.set(stream.id, ends);
    stream.setHandlers(handlers);
  };
  const controllerEnds = Array.from({ length: 10 }, () => recordEnds());
  const streams = controllerEnds.map(({ handlers }) => loop.controller.table.openStream(GET, handlers));
  await loop.step('toHost', 10);
  assert.equal(hostStreams.length, 10);

  // A hostile peer asked for ten big downloads and never reads: the Host writes 1 MiB per stream, ignoring pause.
  const body = Buffer.alloc(MIB, 7);
  let peak = 0;
  for (const stream of hostStreams) {
    stream.sendResponse({ status: 200, headers: {} });
    stream.writeBody(body, false);
    peak = Math.max(peak, loop.host.table.queuedBytes);
  }
  assert.ok(peak <= 3 * MIB + 2 * MAX_BODY_CHUNK_BYTES, `peak queued bytes ${peak}`);
  const failed = hostStreams.filter((stream) => stream.closed);
  const alive = hostStreams.filter((stream) => !stream.closed);
  assert.ok(failed.length >= 7 && alive.length >= 1 && alive.length <= 3, `failed ${failed.length}, alive ${alive.length}`);
  for (const stream of failed) {
    assert.deepEqual((hostEnds.get(stream.id) as RemoteStreamEnd[]).map((end) => end.cause === 'error' && [end.origin, end.code]), [['local', 'REMOTE_QUOTA']]);
  }

  // The peer is told per stream, and the session itself survives (the breach was resolved by failing the offender).
  await loop.open('toController');
  await tick();
  assert.equal(controllerEnds.filter(({ ends }) => ends.some((end) => end.cause === 'error' && end.code === 'REMOTE_QUOTA')).length, failed.length);
  assert.equal(streams.filter((stream) => !stream.closed).length, alive.length);
  assert.equal(loop.host.transmitErrors.length, 0);
});

test('a link-wide cap that cannot be satisfied by failing the offender (no stream to fail) reports the breach so the session is torn down', () => {
  let breaches = 0;
  const clock = createManualClock(1_800_000_000_000);
  const table = createStreamTable({
    role: 'host',
    clock,
    limits: { maxTotalQueuedBytes: 200 },
    transmit: () => new Promise<void>(() => undefined), // a link that never drains
    onIncomingStream: () => undefined,
    onConnectionFrame: () => undefined,
    onTransmitError: () => undefined,
    onLinkQuotaExceeded: () => void (breaches += 1),
  });
  for (let i = 0; i < 20; i += 1) table.receive(requestBody(2 * i + 1)); // each is answered with an ERROR that no stream owns
  assert.ok(breaches >= 1, 'the table asked its owner to end the session');
  assert.equal(breaches, 1, 'and only once');
});

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

test('a Controller refuses every peer-opened stream, even when a stream handler is installed', async () => {
  const loop = createMuxLoopback();
  let hookCalls = 0;
  loop.controller.handleIncoming = () => {
    hookCalls += 1;
  };
  const hostOutcome = recordEnds();
  const http = loop.host.table.openStream(GET, hostOutcome.handlers);
  const ws = loop.host.table.openStream(WS, {});
  await tick();

  assert.equal(hookCalls, 0, 'the handler was never consulted');
  assert.equal(loop.controller.incoming.length, 0);
  assert.equal(loop.controller.table.size, 0);
  assert.equal(http.closed, true);
  assert.equal(ws.closed, true);
  assert.deepEqual(hostOutcome.ends.map((end) => end.cause === 'error' && [end.origin, end.code]), [['peer', 'REMOTE_PROTOCOL']]);
});

test('a Host refuses opening frames whose id has the Controller-opposite parity or was used before', async () => {
  const loop = createMuxLoopback();
  loop.host.table.receive(httpRequest(2)); // even: only the Host itself would use it
  loop.host.table.receive(httpRequest(0));
  loop.host.table.receive(httpRequest(3));
  loop.host.table.receive(httpRequest(3)); // reused
  loop.host.table.receive(httpRequest(1)); // lower than the highest seen
  await tick();
  assert.deepEqual(loop.host.incoming.map((entry) => entry.stream.id), [3]);
  assert.ok(framesOfType(loop.host.transmitted, 'ERROR').every((frame) => frame.meta.code === 'REMOTE_PROTOCOL'));
});

// ---------------------------------------------------------------------------
// writeBody re-entrancy
// ---------------------------------------------------------------------------

test('cancelling from inside onPause stops writeBody at once: no frame is queued for the dead stream', async () => {
  const loop = createMuxLoopback({ gated: true });
  const flowEnds = recordEnds();
  let pauses = 0;
  const holder: { stream?: RemoteMuxStream } = {};
  holder.stream = loop.controller.table.openStream(
    { kind: 'http', meta: { method: 'POST', path: '/up', headers: {} } },
    {
      ...flowEnds.handlers,
      onPause: () => {
        pauses += 1;
        holder.stream?.cancel();
      },
    },
  );
  const accepted = holder.stream.writeBody(Buffer.alloc(6 * MIB), true);

  assert.equal(accepted, false);
  assert.equal(pauses, 1);
  assert.equal(holder.stream.closed, true);
  assert.deepEqual(flowEnds.ends, [{ cause: 'local-cancel' }]);
  assert.ok(loop.controller.table.pendingFrames <= 1, `only the CANCEL may be queued, found ${loop.controller.table.pendingFrames}`);
  assert.ok(loop.controller.table.queuedBytes < 64, `only the CANCEL frame remains (${loop.controller.table.queuedBytes} bytes)`);

  await loop.open('toHost');
  const types = loop.controller.transmitted.map((frame) => frame.type);
  const cancelAt = types.indexOf('CANCEL');
  assert.ok(cancelAt >= 0);
  assert.ok(!types.slice(cancelAt + 1).includes('REQ_BODY'), 'no body frame follows the CANCEL');
});

test('cancelling a WebSocket stream from inside onPause stops sendMessage too', () => {
  const loop = createMuxLoopback({ gated: true });
  const holder: { stream?: RemoteMuxStream } = {};
  holder.stream = loop.controller.table.openStream(WS, { onPause: () => holder.stream?.cancel() });
  const message = Buffer.alloc(16 * 1024, 1);
  const results: boolean[] = [];
  for (let i = 0; i < 400 && !holder.stream.closed; i += 1) results.push(holder.stream.sendMessage(message, true));
  assert.equal(holder.stream.closed, true);
  assert.equal(results.at(-1), false, 'the write that triggered the cancel reports it was not accepted');
  assert.ok(loop.controller.table.pendingFrames <= 1);
});

// ---------------------------------------------------------------------------
// Opening frames keep their order (the receiver rejects ids <= the highest seen)
// ---------------------------------------------------------------------------

test('the scheduler never reorders opening frames: 150 randomized runs of opens, bulk writes and cancels produce no id refusal', async () => {
  for (let seed = 1; seed <= 150; seed += 1) {
    const random = createSeededRandom(seed);
    const loop = createMuxLoopback({ gated: true });
    const opened: RemoteMuxStream[] = [];
    const refusals: string[] = [];
    const accepted: number[] = [];
    loop.host.handleIncoming = (stream) => {
      accepted.push(stream.id);
      stream.setHandlers({});
    };
    for (let step = 0; step < 40; step += 1) {
      const action = random.int(0, 9);
      if (action <= 3) {
        const kind = random.int(0, 1) === 0 ? GET : WS;
        const stream = loop.controller.table.openStream(kind, { onClosed: (end) => end.cause === 'error' && refusals.push(end.message) });
        opened.push(stream);
      } else if (action <= 5 && opened.length > 0) {
        const stream = random.pick(opened);
        if (stream.kind === 'http') stream.writeBody(Buffer.alloc(random.int(1, 3 * MAX_BODY_CHUNK_BYTES), 1), random.int(0, 1) === 0);
        else stream.sendMessage(Buffer.alloc(random.int(0, 40 * 1024), 2), random.int(0, 1) === 0);
      } else if (action === 6 && opened.length > 0) {
        random.pick(opened).cancel();
      } else {
        await loop.step('toHost', random.int(1, 4));
      }
    }
    await loop.open('toHost');
    await tick();
    assert.deepEqual(refusals, [], `seed ${seed}: a stream was refused`);
    assert.deepEqual(framesOfType(loop.host.transmitted, 'ERROR').filter((frame) => frame.meta.message === 'Invalid stream id.'), [], `seed ${seed}`);
    assert.deepEqual(accepted, [...accepted].sort((a, b) => a - b), `seed ${seed}: opening frames arrived out of order`);
    assert.equal(new Set(accepted).size, accepted.length);
  }
});

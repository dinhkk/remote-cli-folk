/**
 * One link session against a scripted peer: PING flood limit, Host-side liveness of the Controller,
 * what an `ERROR` on stream 0 means before and after the hello, and the quota teardown.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import type { RemoteLinkReason, RemoteMuxFrame, RemotePairingRole } from '@/shared/types.js';

import { createSecureChannel } from '../../crypto/secure-channel.js';
import { createLinkSession, type LinkSession } from '../../link/link-session.js';
import { decodeFrame, encodeFrame } from '../../mux/frames.js';
import { createManualClock } from '../support/manual-clock.js';

const EMPTY = Buffer.alloc(0);

/** A session of `role` plus a peer channel that speaks to it with the matching keys. */
const makeRig = (role: RemotePairingRole, limits?: Parameters<typeof createLinkSession>[0]['limits']) => {
  const mine = crypto.randomBytes(32);
  const theirs = crypto.randomBytes(32);
  const clock = createManualClock(1_800_000_000_000);
  const sentToPeer: Buffer[] = [];
  const failures: RemoteLinkReason[] = [];
  const state = { established: 0 };
  const session: LinkSession = createLinkSession({
    role,
    keys: { sendKey: mine, receiveKey: theirs },
    transmit: (frame) => void sentToPeer.push(frame),
    clock,
    limits,
    appVersion: `${role}-1`,
    protocolVersion: 1,
    onIncomingStream: () => undefined,
    onEstablished: () => void (state.established += 1),
    onFailed: (reason) => void failures.push(reason),
  });
  const peerRole: RemotePairingRole = role === 'host' ? 'controller' : 'host';
  const peerReceiver = createSecureChannel({ sendKey: theirs, receiveKey: mine, transmit: () => undefined });
  const peerSender = createSecureChannel({ sendKey: theirs, receiveKey: mine, transmit: (frame) => session.receive(frame) });

  const send = async (frame: RemoteMuxFrame): Promise<void> => {
    await peerSender.send(encodeFrame(frame));
  };
  const hello = (): Promise<void> =>
    send({ type: 'APP_HELLO', streamId: 0, meta: { protocolVersion: 1, appVersion: `${peerRole}-1`, role: peerRole }, body: EMPTY });
  const ping = (): Promise<void> => send({ type: 'PING', streamId: 0, meta: {}, body: EMPTY });
  // The receiving channel is stateful (counters), so each frame is decoded exactly once.
  const decoded: RemoteMuxFrame[] = [];
  const received = (): RemoteMuxFrame[] => {
    while (decoded.length < sentToPeer.length) decoded.push(decodeFrame(peerReceiver.receive(sentToPeer[decoded.length]) as Buffer));
    return decoded;
  };
  return { session, clock, failures, state, hello, ping, send, received, sentToPeer };
};

test('a Controller that floods PINGs gets at most four PONGs per second; the rest are dropped', async () => {
  const rig = makeRig('host');
  await rig.hello();
  for (let i = 0; i < 10_000; i += 1) await rig.ping();
  const pongs = () => rig.received().filter((frame) => frame.type === 'PONG').length;
  assert.equal(pongs(), 4, 'four answers inside the first second');
  assert.equal(rig.failures.length, 0, 'a flood is ignored, not a reason to drop the session');

  rig.clock.advance(1000);
  for (let i = 0; i < 1000; i += 1) await rig.ping();
  assert.equal(pongs(), 8, 'the next second allows four more');
  rig.session.stop('stopped');
});

test('the PING limit is configurable', async () => {
  const rig = makeRig('host', { maxPingsPerSecond: 1 });
  await rig.hello();
  for (let i = 0; i < 20; i += 1) await rig.ping();
  assert.equal(rig.received().filter((frame) => frame.type === 'PONG').length, 1);
  rig.session.stop('stopped');
});

test('a Host drops a Controller session that went silent for 40 s; any authentic frame restarts that clock', async () => {
  const rig = makeRig('host');
  await rig.hello();
  assert.equal(rig.state.established, 1);
  rig.clock.advance(39_000);
  assert.deepEqual(rig.failures, []);
  await rig.ping(); // the Controller is alive after all
  rig.clock.advance(39_999);
  assert.deepEqual(rig.failures, [], 'still within 40 s of the last frame');
  rig.clock.advance(1);
  assert.deepEqual(rig.failures, ['liveness-timeout']);
  rig.clock.advance(120_000);
  assert.deepEqual(rig.failures, ['liveness-timeout'], 'reported once');
});

test('the Host idle check does not run before the hello is accepted (the handshake timer owns that) nor after stop()', async () => {
  const early = makeRig('host');
  early.clock.advance(60_000);
  assert.deepEqual(early.failures, ['handshake-timeout'], 'the hello timer, not the liveness timer');

  const stopped = makeRig('host');
  await stopped.hello();
  stopped.session.stop('stopped');
  stopped.clock.advance(120_000);
  assert.deepEqual(stopped.failures, []);
  assert.equal(stopped.clock.pendingTimers(), 0);
});

test('a Controller has no idle timer of its own towards the Host: it relies on its PING/PONG check', async () => {
  const rig = makeRig('controller');
  await rig.hello();
  rig.clock.advance(14_000);
  assert.deepEqual(rig.failures, []);
  rig.clock.advance(1_000); // PING goes out
  rig.clock.advance(9_999);
  assert.deepEqual(rig.failures, []);
  rig.clock.advance(1);
  assert.deepEqual(rig.failures, ['liveness-timeout']);
});

test('an ERROR REMOTE_PROTOCOL on stream 0 after the session is up tears it down once, as protocol-error', async () => {
  for (const role of ['host', 'controller'] as const) {
    const rig = makeRig(role);
    await rig.hello();
    await rig.send({ type: 'ERROR', streamId: 0, meta: { code: 'REMOTE_PROTOCOL', message: 'you broke a rule' }, body: EMPTY });
    await rig.send({ type: 'ERROR', streamId: 0, meta: { code: 'REMOTE_PROTOCOL', message: 'again' }, body: EMPTY });
    assert.deepEqual(rig.failures, ['protocol-error'], role);
  }
});

test('before the hello is accepted the same ERROR still means a protocol version mismatch', async () => {
  const rig = makeRig('controller');
  await rig.send({ type: 'ERROR', streamId: 0, meta: { code: 'REMOTE_PROTOCOL', message: 'version' }, body: EMPTY });
  assert.deepEqual(rig.failures, ['protocol-mismatch']);
});

test('other connection-level errors, and stream-scoped ERRORs, do not end the session', async () => {
  const rig = makeRig('host');
  await rig.hello();
  await rig.send({ type: 'ERROR', streamId: 0, meta: { code: 'REMOTE_INTERNAL', message: 'oops' }, body: EMPTY });
  await rig.send({ type: 'ERROR', streamId: 1, meta: { code: 'REMOTE_PROTOCOL', message: 'about one stream' }, body: EMPTY });
  await rig.send({ type: 'ERROR', streamId: 7, meta: { code: 'REMOTE_PROTOCOL', message: 'about an unknown stream' }, body: EMPTY });
  assert.deepEqual(rig.failures, []);
  assert.equal(rig.session.established, true);
  rig.session.stop('stopped');
});

test('a stream-scoped ERROR REMOTE_PROTOCOL closes only that stream', async () => {
  const rig = makeRig('host');
  await rig.hello();
  const ends: string[] = [];
  const stream = rig.session.table.openStream({ kind: 'ws', meta: { path: '/ws' } }, { onClosed: (end) => void ends.push(end.cause) });
  const other = rig.session.table.openStream({ kind: 'ws', meta: { path: '/ws' } }, {});
  await rig.send({ type: 'ERROR', streamId: stream.id, meta: { code: 'REMOTE_PROTOCOL', message: 'bad frame on this stream' }, body: EMPTY });
  assert.deepEqual(ends, ['error']);
  assert.equal(other.closed, false);
  assert.deepEqual(rig.failures, []);
  rig.session.stop('stopped');
});

test('the link-wide byte ceiling, when failing a stream cannot fix it, ends the session as quota-exceeded (once)', () => {
  // Replies the table generates for ids it has no stream for are the only queued bytes; the link never drains, so they pile up.
  const stuck = makeStuckHostSession();
  for (let i = 0; i < 20; i += 1) stuck.table.receive(encodeFrame({ type: 'REQ_BODY', streamId: 2 * i + 1, meta: { fin: false }, body: Buffer.from('x') }));
  assert.deepEqual(stuck.failures, ['quota-exceeded']);
  stuck.stop();
});

/** A Host session whose transmit never completes, so queued bytes only grow. */
const makeStuckHostSession = () => {
  const failures: RemoteLinkReason[] = [];
  const clock = createManualClock(1_800_000_000_000);
  const session = createLinkSession({
    role: 'host',
    keys: { sendKey: crypto.randomBytes(32), receiveKey: crypto.randomBytes(32) },
    transmit: () => new Promise<void>(() => undefined),
    clock,
    limits: { maxTotalQueuedBytes: 150 },
    appVersion: 'host-1',
    protocolVersion: 1,
    onIncomingStream: () => undefined,
    onEstablished: () => undefined,
    onFailed: (reason) => void failures.push(reason),
  });
  return { table: session.table, failures, stop: () => session.stop('stopped') };
};

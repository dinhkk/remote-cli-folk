import assert from 'node:assert/strict';
import test from 'node:test';

import type { RemoteMuxStream, RemoteRelaySocketFactory, RemoteStreamEnd } from '@/shared/types.js';

import { createControllerHandshake } from '../../crypto/handshake.js';
import { deriveLinkKeys } from '../../crypto/key-derivation.js';
import { createSecureChannel } from '../../crypto/secure-channel.js';
import { RemoteLinkDownError, toRemotePeerState } from '../../link/relay-link.js';
import { encodeFrame } from '../../mux/frames.js';
import { createLinkRig, watchLink, type LinkRig, type LinkTap } from '../support/relay-link-rig.js';

const EMPTY = Buffer.alloc(0);
const GET = { kind: 'http', meta: { method: 'GET', path: '/api/ping', headers: {} } } as const;
const WS = { kind: 'ws', meta: { path: '/ws' } } as const;

const withRig = (name: string, body: (rig: LinkRig) => Promise<void>, tap?: LinkTap) =>
  test(name, async () => {
    const rig = createLinkRig(tap);
    try {
      await body(rig);
    } finally {
      rig.dispose();
    }
  });

/** Starts a Host and a Controller and waits until both have a session. */
const connectPair = async (rig: LinkRig) => {
  const host = rig.createLink('host');
  const controller = rig.createLink('controller');
  host.onStream((stream) => stream.setHandlers({}));
  host.start();
  await rig.settle();
  controller.start();
  await rig.settle();
  assert.equal(controller.status.state, 'online');
  assert.equal(host.sessionActive, true);
  return { host, controller };
};

const controllerSockets = (rig: LinkRig) => rig.net.sockets.filter((record) => record.role === 'controller');

test('link states map to the peer states of the contracts', () => {
  assert.equal(toRemotePeerState('stopped'), 'offline');
  assert.equal(toRemotePeerState('connecting'), 'connecting');
  assert.equal(toRemotePeerState('online'), 'online');
  assert.equal(toRemotePeerState('rejected'), 'offline');
  assert.equal(toRemotePeerState('locked'), 'locked');
  assert.equal(toRemotePeerState('replaced'), 'replaced');
  assert.equal(toRemotePeerState('revoked'), 'revoked');
});

withRig('a Host link is offline until started, then connecting, then online once the relay says ready', async (rig) => {
  const host = rig.createLink('host');
  const events = watchLink(host);
  assert.deepEqual(host.status, { state: 'stopped', peerState: 'offline', reason: null, attempt: 0, retryInMs: null });
  host.start();
  assert.equal(host.status.state, 'connecting');
  assert.equal(host.status.peerState, 'connecting');
  await rig.settle();
  assert.equal(host.status.state, 'online');
  assert.equal(host.status.peerState, 'online');
  assert.equal(host.sessionActive, false, 'no Controller yet');
  assert.deepEqual(events.states.map((status) => status.state), ['connecting', 'online']);
  host.start(); // already started: nothing changes
  assert.equal(rig.net.sockets.length, 1);
});

withRig('a Controller connects, handshakes, exchanges APP_HELLO and becomes online; versions are recorded', async (rig) => {
  const host = rig.createLink('host');
  const controller = rig.createLink('controller');
  const controllerEvents = watchLink(controller);
  const hostEvents = watchLink(host);
  host.start();
  await rig.settle();
  controller.start();
  await rig.settle();

  assert.equal(controller.status.state, 'online');
  assert.equal(controller.sessionActive, true);
  assert.equal(controller.peerAppVersion, 'host-1.0');
  assert.equal(host.peerAppVersion, 'controller-1.0');
  assert.deepEqual(controllerEvents.sessions, [{ up: true, peerAppVersion: 'host-1.0' }]);
  assert.deepEqual(hostEvents.sessions, [{ up: true, peerAppVersion: 'controller-1.0' }]);
  assert.deepEqual(controllerEvents.peers, [true]);

  // Streams flow end to end.
  const answered: string[] = [];
  host.onStream((stream, open) => {
    answered.push(`${open.kind}:${stream.id}`);
    stream.setHandlers({
      onBody: (_chunk, fin) => {
        if (!fin) return;
        stream.sendResponse({ status: 200, headers: {} });
        stream.writeBody(Buffer.from('pong'), true);
      },
    });
  });
  const chunks: Buffer[] = [];
  let end: RemoteStreamEnd | undefined;
  const stream = controller.openStream(GET, { onBody: (chunk) => chunks.push(chunk), onClosed: (e) => (end = e) });
  stream.writeBody(EMPTY, true);
  await rig.settle();
  assert.deepEqual(answered, ['http:1']);
  assert.equal(Buffer.concat(chunks).toString(), 'pong');
  assert.deepEqual(end, { cause: 'completed' });
});

withRig('a Controller that arrives before the Host retries with back-off (4404) and succeeds once the Host is there', async (rig) => {
  const controller = rig.createLink('controller');
  controller.start();
  await rig.settle();
  assert.deepEqual(
    { state: controller.status.state, reason: controller.status.reason, retryInMs: controller.status.retryInMs, attempt: controller.status.attempt },
    { state: 'connecting', reason: 'host-absent', retryInMs: 1000, attempt: 1 },
  );
  assert.equal(rig.net.sockets.length, 1);
  await rig.advance(999, 999);
  assert.equal(rig.net.sockets.length, 1);
  await rig.advance(1, 1);
  assert.equal(rig.net.sockets.length, 2);
  assert.equal(controller.status.retryInMs, 2000);

  const host = rig.createLink('host');
  host.start();
  await rig.settle();
  await rig.advance(2000, 2000);
  assert.equal(controller.status.state, 'online');
  assert.ok(controller.status.attempt > 0, 'back-off is kept until the session proved stable');
  await rig.advance(60_000, 10_000);
  assert.equal(controller.status.attempt, 0);
  assert.equal(controller.status.retryInMs, null);
});

withRig('reconnects follow 1, 2, 5, 10, 30, 30 seconds', async (rig) => {
  rig.net.setNetworkDown(true);
  const link = rig.createLink('host');
  link.start();
  await rig.settle();
  const delays: Array<number | null> = [];
  for (let i = 0; i < 7; i += 1) {
    delays.push(link.status.retryInMs);
    assert.equal(link.status.reason, 'relay-unreachable');
    assert.equal(link.status.attempt, i + 1);
    await rig.advance(link.status.retryInMs as number, link.status.retryInMs as number);
  }
  assert.deepEqual(delays, [1000, 2000, 5000, 10_000, 30_000, 30_000, 30_000]);
  assert.equal(rig.net.sockets.length, 8);

  rig.net.setNetworkDown(false);
  await rig.advance(30_000, 30_000);
  assert.equal(link.status.state, 'online');
});

withRig('a relay that refuses the credentials (401) is rejected and retried after 60 seconds', async (rig) => {
  const link = rig.createLink('host', { relaySecret: 'not-the-relay-secret' });
  link.start();
  await rig.settle();
  assert.equal(rig.net.sockets[0].refusedWith, 401);
  assert.equal(link.status.state, 'rejected');
  assert.equal(link.status.peerState, 'offline');
  assert.equal(link.status.reason, 'relay-rejected');
  assert.equal(link.status.retryInMs, 60_000);
  await rig.advance(59_999, 59_999);
  assert.equal(rig.net.sockets.length, 1);
  await rig.advance(1, 1);
  assert.equal(rig.net.sockets.length, 2);
  assert.equal(link.status.state, 'rejected');
});

/** Makes the relay lock a link room: 8 wrong tokens, then every connection gets 4429. */
const lockRoom = async (rig: LinkRig) => {
  const room = deriveLinkKeys(rig.k).roomId;
  for (let i = 0; i < 8; i += 1) {
    const opened = rig.relay.open(
      { kind: 'link', room, role: 'controller' },
      { text: () => undefined, binary: () => undefined, close: () => undefined },
    );
    opened.socket?.sendText(JSON.stringify({ t: 'auth', token: `${'x'.repeat(42)}${i}` }));
  }
  await rig.settle();
};

withRig('a locked room (4429) shows as locked and is retried every 60 seconds until the lock expires', async (rig) => {
  const host = rig.createLink('host');
  host.start();
  await rig.settle();
  await lockRoom(rig);
  const controller = rig.createLink('controller');
  controller.start();
  await rig.settle();
  assert.equal(controller.status.state, 'locked');
  assert.equal(controller.status.peerState, 'locked');
  assert.equal(controller.status.reason, 'locked');
  assert.equal(controller.status.retryInMs, 60_000);

  await rig.advance(60_000, 60_000);
  assert.equal(rig.net.sockets.filter((record) => record.role === 'controller').length, 2);
  assert.equal(controller.status.state, 'locked', 'the lock lasts 15 minutes');

  await rig.advance(15 * 60_000, 60_000);
  assert.equal(controller.status.state, 'online');
});

withRig('a link replaced by a newer connection (4409) stops and does not take the room back', async (rig) => {
  const host = rig.createLink('host');
  host.start();
  await rig.settle();
  const first = rig.createLink('controller');
  const firstEvents = watchLink(first);
  first.start();
  await rig.settle();
  assert.equal(first.status.state, 'online');
  const stream = first.openStream(WS, {});

  const second = rig.createLink('controller');
  second.start();
  await rig.settle();

  assert.equal(first.status.state, 'replaced');
  assert.equal(first.status.peerState, 'replaced');
  assert.equal(first.status.reason, 'replaced');
  assert.equal(first.status.retryInMs, null);
  assert.equal(first.sessionActive, false);
  assert.equal(stream.closed, true);
  assert.deepEqual(firstEvents.sessions.at(-1), { up: false, reason: 'replaced' });
  assert.equal(second.status.state, 'online');
  const before = rig.net.sockets.length;
  await rig.advance(10 * 60_000, 60_000);
  assert.equal(rig.net.sockets.length, before, 'no reconnect attempts');
  assert.equal(second.status.state, 'online');
  assert.throws(() => first.openStream(WS, {}), RemoteLinkDownError);
});

withRig('a revoked room (4410) stops both links for good', async (rig) => {
  const { host, controller } = await connectPair(rig);
  assert.equal(controller.destroyRoom(), false, 'only the Host may destroy a room');
  assert.equal(host.destroyRoom(), true);
  await rig.settle();
  for (const link of [host, controller]) {
    assert.equal(link.status.state, 'revoked');
    assert.equal(link.status.peerState, 'revoked');
    assert.equal(link.status.retryInMs, null);
    assert.equal(link.sessionActive, false);
  }
  const before = rig.net.sockets.length;
  await rig.advance(10 * 60_000, 60_000);
  assert.equal(rig.net.sockets.length, before);
  assert.equal(host.destroyRoom(), false, 'not connected any more');
});

withRig('HELLO1 goes out on every peer up and never while the Host is away (the relay does not queue it)', async (rig) => {
  const hello1s = () => rig.net.wire.filter((record) => record.from === 'controller' && record.type === 1);
  const host = rig.createLink('host');
  const controller = rig.createLink('controller');
  host.start();
  await rig.settle();
  controller.start();
  await rig.settle();
  assert.equal(hello1s().length, 1);

  host.close();
  await rig.settle();
  assert.equal(controller.status.state, 'connecting');
  assert.equal(controller.status.reason, 'host-absent');
  assert.equal(controller.sessionActive, false);
  await rig.advance(60_000, 5000);
  assert.equal(hello1s().length, 1, 'nothing sent while the Host is away');

  const replacement = rig.createLink('host');
  replacement.start();
  await rig.settle();
  assert.equal(hello1s().length, 2);
  assert.equal(controller.status.state, 'online');
  const [first, second] = hello1s();
  assert.ok(!Buffer.from(first.data).subarray(1, 17).equals(Buffer.from(second.data).subarray(1, 17)), 'a fresh nonce for every handshake');
  assert.ok(!Buffer.from(first.data).subarray(17).equals(Buffer.from(second.data).subarray(17)), 'a fresh ephemeral key for every handshake');
});

withRig('after a reconnect the session starts over: new counters and a new handshake', async (rig) => {
  const { host, controller } = await connectPair(rig);
  const firstDataFrames = rig.net.wire.filter((record) => record.from === 'controller' && record.type === 0x10);
  assert.equal(firstDataFrames[0].counter, 0n);
  rig.net.sever('controller');
  await rig.settle();
  assert.equal(controller.status.state, 'connecting');
  assert.equal(controller.status.reason, 'relay-unreachable');
  assert.equal(host.sessionActive, false);
  await rig.advance(1000, 1000);
  assert.equal(controller.status.state, 'online');
  assert.equal(host.sessionActive, true);
  const hello1Index = rig.net.wire.map((record) => record.type).lastIndexOf(1);
  const dataAfter = rig.net.wire.slice(hello1Index).find((record) => record.from === 'controller' && record.type === 0x10);
  assert.equal(dataAfter?.counter, 0n);
});

withRig('a tampered HELLO2 (what a wrong key would produce) never reaches online and ends in a handshake timeout', async (rig) => {
  const controllerTamper: LinkTap = {
    onReceive: (role, data) => {
      if (role === 'controller' && data[0] === 2) data[data.length - 1] ^= 0xff;
    },
  };
  rig.net.tap.onReceive = controllerTamper.onReceive;
  const host = rig.createLink('host');
  const controller = rig.createLink('controller');
  const events = watchLink(controller);
  host.start();
  await rig.settle();
  controller.start();
  await rig.settle();
  assert.notEqual(controller.status.state, 'online');
  assert.deepEqual(events.handshakeErrors, ['bad-mac']);
  assert.equal(controller.sessionActive, false);

  await rig.advance(10_000, 10_000);
  assert.equal(controller.status.state, 'connecting');
  assert.equal(controller.status.reason, 'handshake-timeout');
  assert.equal(controller.status.retryInMs, 1000);
  assert.equal(host.sessionActive, false);
});

withRig('no HELLO2 within 10 seconds: handshake-timeout, the socket is dropped and a retry follows the back-off', async (rig) => {
  rig.net.tap.onReceive = (role, data) => (role === 'controller' && data[0] === 2 ? false : undefined);
  const host = rig.createLink('host');
  const controller = rig.createLink('controller');
  host.start();
  await rig.settle();
  controller.start();
  await rig.settle();
  await rig.advance(9999, 9999);
  assert.equal(controller.status.reason, null, 'still waiting');
  assert.equal(controllerSockets(rig).length, 1);
  await rig.advance(1, 1);
  assert.equal(controller.status.reason, 'handshake-timeout');
  assert.equal(controller.status.retryInMs, 1000);
  assert.equal(controller.status.attempt, 1);
  assert.notEqual(controllerSockets(rig)[0].closedByLink, undefined, 'the stalled socket was closed');
  await rig.advance(1000, 1000);
  assert.equal(controllerSockets(rig).length, 2);
  await rig.advance(10_000, 10_000);
  assert.equal(controller.status.retryInMs, 2000, 'the second failure waits longer');
});

withRig('events of a socket the link already gave up on are ignored (generation guard)', async (rig) => {
  const { controller } = await connectPair(rig);
  const events = watchLink(controller);
  const [stale] = controllerSockets(rig);
  rig.net.sever('controller');
  await rig.settle();
  assert.equal(controller.status.state, 'connecting');

  // A late close(4409) of the dead socket must not mark the link replaced.
  stale.handlers.onClose(4409);
  stale.handlers.onText('{"t":"peer","up":false}');
  stale.handlers.onBinary(Buffer.from([0x10, 1, 2, 3]));
  await rig.settle();
  assert.equal(controller.status.state, 'connecting');
  assert.equal(controller.status.reason, 'relay-unreachable');

  await rig.advance(1000, 1000);
  assert.equal(controller.status.state, 'online');
  stale.handlers.onClose(4409);
  stale.handlers.onClose(4410);
  assert.equal(controller.status.state, 'online');
  assert.ok(!events.states.some((status) => status.state === 'replaced' || status.state === 'revoked'));
});

withRig('a Host that gets a new HELLO1 mid-session keeps the old session until the new handshake proves itself, then drops its streams', async (rig) => {
  let lastHello2: Uint8Array | undefined;
  rig.net.tap.onReceive = (role, data) => {
    if (role === 'controller' && data[0] === 2) lastHello2 = Uint8Array.from(data);
  };
  const { host, controller } = await connectPair(rig);
  const hostEvents = watchLink(host);
  const ends: RemoteStreamEnd[] = [];
  host.onStream((stream) => stream.setHandlers({ onClosed: (end) => ends.push(end) }));
  controller.openStream(WS, {});
  await rig.settle();
  assert.equal(host.sessionActive, true);

  // A second, independent handshake from the Controller side of the relay (same pairing key).
  const [{ socket }] = [...controllerSockets(rig)].reverse().map((record) => ({ socket: record.socket }));
  const manual = createControllerHandshake({ k: rig.k, now: () => rig.clock.now() });
  socket?.sendBinary(manual.hello1);
  await rig.settle();
  assert.ok(lastHello2, 'the Host answered with HELLO2');
  assert.deepEqual(ends, [], 'the old session lives on until HELLO3 authenticates');

  const { hello3, keys } = manual.completeWithHello2(lastHello2);
  socket?.sendBinary(hello3);
  await rig.settle();
  assert.deepEqual(ends, [{ cause: 'link-down', reason: 'peer-down' }]);
  assert.equal(host.sessionActive, false, 'the new session waits for APP_HELLO');
  assert.deepEqual(hostEvents.sessions.at(-1), { up: false, reason: 'peer-down' });

  const channel = createSecureChannel({ sendKey: keys.sendKey, receiveKey: keys.receiveKey, transmit: (frame) => socket?.sendBinary(frame) });
  await channel.send(encodeFrame({ type: 'APP_HELLO', streamId: 0, meta: { protocolVersion: 1, appVersion: 'manual-1', role: 'controller' }, body: EMPTY }));
  await rig.settle();
  assert.equal(host.sessionActive, true);
  assert.equal(host.peerAppVersion, 'manual-1');
  channel.close();
});

withRig('HELLO1 floods and malformed handshake frames are reported and ignored', async (rig) => {
  const { host } = await connectPair(rig);
  const events = watchLink(host);
  const [{ socket }] = [...controllerSockets(rig)].reverse().map((record) => ({ socket: record.socket }));
  for (let i = 0; i < 6; i += 1) socket?.sendBinary(createControllerHandshake({ k: rig.k }).hello1);
  socket?.sendBinary(Buffer.from([1, 2, 3])); // wrong length HELLO1
  socket?.sendBinary(Buffer.concat([Buffer.from([3]), Buffer.alloc(32)])); // HELLO3 without a pending handshake
  socket?.sendBinary(Buffer.alloc(0));
  await rig.settle();
  assert.ok(events.handshakeErrors.includes('handshake-rate-limited'));
  assert.ok(events.handshakeErrors.includes('bad-length'));
  assert.equal(host.status.state, 'online');
  assert.equal(host.sessionActive, true, 'the established session survived');
});

withRig('a HELLO3 with a bad MAC is reported and the pending handshake expires after 10 seconds', async (rig) => {
  const host = rig.createLink('host');
  const events = watchLink(host);
  host.start();
  await rig.settle();
  const raw = rig.relay.open(
    { kind: 'link', room: deriveLinkKeys(rig.k).roomId, role: 'controller' },
    { text: () => undefined, binary: () => undefined, close: () => undefined },
  );
  raw.socket?.sendText(JSON.stringify({ t: 'auth', token: deriveLinkKeys(rig.k).controllerToken }));
  await rig.settle();
  raw.socket?.sendBinary(createControllerHandshake({ k: rig.k }).hello1);
  await rig.settle();
  raw.socket?.sendBinary(Buffer.concat([Buffer.from([3]), Buffer.alloc(32, 9)]));
  await rig.settle();
  assert.deepEqual(events.handshakeErrors, ['bad-mac']);
  await rig.advance(10_000, 10_000); // the pending handshake is dropped
  raw.socket?.sendBinary(Buffer.concat([Buffer.from([3]), Buffer.alloc(32, 9)]));
  await rig.settle();
  assert.deepEqual(events.handshakeErrors, ['bad-mac'], 'no pending handshake any more: ignored silently');
  assert.equal(host.sessionActive, false);
});

withRig('three corrupt DATA frames in a row are a desync: streams end and the Controller handshakes again', async (rig) => {
  const { controller } = await connectPair(rig);
  const events = watchLink(controller);
  const stream = controller.openStream(WS, {});
  const [live] = [...controllerSockets(rig)].reverse();
  for (let i = 0; i < 3; i += 1) live.handlers.onBinary(Buffer.concat([Buffer.from([0x10]), Buffer.alloc(40, i + 1)]));
  assert.deepEqual(events.desyncs, [{ code: 'too-many-bad-frames' }]);
  assert.equal(stream.closed, true);
  assert.equal(controller.status.reason, 'desync');
  await rig.advance(1000, 1000);
  assert.equal(controller.status.state, 'online');
  assert.equal(controller.sessionActive, true);
});

withRig('unknown or malformed relay messages are ignored', async (rig) => {
  const { controller } = await connectPair(rig);
  const [live] = [...controllerSockets(rig)].reverse();
  live.handlers.onText('not json');
  live.handlers.onText('{"t":"mystery"}');
  live.handlers.onText('42');
  live.handlers.onText('{"t":"ready"}');
  live.handlers.onBinary(Buffer.alloc(0));
  live.handlers.onBinary(Buffer.from([0x99, 1, 2]));
  await rig.settle();
  assert.equal(controller.status.state, 'online');
  assert.equal(controller.sessionActive, true);
});

withRig('close() is final: sockets and timers are gone, restarting does nothing, streams are refused', async (rig) => {
  const { host, controller } = await connectPair(rig);
  const stream = controller.openStream(WS, {});
  const events = watchLink(controller);
  controller.close();
  assert.equal(controller.status.state, 'stopped');
  assert.equal(controller.status.peerState, 'offline');
  assert.equal(controller.status.reason, 'stopped');
  assert.equal(stream.closed, true);
  assert.deepEqual(events.sessions, [{ up: false, reason: 'stopped' }]);
  assert.notEqual(controllerSockets(rig)[0].closedByLink, undefined);
  controller.close(); // idempotent
  controller.start();
  assert.equal(controller.status.state, 'stopped');
  assert.throws(() => controller.openStream(WS, {}), RemoteLinkDownError);
  await rig.settle();
  assert.equal(host.sessionActive, false);
  host.close();
  assert.equal(rig.clock.pendingTimers(), 0, 'no timer survives close()');
});

withRig('the onStream handler can refuse streams, and unsubscribing leaves the Host without one', async (rig) => {
  const { host, controller } = await connectPair(rig);
  const unsubscribe = host.onStream(() => 'REMOTE_QUOTA');
  const ends: RemoteStreamEnd[] = [];
  controller.openStream(GET, { onClosed: (end) => ends.push(end) });
  await rig.settle();
  assert.deepEqual(ends[0], { cause: 'error', origin: 'peer', code: 'REMOTE_QUOTA', message: 'Stream refused.' });

  unsubscribe();
  unsubscribe(); // second call is harmless
  controller.openStream(GET, { onClosed: (end) => ends.push(end) });
  await rig.settle();
  assert.equal(ends[1]?.cause === 'error' && ends[1].code, 'REMOTE_INTERNAL');
});

test('HTTP refusals and odd close codes are classified: 4xx and 503 reject for 60 s, other failures back off', async () => {
  const cases: Array<{ name: string; http?: number; code?: number; state: string; retryInMs: number; reason: string }> = [
    { name: 'http 401', http: 401, state: 'rejected', retryInMs: 60_000, reason: 'relay-rejected' },
    { name: 'http 403', http: 403, state: 'rejected', retryInMs: 60_000, reason: 'relay-rejected' },
    { name: 'http 404', http: 404, state: 'rejected', retryInMs: 60_000, reason: 'relay-rejected' },
    { name: 'http 426', http: 426, state: 'rejected', retryInMs: 60_000, reason: 'relay-rejected' },
    { name: 'http 503', http: 503, state: 'rejected', retryInMs: 60_000, reason: 'relay-rejected' },
    { name: 'http 500', http: 500, state: 'connecting', retryInMs: 1000, reason: 'relay-unreachable' },
    { name: 'http 502', http: 502, state: 'connecting', retryInMs: 1000, reason: 'relay-unreachable' },
    { name: 'close 4401', code: 4401, state: 'rejected', retryInMs: 60_000, reason: 'relay-rejected' },
    { name: 'close 4400', code: 4400, state: 'connecting', retryInMs: 1000, reason: 'relay-unreachable' },
    { name: 'close 1009', code: 1009, state: 'connecting', retryInMs: 1000, reason: 'relay-unreachable' },
    { name: 'close 1000', code: 1000, state: 'connecting', retryInMs: 1000, reason: 'relay-unreachable' },
    { name: 'close 4404', code: 4404, state: 'connecting', retryInMs: 1000, reason: 'host-absent' },
  ];
  for (const scenario of cases) {
    const rig = createLinkRig();
    try {
      const factory: RemoteRelaySocketFactory = (_target, handlers) => {
        queueMicrotask(() => (scenario.http !== undefined ? handlers.onClose(0, scenario.http) : handlers.onClose(scenario.code as number)));
        return { sendText: () => undefined, sendBinary: () => undefined, close: () => undefined };
      };
      const link = rig.createLink('controller', { socketFactory: factory });
      link.start();
      await rig.settle();
      assert.equal(link.status.state, scenario.state, scenario.name);
      assert.equal(link.status.retryInMs, scenario.retryInMs, scenario.name);
      assert.equal(link.status.reason, scenario.reason, scenario.name);
    } finally {
      rig.dispose();
    }
  }
});

withRig('a dead socket under an established session ends the session and reconnects', async (rig) => {
  let broken = false;
  const wrapped: RemoteRelaySocketFactory = (target, handlers) => {
    const socket = rig.net.factory(target, handlers);
    return {
      ...socket,
      sendBinary: (data) => (broken && target.role === 'controller' ? Promise.reject(new Error('socket is gone')) : socket.sendBinary(data)),
    };
  };
  const host = rig.createLink('host');
  const controller = rig.createLink('controller', { socketFactory: wrapped });
  const events = watchLink(controller);
  host.onStream((stream) => stream.setHandlers({}));
  host.start();
  await rig.settle();
  controller.start();
  await rig.settle();
  assert.equal(controller.status.state, 'online');

  const stream = controller.openStream(WS, {});
  broken = true;
  stream.sendMessage(Buffer.from('lost'), false);
  await rig.settle();
  assert.equal(stream.closed, true);
  assert.equal(controller.status.state, 'connecting');
  assert.equal(controller.status.reason, 'transmit-failed');
  assert.deepEqual(events.sessions.at(-1), { up: false, reason: 'transmit-failed' });
  broken = false;
  await rig.advance(1000, 1000);
  assert.equal(controller.status.state, 'online');
});

withRig('a throwing event listener does not break the link', async (rig) => {
  const host = rig.createLink('host');
  host.on('state', () => {
    throw new Error('listener bug');
  });
  const unsubscribe = host.on('peer', () => undefined);
  unsubscribe();
  host.start();
  await rig.settle();
  assert.equal(host.status.state, 'online');
});

withRig('streams opened before the session is up are refused with REMOTE_LINK_DOWN', async (rig) => {
  const controller = rig.createLink('controller');
  assert.throws(() => controller.openStream(GET, {}), (error: unknown) => error instanceof RemoteLinkDownError && error.code === 'REMOTE_LINK_DOWN');
  controller.start();
  assert.throws(() => controller.openStream(GET, {}), RemoteLinkDownError);
});

withRig('a stream that cannot be opened because of invalid meta throws without disturbing the session', async (rig) => {
  const { controller } = await connectPair(rig);
  assert.throws(() => controller.openStream({ kind: 'http', meta: { method: 'GET', path: 'no-slash', headers: {} } }, {}));
  assert.equal(controller.sessionActive, true);
  const ok: RemoteMuxStream = controller.openStream(GET, {});
  assert.equal(ok.closed, false);
});

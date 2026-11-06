import assert from 'node:assert/strict';
import test from 'node:test';

import type { RemoteMuxStream, RemoteStreamEnd } from '@/shared/types.js';

import { createLinkRig, watchLink, type LinkRig, type LinkTap } from '../support/relay-link-rig.js';

const WS = { kind: 'ws', meta: { path: '/ws' } } as const;

const withRig = (name: string, body: (rig: LinkRig, control: { muteHost: boolean; dropHostData: number; dropControllerData: number }) => Promise<void>) =>
  test(name, async () => {
    const control = { muteHost: false, dropHostData: 0, dropControllerData: 0 };
    const tap: LinkTap = {
      onSend: (role, data) => {
        if (role === 'host' && control.muteHost) return false;
        if (data[0] !== 0x10) return undefined;
        if (role === 'host' && control.dropHostData > 0) {
          control.dropHostData -= 1;
          return false;
        }
        if (role === 'controller' && control.dropControllerData > 0) {
          control.dropControllerData -= 1;
          return false;
        }
        return undefined;
      },
    };
    const rig = createLinkRig(tap);
    try {
      await body(rig, control);
    } finally {
      rig.dispose();
    }
  });

const connectPair = async (rig: LinkRig) => {
  const host = rig.createLink('host');
  const controller = rig.createLink('controller');
  host.onStream((stream) => stream.setHandlers({}));
  host.start();
  await rig.settle();
  controller.start();
  await rig.settle();
  assert.equal(controller.status.state, 'online');
  return { host, controller };
};

withRig('a healthy link keeps answering PING with PONG and never reconnects', async (rig) => {
  const { host, controller } = await connectPair(rig);
  const sockets = rig.net.sockets.length;
  await rig.advance(180_000, 1000);
  assert.equal(controller.status.state, 'online');
  assert.equal(host.sessionActive, true);
  assert.equal(rig.net.sockets.length, sockets);
  const hostFrames = rig.net.wire.filter((record) => record.from === 'host' && record.type === 0x10).length;
  assert.ok(hostFrames >= 10, `the Host answered the pings (${hostFrames} frames)`);
});

withRig('a Host that vanishes without the relay noticing: PING at 15 s, no PONG by 25 s, link offline, streams closed, handshake again', async (rig, control) => {
  const { host, controller } = await connectPair(rig);
  const events = watchLink(controller);
  const ends: RemoteStreamEnd[] = [];
  controller.openStream(WS, { onClosed: (end) => ends.push(end) }); // the pairing's browser WebSocket
  await rig.settle();
  const firstSession = controller.sessionActive;
  assert.equal(firstSession, true);

  control.muteHost = true; // packets to the Controller are lost; the relay reports nothing
  await rig.advance(15_000, 1000);
  assert.equal(controller.status.state, 'online', 'the PING has just gone out, the deadline is 10 s away');
  await rig.advance(9_000, 1000);
  assert.equal(controller.status.state, 'online');
  await rig.advance(1_000, 1000);

  assert.equal(controller.status.state, 'connecting');
  assert.equal(controller.status.peerState, 'connecting');
  assert.equal(controller.status.reason, 'liveness-timeout');
  assert.equal(controller.sessionActive, false);
  assert.deepEqual(events.sessions.at(-1), { up: false, reason: 'liveness-timeout' });
  assert.deepEqual(ends, [{ cause: 'link-down', reason: 'liveness-timeout' }], 'the browser WebSocket of the pairing is closed');
  assert.equal(host.sessionActive, false, 'dropping the socket told the Host the Controller left');

  control.muteHost = false;
  await rig.advance(1000, 1000);
  assert.equal(controller.status.state, 'online');
  assert.equal(host.sessionActive, true);
  assert.equal(events.sessions.at(-1)?.up, true, 'a new session was negotiated');
});

withRig('a replaced Host (peer down then up) makes the Controller handshake at once and never reuse the old key', async (rig) => {
  const { host: first, controller } = await connectPair(rig);
  const ends: RemoteStreamEnd[] = [];
  controller.openStream(WS, { onClosed: (end) => ends.push(end) });
  await rig.settle();
  const wireBefore = rig.net.wire.length;

  const second = rig.createLink('host');
  second.start();
  await rig.settle();

  assert.equal(first.status.state, 'replaced');
  assert.deepEqual(ends, [{ cause: 'link-down', reason: 'peer-down' }]);
  assert.equal(controller.status.state, 'online');
  assert.equal(second.sessionActive, true);
  assert.equal(controller.peerAppVersion, 'host-1.0');

  const sent = rig.net.wire.slice(wireBefore).filter((record) => record.from === 'controller');
  const hello1 = sent.findIndex((record) => record.type === 1);
  assert.ok(hello1 >= 0, 'a new HELLO1 followed the peer-up');
  assert.ok(sent.slice(0, hello1).every((record) => record.type !== 0x10), 'no data with the old key after the Host changed');
  const firstData = sent.slice(hello1).find((record) => record.type === 0x10);
  assert.equal(firstData?.counter, 0n, 'the new session starts with fresh counters');
});

withRig('a frame lost by the relay is a desync: streams are cancelled and the Controller handshakes again', async (rig, control) => {
  const { host, controller } = await connectPair(rig);
  const events = watchLink(controller);
  const held: { stream?: RemoteMuxStream } = {};
  host.onStream((stream) => {
    held.stream = stream;
    stream.setHandlers({});
  });
  const ends: RemoteStreamEnd[] = [];
  controller.openStream(WS, { onClosed: (end) => ends.push(end), onMessage: () => undefined });
  await rig.settle();
  const hostStream = held.stream as RemoteMuxStream;
  assert.ok(hostStream);

  control.dropHostData = 1; // the relay loses the next frame the Host sends
  hostStream.sendMessage(Buffer.from('lost'), false);
  await rig.advance(50, 50);
  hostStream.sendMessage(Buffer.from('arrives but out of step'), false);
  await rig.advance(50, 50);

  assert.deepEqual(events.desyncs, [{ code: 'counter-mismatch' }]);
  assert.deepEqual(ends, [{ cause: 'link-down', reason: 'desync' }]);
  assert.equal(controller.status.state, 'connecting');
  assert.equal(controller.status.reason, 'desync');
  assert.equal(controller.status.retryInMs, 1000);

  await rig.advance(1000, 1000);
  assert.equal(controller.status.state, 'online');
  assert.equal(host.sessionActive, true);
  const again = controller.openStream(WS, {});
  assert.equal(again.closed, false);
});

// A desync seen by the Host resets its relay socket so the Controller recovers within about a second:
// see relay-link-recovery.test.ts.

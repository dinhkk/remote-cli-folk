/**
 * Recovery rules of a relay link: back-off resets, Host-side desync/liveness recovery, polling that
 * stops with the link, a link closed while its socket is still being upgraded, and what a connection
 * level `ERROR REMOTE_PROTOCOL` does mid-session.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { RemoteStreamEnd } from '@/shared/types.js';

import { createManualClock } from '../support/manual-clock.js';
import { createLinkRig, watchLink, type LinkRig } from '../support/relay-link-rig.js';
import { startScriptedHost } from '../support/scripted-host.js';

const WS = { kind: 'ws', meta: { path: '/ws' } } as const;
const EMPTY = Buffer.alloc(0);

const withRig = (name: string, body: (rig: LinkRig) => Promise<void>, tap = {}) =>
  test(name, async () => {
    const rig = createLinkRig(tap);
    try {
      await body(rig);
    } finally {
      rig.dispose();
    }
  });

// ---------------------------------------------------------------------------
// Back-off
// ---------------------------------------------------------------------------

withRig('Host back-off: a socket that stayed ready for 60 s forgets earlier failures, so idle reconnects do not stay at 30 s', async (rig) => {
  const host = rig.createLink('host');
  host.start();
  await rig.settle();
  assert.equal(host.status.state, 'online');

  // A transient burst: four drops in a row climb the ladder 1, 2, 5, 10 s.
  const delays: Array<number | null> = [];
  for (let i = 0; i < 4; i += 1) {
    rig.net.sever('host');
    delays.push(host.status.retryInMs);
    await rig.advance(host.status.retryInMs ?? 0);
    assert.equal(host.status.state, 'online');
  }
  assert.deepEqual(delays, [1000, 2000, 5000, 10_000]);
  assert.equal(host.status.attempt, 4);

  await rig.advance(59_000);
  assert.equal(host.status.attempt, 4, 'not yet: 59 s of calm');
  await rig.advance(1_000);
  assert.equal(host.status.attempt, 0, 'a minute of connected idling clears the counter');
  assert.equal(host.status.state, 'online');

  rig.net.sever('host');
  assert.equal(host.status.retryInMs, 1000, 'the next hiccup starts again at one second');
});

withRig('Host back-off: a socket that keeps dropping before a minute never earns the reset', async (rig) => {
  const host = rig.createLink('host');
  host.start();
  await rig.settle();
  const seen: Array<number | null> = [];
  for (let i = 0; i < 7; i += 1) {
    rig.net.sever('host');
    seen.push(host.status.retryInMs);
    await rig.advance(host.status.retryInMs ?? 0);
    await rig.advance(20_000, 5000); // up for 20 s only
  }
  assert.deepEqual(seen, [1000, 2000, 5000, 10_000, 30_000, 30_000, 30_000]);
});

withRig('a Controller waiting for a Host that has no room polls every 30 s at most, and stops the moment the link is closed', async (rig) => {
  const controller = rig.createLink('controller');
  controller.start();
  await rig.settle();
  assert.equal(controller.status.reason, 'host-absent');
  const delays: number[] = [];
  for (let i = 0; i < 8; i += 1) {
    delays.push(controller.status.retryInMs as number);
    await rig.advance(controller.status.retryInMs as number);
  }
  assert.deepEqual(delays, [1000, 2000, 5000, 10_000, 30_000, 30_000, 30_000, 30_000]);

  controller.close();
  const sockets = rig.net.sockets.length;
  await rig.advance(5 * 60_000, 30_000);
  assert.equal(rig.net.sockets.length, sockets, 'no further upgrade after close()');
  assert.equal(controller.status.state, 'stopped');
  assert.equal(rig.clock.pendingTimers(), 0);
});

// ---------------------------------------------------------------------------
// Closing while the socket is still connecting
// ---------------------------------------------------------------------------

withRig('closing a link while its socket upgrade is still in flight sends nothing, schedules nothing and reports stopped', async (rig) => {
  for (const role of ['host', 'controller'] as const) {
    const link = rig.createLink(role);
    const events = watchLink(link);
    link.start();
    const record = rig.net.sockets.at(-1);
    assert.ok(record && record.texts.length === 0, 'the upgrade has not completed: no auth frame yet');
    link.close(); // before the socket reported "open"
    await rig.settle();

    assert.equal(link.status.state, 'stopped');
    assert.equal(record.closedByLink, 1000, `${role}: the half-open socket was closed`);
    assert.deepEqual(record.texts, [], `${role}: no auth frame leaked out after close()`);
    assert.deepEqual(events.peers, []);
  }
  const sockets = rig.net.sockets.length;
  await rig.advance(120_000, 30_000);
  assert.equal(rig.net.sockets.length, sockets);
  assert.equal(rig.clock.pendingTimers(), 0);
});

// ---------------------------------------------------------------------------
// Host side: desync and silent Controller
// ---------------------------------------------------------------------------

test('a desync seen by the Host resets its relay socket: the Controller learns at once and the link is back within two seconds', async () => {
  const control = { dropControllerData: 0 };
  const rig = createLinkRig({
    onSend: (role, data) => {
      if (role === 'controller' && data[0] === 0x10 && control.dropControllerData > 0) {
        control.dropControllerData -= 1;
        return false;
      }
      return undefined;
    },
  });
  try {
    const host = rig.createLink('host');
    const controller = rig.createLink('controller');
    host.onStream((stream) => stream.setHandlers({}));
    host.start();
    await rig.settle();
    controller.start();
    await rig.settle();
    assert.equal(controller.status.state, 'online');
    const hostEvents = watchLink(host);
    const controllerEvents = watchLink(controller);
    const hostSockets = rig.net.sockets.filter((record) => record.role === 'host').length;

    control.dropControllerData = 1; // the first PING is lost ...
    await rig.advance(15_000, 1000);
    control.dropControllerData = 0;
    const stream = controller.openStream(WS, {}); // ... and the next frame arrives out of step
    const ends: RemoteStreamEnd[] = [];
    stream.setHandlers({ onClosed: (end) => ends.push(end) });
    await rig.settle();

    assert.deepEqual(hostEvents.desyncs, [{ code: 'counter-mismatch' }]);
    assert.equal(host.sessionActive, false);
    assert.equal(host.status.state, 'connecting', 'the Host left the relay to force a clean start');
    assert.equal(host.status.reason, 'desync');
    assert.equal(host.status.retryInMs, 1000);
    assert.equal(controller.status.reason, 'host-absent', 'the relay told the Controller the Host is gone');
    assert.equal(controllerEvents.peers.at(-1), false);
    assert.deepEqual(ends, [{ cause: 'link-down', reason: 'peer-down' }]);

    await rig.advance(1000, 1000);
    assert.equal(host.status.state, 'online');
    assert.equal(controller.status.state, 'online', 'recovered 1 s after the desync, not 26 s');
    assert.equal(host.sessionActive, true);
    assert.equal(rig.net.sockets.filter((record) => record.role === 'host').length, hostSockets + 1);
  } finally {
    rig.dispose();
  }
});

test('a Host drops a Controller that went silent for 40 s but stays on the relay, ready for the next HELLO1', async () => {
  const rig = createLinkRig();
  try {
    const host = rig.createLink('host');
    // The Controller's own timers never run (frozen clock): to the Host it is a peer that vanished without the relay noticing.
    const controller = rig.createLink('controller', { clock: createManualClock(rig.clock.now()) });
    host.start();
    await rig.settle();
    controller.start();
    await rig.settle();
    assert.equal(host.sessionActive, true);
    const hostEvents = watchLink(host);

    await rig.advance(39_000, 1000);
    assert.equal(host.sessionActive, true);
    await rig.advance(1_000, 1000);
    assert.equal(host.sessionActive, false);
    assert.deepEqual(hostEvents.sessions.at(-1), { up: false, reason: 'liveness-timeout' });
    assert.equal(host.status.state, 'online', 'no reconnect: the socket is fine');
    assert.equal(rig.net.sockets.filter((record) => record.role === 'host').length, 1);
  } finally {
    rig.dispose();
  }
});

// ---------------------------------------------------------------------------
// ERROR REMOTE_PROTOCOL on stream 0 after the session is up
// ---------------------------------------------------------------------------

withRig('an ERROR REMOTE_PROTOCOL on stream 0 mid-session tears the Controller session down and it re-handshakes on the same socket', async (rig) => {
  const host = startScriptedHost(rig);
  await rig.settle();
  const controller = rig.createLink('controller');
  const events = watchLink(controller);
  controller.start();
  await rig.settle();
  assert.equal(controller.status.state, 'online');
  assert.equal(host.sessions, 1);
  const ends: RemoteStreamEnd[] = [];
  controller.openStream(WS, { onClosed: (end) => ends.push(end) });
  await rig.settle();
  const controllerSockets = rig.net.sockets.filter((record) => record.role === 'controller').length;

  host.send({ type: 'ERROR', streamId: 0, meta: { code: 'REMOTE_PROTOCOL', message: 'out of order' }, body: EMPTY });
  host.send({ type: 'ERROR', streamId: 0, meta: { code: 'REMOTE_PROTOCOL', message: 'a second one changes nothing' }, body: EMPTY });
  await rig.settle();

  assert.equal(controller.sessionActive, false);
  assert.deepEqual(ends, [{ cause: 'link-down', reason: 'protocol-error' }]);
  assert.deepEqual(events.sessions.at(-1), { up: false, reason: 'protocol-error' });
  assert.equal(controller.status.state, 'connecting');
  assert.equal(controller.status.reason, 'protocol-error');
  assert.equal(controller.status.retryInMs, 1000);

  await rig.advance(1000, 1000);
  assert.equal(controller.status.state, 'online');
  assert.equal(host.sessions, 2, 'a fresh handshake with fresh keys');
  assert.equal(rig.net.sockets.filter((record) => record.role === 'controller').length, controllerSockets, 'the relay socket was kept');
});

withRig('a stream-scoped ERROR from the Host closes only that stream; the session stays up', async (rig) => {
  const host = startScriptedHost(rig);
  await rig.settle();
  const controller = rig.createLink('controller');
  controller.start();
  await rig.settle();
  const ends: RemoteStreamEnd[] = [];
  const stream = controller.openStream(WS, { onClosed: (end) => ends.push(end) });
  const other = controller.openStream(WS, {});
  await rig.settle();

  host.send({ type: 'ERROR', streamId: stream.id, meta: { code: 'REMOTE_PROTOCOL', message: 'only this stream' }, body: EMPTY });
  await rig.settle();
  assert.deepEqual(ends.map((end) => end.cause), ['error']);
  assert.equal(other.closed, false);
  assert.equal(controller.sessionActive, true);
  assert.equal(controller.status.state, 'online');
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { REMOTE_PROTOCOL_VERSION, RemoteLinkDownError } from '../../link/relay-link.js';
import { createLinkRig, watchLink, type LinkRig, type LinkTap } from '../support/relay-link-rig.js';

const GET = { kind: 'http', meta: { method: 'GET', path: '/api/ping', headers: {} } } as const;

const withRig = (name: string, body: (rig: LinkRig) => Promise<void>, tap?: LinkTap) =>
  test(name, async () => {
    const rig = createLinkRig(tap);
    try {
      await body(rig);
    } finally {
      rig.dispose();
    }
  });

for (const [hostVersion, controllerVersion] of [
  [2, 1],
  [1, 2],
] as const) {
  withRig(`protocolVersion ${controllerVersion} (Controller) against ${hostVersion} (Host): REMOTE_PROTOCOL, no stream is ever opened`, async (rig) => {
    const host = rig.createLink('host', { protocolVersion: hostVersion });
    const controller = rig.createLink('controller', { protocolVersion: controllerVersion });
    const hostEvents = watchLink(host);
    const controllerEvents = watchLink(controller);
    let hostSawStream = false;
    host.onStream(() => {
      hostSawStream = true;
    });
    host.start();
    await rig.settle();
    controller.start();
    await rig.settle();

    assert.equal(controller.status.state, 'rejected');
    assert.equal(controller.status.peerState, 'offline');
    assert.equal(controller.status.reason, 'protocol-mismatch');
    assert.equal(controller.status.retryInMs, 60_000);
    assert.equal(controller.sessionActive, false);
    assert.equal(controller.peerAppVersion, null);
    assert.equal(host.sessionActive, false);
    assert.equal(host.status.state, 'online', 'the Host stays connected and keeps listening');
    assert.throws(() => controller.openStream(GET, {}), RemoteLinkDownError);
    assert.equal(hostSawStream, false);
    assert.ok(!controllerEvents.sessions.some((event) => event.up));
    assert.ok(!hostEvents.sessions.some((event) => event.up));

    // The mismatch is retried (the peer may have been upgraded), once a minute.
    const sockets = rig.net.sockets.length;
    await rig.advance(60_000, 10_000);
    assert.equal(rig.net.sockets.length, sockets + 1);
    assert.equal(controller.status.reason, 'protocol-mismatch');
  });
}

withRig('matching versions record the peer appVersion and the default protocol version is shared', async (rig) => {
  assert.equal(REMOTE_PROTOCOL_VERSION, 1);
  const host = rig.createLink('host', { appVersion: '1.37.7-host' });
  const controller = rig.createLink('controller', { appVersion: '1.38.0-controller' });
  host.start();
  await rig.settle();
  controller.start();
  await rig.settle();
  assert.equal(controller.peerAppVersion, '1.37.7-host');
  assert.equal(host.peerAppVersion, '1.38.0-controller');
});

withRig('a Host that never sends APP_HELLO is dropped after 10 seconds', async (rig) => {
  rig.net.tap.onSend = (role, data) => (role === 'host' && data[0] === 0x10 ? false : undefined);
  const host = rig.createLink('host');
  const controller = rig.createLink('controller');
  host.start();
  await rig.settle();
  controller.start();
  await rig.settle();
  assert.equal(controller.status.state, 'connecting', 'the handshake finished but the session is not usable yet');
  assert.equal(controller.sessionActive, false);
  await rig.advance(10_000, 10_000);
  assert.equal(controller.status.reason, 'handshake-timeout');
  assert.equal(controller.status.retryInMs, 1000);
});

withRig('a Controller that never sends APP_HELLO is dropped by the Host after 10 seconds, which stays connected', async (rig) => {
  rig.net.tap.onSend = (role, data) => (role === 'controller' && data[0] === 0x10 ? false : undefined);
  const host = rig.createLink('host');
  const controller = rig.createLink('controller');
  host.start();
  await rig.settle();
  controller.start();
  await rig.settle();
  assert.equal(host.sessionActive, false);
  await rig.advance(10_000, 10_000);
  assert.equal(host.sessionActive, false);
  assert.equal(host.status.state, 'online');
  assert.equal(host.status.reason, null);
});

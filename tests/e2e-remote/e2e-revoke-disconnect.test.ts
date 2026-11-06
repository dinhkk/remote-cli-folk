// Host-side control over a paired Controller (AC-10, AC-11): Disconnect ends the streams within 5 s and the
// Controller may come back; Accept off ends them too; Revoke is final: the Controller reaches `revoked`,
// never reconnects, and cannot open tabs any more.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { RemoteSocket } from './support/e2e-browser-client.js';
import { startWorld, waitForPeerState, type RemoteWorld } from './support/e2e-world.js';
import { sleep, waitUntil } from './support/e2e-util.js';

describe('Disconnect, Accept off and Revoke', () => {
  let world: RemoteWorld;
  beforeEach(async () => {
    world = await startWorld();
  });
  afterEach(async () => {
    await world.stop();
  });

  it('Disconnect closes the Controller streams within 5 s; the Controller can reconnect afterwards', async () => {
    const token = await world.tabToken();
    const chat = await world.openChat(token);
    const shell = await RemoteSocket.open(world.controller.baseUrl, world.peerId, 'shell', token);
    await sleep(300);

    const response = await world.manage(world.host, `/host/controllers/${world.hostPairingId}/disconnect`, 'POST');
    assert.equal(response.status, 200, response.text);
    const answeredAt = Date.now();
    await Promise.all([chat.waitForClose(5000), shell.waitForClose(5000)]);
    assert.ok(Date.now() - answeredAt <= 5000);

    // Not a revocation: the pairing survives and the link comes back (backoff 1 s .. 30 s).
    await waitForPeerState(world.controller, world.peerId, 'online', 60_000);
    const again = await waitUntil(() => world.openChat(token).catch(() => null), 'a new tab connection', 30_000);
    const sessionId = await world.createSession(token);
    again.send({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: 0 }] });
    await again.waitFor((m) => m.kind === 'chat_subscribed', 'chat_subscribed');
    again.close();
    const status = (await world.host.api('/api/remote/host/status')).json<{ controllers: Array<{ pairingId: string }> }>();
    assert.equal(status.controllers.length, 1, 'the pairing is still listed');
  });

  it('turning Accept off ends the streams and refuses new ones; turning it on again lets the Controller back in', async () => {
    const token = await world.tabToken();
    const chat = await world.openChat(token);
    await sleep(300);

    const off = await world.manage(world.host, '/host/accept', 'PUT', { enabled: false });
    assert.equal(off.status, 200, off.text);
    await chat.waitForClose(5000);
    await waitUntil(async () => (await world.viaRemote('/api/projects', { token })).status === 503, 'the Controller to see the Host go away', 30_000);
    await assert.rejects(RemoteSocket.open(world.controller.baseUrl, world.peerId, 'ws', token), (error: { status?: number }) => error.status === 503);

    const on = await world.manage(world.host, '/host/accept', 'PUT', { enabled: true });
    assert.equal(on.status, 200, on.text);
    await waitUntil(async () => (await world.viaRemote('/api/projects', { token })).status === 200, 'the Controller to be served again', 60_000);
  });

  it('Revoke is final: the Controller reaches revoked, stops reconnecting and cannot open a tab (AC-11)', async () => {
    const token = await world.tabToken();
    const chat = await world.openChat(token);
    await sleep(300);

    const revoked = await world.manage(world.host, `/host/pairings/${world.hostPairingId}`, 'DELETE');
    assert.equal(revoked.status, 200, revoked.text);
    assert.equal(revoked.json<{ relayConfirmed: boolean }>().relayConfirmed, true, 'the relay destroyed the room');
    await chat.waitForClose(5000);
    await waitForPeerState(world.controller, world.peerId, 'revoked', 30_000);

    // No reconnect storm: the relay sees no new Controller connection while the pairing stays revoked.
    const connectionsBefore = world.relay.connectionCount();
    await sleep(8000);
    assert.equal(world.relay.connectionCount(), connectionsBefore, 'a revoked Controller does not retry');
    const view = await world.viaRemote('/api/projects', { token });
    assert.equal(view.status, 503);
    await assert.rejects(RemoteSocket.open(world.controller.baseUrl, world.peerId, 'ws', token), (error: { status?: number }) => error.status === 503);

    // The Host forgot the Controller's key: even turning Accept on does not bring it back.
    await world.manage(world.host, '/host/accept', 'PUT', { enabled: false });
    await world.manage(world.host, '/host/accept', 'PUT', { enabled: true });
    await sleep(3000);
    const peers = (await world.controller.api('/api/remote/peers')).json<Array<{ peerId: string; state: string }>>();
    assert.equal(peers.find((peer) => peer.peerId === world.peerId)?.state, 'revoked');
    const hostStatus = (await world.host.api('/api/remote/host/status')).json<{ controllers: Array<{ connected: boolean }> }>();
    assert.ok(hostStatus.controllers.every((controller) => !controller.connected));

    // The Controller can forget the dead pairing and the browser data goes with it.
    const forgotten = await world.controller.api(`/api/remote/peers/${world.peerId}`, { method: 'DELETE', body: {} });
    assert.equal(forgotten.status, 200, forgotten.text);
  });

  it('a wrong password does not revoke, and a missing one is a 401 that does not end the session', async () => {
    const wrong = await world.host.api(`/api/remote/host/pairings/${world.hostPairingId}`, { method: 'DELETE', body: { password: 'nope' } });
    assert.equal(wrong.status, 403);
    const missing = await world.host.api(`/api/remote/host/pairings/${world.hostPairingId}`, { method: 'DELETE', body: {} });
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get('x-auth-error'), null);
    await waitForPeerState(world.controller, world.peerId, 'online', 10_000);
  });
});

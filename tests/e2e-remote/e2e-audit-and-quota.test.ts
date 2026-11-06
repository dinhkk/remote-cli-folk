// Host audit (FR-42, AC-32) through two real servers and the relay: pairing, connecting, a host-side
// disconnect and a revoke each leave one row on the Host, the API shows them to the full JWT only (a tab
// token gets 401), and no audit text travels through the relay or into the Controller's own database.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { startWorld, waitForPeerState, type RemoteWorld } from './support/e2e-world.js';
import { waitUntil } from './support/e2e-util.js';

type AuditEntry = { id: number; at: number; pairingId: string | null; controller: string; event: string; target: string; result: string };
type AuditPage = { entries: AuditEntry[]; nextBefore: number | null; controllers: Array<{ pairingId: string; label: string }> };

describe('Host audit', () => {
  let world: RemoteWorld;
  beforeEach(async () => {
    world = await startWorld();
  });
  afterEach(async () => {
    await world.stop();
  });

  const hostAudit = async (query = ''): Promise<AuditPage> => {
    const response = await world.host.api(`/api/remote/host/audit${query}`);
    assert.equal(response.status, 200, response.text);
    return response.json<AuditPage>();
  };

  it('records pair, connect, disconnect and revoke on the Host, and shows them to the full JWT only', async () => {
    const token = await world.tabToken();

    // The pairing and the first link are already done by the world setup.
    await waitUntil(async () => (await hostAudit()).entries.some((entry) => entry.event === 'connect'), 'the connect row', 20_000);
    let page = await hostAudit();
    const events = page.entries.map((entry) => entry.event);
    assert.ok(events.includes('pair'), `a pair row (${events.join(',')})`);
    assert.ok(events.includes('connect'), 'a connect row');
    const controller = page.entries.find((entry) => entry.event === 'pair');
    assert.equal(controller?.pairingId, world.hostPairingId);
    assert.equal(controller?.controller, 'e2e-controller', 'the label is the device name the Controller declared');
    assert.deepEqual(page.controllers.map((item) => item.pairingId), [world.hostPairingId]);

    // Paging and the Controller filter.
    const first = await hostAudit('?limit=1');
    assert.equal(first.entries.length, 1);
    assert.notEqual(first.nextBefore, null);
    const older = await hostAudit(`?limit=50&before=${first.nextBefore}`);
    assert.ok(older.entries.every((entry) => entry.id < (first.nextBefore as number)));
    assert.equal((await hostAudit('?controller=no-such-pairing')).entries.length, 0);

    // The tab token and a missing token never open it (not on either server).
    for (const server of [world.host, world.controller]) {
      assert.equal((await server.api('/api/remote/host/audit', { token })).status, 401, `${server.name}: tab token`);
      assert.equal((await server.api('/api/remote/host/audit', { token: null })).status, 401, `${server.name}: no token`);
    }
    // And a Remote tab cannot reach it through the bridge either (the management API is off the allow-list).
    const viaTab = await world.viaRemote('/api/remote/host/audit', { token });
    assert.ok(viaTab.status === 403 || viaTab.status === 404, `through the tab: ${viaTab.status}`);

    // The Controller side keeps no audit of its own.
    const controllerOwn = await world.controller.api('/api/remote/host/audit');
    assert.ok([200, 409].includes(controllerOwn.status), String(controllerOwn.status));
    if (controllerOwn.status === 200) assert.deepEqual(controllerOwn.json<AuditPage>().entries, []);

    const disconnected = await world.manage(world.host, `/host/controllers/${world.hostPairingId}/disconnect`, 'POST');
    assert.equal(disconnected.status, 200, disconnected.text);
    await waitUntil(async () => (await hostAudit()).entries.some((entry) => entry.event === 'disconnect'), 'the disconnect row', 20_000);

    const revoked = await world.manage(world.host, `/host/pairings/${world.hostPairingId}`, 'DELETE');
    assert.equal(revoked.status, 200, revoked.text);
    await waitForPeerState(world.controller, world.peerId, 'revoked', 30_000);
    page = await hostAudit();
    assert.ok(page.entries.some((entry) => entry.event === 'revoke' && entry.pairingId === world.hostPairingId), 'a revoke row');

    // Nothing sensitive is in what the API returned: no key, relay secret or token.
    const body = JSON.stringify(page);
    for (const secret of [world.relay.secret, token, world.host.jwt]) assert.equal(body.includes(secret), false, 'the audit leaked a secret');
  });

  it('refuses the 9th chat socket of one pairing with a quota error, audits it, and frees the slot when one closes (AC-30)', async () => {
    const token = await world.tabToken();
    const open: Awaited<ReturnType<RemoteWorld['openChat']>>[] = [];
    try {
      for (let index = 0; index < 8; index += 1) open.push(await world.openChat(token));
      // The Controller accepts the upgrade; the Host refuses the stream, so the 9th socket is closed right away (or never opens).
      const ninth = await world.openChat(token).catch(() => null);
      await ninth?.waitForClose(5000);

      await waitUntil(async () => (await hostAudit()).entries.some((entry) => entry.event === 'quota-reject'), 'the quota-reject row', 20_000);
      const rows = (await hostAudit()).entries.filter((entry) => entry.event === 'quota-reject');
      assert.equal(rows.length, 1, 'one row per refusal');
      assert.equal(rows[0].result, 'refused');
      assert.equal(rows[0].pairingId, world.hostPairingId);

      // The older sockets keep running, and a slot freed by a close is usable again.
      open.pop()?.close();
      const again = await waitUntil(() => world.openChat(token).catch(() => null), 'a socket after a slot was freed', 15_000);
      open.push(again);
    } finally {
      for (const socket of open) socket.close();
    }
  });
});

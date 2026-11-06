/**
 * Idle expiry of pairings (FR-40, AC-29) on a manual clock: 30 days without activity -> `expired`, K gone,
 * the Controller cannot reconnect (410 at the proxy, state `expired` in the list), activity moves the
 * deadline, the Host side tears the link down and still owes the relay a DESTROY, the periodic job and the
 * check at connect time both apply the rule, and the real store erases K.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';

import type { HostBridge } from '@/modules/remote/bridge/host-bridge.js';
import type { RemoteAuditEvent, RemoteAuditSubject } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { createPeerRegistry } from '../../controller/peer-registry.service.js';
import { createSecretBox } from '../../crypto/secret-box.js';
import { createHostAcceptService } from '../../host/host-accept.service.js';
import { createPairingExpiryService, resolveIdleDays } from '../../pairing/pairing-expiry.service.js';
import { createPairingStore } from '../../pairing/pairing-store.service.js';
import { createFakeLink } from '../support/fake-link.js';
import { createManualClock } from '../support/manual-clock.js';
import { createMemoryPairingStore } from '../support/memory-pairing-store.js';
import { withTempDatabase } from '../support/temp-database.js';

const DAY = 86_400_000;
const START = 1_800_000_000_000;

const noBridge = (): HostBridge => ({
  handleStream: () => undefined,
  attach: () => () => undefined,
  activeStreams: 0,
  suppressedViolations: 0,
  closeAll: () => undefined,
});

const arrange = (idleDays = 30) => {
  const clock = createManualClock(START);
  const store = createMemoryPairingStore(clock.now);
  const audit: Array<{ subject: RemoteAuditSubject; event: RemoteAuditEvent }> = [];
  const destroyed: string[] = [];
  const dropped: string[] = [];
  let hostAccept!: ReturnType<typeof createHostAcceptService>;
  const expiry = createPairingExpiryService({
    store,
    clock,
    idleDays,
    onControllerExpired: (record) => dropped.push(record.id),
    expireHostPairings: () => hostAccept.expireIdlePairings(),
  });
  const registry = createPeerRegistry({
    store,
    expiry,
    getRelaySecret: () => 'a'.repeat(32),
    isSupported: () => true,
    clock,
    appVersion: 'test',
    createLink: () => createFakeLink('controller'),
  });
  hostAccept = createHostAcceptService({
    store,
    settings: { get: () => null, set: () => undefined },
    getRelaySecret: () => 's'.repeat(40),
    isSupported: () => true,
    clock,
    appVersion: 'host-test',
    createLink: () => createFakeLink('host'),
    createBridge: noBridge,
    pendingDestroy: { destroyNow: (id) => (destroyed.push(id), Promise.resolve(true)) },
    approvalTimeoutMs: () => 55_000,
    audit: { record: (subject, event) => void audit.push({ subject, event }) },
    expiry,
  });
  return { clock, store, expiry, registry, hostAccept, audit, destroyed, dropped };
};

describe('idle expiry of pairings', () => {
  it('reads the idle days from the environment: 30 by default, 0 = never, garbage = default', () => {
    assert.equal(resolveIdleDays(undefined), 30);
    assert.equal(resolveIdleDays(''), 30);
    assert.equal(resolveIdleDays('7'), 7);
    assert.equal(resolveIdleDays('0'), 0);
    assert.equal(resolveIdleDays('-1'), 30);
    assert.equal(resolveIdleDays('soon'), 30);
    assert.equal(resolveIdleDays('1.5'), 30);
  });

  it('a Controller pairing idle for 30 days becomes `expired`: K is deleted, no link, 410 at the proxy, listed as expired', () => {
    const { clock, store, registry, dropped } = arrange();
    const record = store.add({ role: 'controller', name: 'Work PC' });
    assert.notEqual(registry.listPeers()[0].state, 'expired');
    clock.advance(30 * DAY - 1000);
    assert.notEqual(registry.listPeers()[0].state, 'expired', 'one second short of the limit');

    clock.advance(2000);
    const [peer] = registry.listPeers();
    assert.equal(peer.state, 'expired');
    assert.equal(registry.isExpired(record.id), true);
    assert.equal(store.keys.has(record.id), false, 'the sealed key is gone');
    assert.throws(() => store.openPairingKey(record.id));
    assert.throws(
      () => registry.attach(record.id),
      (error: unknown) => error instanceof AppError && error.statusCode === 410 && error.code === 'REMOTE_PEER_EXPIRED',
    );
    assert.equal(registry.openLinkCount, 0, 'the open link was dropped when the pairing expired');
    assert.ok(dropped.includes(record.id));
    assert.equal(registry.hasPeer(record.id), true, 'it stays listed so it can be forgotten and paired again');
  });

  it('activity renews the deadline: a pairing used every 20 days never expires; one that was not used for 30 days does', () => {
    const { clock, store, registry } = arrange();
    const busy = store.add({ role: 'controller', name: 'Busy' });
    const idle = store.add({ role: 'controller', name: 'Idle' });
    for (let round = 0; round < 4; round += 1) {
      clock.advance(20 * DAY);
      registry.attach(busy.id); // a proxied request marks activity
    }
    const states = Object.fromEntries(registry.listPeers().map((peer) => [peer.name, peer.state]));
    assert.notEqual(states.Busy, 'expired');
    assert.equal(states.Idle, 'expired');
  });

  it('a link that connected counts as activity (the session-up mark)', () => {
    const { clock, store, registry } = arrange();
    const record = store.add({ role: 'controller', name: 'Host' });
    clock.advance(29 * DAY);
    store.markConnected(record.id);
    clock.advance(29 * DAY);
    assert.notEqual(registry.listPeers()[0].state, 'expired');
    clock.advance(2 * DAY);
    assert.equal(registry.listPeers()[0].state, 'expired');
  });

  it('with idle days 0 nothing ever expires', () => {
    const { clock, store, registry } = arrange(0);
    store.add({ role: 'controller', name: 'Forever' });
    clock.advance(3650 * DAY);
    assert.notEqual(registry.listPeers()[0].state, 'expired');
  });

  it('the periodic job expires idle pairings of both roles without anybody using them, and audits the Host side', async () => {
    const { clock, store, expiry, hostAccept, audit, destroyed } = arrange();
    const controller = store.add({ role: 'controller', name: 'A Host' });
    const host = store.add({ role: 'host', name: 'A Controller' });
    hostAccept.setAccept({ enabled: true });
    expiry.start();
    clock.advance(31 * DAY);
    await new Promise((resolve) => setImmediate(resolve)); // the audit row waits for the relay DESTROY attempt
    assert.ok(store.getPairing(controller.id)?.expiresAt !== null, 'the Controller pairing expired by itself');
    assert.equal(store.keys.has(controller.id), false);
    assert.equal(store.getPairing(host.id)?.revokedAt !== null, true, 'the Host pairing is closed for good');
    assert.equal(store.keys.has(host.id), false);
    assert.ok(destroyed.includes(host.id), 'the relay room is destroyed (or owed)');
    const expired = audit.filter((entry) => entry.event.event === 'expire');
    assert.equal(expired.length, 1);
    assert.deepEqual(expired[0].subject, { pairingId: host.id, label: 'A Controller' });
    expiry.stop();
    hostAccept.stop();
    assert.equal(clock.pendingTimers(), 0);
  });

  it('a Host pairing that is idle is not served: the check at connect time expires it before a link is opened', () => {
    const { clock, store, hostAccept } = arrange();
    const host = store.add({ role: 'host', name: 'Old Controller' });
    clock.advance(31 * DAY);
    const status = hostAccept.setAccept({ enabled: true });
    assert.deepEqual(status.controllers, []);
    assert.equal(store.calls.filter((call) => call === `openPairingKey:${host.id}`).length, 0, 'its key was never opened');
    assert.equal(store.getPairing(host.id)?.revokedAt !== null, true);
    hostAccept.stop();
  });

  it('the real store: expiring a Host pairing keeps only the sealed DESTROY record, a Controller pairing keeps its row without K', async () => {
    await withTempDatabase(() => {
      const box = createSecretBox(Buffer.alloc(32, 7));
      let now = START;
      const store = createPairingStore({ box, now: () => now });
      const host = store.insertPairing({ role: 'host', peerName: 'Phone', k: crypto.randomBytes(32), relayUrl: 'wss://relay.test' });
      const controller = store.insertPairing({ role: 'controller', peerName: 'Work PC', k: crypto.randomBytes(32), relayUrl: 'wss://relay.test' });
      now += 31 * DAY;

      const expiredHost = store.expirePairing(host.id);
      assert.equal(expiredHost.expiresAt, now);
      assert.notEqual(expiredHost.revokedAt, null);
      assert.equal(expiredHost.pendingDestroy, true);
      assert.throws(() => store.openPairingKey(host.id));
      assert.equal(store.listPendingDestroy().length, 1, 'the relay can still be told to destroy the room');

      const expiredController = store.expirePairing(controller.id);
      assert.equal(expiredController.expiresAt, now);
      assert.equal(expiredController.revokedAt, null);
      assert.throws(() => store.openPairingKey(controller.id));
      assert.equal(store.getPairing(controller.id)?.peerName, 'Work PC');

      // Expiring twice changes nothing.
      now += DAY;
      assert.equal(store.expirePairing(controller.id).expiresAt, expiredController.expiresAt);
      assert.equal(store.expirePairing(host.id).expiresAt, expiredHost.expiresAt);
    });
  });
});

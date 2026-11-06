/**
 * What renews a pairing's idle timer (FR-40): real use only. A Settings tab that lists the Hosts (and so opens
 * their links) does not keep a pairing alive for ever; a tab or proxied request (a tab token), and on the Host
 * side a Controller that really completes the K handshake, do. Status and list reads never write activity.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { HostBridge } from '@/modules/remote/bridge/host-bridge.js';

import { createPeerRegistry } from '../../controller/peer-registry.service.js';
import { createHostAcceptService } from '../../host/host-accept.service.js';
import { createPairingExpiryService } from '../../pairing/pairing-expiry.service.js';
import { createFakeLink, type FakeLink } from '../support/fake-link.js';
import { createManualClock } from '../support/manual-clock.js';
import { createMemoryPairingStore } from '../support/memory-pairing-store.js';

const DAY = 86_400_000;
const START = 1_800_000_000_000;

const noBridge = (): HostBridge => ({
  handleStream: () => undefined,
  attach: () => () => undefined,
  activeStreams: 0,
  suppressedViolations: 0,
  closeAll: () => undefined,
});

const arrangeController = () => {
  const clock = createManualClock(START);
  const store = createMemoryPairingStore(clock.now);
  const links: FakeLink[] = [];
  const expiry = createPairingExpiryService({ store, clock, idleDays: 30, onControllerExpired: () => undefined, expireHostPairings: () => 0 });
  const registry = createPeerRegistry({
    store,
    expiry,
    getRelaySecret: () => 'a'.repeat(32),
    isSupported: () => true,
    clock,
    appVersion: 'test',
    createLink: () => {
      const link = createFakeLink('controller');
      links.push(link);
      return link;
    },
  });
  return { clock, store, links, registry };
};

describe('Controller: a Settings tab that lists the Hosts does not keep a pairing alive', () => {
  it('listing opens the link and the session-up records "last connected" but not activity; the pairing still expires after 30 idle days', () => {
    const { clock, store, links, registry } = arrangeController();
    const record = store.add({ role: 'controller', name: 'Work PC' });
    clock.advance(20 * DAY);

    registry.listPeers();
    links[0].setSession(true); // the K handshake with an online Host succeeded because the list opened the link
    assert.equal(store.getPairing(record.id)?.lastConnectedAt, START + 20 * DAY, 'last connected is still recorded');
    assert.equal(store.getPairing(record.id)?.lastActivityAt, null, 'but the list did not renew the idle timer');
    assert.equal(store.calls.some((call) => call.startsWith('touchActivity:')), false);

    clock.advance(11 * DAY);
    registry.listPeers();
    registry.listPeers();
    assert.equal(registry.listPeers()[0].state, 'expired', 'a tab left open on the Settings page cannot prolong the pairing');
  });

  it('opening a tab or proxying a request renews activity, also when the session comes up after the attach', () => {
    const { clock, store, links, registry } = arrangeController();
    const record = store.add({ role: 'controller', name: 'Work PC' });
    clock.advance(20 * DAY);

    registry.attach(record.id); // a tab token was used
    assert.equal(store.getPairing(record.id)?.lastActivityAt, START + 20 * DAY);
    links[0].setSession(true);
    clock.advance(20 * DAY);
    registry.attach(record.id);
    assert.equal(store.getPairing(record.id)?.lastActivityAt, START + 40 * DAY, 'still renewed 20 days later');
    assert.notEqual(registry.listPeers()[0].state, 'expired');
  });

  it('a link that was opened by attach and whose session comes up later counts as used', () => {
    const { clock, store, links, registry } = arrangeController();
    const record = store.add({ role: 'controller', name: 'Work PC' });
    clock.advance(25 * DAY);
    registry.attach(record.id);
    clock.advance(60_000); // inside the write throttle of attach: only the session-up can move the mark now
    links[0].setSession(true);
    assert.equal(store.getPairing(record.id)?.lastActivityAt, START + 25 * DAY + 60_000);
  });
});

describe('Host: status reads never write activity, a real Controller handshake does', () => {
  it('status() and syncLinks() open links but write nothing; the session-up of a Controller renews', () => {
    const clock = createManualClock(START);
    const store = createMemoryPairingStore(clock.now);
    const links: FakeLink[] = [];
    const service = createHostAcceptService({
      store,
      settings: { get: () => null, set: () => undefined },
      getRelaySecret: () => 's'.repeat(40),
      isSupported: () => true,
      clock,
      appVersion: 'host-test',
      createLink: () => {
        const link = createFakeLink('host');
        links.push(link);
        return link;
      },
      createBridge: noBridge,
      pendingDestroy: { destroyNow: () => Promise.resolve(true) },
      approvalTimeoutMs: () => 55_000,
    });
    const record = store.add({ role: 'host', name: 'Phone' });
    service.setAccept({ enabled: true });
    for (let index = 0; index < 5; index += 1) {
      service.status();
      service.syncLinks();
      clock.advance(DAY);
    }
    assert.equal(store.calls.some((call) => call.startsWith('markConnected:') || call.startsWith('touchActivity:')), false, 'reads wrote nothing');
    assert.equal(store.getPairing(record.id)?.lastActivityAt, null);

    links[0].setSession(true); // the Controller really connected: K handshake done
    assert.equal(store.getPairing(record.id)?.lastActivityAt, START + 5 * DAY);
    service.stop();
  });
});

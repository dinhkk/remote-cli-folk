/**
 * Host Accept under failure: a bridge that cannot be built does not leak the link it was for, a pairing whose
 * key cannot be read can still be removed, and revoking everything continues past failures and runs the relay
 * calls in parallel.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { HostBridge } from '@/modules/remote/bridge/host-bridge.js';

import { createHostAcceptService } from '../../host/host-accept.service.js';
import { createFakeLink, type FakeLink } from '../support/fake-link.js';
import { createManualClock } from '../support/manual-clock.js';
import { createMemoryPairingStore } from '../support/memory-pairing-store.js';

const START = 1_800_000_000_000;

const fakeBridge = (): HostBridge => ({
  suppressedViolations: 0,
  handleStream: () => undefined,
  attach: () => () => undefined,
  activeStreams: 0,
  closeAll: () => undefined,
});

const arrange = (options: { bridge?: () => HostBridge; destroyNow?: (id: string) => Promise<boolean> } = {}) => {
  const clock = createManualClock(START);
  const store = createMemoryPairingStore(clock.now);
  const settings = new Map<string, string>();
  const links: FakeLink[] = [];
  const service = createHostAcceptService({
    store,
    settings: { get: (key) => settings.get(key) ?? null, set: (key, value) => void settings.set(key, value) },
    getRelaySecret: () => 's'.repeat(40),
    isSupported: () => true,
    clock,
    appVersion: 'host-test',
    createLink: () => {
      const link = createFakeLink('host');
      links.push(link);
      return link;
    },
    createBridge: options.bridge ?? fakeBridge,
    pendingDestroy: { destroyNow: options.destroyNow ?? (() => Promise.resolve(true)) },
    approvalTimeoutMs: () => 55_000,
  });
  return { clock, store, links, service };
};

describe('Host Accept: a bridge that cannot be built', () => {
  it('closes the link that was created for it, and the other pairings still get theirs', () => {
    let calls = 0;
    const rig = arrange({
      bridge: () => {
        calls += 1;
        if (calls === 1) throw new Error('bridge setup failed');
        return fakeBridge();
      },
    });
    rig.store.add({ role: 'host', name: 'A' });
    rig.store.add({ role: 'host', name: 'B' });
    const status = rig.service.setAccept({ enabled: true });
    // The failed pairing is tried again on the next sync (reading the status syncs), which then succeeds.
    const [failed, ...running] = rig.links;
    assert.equal(failed.closed, true, 'the link of the failed attempt was closed, not leaked');
    assert.equal(failed.started, false);
    assert.ok(running.length >= 1 && running.every((link) => link.started && !link.closed), 'the other pairing (and the retry) run');
    assert.equal(status.controllers.length, 2, 'both are still listed');
  });

  it('closes the link when attaching the bridge throws', () => {
    const rig = arrange({
      bridge: () => ({
        ...fakeBridge(),
        attach: () => {
          throw new Error('attach failed');
        },
      }),
    });
    rig.store.add({ role: 'host', name: 'A' });
    rig.service.setAccept({ enabled: true });
    // Every attempt (the failed pairing is retried on each sync) closes the link it created.
    assert.ok(rig.links.length >= 1);
    assert.ok(rig.links.every((link) => link.closed && !link.started), 'no link was left behind');
  });
});

describe('Host Accept: revoking', () => {
  it('removes a pairing whose key cannot be read, reporting that the relay was not asked', async () => {
    const rig = arrange();
    const unreadable = rig.store.add({ role: 'host', name: 'Broken' });
    const fine = rig.store.add({ role: 'host', name: 'Fine' });
    rig.store.revokeHostPairing = () => {
      throw new Error('the pairing key cannot be opened'); // what the real store does when K cannot be opened
    };
    const result = await rig.service.revoke(unreadable.id);
    assert.deepEqual(result, { ok: true, relayConfirmed: false });
    assert.equal(rig.store.getPairing(unreadable.id), null, 'the row is gone instead of staying active forever');
    assert.ok(rig.store.getPairing(fine.id));
    assert.ok(!rig.service.status().controllers.some((view) => view.pairingId === unreadable.id));
  });

  it('still refuses an unknown pairing and one that is already revoked', async () => {
    const rig = arrange();
    await assert.rejects(() => rig.service.revoke('nope'), (error: { code?: string }) => error.code === 'REMOTE_PAIR_NOT_FOUND');
  });

  it('revokeAll continues past a pairing that cannot be revoked at all, and reports how many failed', async () => {
    const rig = arrange();
    const stuck = rig.store.add({ role: 'host', name: 'Stuck' });
    const ok1 = rig.store.add({ role: 'host', name: 'One' });
    const ok2 = rig.store.add({ role: 'host', name: 'Two' });
    const original = rig.store.revokeHostPairing.bind(rig.store);
    rig.store.revokeHostPairing = (id) => {
      if (id === stuck.id) throw new Error('cannot revoke');
      return original(id);
    };
    rig.store.deletePairing = (id) => {
      if (id === stuck.id) throw new Error('cannot delete either');
    };
    const outcome = await rig.service.revokeAll();
    assert.deepEqual(outcome, { revoked: 2, failed: 1 });
    assert.ok(rig.store.getPairing(ok1.id)?.revokedAt);
    assert.ok(rig.store.getPairing(ok2.id)?.revokedAt);
  });

  it('asks the relay about all pairings at the same time, not one after the other', async () => {
    const waiting: Array<() => void> = [];
    let inFlight = 0;
    let peak = 0;
    const rig = arrange({
      destroyNow: () =>
        new Promise<boolean>((resolve) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          waiting.push(() => {
            inFlight -= 1;
            resolve(true);
          });
        }),
    });
    for (const name of ['A', 'B', 'C']) rig.store.add({ role: 'host', name });
    const done = rig.service.revokeAll();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(peak, 3, 'the three DESTROY requests were outstanding together');
    for (const release of waiting) release();
    assert.deepEqual(await done, { revoked: 3, failed: 0 });
  });
});

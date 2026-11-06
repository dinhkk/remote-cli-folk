/**
 * Host Accept: a suspended (auto-disconnected) pairing stays suspended until its time is up (also when the
 * owner presses Disconnect, and also when the wall clock jumps), the Host view says until when, and idle
 * expiry deletes a pairing only when its key can never be opened again, never on a transient database error,
 * and can never throw out of `status()`, `syncLinks()` or `restore()`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { HostBridge } from '@/modules/remote/bridge/host-bridge.js';
import type { RemoteAuditEvent, RemoteAuditSubject } from '@/shared/types.js';

import { SecretBoxError } from '../../crypto/secret-box.js';
import { createHostAcceptService } from '../../host/host-accept.service.js';
import { createFakeLink, type FakeLink } from '../support/fake-link.js';
import { createManualClock } from '../support/manual-clock.js';
import { createMemoryPairingStore } from '../support/memory-pairing-store.js';

const START = 1_800_000_000_000;
const HOUR = 3_600_000;

const fakeBridge = (): HostBridge => ({
  suppressedViolations: 0,
  handleStream: () => undefined,
  attach: () => () => undefined,
  activeStreams: 0,
  closeAll: () => undefined,
});

const arrange = (options: { destroyNow?: (id: string) => Promise<boolean>; settings?: Map<string, string> } = {}) => {
  const clock = createManualClock(START);
  const store = createMemoryPairingStore(clock.now);
  const settings = options.settings ?? new Map<string, string>();
  const links: FakeLink[] = [];
  const audit: Array<{ subject: RemoteAuditSubject; event: RemoteAuditEvent }> = [];
  let monotonic = 1_000;
  const idle = new Set<string>();
  const service = createHostAcceptService({
    store,
    settings: { get: (key) => settings.get(key) ?? null, set: (key, value) => void settings.set(key, value) },
    getRelaySecret: () => 's'.repeat(40),
    isSupported: () => true,
    clock,
    monotonicNow: () => monotonic,
    appVersion: 'host-test',
    createLink: () => {
      const link = createFakeLink('host');
      links.push(link);
      return link;
    },
    createBridge: fakeBridge,
    pendingDestroy: { destroyNow: options.destroyNow ?? (() => Promise.resolve(true)) },
    approvalTimeoutMs: () => 55_000,
    audit: { record: (subject, event) => void audit.push({ subject, event }) },
    expiry: { isIdleExpired: (record) => idle.has(record.id) },
  });
  return {
    clock,
    store,
    links,
    audit,
    idle,
    service,
    settings,
    advanceMonotonic: (ms: number) => void (monotonic += ms),
    expireEvents: () => audit.filter((entry) => entry.event.event === 'expire'),
  };
};

describe('Host Accept: suspension', () => {
  it('the Host view says until when a suspended Controller cannot reconnect, and the time passes', () => {
    const rig = arrange();
    const pairing = rig.store.add({ role: 'host', name: 'Phone' });
    rig.service.setAccept({ enabled: true });
    assert.equal(rig.links.length, 1);

    rig.service.suspend(pairing.id, 300_000);
    assert.equal(rig.links[0].closed, true);
    const [view] = rig.service.status().controllers;
    assert.equal(view.suspendedUntil, START + 300_000);
    assert.equal(view.connected, false);
    assert.equal(rig.links.length, 1, 'no new link while suspended');

    rig.advanceMonotonic(299_000);
    assert.equal(rig.service.status().controllers[0].suspendedUntil, START + 300_000);
    assert.equal(rig.links.length, 1);

    rig.advanceMonotonic(2_000);
    const after = rig.service.status();
    assert.equal(after.controllers[0].suspendedUntil, undefined, 'the suspension is over and its record is gone');
    assert.equal(rig.links.length, 2, 'the link is offered again');
    assert.equal(rig.links[1].started, true);
  });

  it('the owner pressing Disconnect on a suspended Controller does not reopen its link', () => {
    const rig = arrange();
    const pairing = rig.store.add({ role: 'host', name: 'Phone' });
    rig.service.setAccept({ enabled: true });
    rig.service.suspend(pairing.id, 300_000);
    rig.service.disconnect(pairing.id);
    assert.equal(rig.links.length, 1, 'still only the first (closed) link');
  });

  it('the suspension is measured on a monotonic clock: a wall-clock step does not shorten or lengthen it', () => {
    const rig = arrange();
    const pairing = rig.store.add({ role: 'host', name: 'Phone' });
    rig.service.setAccept({ enabled: true });
    rig.service.suspend(pairing.id, 300_000);

    rig.clock.advance(-HOUR); // the wall clock jumps back an hour
    rig.advanceMonotonic(301_000); // while 301 real seconds pass
    rig.service.status();
    assert.equal(rig.links.length, 2, 'it is over after 300 real seconds, whatever the wall clock says');

    rig.service.suspend(pairing.id, 300_000);
    rig.clock.advance(10 * HOUR); // the wall clock jumps forward
    rig.advanceMonotonic(1_000);
    rig.service.status();
    assert.equal(rig.links.length, 2, 'still suspended: only 1 real second has passed');
  });
});

describe('Host Accept: idle expiry never throws and never deletes on a transient error', () => {
  const failing = (rig: ReturnType<typeof arrange>, error: Error) => {
    rig.store.expirePairing = () => {
      throw error;
    };
  };

  it('a transient store error (SQLITE_BUSY) leaves the pairing alone, throws nothing, and the next tick expires it', async () => {
    const rig = arrange();
    const pairing = rig.store.add({ role: 'host', name: 'Old' });
    rig.idle.add(pairing.id);
    const working = rig.store.expirePairing.bind(rig.store);
    failing(rig, new Error('SQLITE_BUSY: database is locked'));

    assert.doesNotThrow(() => rig.service.status());
    assert.doesNotThrow(() => rig.service.syncLinks());
    assert.doesNotThrow(() => rig.service.setAccept({ enabled: true }));
    assert.doesNotThrow(() => rig.service.expireIdlePairings());
    assert.ok(rig.store.getPairing(pairing.id), 'the row (and its pending-DESTROY record) was not deleted');
    assert.equal(rig.store.calls.some((call) => call === `delete:${pairing.id}`), false);
    assert.equal(rig.expireEvents().length, 0, 'nothing is claimed as expired yet');
    assert.equal(rig.links.length, 0, 'an idle-expired pairing is not served while it waits for the retry');

    rig.store.expirePairing = working; // the database is back
    assert.equal(rig.service.expireIdlePairings(), 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rig.expireEvents().length, 1);
    assert.notEqual(rig.store.getPairing(pairing.id)?.revokedAt, null);
  });

  it('restore() survives a transient error at start', () => {
    const settings = new Map([['remote.accept_enabled', '1'], ['remote.accept_enabled_at', String(START)]]);
    const rig = arrange({ settings });
    const pairing = rig.store.add({ role: 'host', name: 'Old' });
    rig.idle.add(pairing.id);
    failing(rig, new Error('SQLITE_BUSY: database is locked'));
    assert.doesNotThrow(() => rig.service.restore());
    assert.ok(rig.store.getPairing(pairing.id));
  });

  it('a key that can never be opened (the sealed key is unreadable) deletes the pairing, which is the only case where it does', async () => {
    const rig = arrange();
    const pairing = rig.store.add({ role: 'host', name: 'Broken key' });
    rig.idle.add(pairing.id);
    failing(rig, new SecretBoxError('decrypt-failed', 'cannot open'));
    rig.service.setAccept({ enabled: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rig.store.getPairing(pairing.id), null);
    const [event] = rig.expireEvents();
    assert.equal(event.event.result, 'ok');
    assert.deepEqual(event.event.detail, { relayDestroy: 'not-owed' });
  });

  it('a store that cannot even delete cannot break status(), syncLinks() or restore()', () => {
    const rig = arrange();
    const pairing = rig.store.add({ role: 'host', name: 'Broken key' });
    rig.idle.add(pairing.id);
    failing(rig, new SecretBoxError('decrypt-failed', 'cannot open'));
    rig.store.deletePairing = () => {
      throw new Error('SQLITE_BUSY: database is locked');
    };
    assert.doesNotThrow(() => rig.service.status());
    assert.doesNotThrow(() => rig.service.syncLinks());
    assert.doesNotThrow(() => rig.service.setAccept({ enabled: true }));
    assert.doesNotThrow(() => rig.service.expireIdlePairings());
    assert.equal(rig.expireEvents().length, 0, 'nothing was deleted, so nothing is reported');
  });
});

describe('Host Accept: the expire audit row says how the relay DESTROY went', () => {
  const run = async (destroyNow: (id: string) => Promise<boolean>) => {
    const rig = arrange({ destroyNow });
    const pairing = rig.store.add({ role: 'host', name: 'Old' });
    rig.idle.add(pairing.id);
    rig.service.setAccept({ enabled: true });
    await new Promise((resolve) => setImmediate(resolve));
    const [event] = rig.expireEvents();
    assert.ok(event, 'one expire row');
    return event.event;
  };

  it('confirmed by the relay: ok', async () => {
    const event = await run(() => Promise.resolve(true));
    assert.equal(event.result, 'ok');
    assert.deepEqual(event.detail, { relayDestroy: 'confirmed' });
  });

  it('not confirmed (the relay is unreachable): ok, queued for the retries', async () => {
    const event = await run(() => Promise.resolve(false));
    assert.equal(event.result, 'ok');
    assert.deepEqual(event.detail, { relayDestroy: 'queued' });
  });

  it('the attempt itself failed: error, and the retrier still owes the DESTROY', async () => {
    const event = await run(() => Promise.reject(new Error('socket hang up')));
    assert.equal(event.result, 'error');
    assert.deepEqual(event.detail, { relayDestroy: 'failed' });
  });
});

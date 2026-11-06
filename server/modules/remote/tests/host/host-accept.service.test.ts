/**
 * Host Accept (FR-5/6/14/15/16/17): the switch that opens one relay link per paired Controller, the
 * persisted auto-off, the Controller list, disconnect and revoke. Links, bridge and relay are fakes; the
 * clock is manual, so the 60-second auto-off tick and a restart run instantly.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { HostBridge } from '@/modules/remote/bridge/host-bridge.js';
import { AppError } from '@/shared/utils.js';

import { createHostAcceptService } from '../../host/host-accept.service.js';
import type { RelayLinkOptions } from '../../link/relay-link.js';
import { createFakeLink, type FakeLink } from '../support/fake-link.js';
import { createManualClock, type ManualClock } from '../support/manual-clock.js';
import { createMemoryPairingStore, type MemoryPairingStore } from '../support/memory-pairing-store.js';

const HOUR = 3_600_000;
const START = 1_800_000_000_000;

type FakeBridge = HostBridge & { attached: unknown[]; closeAllCalls: number; streams: number };

const createFakeBridge = (): FakeBridge => {
  const bridge: FakeBridge = {
    attached: [],
    closeAllCalls: 0,
    streams: 0,
    suppressedViolations: 0,
    handleStream: () => undefined,
    attach(link) {
      bridge.attached.push(link);
      return () => undefined;
    },
    get activeStreams() {
      return bridge.streams;
    },
    closeAll() {
      bridge.closeAllCalls += 1;
    },
  };
  return bridge;
};

type Rig = ReturnType<typeof arrange>;

function arrange(options: { supported?: boolean; secret?: string | null; settings?: Map<string, string>; store?: MemoryPairingStore; clock?: ManualClock } = {}) {
  const clock = options.clock ?? createManualClock(START);
  const store = options.store ?? createMemoryPairingStore(clock.now);
  const settings = options.settings ?? new Map<string, string>();
  const state = { supported: options.supported ?? true, secret: options.secret === undefined ? 's'.repeat(40) : options.secret, destroyConfirms: true, timeoutMs: 55_000 };
  const links: Array<{ link: FakeLink; options: RelayLinkOptions }> = [];
  const bridges: FakeBridge[] = [];
  const destroyed: string[] = [];
  const service = createHostAcceptService({
    store,
    settings: { get: (key) => settings.get(key) ?? null, set: (key, value) => void settings.set(key, value) },
    getRelaySecret: () => state.secret,
    isSupported: () => state.supported,
    clock,
    appVersion: 'host-test',
    createLink: (linkOptions) => {
      const link = createFakeLink('host');
      links.push({ link, options: linkOptions });
      return link;
    },
    createBridge: () => {
      const bridge = createFakeBridge();
      bridges.push(bridge);
      return bridge;
    },
    pendingDestroy: {
      destroyNow: (id) => {
        destroyed.push(id);
        return Promise.resolve(state.destroyConfirms);
      },
    },
    approvalTimeoutMs: () => state.timeoutMs,
  });
  return { clock, store, settings, state, links, bridges, destroyed, service };
}

const hostPairing = (rig: Rig, name = 'Laptop', extra: { expiresAt?: number | null } = {}) => rig.store.add({ role: 'host', name, ...extra });

const refusal = (run: () => unknown): AppError => {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof AppError, `expected an AppError, got ${String(error)}`);
    return error;
  }
  throw new Error('expected a refusal');
};

describe('Host Accept: switching on and off', () => {
  let rig: Rig;
  beforeEach(() => {
    rig = arrange();
  });

  it('is off until switched on, and shows no relay activity', () => {
    const status = rig.service.status();
    assert.equal(status.acceptEnabled, false);
    assert.equal(status.relay.state, 'stopped');
    assert.equal(status.autoOffAt, null);
    assert.equal(rig.links.length, 0);
  });

  it('switching on opens one Host link per active Host pairing, with the bridge attached and no secret in the answer', () => {
    const a = hostPairing(rig, 'Phone');
    hostPairing(rig, 'Tablet');
    rig.store.add({ role: 'controller', name: 'Not a Host pairing' });
    const revoked = hostPairing(rig, 'Old');
    rig.store.revokeHostPairing(revoked.id);
    hostPairing(rig, 'Stale', { expiresAt: START - 1 });

    const status = rig.service.setAccept({ enabled: true });
    assert.equal(status.acceptEnabled, true);
    assert.equal(rig.links.length, 2);
    assert.ok(rig.links.every(({ link, options }) => link.started && options.role === 'host' && options.appVersion === 'host-test'));
    assert.ok(rig.links.every(({ options }) => options.relaySecret === 's'.repeat(40)));
    assert.equal(rig.bridges.length, 2);
    assert.ok(rig.bridges.every((bridge) => bridge.attached.length === 1));
    assert.equal(status.controllers.length, 2);
    assert.ok(status.controllers.some((view) => view.pairingId === a.id && view.name === 'Phone'));
    const serialized = JSON.stringify(status);
    assert.ok(!serialized.includes('s'.repeat(40)), 'the relay secret is not part of the status');
  });

  it('persists the switch in the remote.* keys', () => {
    rig.service.setAccept({ enabled: true, autoOffHours: 8 });
    assert.equal(rig.settings.get('remote.accept_enabled'), '1');
    assert.equal(rig.settings.get('remote.accept_auto_off_hours'), '8');
    assert.equal(rig.settings.get('remote.accept_enabled_at'), String(START));
    rig.service.setAccept({ enabled: false });
    assert.equal(rig.settings.get('remote.accept_enabled'), '0');
  });

  it('switching off closes every link, cuts every stream and reports stopped', () => {
    hostPairing(rig);
    hostPairing(rig);
    rig.service.setAccept({ enabled: true });
    const status = rig.service.setAccept({ enabled: false });
    assert.equal(status.acceptEnabled, false);
    assert.equal(status.relay.state, 'stopped');
    assert.ok(rig.links.every(({ link }) => link.closed));
    assert.ok(rig.bridges.every((bridge) => bridge.closeAllCalls >= 1));
    assert.equal(rig.clock.pendingTimers(), 0, 'no timer is left running');
  });

  it('on -> off -> on in a row leaves exactly one live link per pairing', () => {
    hostPairing(rig);
    rig.service.setAccept({ enabled: true });
    rig.service.setAccept({ enabled: false });
    rig.service.setAccept({ enabled: true });
    const live = rig.links.filter(({ link }) => !link.closed);
    assert.equal(live.length, 1);
    assert.equal(rig.links.length, 2);
  });

  it('switching on twice does not duplicate links', () => {
    hostPairing(rig);
    rig.service.setAccept({ enabled: true });
    rig.service.setAccept({ enabled: true, autoOffHours: 4 });
    assert.equal(rig.links.length, 1);
  });

  it('refuses to switch on in an unsupported mode and opens nothing', () => {
    hostPairing(rig);
    rig.state.supported = false;
    const error = refusal(() => rig.service.setAccept({ enabled: true }));
    assert.equal(error.code, 'REMOTE_UNSUPPORTED_MODE');
    assert.equal(error.statusCode, 409);
    assert.equal(rig.links.length, 0);
  });

  it('refuses to switch on without a saved relay secret', () => {
    rig.state.secret = null;
    const error = refusal(() => rig.service.setAccept({ enabled: true }));
    assert.equal(error.code, 'REMOTE_NOT_CONFIGURED');
    assert.equal(error.statusCode, 400);
  });

  it('switching off is always allowed (even in an unsupported mode)', () => {
    rig.service.setAccept({ enabled: true });
    rig.state.supported = false;
    assert.equal(rig.service.setAccept({ enabled: false }).acceptEnabled, false);
  });

  it('rejects an auto-off outside 0-168 whole hours', () => {
    for (const bad of [169, -1, 1.5, Number.NaN, '8' as unknown as number]) {
      const error = refusal(() => rig.service.setAccept({ enabled: true, autoOffHours: bad }));
      assert.equal(error.code, 'REMOTE_BAD_REQUEST', String(bad));
    }
    assert.equal(rig.service.status().acceptEnabled, false);
    assert.equal(rig.service.setAccept({ enabled: true, autoOffHours: 168 }).autoOffHours, 168);
  });
});

describe('Host Accept: auto-off and restart', () => {
  it('turns itself off when the hours pass, checked by a 60-second tick (no long timer)', () => {
    const rig = arrange();
    hostPairing(rig);
    const status = rig.service.setAccept({ enabled: true, autoOffHours: 1 });
    assert.equal(status.autoOffAt, START + HOUR);
    rig.clock.advance(HOUR - 60_000);
    assert.equal(rig.service.status().acceptEnabled, true);
    rig.clock.advance(60_000);
    assert.equal(rig.service.status().acceptEnabled, false);
    assert.equal(rig.settings.get('remote.accept_enabled'), '0');
    assert.ok(rig.links.every(({ link }) => link.closed));
    assert.equal(rig.clock.pendingTimers(), 0);
  });

  it('never turns itself off with autoOffHours 0', () => {
    const rig = arrange();
    rig.service.setAccept({ enabled: true, autoOffHours: 0 });
    rig.clock.advance(1000 * HOUR);
    assert.equal(rig.service.status().acceptEnabled, true);
    assert.equal(rig.service.status().autoOffAt, null);
  });

  it('a restart before the deadline restores Accept and reopens the links', () => {
    const first = arrange();
    hostPairing(first);
    first.service.setAccept({ enabled: true, autoOffHours: 2 });
    first.service.stop();

    first.clock.advance(HOUR);
    const second = arrange({ settings: first.settings, store: first.store, clock: first.clock });
    second.service.restore();
    assert.equal(second.service.status().acceptEnabled, true);
    assert.equal(second.links.length, 1);
    assert.ok(second.links[0].link.started);
  });

  it('a restart after the deadline does not switch Accept on again', () => {
    const first = arrange();
    hostPairing(first);
    first.service.setAccept({ enabled: true, autoOffHours: 2 });
    first.service.stop();

    first.clock.advance(2 * HOUR);
    const second = arrange({ settings: first.settings, store: first.store, clock: first.clock });
    second.service.restore();
    assert.equal(second.service.status().acceptEnabled, false);
    assert.equal(second.links.length, 0);
    assert.equal(second.settings.get('remote.accept_enabled'), '0');
  });

  it('a restart with autoOffHours 0 keeps the saved state, however long ago it was switched on', () => {
    const first = arrange();
    hostPairing(first);
    first.service.setAccept({ enabled: true, autoOffHours: 0 });
    first.service.stop();
    first.clock.advance(500 * HOUR);
    const second = arrange({ settings: first.settings, store: first.store, clock: first.clock });
    second.service.restore();
    assert.equal(second.service.status().acceptEnabled, true);
  });

  it('a restart that finds Accept off, an unsupported mode or no relay secret opens nothing', () => {
    const off = arrange();
    off.service.restore();
    assert.equal(off.links.length, 0);

    const first = arrange();
    first.service.setAccept({ enabled: true });
    first.service.stop();
    const unsupported = arrange({ settings: first.settings, store: first.store, clock: first.clock, supported: false });
    unsupported.service.restore();
    assert.equal(unsupported.service.status().acceptEnabled, false);

    first.settings.set('remote.accept_enabled', '1');
    const noSecret = arrange({ settings: first.settings, store: first.store, clock: first.clock, secret: null });
    noSecret.service.restore();
    assert.equal(noSecret.service.status().acceptEnabled, false);
    assert.equal(noSecret.links.length, 0);
  });

  it('stop() ends links and timers without changing the saved switch', () => {
    const rig = arrange();
    hostPairing(rig);
    rig.service.setAccept({ enabled: true, autoOffHours: 3 });
    rig.service.stop();
    assert.ok(rig.links.every(({ link }) => link.closed));
    assert.equal(rig.clock.pendingTimers(), 0);
    assert.equal(rig.settings.get('remote.accept_enabled'), '1');
  });
});

describe('Host Accept: Controllers, disconnect and revoke', () => {
  it('lists each Controller with its name, link state, last connection and open streams', () => {
    const rig = arrange();
    const a = rig.store.add({ role: 'host', name: 'Phone', relayUrl: 'wss://phone.test' });
    const b = hostPairing(rig, 'Tablet');
    rig.service.setAccept({ enabled: true });
    const index = rig.links.findIndex(({ options }) => options.relayUrl === 'wss://phone.test');
    assert.ok(index >= 0, 'a link was opened for the first pairing');
    const linkA = rig.links[index].link;
    rig.clock.advance(5_000);
    linkA.setStatus({ state: 'online', peerState: 'online' });
    linkA.setSession(true);
    rig.bridges[index].streams = 3;

    const controllers = rig.service.status().controllers;
    const viewA = controllers.find((view) => view.pairingId === a.id);
    const viewB = controllers.find((view) => view.pairingId === b.id);
    assert.deepEqual(viewA, { pairingId: a.id, name: 'Phone', connected: true, connectedAt: START + 5_000, streams: 3 });
    assert.equal(viewB?.connected, false);
    assert.equal(viewB?.streams, 0);
    assert.ok(rig.store.calls.includes(`markConnected:${a.id}`));
  });

  it('a Controller that dropped is shown as not connected and its streams are cut', () => {
    const rig = arrange();
    const a = hostPairing(rig);
    rig.service.setAccept({ enabled: true });
    const { link } = rig.links[0];
    link.setSession(true);
    link.setSession(false);
    assert.equal(rig.service.status().controllers.find((view) => view.pairingId === a.id)?.connected, false);
    assert.ok(rig.bridges[0].closeAllCalls >= 1);
  });

  it('summarises the relay state: idle without pairings, then the best state among the links', () => {
    const rig = arrange();
    rig.service.setAccept({ enabled: true });
    assert.equal(rig.service.status().relay.state, 'idle');
    hostPairing(rig);
    assert.equal(rig.service.status().relay.state, 'connecting');
    rig.links[0].link.setStatus({ state: 'online', peerState: 'online' });
    assert.equal(rig.service.status().relay.state, 'online');
  });

  it('opens a link for a pairing created after Accept was switched on, the next time the status is read', () => {
    const rig = arrange();
    rig.service.setAccept({ enabled: true });
    assert.equal(rig.links.length, 0);
    hostPairing(rig);
    rig.service.status();
    assert.equal(rig.links.length, 1);
    rig.service.status();
    assert.equal(rig.links.length, 1, 'not duplicated');
  });

  it('syncLinks drops the link of a pairing that is no longer active', () => {
    const rig = arrange();
    const a = hostPairing(rig);
    rig.service.setAccept({ enabled: true });
    rig.store.revokeHostPairing(a.id);
    rig.service.syncLinks();
    assert.ok(rig.links[0].link.closed);
  });

  it('disconnect cuts that Controller now and offers a fresh link, so it can come back while Accept is on', () => {
    const rig = arrange();
    const a = hostPairing(rig);
    rig.service.setAccept({ enabled: true });
    rig.service.disconnect(a.id);
    assert.ok(rig.links[0].link.closed);
    assert.ok(rig.bridges[0].closeAllCalls >= 1);
    assert.equal(rig.links.length, 2);
    assert.ok(rig.links[1].link.started && !rig.links[1].link.closed);
    assert.equal(rig.store.getPairing(a.id)?.revokedAt, null, 'the pairing stays');
  });

  it('disconnect of an unknown pairing is a 404', () => {
    const rig = arrange();
    const error = refusal(() => rig.service.disconnect('nope'));
    assert.equal(error.statusCode, 404);
  });

  it('revoke ends the link, erases K, asks the relay to destroy the room and reports the confirmation', async () => {
    const rig = arrange();
    const a = hostPairing(rig);
    rig.service.setAccept({ enabled: true });
    const result = await rig.service.revoke(a.id);
    assert.deepEqual(result, { ok: true, relayConfirmed: true });
    assert.ok(rig.links[0].link.closed);
    assert.ok(rig.bridges[0].closeAllCalls >= 1);
    assert.ok(rig.store.getPairing(a.id)?.revokedAt);
    assert.deepEqual(rig.destroyed, [a.id]);
    assert.equal(rig.service.status().controllers.length, 0);
  });

  it('revoke while the relay cannot be reached still revokes and reports relayConfirmed false (the retrier owes the DESTROY)', async () => {
    const rig = arrange();
    const a = hostPairing(rig);
    rig.state.destroyConfirms = false;
    const result = await rig.service.revoke(a.id);
    assert.deepEqual(result, { ok: true, relayConfirmed: false });
    assert.equal(rig.store.listPendingDestroy().length, 1);
  });

  it('revoke of an unknown, Controller-role or already revoked pairing is a 404 and touches nothing', async () => {
    const rig = arrange();
    const controller = rig.store.add({ role: 'controller' });
    const gone = hostPairing(rig);
    rig.store.revokeHostPairing(gone.id);
    for (const id of ['nope', controller.id, gone.id]) {
      await assert.rejects(rig.service.revoke(id), (error: AppError) => error.statusCode === 404 && error.code === 'REMOTE_PAIR_NOT_FOUND');
    }
  });

  it('revokeAll revokes every active Host pairing and counts them', async () => {
    const rig = arrange();
    hostPairing(rig);
    hostPairing(rig);
    rig.service.setAccept({ enabled: true });
    assert.deepEqual(await rig.service.revokeAll(), { revoked: 2, failed: 0 });
    assert.equal(rig.store.countActivePairings('host'), 0);
    assert.ok(rig.links.every(({ link }) => link.closed));
  });

  it('closeStreams cuts the bridged streams of every Controller but keeps the links (auth epoch change)', () => {
    const rig = arrange();
    hostPairing(rig);
    hostPairing(rig);
    rig.service.setAccept({ enabled: true });
    rig.service.closeStreams();
    assert.ok(rig.bridges.every((bridge) => bridge.closeAllCalls === 1));
    assert.ok(rig.links.every(({ link }) => !link.closed));
  });

  it('reports the effective approval timeout', () => {
    const rig = arrange();
    assert.equal(rig.service.status().approvalTimeoutMs, 55_000);
    rig.state.timeoutMs = 300_000;
    assert.equal(rig.service.status().approvalTimeoutMs, 300_000);
  });
});

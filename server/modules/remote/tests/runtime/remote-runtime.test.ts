/**
 * How the running parts are put together: relay settings that cannot be read leave Remote "not
 * configured" instead of crashing, pairing uses the real relay connector (or the one a test injects),
 * a restart picks up a DESTROY the relay still owes, and shutdown closes every link.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';

import { AppError } from '@/shared/utils.js';

import { createSecretBox } from '../../crypto/secret-box.js';
import { createPairingStore } from '../../pairing/pairing-store.service.js';
import { createRemoteRuntime, type RemoteRuntimeOptions } from '../../runtime/remote-runtime.service.js';
import { createRemoteConfigService } from '../../storage/remote-storage.service.js';
import { FakeRelay } from '../support/fake-relay.js';
import { createFakeRelayConnector } from '../support/fake-relay-connector.js';
import { createManualClock } from '../support/manual-clock.js';
import { createInProcessNetwork } from '../support/relay-link-rig.js';
import { withTempDatabase } from '../support/temp-database.js';

const SECRET = 's'.repeat(40);

const arrange = (extra: Partial<RemoteRuntimeOptions> = {}, boxKey: Buffer = Buffer.alloc(32, 1)) => {
  const relay = new FakeRelay({ secret: SECRET });
  const clock = createManualClock(relay.now(), relay);
  const net = createInProcessNetwork(relay);
  const box = createSecretBox(boxKey);
  const config = createRemoteConfigService({ box });
  const pairings = createPairingStore({ box, now: clock.now });
  const settings = new Map<string, string>();
  const runtime = createRemoteRuntime({
    storage: { config, pairings, keySource: 'file' },
    env: {},
    appVersion: 'test',
    bridgeTarget: { port: 3001 },
    clock,
    settings: { get: (key) => settings.get(key) ?? null, set: (key, value) => void settings.set(key, value) },
    socketFactory: net.factory,
    ...extra,
  });
  return { relay, clock, net, config, pairings, settings, runtime, box };
};

describe('Remote runtime', () => {
  it('starting a pairing without saved relay settings is refused by the pairing connector too', async () => {
    await withTempDatabase(() => {
      const { runtime } = arrange();
      assert.throws(
        () => runtime.hostPairing.start(),
        (error: unknown) => error instanceof AppError && error.code === 'REMOTE_NOT_CONFIGURED',
      );
    });
  });

  it('uses the real relay connector with the saved settings, or the connector a test injects', async () => {
    await withTempDatabase(async () => {
      const real = arrange();
      real.config.setRelayUrl('wss://fake-relay.test');
      real.config.setRelaySecret(SECRET);
      const started = real.runtime.hostPairing.start();
      await real.relay.flush();
      assert.match(started.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
      assert.ok(real.net.sockets.some((socket) => socket.target.kind === 'pair' && socket.target.role === 'host'), 'a pairing room socket was opened');
    });
    await withTempDatabase(async () => {
      const relay = new FakeRelay({ secret: SECRET });
      const injected = arrange({ pairConnector: createFakeRelayConnector(relay) });
      injected.config.setRelayUrl('wss://fake-relay.test');
      assert.ok(injected.runtime.hostPairing.start().pairingId);
      assert.equal(injected.net.sockets.length, 0, 'the injected connector replaced the real one');
    });
  });

  it('treats a relay secret that cannot be opened as "not configured", never as a crash', async () => {
    await withTempDatabase(async () => {
      const first = arrange({}, Buffer.alloc(32, 1));
      first.config.setRelayUrl('wss://fake-relay.test');
      first.config.setRelaySecret(SECRET);
      // Same database, another master key: the sealed secret can no longer be opened.
      const second = arrange({}, Buffer.alloc(32, 2));
      assert.throws(() => second.config.getRelaySecret());
      assert.throws(
        () => second.runtime.management.startHostPairing(),
        (error: unknown) => error instanceof AppError && error.code === 'REMOTE_NOT_CONFIGURED',
      );
      assert.throws(() => second.runtime.registry.attach('anything'));
      second.runtime.stop();
    });
  });

  it('a restart finishes a DESTROY the relay still owed, and shutdown closes every link', async () => {
    await withTempDatabase(async () => {
      const rig = arrange();
      rig.config.setRelayUrl('wss://fake-relay.test');
      rig.config.setRelaySecret(SECRET);
      const k = crypto.randomBytes(32);
      const record = rig.pairings.insertPairing({ role: 'host', peerName: 'Phone', k, relayUrl: 'wss://fake-relay.test' });
      rig.pairings.revokeHostPairing(record.id);
      assert.equal(rig.pairings.listPendingDestroy().length, 1);

      rig.runtime.start();
      await rig.relay.flush();
      await rig.relay.flush();
      assert.equal(rig.pairings.listPendingDestroy().length, 0, 'the owed DESTROY was sent on start');

      const peer = rig.pairings.insertPairing({ role: 'controller', peerName: 'Host', k: crypto.randomBytes(32), relayUrl: 'wss://fake-relay.test' });
      rig.runtime.registry.attach(peer.id);
      assert.equal(rig.runtime.registry.openLinkCount, 1);
      rig.runtime.stop();
      assert.equal(rig.runtime.registry.openLinkCount, 0);
      assert.equal(rig.clock.pendingTimers(), 0);
    });
  });

  it('"log out everywhere" closes browser connections and bridged streams but leaves the links', async () => {
    await withTempDatabase(() => {
      const rig = arrange();
      const peer = rig.pairings.insertPairing({ role: 'controller', peerName: 'Host', k: crypto.randomBytes(32), relayUrl: 'wss://fake-relay.test' });
      rig.config.setRelayUrl('wss://fake-relay.test');
      rig.config.setRelaySecret(SECRET);
      const closes: Array<[number, string]> = [];
      rig.runtime.registry.trackConnection(peer.id, { close: (code, reason) => closes.push([code, reason]) });
      rig.runtime.closeRemoteConnections();
      assert.deepEqual(closes, [[4401, 'session-ended']]);
    });
  });

  it('forgets every Controller pairing and revokes every Host pairing when the relay settings change', async () => {
    await withTempDatabase(async () => {
      const rig = arrange();
      rig.config.setRelayUrl('wss://fake-relay.test');
      rig.config.setRelaySecret(SECRET);
      const peer = rig.pairings.insertPairing({ role: 'controller', peerName: 'Host', k: crypto.randomBytes(32), relayUrl: 'wss://fake-relay.test' });
      const host = rig.pairings.insertPairing({ role: 'host', peerName: 'Phone', k: crypto.randomBytes(32), relayUrl: 'wss://fake-relay.test' });
      rig.runtime.registry.attach(peer.id);

      await rig.runtime.relaySettings.update({ url: 'wss://fake-relay.test', secret: 'n'.repeat(40) });
      assert.equal(rig.pairings.getPairing(peer.id), null);
      assert.ok(rig.pairings.getPairing(host.id)?.revokedAt);
      assert.equal(rig.runtime.registry.openLinkCount, 0);
    });
  });
});

/**
 * Revocation at the relay: the standalone DESTROY client (host token only, no K) and the retrier that
 * keeps trying, every 5 minutes for up to 30 days, until the relay confirms. Runs against the in-process
 * fake relay, so the relay's real answers (4410 revoked, 401 gate, 4401 token) decide the outcome.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';

import type { RemoteRelaySocketFactory } from '@/shared/types.js';

import { deriveLinkKeys } from '../../crypto/key-derivation.js';
import { createPendingDestroyRetrier } from '../../host/pending-destroy-retrier.js';
import { createRelayDestroyClient } from '../../host/relay-destroy-client.js';
import { RELAY_SECRET, RELAY_URL, createLinkRig } from '../support/relay-link-rig.js';
import { createMemoryPairingStore } from '../support/memory-pairing-store.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const hostCredentials = (k: Buffer) => {
  const { roomId, hostToken } = deriveLinkKeys(k);
  return { relayUrl: RELAY_URL, relaySecret: RELAY_SECRET, roomId, hostToken };
};

describe('relay DESTROY client', () => {
  it('destroys a room the Host registered: the relay answers 4410 and the Controller link ends revoked', async () => {
    const rig = createLinkRig();
    const host = rig.createLink('host');
    const controller = rig.createLink('controller');
    host.start();
    await rig.settle();
    host.close(); // the revoke flow stops the Host link first
    const client = createRelayDestroyClient({ socketFactory: rig.net.factory, clock: rig.clock });
    const outcome = client.destroy(hostCredentials(rig.k));
    await rig.settle();
    assert.equal(await outcome, 'confirmed');

    controller.start();
    await rig.settle();
    assert.equal(controller.status.state, 'revoked');
    rig.dispose();
  });

  it('destroys a room nobody ever registered (a revoke before the Host ever connected)', async () => {
    const rig = createLinkRig();
    const client = createRelayDestroyClient({ socketFactory: rig.net.factory, clock: rig.clock });
    const first = client.destroy(hostCredentials(rig.k));
    await rig.settle();
    assert.equal(await first, 'confirmed');
    // The mark stays: asking again is answered 4410 too, which still counts as confirmed.
    const again = client.destroy(hostCredentials(rig.k));
    await rig.settle();
    assert.equal(await again, 'confirmed');
    rig.dispose();
  });

  it('reports failure when the relay refuses the gate (wrong RELAY_SECRET)', async () => {
    const rig = createLinkRig();
    const client = createRelayDestroyClient({ socketFactory: rig.net.factory, clock: rig.clock });
    const outcome = client.destroy({ ...hostCredentials(rig.k), relaySecret: 'x'.repeat(40) });
    await rig.settle();
    assert.equal(await outcome, 'failed');
    rig.dispose();
  });

  it('reports failure when the host token does not own the room', async () => {
    const rig = createLinkRig();
    const host = rig.createLink('host');
    host.start();
    await rig.settle();
    const client = createRelayDestroyClient({ socketFactory: rig.net.factory, clock: rig.clock });
    const other = hostCredentials(rig.k);
    const outcome = client.destroy({ ...other, hostToken: crypto.randomBytes(32).toString('base64url') });
    await rig.settle();
    assert.equal(await outcome, 'failed');
    assert.equal(host.status.state, 'online', 'a stranger cannot take the room down');
    rig.dispose();
  });

  it('reports failure when the relay is unreachable', async () => {
    const rig = createLinkRig();
    rig.net.setNetworkDown(true);
    const client = createRelayDestroyClient({ socketFactory: rig.net.factory, clock: rig.clock });
    const outcome = client.destroy(hostCredentials(rig.k));
    await rig.settle();
    assert.equal(await outcome, 'failed');
    rig.dispose();
  });

  it('gives up after the timeout when the relay never answers, and closes its socket', async () => {
    const rig = createLinkRig();
    const closes: Array<number | undefined> = [];
    const silent: RemoteRelaySocketFactory = () => ({
      sendText: () => undefined,
      sendBinary: () => undefined,
      close: (code) => {
        closes.push(code);
      },
    });
    const client = createRelayDestroyClient({ socketFactory: silent, clock: rig.clock, timeoutMs: 10_000 });
    const outcome = client.destroy(hostCredentials(rig.k));
    rig.clock.advance(10_000);
    assert.equal(await outcome, 'failed');
    assert.equal(closes.length, 1);
  });

  it('sends only the auth frame and then destroy, never anything derived from K', async () => {
    const rig = createLinkRig();
    const client = createRelayDestroyClient({ socketFactory: rig.net.factory, clock: rig.clock });
    const outcome = client.destroy(hostCredentials(rig.k));
    await rig.settle();
    await outcome;
    const texts = rig.net.sockets.flatMap((socket) => socket.texts);
    assert.equal(texts.length, 2);
    const auth = JSON.parse(texts[0]) as { t: string; token: string; ctl: string };
    assert.equal(auth.t, 'auth');
    assert.equal(auth.token, deriveLinkKeys(rig.k).hostToken);
    assert.match(auth.ctl, /^[0-9a-f]{64}$/);
    assert.notEqual(auth.ctl, crypto.createHash('sha256').update(deriveLinkKeys(rig.k).controllerToken).digest('hex'));
    assert.deepEqual(JSON.parse(texts[1]), { t: 'destroy' });
    rig.dispose();
  });
});

describe('pending DESTROY retrier', () => {
  const arrange = () => {
    const rig = createLinkRig();
    const store = createMemoryPairingStore(rig.clock.now);
    const record = store.add({ role: 'host', name: 'Phone', relayUrl: RELAY_URL, k: rig.k });
    store.revokeHostPairing(record.id);
    const client = createRelayDestroyClient({ socketFactory: rig.net.factory, clock: rig.clock });
    const secret = { value: RELAY_SECRET as string | null };
    const retrier = createPendingDestroyRetrier({ store, destroyClient: client, getRelaySecret: () => secret.value, clock: rig.clock });
    return { rig, store, record, secret, retrier };
  };

  it('destroyNow confirms and clears the pending record', async () => {
    const { rig, store, record, retrier } = arrange();
    const result = retrier.destroyNow(record.id);
    await rig.settle();
    assert.equal(await result, true);
    assert.equal(store.listPendingDestroy().length, 0);
    rig.dispose();
  });

  it('keeps the record while the relay cannot be reached and retries every 5 minutes until it answers', async () => {
    const { rig, store, record, retrier } = arrange();
    rig.net.setNetworkDown(true);
    retrier.start();
    await rig.advance(5 * MINUTE, 1000);
    assert.equal(store.listPendingDestroy().length, 1, 'still owed while the relay is down');
    await rig.advance(5 * MINUTE, 1000);
    assert.equal(store.listPendingDestroy().length, 1);
    rig.net.setNetworkDown(false);
    await rig.advance(5 * MINUTE, 1000);
    assert.equal(store.listPendingDestroy().length, 0, 'cleared once the relay confirmed');
    assert.equal(store.getPairing(record.id)?.pendingDestroy, false);
    retrier.stop();
    rig.dispose();
  });

  it('does nothing without a saved relay secret', async () => {
    const { rig, store, secret, retrier } = arrange();
    secret.value = null;
    assert.equal(await retrier.runOnce(), 0);
    assert.equal(store.listPendingDestroy().length, 1);
    rig.dispose();
  });

  it('drops a record after 30 days: the relay forgets an idle room by then anyway', async () => {
    const { rig, store, retrier } = arrange();
    rig.net.setNetworkDown(true);
    rig.clock.advance(30 * DAY + 1);
    await retrier.runOnce();
    assert.equal(store.listPendingDestroy().length, 0);
    rig.dispose();
  });

  it('stop() cancels the schedule', async () => {
    const { rig, retrier } = arrange();
    retrier.start();
    retrier.stop();
    assert.equal(rig.clock.pendingTimers(), 0);
    rig.dispose();
  });

  it('start() twice schedules once, and destroyNow of a pairing with nothing owed is simply done', async () => {
    const { rig, retrier } = arrange();
    retrier.start();
    retrier.start();
    assert.equal(rig.clock.pendingTimers(), 1);
    assert.equal(await retrier.destroyNow('not-pending'), true);
    retrier.stop();
    rig.dispose();
  });

  it('never runs two rounds at once: a round still waiting on the relay makes the next one a no-op', async () => {
    const rig = createLinkRig();
    const store = createMemoryPairingStore(rig.clock.now);
    const record = store.add({ role: 'host', relayUrl: RELAY_URL, k: rig.k });
    store.revokeHostPairing(record.id);
    const silent: RemoteRelaySocketFactory = () => ({ sendText: () => undefined, sendBinary: () => undefined, close: () => undefined });
    const client = createRelayDestroyClient({ socketFactory: silent, clock: rig.clock, timeoutMs: 10_000 });
    const retrier = createPendingDestroyRetrier({ store, destroyClient: client, getRelaySecret: () => RELAY_SECRET, clock: rig.clock });
    const first = retrier.runOnce();
    assert.equal(await retrier.runOnce(), 0, 'overlapping round');
    rig.clock.advance(10_000);
    assert.equal(await first, 0);
  });

  it('keeps its schedule when a round throws (a database error must not end the retries)', async () => {
    const rig = createLinkRig();
    let failing = true;
    const store = {
      listPendingDestroy: () => {
        if (failing) throw new Error('database is locked');
        return [];
      },
      clearPendingDestroy: () => undefined,
      getPairing: () => null,
    };
    const client = createRelayDestroyClient({ socketFactory: rig.net.factory, clock: rig.clock });
    const retrier = createPendingDestroyRetrier({ store, destroyClient: client, getRelaySecret: () => RELAY_SECRET, clock: rig.clock });
    retrier.start();
    await rig.advance(5 * MINUTE, 1000);
    assert.equal(rig.clock.pendingTimers(), 1, 'the next round is already scheduled');
    failing = false;
    await rig.advance(5 * MINUTE, 1000);
    assert.equal(rig.clock.pendingTimers(), 1);
    retrier.stop();
  });

  it('drops a pending record whose pairing row is gone (no relay URL to ask, no age to wait for) instead of retrying it forever', async () => {
    const { rig, store, record, retrier } = arrange();
    store.deletePairing(record.id);
    assert.equal(store.listPendingDestroy().length, 1, 'the pending record outlives the row only in a broken store');
    assert.equal(await retrier.runOnce(), 1);
    assert.equal(store.listPendingDestroy().length, 0);
    rig.dispose();
  });
});

describe('relay DESTROY client: unusual relay traffic', () => {
  const hostCreds = (k: Buffer) => ({ ...hostCredentials(k) });

  it('ignores frames that are not a ready notice and finishes on the relay close', async () => {
    const rig = createLinkRig();
    const sent: string[] = [];
    const factory: RemoteRelaySocketFactory = (_target, handlers) => {
      queueMicrotask(() => {
        handlers.onOpen();
        handlers.onText('not json');
        handlers.onText('null');
        handlers.onText('"ready"');
        handlers.onText('{"t":"peer","up":true}');
        handlers.onBinary(new Uint8Array(4));
        handlers.onText('{"t":"ready"}');
        handlers.onClose(4410);
      });
      return { sendText: (text) => void sent.push(text), sendBinary: () => undefined, close: () => undefined };
    };
    const client = createRelayDestroyClient({ socketFactory: factory, clock: rig.clock });
    assert.equal(await client.destroy(hostCreds(rig.k)), 'confirmed');
    assert.equal(sent.length, 2, 'the auth frame and one destroy, only after the ready notice');
    assert.deepEqual(JSON.parse(sent[1]), { t: 'destroy' });
  });

  it('a close after the timeout does not change the outcome', async () => {
    const rig = createLinkRig();
    let late: (() => void) | undefined;
    const factory: RemoteRelaySocketFactory = (_target, handlers) => {
      late = () => handlers.onClose(4410);
      return { sendText: () => undefined, sendBinary: () => undefined, close: () => undefined };
    };
    const client = createRelayDestroyClient({ socketFactory: factory, clock: rig.clock, timeoutMs: 1000 });
    const outcome = client.destroy(hostCreds(rig.k));
    rig.clock.advance(1000);
    assert.equal(await outcome, 'failed');
    late?.();
  });
});

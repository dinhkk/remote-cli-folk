import assert from 'node:assert/strict';
import test from 'node:test';

import type { RemoteClock, RemotePairChannelHandlers, RemotePairConnector, RemotePairingStore } from '@/shared/types.js';

import { createSecretBox } from '../../crypto/secret-box.js';
import { systemClock } from '../../pairing/pairing-clock.js';
import { createControllerPairingService } from '../../pairing/pairing-controller.service.js';
import { PairingError, createHostPairingService } from '../../pairing/pairing-host.service.js';
import { createPairingStore } from '../../pairing/pairing-store.service.js';
import { FakeRelay } from '../support/fake-relay.js';
import { memoryPairLockStore } from '../support/memory-pair-lock-store.js';
import { createFakeRelayConnector } from '../support/fake-relay-connector.js';
import { createManualClock } from '../support/manual-clock.js';
import { withTempDatabase } from '../support/temp-database.js';

const RELAY_URL = 'wss://relay.example';
const HOUR = 60 * 60_000;
const FIVE_MINUTES = 5 * 60_000;

const newStore = (now: () => number): RemotePairingStore => createPairingStore({ box: createSecretBox(Buffer.alloc(32, 0x44)), now });

/** A clock whose timers never fire: only the lazy "has the deadline passed" checks can end a pairing. */
const timerlessClock = (start: number): RemoteClock & { advance(ms: number): void } => {
  let current = start;
  return { now: () => current, setTimer: () => () => undefined, advance: (ms) => void (current += ms) };
};

const world = (storeOverride?: (store: RemotePairingStore) => RemotePairingStore, clockOverride?: RemoteClock) => {
  const relay = new FakeRelay();
  const clock = clockOverride ?? createManualClock(relay.now(), relay);
  const store = newStore(clock.now);
  const connect = createFakeRelayConnector(relay);
  const used = storeOverride ? storeOverride(store) : store;
  return {
    relay,
    clock,
    store,
    host: createHostPairingService({ connect, store: used, getRelayUrl: () => RELAY_URL, hostName: 'Office PC', clock }),
    controller: createControllerPairingService({ connect, store: used, getRelayUrl: () => RELAY_URL, clock }),
  };
};

const reachSas = async (w: ReturnType<typeof world>) => {
  const started = w.host.start();
  const { joinId } = w.controller.join({ code: started.code, deviceName: 'My Laptop' });
  await w.relay.flush();
  const sas = w.controller.getStatus(joinId)?.sas as string;
  assert.match(sas, /^\d{6}$/);
  return { started, joinId, sas };
};

/** Connector that exposes the handlers it was given so a test can play the relay by hand. */
const manualConnector = () => {
  const sent: Uint8Array[] = [];
  const events = { handlers: null as RemotePairChannelHandlers | null, destroys: 0, closes: 0 };
  const connect: RemotePairConnector = (_target, handlers) => {
    events.handlers = handlers;
    return {
      sendFrame: (frame) => void sent.push(frame),
      sendDestroy: () => void (events.destroys += 1),
      close: () => void (events.closes += 1),
    };
  };
  return { connect, sent, events };
};

test('Host: a storage failure after a verified ceremony fails the pairing and stores nothing', async () => {
  await withTempDatabase(async () => {
    const w = world((store) => ({
      ...store,
      insertPairing: (input) => (input.role === 'host' ? (() => { throw new Error('disk full'); })() : store.insertPairing(input)),
    }));
    const { started, sas } = await reachSas(w);
    assert.deepEqual(w.host.confirmSas(started.pairingId, sas), { ok: true });
    await w.relay.flush();
    assert.equal(w.host.getStatus(started.pairingId)?.state, 'failed');
    assert.equal(w.host.getStatus(started.pairingId)?.failure, 'storage-error');
    assert.equal(w.store.countActivePairings('host'), 0);
  });
});

test('storage-error keeps a non-secret cause code for the operator (never the error message, never in the status)', async () => {
  await withTempDatabase(async () => {
    const leaky = Object.assign(new Error('write failed for K=deadbeef code ABCD-EFGH'), { code: 'SQLITE_FULL' });
    const plain = new Error('K=cafebabe leaked in a plain message');
    for (const [thrown, expected] of [
      [leaky, 'SQLITE_FULL'],
      [plain, 'Error'],
      [Object.assign(new Error('x'), { code: 'bad code with spaces & K=00' }), 'Error'],
    ] as const) {
      const w = world((store) => ({
        ...store,
        insertPairing: (input) => (input.role === 'host' ? (() => { throw thrown; })() : store.insertPairing(input)),
      }));
      const { started, sas } = await reachSas(w);
      w.host.confirmSas(started.pairingId, sas);
      await w.relay.flush();
      assert.equal(w.host.getStatus(started.pairingId)?.failure, 'storage-error');
      assert.equal(w.host.getFailureCause(started.pairingId), expected);
      assert.ok(!JSON.stringify(w.host.getStatus(started.pairingId)).includes(expected), 'the status JSON does not carry the cause');
      assert.equal(w.host.getFailureCause('unknown'), null);
    }

    const c = world((store) => ({
      ...store,
      insertPairing: (input) => (input.role === 'controller' ? (() => { throw Object.assign(new Error('secret'), { code: 'SECRET_BOX_BAD' }); })() : store.insertPairing(input)),
    }));
    const { started, joinId, sas } = await reachSas(c);
    c.host.confirmSas(started.pairingId, sas);
    await c.relay.flush();
    assert.equal(c.controller.getFailureCause(joinId), 'SECRET_BOX_BAD');
    assert.equal(c.controller.getFailureCause('unknown'), null);
  });
});

test('Host: a limit that is reached while the ceremony runs is enforced again at the end', async () => {
  await withTempDatabase(async () => {
    let calls = 0;
    const w = world((store) => ({ ...store, countActivePairings: () => (++calls === 1 ? 0 : 8) })); // room at start(), full at completion
    const { started, sas } = await reachSas(w);
    w.host.confirmSas(started.pairingId, sas);
    await w.relay.flush();
    assert.equal(w.host.getStatus(started.pairingId)?.failure, 'limit-reached');
    assert.equal(w.store.listPairings('host').length, 0);
  });
});

test('Controller: a storage failure ends the join before any confirmation is sent, and the Host is told', async () => {
  await withTempDatabase(async () => {
    const w = world((store) => ({
      ...store,
      insertPairing: (input) => (input.role === 'controller' ? (() => { throw new Error('disk full'); })() : store.insertPairing(input)),
    }));
    const { started, joinId, sas } = await reachSas(w);
    w.host.confirmSas(started.pairingId, sas);
    await w.relay.flush();
    assert.equal(w.controller.getStatus(joinId)?.state, 'failed');
    assert.equal(w.controller.getStatus(joinId)?.failure, 'storage-error');
    assert.equal(w.host.getStatus(started.pairingId)?.state, 'failed');
    assert.equal(w.host.getStatus(started.pairingId)?.failure, 'peer-aborted');
    assert.equal(w.store.listPairings().length, 0, 'neither side kept a pairing');
  });
});

test('deadlines are also enforced when the status or SAS is requested after the time passed', async () => {
  await withTempDatabase(async () => {
    const clock = timerlessClock(new FakeRelay().now());
    const w = world(undefined, clock);
    const { started, joinId } = await reachSas(w);
    clock.advance(FIVE_MINUTES);
    assert.equal(w.host.getStatus(started.pairingId)?.failure, 'expired');
    assert.equal(w.controller.getStatus(joinId)?.state, 'failed');
    assert.equal(w.controller.getStatus(joinId)?.failure, 'expired');

    const second = world(undefined, timerlessClock(new FakeRelay().now()));
    const pair = await reachSas(second);
    (second.clock as ReturnType<typeof timerlessClock>).advance(FIVE_MINUTES + 1);
    assert.throws(() => second.host.confirmSas(pair.started.pairingId, pair.sas), (error: unknown) => error instanceof PairingError && error.code === 'PAIRING_NOT_READY');
    assert.equal(second.store.listPairings().length, 0);
  });
});

test('Host expiry tells a waiting Controller with an abort frame, not just by closing the room', async () => {
  await withTempDatabase(async () => {
    const relay = new FakeRelay();
    const hostClock = createManualClock(relay.now(), relay);
    const store = newStore(hostClock.now);
    const connect = createFakeRelayConnector(relay);
    const host = createHostPairingService({ connect, store, getRelayUrl: () => RELAY_URL, hostName: 'Office PC', clock: hostClock });
    // The Controller has no working timer, so only the Host can end its wait.
    const controller = createControllerPairingService({ connect, store, getRelayUrl: () => RELAY_URL, clock: timerlessClock(relay.now()) });

    const started = host.start();
    const { joinId } = controller.join({ code: started.code, deviceName: 'My Laptop' });
    await relay.flush();
    assert.equal(controller.getStatus(joinId)?.state, 'showing-sas');

    hostClock.advance(FIVE_MINUTES);
    await relay.flush();
    assert.equal(controller.getStatus(joinId)?.failure, 'expired', 'the reason travels in the abort frame (the relay close alone would say code-used-or-expired)');
  });
});

test('finished pairings and joins are forgotten after an hour', async () => {
  await withTempDatabase(async () => {
    const w = world();
    const first = w.host.start();
    w.host.cancel(first.pairingId);
    const join = w.controller.join({ code: 'ABCD-EFGH', deviceName: 'x' });
    await w.relay.flush();
    assert.equal(w.controller.getStatus(join.joinId)?.state, 'failed');

    (w.clock as ReturnType<typeof createManualClock>).advance(HOUR + 1);
    w.host.start();
    w.controller.join({ code: 'ABCD-EFGH', deviceName: 'x' });
    assert.equal(w.host.getStatus(first.pairingId), null);
    assert.equal(w.controller.getStatus(join.joinId), null);
  });
});

test('Controller status walks connecting, exchanging, then fails when the Host leaves; late events are ignored', () => {
  const { connect, sent, events } = manualConnector();
  const clock = timerlessClock(1_000);
  const controller = createControllerPairingService({ connect, store: newStoreNoDb(), getRelayUrl: () => RELAY_URL, clock });
  const { joinId } = controller.join({ code: 'ABCD-EFGH', deviceName: 'My Laptop' });
  const handlers = events.handlers as RemotePairChannelHandlers;

  assert.deepEqual(controller.getStatus(joinId), { state: 'connecting' });
  handlers.onReady();
  assert.deepEqual(controller.getStatus(joinId), { state: 'connecting' });
  handlers.onPeer(true);
  handlers.onPeer(true); // a repeated notification must not start a second ceremony
  assert.equal(sent.length, 1, 'exactly one hello');
  assert.deepEqual(controller.getStatus(joinId), { state: 'exchanging' });

  handlers.onPeer(false);
  assert.equal(controller.getStatus(joinId)?.failure, 'peer-changed');
  assert.equal(events.destroys, 1);
  assert.equal(events.closes, 1);
  handlers.onPeer(true);
  handlers.onFrame(Buffer.from([0x99]));
  handlers.onClose(1006);
  assert.equal(controller.getStatus(joinId)?.failure, 'peer-changed', 'the first reason sticks');
  assert.equal(events.destroys, 1);
});

test('Controller: cancelling before the Host appeared sends nothing but still closes the socket', () => {
  const { connect, sent, events } = manualConnector();
  const controller = createControllerPairingService({ connect, store: newStoreNoDb(), getRelayUrl: () => RELAY_URL, clock: timerlessClock(1) });
  const { joinId } = controller.join({ code: 'ABCD-EFGH', deviceName: 'My Laptop' });
  controller.cancel(joinId);
  assert.equal(sent.length, 0);
  assert.equal(events.closes, 1);
  assert.equal(controller.getStatus(joinId)?.failure, 'cancelled');
});

test('Controller: a Host leaving before any hello is not a failure of the ceremony', () => {
  const { connect, events } = manualConnector();
  const controller = createControllerPairingService({ connect, store: newStoreNoDb(), getRelayUrl: () => RELAY_URL, clock: timerlessClock(1) });
  const { joinId } = controller.join({ code: 'ABCD-EFGH', deviceName: 'My Laptop' });
  (events.handlers as RemotePairChannelHandlers).onPeer(false);
  assert.deepEqual(controller.getStatus(joinId), { state: 'connecting' });
});

test('Host: relay events that do not matter are ignored; a closed room means the code expired', () => {
  const { connect, events } = manualConnector();
  const host = createHostPairingService({ connect, store: newStoreNoDb(), getRelayUrl: () => RELAY_URL, hostName: 'Office PC', clock: timerlessClock(1), lockStore: memoryPairLockStore() });
  const { pairingId } = host.start();
  const handlers = events.handlers as RemotePairChannelHandlers;
  handlers.onReady();
  handlers.onPeer(true);
  handlers.onPeer(false); // nobody had said hello yet
  assert.equal(host.getStatus(pairingId)?.state, 'waiting-controller');
  handlers.onClose(4410);
  assert.equal(host.getStatus(pairingId)?.failure, 'expired');
  assert.equal(events.destroys, 0, 'nothing is sent on a socket the relay already closed');
  handlers.onFrame(Buffer.from([1]));
  handlers.onPeer(false);
  assert.equal(host.getStatus(pairingId)?.failure, 'expired');
});

test('Host: a connection that closes before connect() even returns still fails cleanly', () => {
  const connect: RemotePairConnector = (_target, handlers) => {
    handlers.onClose(0);
    return { sendFrame: () => undefined, sendDestroy: () => undefined, close: () => undefined };
  };
  const host = createHostPairingService({ connect, store: newStoreNoDb(), getRelayUrl: () => RELAY_URL, hostName: 'Office PC', clock: timerlessClock(1), lockStore: memoryPairLockStore() });
  const { pairingId } = host.start();
  assert.equal(host.getStatus(pairingId)?.failure, 'relay-unavailable');
});

test('the system clock reads real time and its timers can be cancelled and never block exit', async () => {
  const before = Date.now();
  assert.ok(systemClock.now() >= before);
  let fired = 0;
  const cancel = systemClock.setTimer(() => void (fired += 1), 5);
  const cancelled = systemClock.setTimer(() => void (fired += 100), 5);
  cancelled();
  await new Promise((resolve) => setTimeout(resolve, 40));
  cancel();
  assert.equal(fired, 1);
});

/** A store for tests that never reach persistence (no database is opened). */
function newStoreNoDb(): RemotePairingStore {
  const unused = (): never => {
    throw new Error('the store must not be used in this test');
  };
  return {
    insertPairing: unused,
    getPairing: unused,
    listPairings: unused,
    countActivePairings: () => 0,
    openPairingKey: unused,
    revokeHostPairing: unused,
    deletePairing: unused,
    setPairingAlias: unused,
    listPendingDestroy: unused,
    clearPendingDestroy: unused,
    markConnected: unused,
    touchActivity: unused,
    expirePairing: unused,
  };
}

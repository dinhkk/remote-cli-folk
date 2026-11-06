import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { remoteConfigDb } from '@/modules/database/index.js';
import type { RemoteControllerPairingStatus, RemoteHostPairingStatus, RemotePairConnector } from '@/shared/types.js';

import { InvalidPairCodeError, deriveLinkKeys } from '../../crypto/key-derivation.js';
import { createSecretBox } from '../../crypto/secret-box.js';
import { createControllerPairingService } from '../../pairing/pairing-controller.service.js';
import { PairingError, createHostPairingService } from '../../pairing/pairing-host.service.js';
import { createPairingStore } from '../../pairing/pairing-store.service.js';
import { FakeRelay } from '../support/fake-relay.js';
import { createFakeRelayConnector } from '../support/fake-relay-connector.js';
import { createManualClock } from '../support/manual-clock.js';
import { withTempDatabase } from '../support/temp-database.js';

const RELAY_URL = 'wss://relay.example';
// Literal values on purpose: the tests must not agree with a wrong constant in the module under test.
const FIVE_MINUTES = 5 * 60_000;
const FIFTEEN_MINUTES = 15 * 60_000;
const PAIR_LOCK_KEY = 'remote.pair_lock_until';

/** One relay, one virtual clock, one database; the Host and the Controller share the process like a dev machine would. */
const makeWorld = ({ maxPairings, connector }: { maxPairings?: number; connector?: RemotePairConnector } = {}) => {
  const relay = new FakeRelay();
  const clock = createManualClock(relay.now(), relay);
  const store = createPairingStore({ box: createSecretBox(Buffer.alloc(32, 0x33)), now: clock.now });
  const connect = connector ?? createFakeRelayConnector(relay);
  const host = createHostPairingService({ connect, store, getRelayUrl: () => RELAY_URL, hostName: 'Office PC', clock, maxPairings });
  const controller = createControllerPairingService({ connect, store, getRelayUrl: () => RELAY_URL, clock });
  return { relay, clock, store, host, controller };
};
type World = ReturnType<typeof makeWorld>;

const hostStatus = (world: World, id: string): RemoteHostPairingStatus => {
  const status = world.host.getStatus(id);
  assert.ok(status, 'host pairing exists');
  return status;
};
const controllerStatus = (world: World, id: string): RemoteControllerPairingStatus => {
  const status = world.controller.getStatus(id);
  assert.ok(status, 'controller join exists');
  return status;
};

/** Host starts, Controller joins, both reach the SAS step. */
const joinedPair = async (world: World, deviceName = 'My Laptop') => {
  const started = world.host.start();
  const { joinId } = world.controller.join({ code: started.code, deviceName });
  await world.relay.flush();
  return { started, joinId, sas: controllerStatus(world, joinId).sas as string };
};

const completePairing = async (world: World) => {
  const pair = await joinedPair(world);
  assert.deepEqual(world.host.confirmSas(pair.started.pairingId, pair.sas), { ok: true });
  await world.relay.flush();
  return pair;
};

const wrongSas = (real: string): string => (real === '000000' ? '000001' : '000000');

test('a full pairing over the relay stores the same K on both sides (AC-2)', async () => {
  await withTempDatabase(async () => {
    const world = makeWorld();
    const { started, joinId, sas } = await joinedPair(world);

    assert.match(started.code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/, 'displayed as XXXX-XXXX');
    assert.equal(started.expiresAt, world.clock.now() + FIVE_MINUTES);

    const controllerView = controllerStatus(world, joinId);
    assert.equal(controllerView.state, 'showing-sas');
    assert.equal(controllerView.hostName, 'Office PC');
    assert.match(sas, /^\d{6}$/);

    const hostView = hostStatus(world, started.pairingId);
    assert.equal(hostView.state, 'awaiting-sas');
    assert.equal(hostView.controllerName, 'My Laptop');
    assert.equal(hostView.attemptsLeft, 3);
    assert.equal(world.store.listPairings().length, 0, 'nothing is stored before the SAS is accepted');

    assert.deepEqual(world.host.confirmSas(started.pairingId, sas), { ok: true });
    await world.relay.flush();

    assert.equal(hostStatus(world, started.pairingId).state, 'done');
    const done = controllerStatus(world, joinId);
    assert.equal(done.state, 'done');
    assert.equal(done.sas, undefined, 'the SAS disappears once it has served its purpose');

    const hostRow = world.store.getPairing(hostStatus(world, started.pairingId).pairingId as string);
    const controllerRow = world.store.getPairing(done.peerId as string);
    assert.ok(hostRow && controllerRow);
    assert.deepEqual([hostRow.role, hostRow.peerName, hostRow.relayUrl], ['host', 'My Laptop', RELAY_URL]);
    assert.deepEqual([controllerRow.role, controllerRow.peerName, controllerRow.relayUrl], ['controller', 'Office PC', RELAY_URL]);
    const hostK = world.store.openPairingKey(hostRow.id);
    assert.ok(hostK.equals(world.store.openPairingKey(controllerRow.id)));
    assert.equal(hostRow.roomId, deriveLinkKeys(hostK).roomId);
    assert.equal(controllerRow.roomId, hostRow.roomId);
    assert.equal(world.clock.pendingTimers(), 0, 'no timer outlives a finished ceremony');
  });
});

test('the Host status never carries the SAS, in any state', async () => {
  await withTempDatabase(async () => {
    const world = makeWorld();
    const { started, sas } = await joinedPair(world);
    const snapshots: RemoteHostPairingStatus[] = [hostStatus(world, started.pairingId)];
    world.host.confirmSas(started.pairingId, wrongSas(sas));
    snapshots.push(hostStatus(world, started.pairingId));
    for (const snapshot of snapshots) {
      assert.ok(!Object.keys(snapshot).some((key) => /sas/i.test(key)), JSON.stringify(snapshot));
      for (const value of Object.values(snapshot)) assert.notEqual(String(value), sas);
    }
  });
});

test('wrong SAS entries lower attemptsLeft; three wrong ones cancel the pairing and lock the Host for 15 minutes (AC-3)', async () => {
  await withTempDatabase(async () => {
    const world = makeWorld();
    const { started, joinId, sas } = await joinedPair(world);
    const wrong = wrongSas(sas);

    assert.deepEqual(world.host.confirmSas(started.pairingId, wrong), { ok: false, attemptsLeft: 2 });
    assert.equal(hostStatus(world, started.pairingId).attemptsLeft, 2);
    assert.deepEqual(world.host.confirmSas(started.pairingId, wrong), { ok: false, attemptsLeft: 1 });
    const lockStart = world.clock.now();
    assert.deepEqual(world.host.confirmSas(started.pairingId, wrong), { ok: false, attemptsLeft: 0 });
    await world.relay.flush();

    const failed = hostStatus(world, started.pairingId);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.failure, 'sas-attempts-exhausted');
    assert.equal(failed.lockedUntil, lockStart + FIFTEEN_MINUTES);
    assert.equal(controllerStatus(world, joinId).state, 'failed');
    assert.equal(controllerStatus(world, joinId).failure, 'sas-attempts-exhausted');
    assert.equal(world.store.listPairings().length, 0, 'no pairing is created');

    assert.throws(() => world.host.start(), (error: unknown) => error instanceof PairingError && error.code === 'PAIRING_LOCKED' && error.lockedUntil === lockStart + FIFTEEN_MINUTES);
    world.clock.advance(FIFTEEN_MINUTES - 1);
    assert.throws(() => world.host.start(), (error: unknown) => error instanceof PairingError && error.code === 'PAIRING_LOCKED');
    world.clock.advance(1);
    assert.ok(world.host.start().code, 'the lock ends after 15 minutes');
  });
});

test('even the correct SAS is refused after the lockout began', async () => {
  await withTempDatabase(async () => {
    const world = makeWorld();
    const { started, sas } = await joinedPair(world);
    for (let i = 0; i < 3; i++) world.host.confirmSas(started.pairingId, wrongSas(sas));
    assert.throws(() => world.host.confirmSas(started.pairingId, sas), (error: unknown) => error instanceof PairingError && error.code === 'PAIRING_NOT_READY');
    assert.equal(world.store.listPairings().length, 0);
  });
});

test('malformed SAS input is an error that does not use up an attempt', async () => {
  await withTempDatabase(async () => {
    const world = makeWorld();
    const { started, sas } = await joinedPair(world);
    for (const bad of ['', '12345', 'abcdef', '1234567']) {
      assert.throws(() => world.host.confirmSas(started.pairingId, bad), (error: unknown) => error instanceof PairingError && error.code === 'INVALID_SAS');
    }
    assert.equal(hostStatus(world, started.pairingId).attemptsLeft, 3);
    assert.deepEqual(world.host.confirmSas(started.pairingId, sas), { ok: true });
  });
});

test('confirming an unknown pairing or one without a Controller is refused', async () => {
  await withTempDatabase(() => {
    const world = makeWorld();
    assert.throws(() => world.host.confirmSas('nope', '123456'), (error: unknown) => error instanceof PairingError && error.code === 'PAIRING_NOT_FOUND');
    const { pairingId } = world.host.start();
    assert.throws(() => world.host.confirmSas(pairingId, '123456'), (error: unknown) => error instanceof PairingError && error.code === 'PAIRING_NOT_READY');
    assert.equal(world.host.getStatus('nope'), null);
    assert.equal(world.host.getStatus(pairingId)?.state, 'waiting-controller');
  });
});

test('after five minutes the pairing is cancelled; expiry never locks the Host, even after a Controller joined', async () => {
  await withTempDatabase(async () => {
    const lonely = makeWorld();
    const idle = lonely.host.start();
    await lonely.relay.flush();
    lonely.clock.advance(FIVE_MINUTES - 1);
    assert.equal(hostStatus(lonely, idle.pairingId).state, 'waiting-controller');
    lonely.clock.advance(1);
    await lonely.relay.flush();
    assert.equal(hostStatus(lonely, idle.pairingId).state, 'failed');
    assert.equal(hostStatus(lonely, idle.pairingId).failure, 'expired');
    assert.equal(hostStatus(lonely, idle.pairingId).lockedUntil, undefined, 'a code nobody used does not lock the Host');
    assert.ok(lonely.host.start().code);

    const world = makeWorld();
    const { started, joinId } = await joinedPair(world);
    world.clock.advance(FIVE_MINUTES);
    await world.relay.flush();
    assert.equal(hostStatus(world, started.pairingId).failure, 'expired');
    assert.equal(hostStatus(world, started.pairingId).lockedUntil, undefined, 'only three wrong SAS entries lock: anyone holding the code could otherwise lock the Host');
    assert.equal(controllerStatus(world, joinId).failure, 'expired');
    assert.ok(world.host.start().code);
    assert.equal(world.store.listPairings().length, 0);
  });
});

test('the Host rejecting a connected Controller cancels without locking; neither does cancelling an unused code', async () => {
  await withTempDatabase(async () => {
    const unused = makeWorld();
    const first = unused.host.start();
    unused.host.cancel(first.pairingId);
    assert.equal(hostStatus(unused, first.pairingId).failure, 'cancelled');
    assert.ok(unused.host.start().code);

    const world = makeWorld();
    const { started, joinId } = await joinedPair(world);
    world.host.cancel(started.pairingId);
    await world.relay.flush();
    assert.equal(hostStatus(world, started.pairingId).failure, 'cancelled');
    assert.equal(hostStatus(world, started.pairingId).lockedUntil, undefined);
    assert.equal(controllerStatus(world, joinId).failure, 'cancelled');
    assert.ok(world.host.start().code, 'a user who rejects a stranger is not punished');
    world.host.cancel(started.pairingId); // idempotent
    world.host.cancel('unknown');
  });
});

test('starting a new pairing supersedes a running one that nobody joined, without locking', async () => {
  await withTempDatabase(() => {
    const world = makeWorld();
    const first = world.host.start();
    const second = world.host.start();
    assert.notEqual(first.code, second.code);
    assert.equal(hostStatus(world, first.pairingId).failure, 'cancelled');
    assert.equal(hostStatus(world, second.pairingId).state, 'waiting-controller');
  });
});

test('start() while a Controller has joined (a double click) returns the running pairing: nothing is cancelled, nothing locks', async () => {
  await withTempDatabase(async () => {
    const world = makeWorld();
    const { started, joinId, sas } = await joinedPair(world);
    const again = world.host.start();
    assert.deepEqual(again, started, 'the same pairing, code and expiry are shown again');
    await world.relay.flush();
    assert.equal(hostStatus(world, started.pairingId).state, 'awaiting-sas');
    assert.equal(controllerStatus(world, joinId).state, 'showing-sas');
    assert.equal(hostStatus(world, started.pairingId).lockedUntil, undefined);
    assert.deepEqual(world.host.confirmSas(started.pairingId, sas), { ok: true }, 'the ceremony carries on');
    assert.equal(remoteConfigDb.get(PAIR_LOCK_KEY), null, 'no lock was ever written');
  });
});

test('three wrong SAS entries persist the lock (remote.pair_lock_until, epoch ms): a restart cannot bypass it', async () => {
  await withTempDatabase(async () => {
    const world = makeWorld();
    const { started, sas } = await joinedPair(world);
    const lockStart = world.clock.now();
    for (let i = 0; i < 3; i++) world.host.confirmSas(started.pairingId, wrongSas(sas));
    assert.equal(remoteConfigDb.get(PAIR_LOCK_KEY), String(lockStart + FIFTEEN_MINUTES));

    // "Restart": a brand new service over the same database, the lock still holds.
    const restarted = createHostPairingService({ connect: createFakeRelayConnector(world.relay), store: world.store, getRelayUrl: () => RELAY_URL, hostName: 'Office PC', clock: world.clock });
    assert.throws(() => restarted.start(), (error: unknown) => error instanceof PairingError && error.code === 'PAIRING_LOCKED' && error.lockedUntil === lockStart + FIFTEEN_MINUTES);
    world.clock.advance(FIFTEEN_MINUTES);
    assert.ok(restarted.start().code, 'and it ends on time');
  });
});

test('the persisted lock is read with the throwing repository: an unreadable database refuses to start a pairing', async () => {
  await withTempDatabase(() => {
    const world = makeWorld();
    const failing = createHostPairingService({
      connect: createFakeRelayConnector(world.relay),
      store: world.store,
      getRelayUrl: () => RELAY_URL,
      clock: world.clock,
      lockStore: {
        read: () => {
          throw new Error('database unavailable');
        },
        write: () => undefined,
      },
    });
    assert.throws(() => failing.start(), /database unavailable/);
  });
});

test('a lock that cannot be persisted still applies in memory and does not break the teardown', async () => {
  await withTempDatabase(async () => {
    const world = makeWorld();
    const host = createHostPairingService({
      connect: createFakeRelayConnector(world.relay),
      store: world.store,
      getRelayUrl: () => RELAY_URL,
      clock: world.clock,
      lockStore: {
        read: () => 0,
        write: () => {
          throw new Error('disk full');
        },
      },
    });
    const started = host.start();
    const { joinId } = world.controller.join({ code: started.code, deviceName: 'My Laptop' });
    await world.relay.flush();
    const sas = controllerStatus(world, joinId).sas as string;
    for (let i = 0; i < 3; i++) host.confirmSas(started.pairingId, wrongSas(sas));
    assert.equal(host.getStatus(started.pairingId)?.failure, 'sas-attempts-exhausted');
    assert.throws(() => host.start(), (error: unknown) => error instanceof PairingError && error.code === 'PAIRING_LOCKED');
  });
});

test('a code is single use: after a completed pairing the same code is dead (4410)', async () => {
  await withTempDatabase(async () => {
    const world = makeWorld();
    const { started } = await completePairing(world);
    const again = world.controller.join({ code: started.code, deviceName: 'Intruder' });
    await world.relay.flush();
    assert.equal(controllerStatus(world, again.joinId).state, 'failed');
    assert.equal(controllerStatus(world, again.joinId).failure, 'code-used-or-expired');
    assert.equal(world.store.countActivePairings('host'), 1);
  });
});

test('a second Controller using the code mid-ceremony replaces the first; the Host fails the pairing', async () => {
  await withTempDatabase(async () => {
    const world = makeWorld();
    const { started, joinId } = await joinedPair(world);
    const second = world.controller.join({ code: started.code, deviceName: 'Second' });
    await world.relay.flush();
    assert.equal(hostStatus(world, started.pairingId).state, 'failed');
    assert.equal(hostStatus(world, started.pairingId).failure, 'peer-changed');
    assert.equal(controllerStatus(world, joinId).state, 'failed');
    assert.notEqual(controllerStatus(world, second.joinId).state, 'done');
    assert.equal(world.store.listPairings().length, 0);
  });
});

test('an unknown code never finds a room (4404) and a malformed code is rejected before any network use', async () => {
  await withTempDatabase(async () => {
    const world = makeWorld();
    const { joinId } = world.controller.join({ code: 'ZZZZ-ZZZZ', deviceName: 'My Laptop' });
    await world.relay.flush();
    assert.equal(controllerStatus(world, joinId).failure, 'code-not-found');
    assert.throws(() => world.controller.join({ code: 'nope', deviceName: 'x' }), InvalidPairCodeError);
    assert.equal(world.controller.getStatus('unknown'), null);
  });
});

test('relay close codes map to Controller failures', async () => {
  const cases: Array<[number, string]> = [
    [4404, 'code-not-found'],
    [4410, 'code-used-or-expired'],
    [4429, 'relay-locked'],
    [4401, 'relay-rejected'],
    [4409, 'peer-changed'],
    [0, 'relay-unavailable'],
    [1006, 'relay-unavailable'],
  ];
  await withTempDatabase(async () => {
    for (const [code, failure] of cases) {
      const connector: RemotePairConnector = (_target, handlers) => {
        queueMicrotask(() => handlers.onClose(code));
        return { sendFrame: () => undefined, sendDestroy: () => undefined, close: () => undefined };
      };
      const world = makeWorld({ connector });
      const { joinId } = world.controller.join({ code: 'ABCD-EFGH', deviceName: 'My Laptop' });
      await world.relay.flush();
      assert.equal(controllerStatus(world, joinId).failure, failure, `close ${code}`);
    }
  });
});

test('relay close codes map to Host failures: a refused gate/token is relay-rejected, never a lock', async () => {
  const cases: Array<[number, string]> = [
    [4410, 'expired'],
    [4401, 'relay-rejected'],
    [4429, 'relay-locked'],
    [4409, 'relay-unavailable'],
    [0, 'relay-unavailable'],
    [1006, 'relay-unavailable'],
  ];
  await withTempDatabase(async () => {
    for (const [code, failure] of cases) {
      const connector: RemotePairConnector = (_target, handlers) => {
        queueMicrotask(() => handlers.onClose(code));
        return { sendFrame: () => undefined, sendDestroy: () => undefined, close: () => undefined };
      };
      const world = makeWorld({ connector });
      const { pairingId } = world.host.start();
      await world.relay.flush();
      assert.equal(hostStatus(world, pairingId).failure, failure, `close ${code}`);
      assert.equal(hostStatus(world, pairingId).lockedUntil, undefined);
    }
  });
});

test('an unreachable relay fails the Host pairing instead of leaving a code that cannot work', async () => {
  await withTempDatabase(async () => {
    const connector: RemotePairConnector = (_target, handlers) => {
      queueMicrotask(() => handlers.onClose(0));
      return { sendFrame: () => undefined, sendDestroy: () => undefined, close: () => undefined };
    };
    const world = makeWorld({ connector });
    const { pairingId } = world.host.start();
    await world.relay.flush();
    assert.equal(hostStatus(world, pairingId).state, 'failed');
    assert.equal(hostStatus(world, pairingId).failure, 'relay-unavailable');
    assert.ok(world.host.start().code, 'a relay outage does not lock the Host');
  });
});

test('the Host refuses a pairing beyond the maximum with a clear error, and revoking frees a slot (FR-7)', async () => {
  await withTempDatabase(async () => {
    const world = makeWorld({ maxPairings: 2 });
    const first = await completePairing(world);
    await completePairing(world);
    assert.equal(world.store.countActivePairings('host'), 2);
    assert.throws(
      () => world.host.start(),
      (error: unknown) => error instanceof PairingError && error.code === 'PAIRING_LIMIT' && /2/.test(error.message),
    );
    const firstHostId = hostStatus(world, first.started.pairingId).pairingId as string;
    world.store.revokeHostPairing(firstHostId);
    assert.ok(world.host.start().code);
  });
});

test('the default limit is 8 Host pairings', async () => {
  await withTempDatabase(() => {
    const world = makeWorld();
    for (let i = 0; i < 8; i++) {
      world.store.insertPairing({ role: 'host', peerName: `d${i}`, k: crypto.randomBytes(32), relayUrl: RELAY_URL });
    }
    assert.throws(() => world.host.start(), (error: unknown) => error instanceof PairingError && error.code === 'PAIRING_LIMIT');
    world.store.insertPairing({ role: 'controller', peerName: 'host', k: crypto.randomBytes(32), relayUrl: RELAY_URL });
  });
});

test('the Controller device name is sanitized on the way out', async () => {
  await withTempDatabase(async () => {
    const world = makeWorld();
    const { started } = await joinedPair(world, `<b>${'N'.repeat(50)}</b>`);
    assert.equal(hostStatus(world, started.pairingId).controllerName, 'b' + 'N'.repeat(31));
  });
});

test('a Controller can cancel its join; the Host is told', async () => {
  await withTempDatabase(async () => {
    const world = makeWorld();
    const { started, joinId } = await joinedPair(world);
    world.controller.cancel(joinId);
    await world.relay.flush();
    assert.equal(controllerStatus(world, joinId).state, 'failed');
    assert.equal(controllerStatus(world, joinId).failure, 'cancelled');
    assert.equal(hostStatus(world, started.pairingId).failure, 'peer-aborted', 'the abort frame reaches the Host before the socket closes');
    world.controller.cancel(joinId);
    world.controller.cancel('unknown');
  });
});

test('nothing the pairing flow logs contains the code, SAS or K', async () => {
  const captured: string[] = [];
  const originals = new Map<string, unknown>();
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    originals.set(method, console[method]);
    console[method] = (...args: unknown[]) => {
      captured.push(args.map(String).join(' '));
    };
  }
  let secrets: string[] = [];
  try {
    await withTempDatabase(async () => {
      const world = makeWorld();
      const { started, sas } = await joinedPair(world);
      world.host.confirmSas(started.pairingId, wrongSas(sas));
      world.host.confirmSas(started.pairingId, sas);
      await world.relay.flush();
      const rowId = hostStatus(world, started.pairingId).pairingId as string;
      const k = world.store.openPairingKey(rowId);
      secrets = [started.code, started.code.replace('-', ''), sas, k.toString('hex'), k.toString('base64'), k.toString('base64url')];
    });
  } finally {
    for (const [method, original] of originals) (console as unknown as Record<string, unknown>)[method] = original;
  }
  const output = captured.join('\n');
  for (const secret of secrets) assert.ok(!output.includes(secret), 'a secret value was logged');
});

test('pairing sources never write to the console or stdio', () => {
  const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'pairing');
  const sources = fs.readdirSync(directory).filter((name) => name.endsWith('.ts'));
  assert.ok(sources.length >= 5);
  for (const name of sources) {
    const source = fs.readFileSync(path.join(directory, name), 'utf8');
    assert.ok(!/\bconsole\./.test(source), `${name} uses console`);
    assert.ok(!/process\.(stdout|stderr)/.test(source), `${name} writes to stdio`);
  }
});

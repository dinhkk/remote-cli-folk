import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  HANDSHAKE_TIMEOUT_MS,
  HELLO1_LENGTH,
  HELLO1_RATE_LIMIT,
  HELLO1_RATE_WINDOW_MS,
  HELLO2_LENGTH,
  HELLO3_LENGTH,
  HandshakeError,
  createControllerHandshake,
  createHostHandshakeListener,
} from '../../crypto/handshake.js';

const K = Buffer.alloc(32, 7);
const OTHER_K = Buffer.alloc(32, 8);

/** Mutable clock injected into both sides so timeouts and rate limits need no real waiting. */
const createClock = (start = 1_000_000) => {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
};

type Deps = Parameters<typeof createHostHandshakeListener>[0];

/** Runs one complete handshake and returns every message plus both key sets. */
const runHandshake = (clock = createClock(), hostKey = K, controllerKey = K) => {
  const listener = createHostHandshakeListener({ k: hostKey, now: clock.now });
  const controller = createControllerHandshake({ k: controllerKey, now: clock.now });
  const pending = listener.acceptHello1(controller.hello1);
  const completed = controller.completeWithHello2(pending.hello2);
  const hostKeys = pending.completeWithHello3(completed.hello3);
  return { listener, controller, pending, completed, hostKeys, clock };
};

const expectCode = (fn: () => unknown, code: string) =>
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof HandshakeError, `expected HandshakeError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });

const flipBit = (buffer: Buffer, index: number) => {
  const copy = Buffer.from(buffer);
  copy[index] ^= 0x01;
  return copy;
};

test('message layouts have the contracted sizes and type bytes', () => {
  assert.equal(HELLO1_LENGTH, 1 + 16 + 32);
  assert.equal(HELLO2_LENGTH, 1 + 16 + 32 + 32);
  assert.equal(HELLO3_LENGTH, 1 + 32);
  const { controller, pending, completed } = runHandshake();
  assert.equal(controller.hello1.length, HELLO1_LENGTH);
  assert.equal(controller.hello1[0], 1);
  assert.equal(pending.hello2.length, HELLO2_LENGTH);
  assert.equal(pending.hello2[0], 2);
  assert.equal(completed.hello3.length, HELLO3_LENGTH);
  assert.equal(completed.hello3[0], 3);
});

test('both sides sharing K end with matching, oriented directional keys', () => {
  const { completed, hostKeys } = runHandshake();
  assert.deepEqual(completed.keys.sendKey, hostKeys.receiveKey);
  assert.deepEqual(completed.keys.receiveKey, hostKeys.sendKey);
  assert.notDeepEqual(completed.keys.sendKey, completed.keys.receiveKey);
  assert.equal(completed.keys.sendKey.length, 32);
});

test('two handshakes with the same K derive different keys (forward secrecy)', () => {
  const first = runHandshake();
  const second = runHandshake();
  assert.notDeepEqual(first.completed.keys.sendKey, second.completed.keys.sendKey);
  assert.notDeepEqual(first.completed.keys.receiveKey, second.completed.keys.receiveKey);
  assert.notDeepEqual(first.controller.hello1, second.controller.hello1);
});

test('a controller with the wrong K rejects HELLO2 (bad MAC)', () => {
  const listener = createHostHandshakeListener({ k: K });
  const controller = createControllerHandshake({ k: OTHER_K });
  const pending = listener.acceptHello1(controller.hello1);
  expectCode(() => controller.completeWithHello2(pending.hello2), 'bad-mac');
});

test('a host with the wrong K rejects HELLO3 (bad MAC)', () => {
  const clock = createClock();
  const listener = createHostHandshakeListener({ k: K, now: clock.now });
  const attacker = createControllerHandshake({ k: OTHER_K, now: clock.now });
  const pending = listener.acceptHello1(attacker.hello1);
  // The attacker cannot verify HELLO2, so it forges HELLO3 with its own key.
  const forged = Buffer.concat([Buffer.from([3]), crypto.randomBytes(32)]);
  expectCode(() => pending.completeWithHello3(forged), 'bad-mac');
});

test('tampering with any authenticated byte of HELLO2 is rejected', () => {
  // Offsets: 1..16 nonceH, 17..48 ephPubH, 49..80 MAC.
  for (const index of [1, 16, 17, 48, 49, 80]) {
    const controller = createControllerHandshake({ k: K });
    const pending = createHostHandshakeListener({ k: K }).acceptHello1(controller.hello1);
    expectCode(() => controller.completeWithHello2(flipBit(pending.hello2, index)), 'bad-mac');
    // A rejected forgery must not burn the handshake: the genuine HELLO2 still completes.
    assert.ok(controller.completeWithHello2(pending.hello2));
  }
});

test('wrong message type or length is rejected before any MAC work', () => {
  const controller = createControllerHandshake({ k: K });
  const pending = createHostHandshakeListener({ k: K }).acceptHello1(controller.hello1);
  expectCode(() => controller.completeWithHello2(flipBit(pending.hello2, 0)), 'bad-type');
  expectCode(() => controller.completeWithHello2(pending.hello2.subarray(0, HELLO2_LENGTH - 1)), 'bad-length');
  expectCode(() => controller.completeWithHello2(Buffer.concat([pending.hello2, Buffer.alloc(1)])), 'bad-length');
});

test('tampering with HELLO3 is rejected and wrong type/length are classified', () => {
  const clock = createClock();
  const listener = createHostHandshakeListener({ k: K, now: clock.now });
  const controller = createControllerHandshake({ k: K, now: clock.now });
  const pending = listener.acceptHello1(controller.hello1);
  const { hello3 } = controller.completeWithHello2(pending.hello2);
  expectCode(() => pending.completeWithHello3(flipBit(hello3, 10)), 'bad-mac');
  expectCode(() => pending.completeWithHello3(flipBit(hello3, 0)), 'bad-type');
  expectCode(() => pending.completeWithHello3(hello3.subarray(0, 10)), 'bad-length');
  // The genuine message still completes after the rejected attempts.
  assert.ok(pending.completeWithHello3(hello3));
});

test('an old HELLO1 replayed on a new connection cannot be completed with the old HELLO3', () => {
  const clock = createClock();
  const first = runHandshake(clock);
  // Attacker replays the recorded HELLO1 against a fresh pending handshake.
  const replayed = first.listener.acceptHello1(first.controller.hello1);
  expectCode(() => replayed.completeWithHello3(first.completed.hello3), 'bad-mac');
});

test('an old HELLO2 replayed to a new controller handshake is rejected', () => {
  const oldRun = runHandshake();
  const newController = createControllerHandshake({ k: K });
  expectCode(() => newController.completeWithHello2(oldRun.pending.hello2), 'bad-mac');
});

test('HELLO1 of the wrong length or type is dropped before any ECDH computation', () => {
  let dhCalls = 0;
  const listener = createHostHandshakeListener({
    k: K,
    diffieHellman: (options) => {
      dhCalls += 1;
      return crypto.diffieHellman(options);
    },
  });
  const valid = createControllerHandshake({ k: K }).hello1;
  const cases: Array<[Buffer, string]> = [
    [Buffer.alloc(0), 'bad-length'],
    [valid.subarray(0, HELLO1_LENGTH - 1), 'bad-length'],
    [Buffer.concat([valid, Buffer.alloc(1)]), 'bad-length'],
    [Buffer.alloc(4096), 'bad-length'],
    [flipBit(valid, 0), 'bad-type'],
  ];
  for (const [message, code] of cases) expectCode(() => listener.acceptHello1(message), code);
  assert.equal(dhCalls, 0);
  listener.acceptHello1(valid);
  assert.equal(dhCalls, 1);
});

test('malformed HELLO1 does not consume the rate-limit budget', () => {
  const clock = createClock();
  const listener = createHostHandshakeListener({ k: K, now: clock.now });
  for (let i = 0; i < 50; i += 1) expectCode(() => listener.acceptHello1(Buffer.alloc(3)), 'bad-length');
  listener.acceptHello1(createControllerHandshake({ k: K }).hello1);
});

test('the host accepts at most 5 HELLO1 per 10 seconds', () => {
  assert.equal(HELLO1_RATE_LIMIT, 5);
  assert.equal(HELLO1_RATE_WINDOW_MS, 10_000);
  const clock = createClock();
  const listener = createHostHandshakeListener({ k: K, now: clock.now });
  for (let i = 0; i < HELLO1_RATE_LIMIT; i += 1) {
    listener.acceptHello1(createControllerHandshake({ k: K }).hello1);
    clock.advance(100);
  }
  const extra = createControllerHandshake({ k: K }).hello1;
  expectCode(() => listener.acceptHello1(extra), 'handshake-rate-limited');
  // Rejected attempts do not extend the lock-out: once the first accepted one ages out, it works.
  clock.advance(HELLO1_RATE_WINDOW_MS - HELLO1_RATE_LIMIT * 100);
  listener.acceptHello1(extra);
});

test('rate-limit window slides instead of resetting all at once', () => {
  const clock = createClock();
  const listener = createHostHandshakeListener({ k: K, now: clock.now });
  for (let i = 0; i < HELLO1_RATE_LIMIT; i += 1) {
    listener.acceptHello1(createControllerHandshake({ k: K }).hello1);
    clock.advance(1_000);
  }
  // 5 s elapsed: all five are still inside the 10 s window.
  expectCode(() => listener.acceptHello1(createControllerHandshake({ k: K }).hello1), 'handshake-rate-limited');
  clock.advance(5_001); // oldest (t=0) is now > 10 s old, the rest are not
  listener.acceptHello1(createControllerHandshake({ k: K }).hello1);
  expectCode(() => listener.acceptHello1(createControllerHandshake({ k: K }).hello1), 'handshake-rate-limited');
});

test('a HELLO1 in the middle of a session starts a fresh handshake with new keys', () => {
  const clock = createClock();
  const first = runHandshake(clock);
  clock.advance(500);
  const controller = createControllerHandshake({ k: K, now: clock.now });
  const pending = first.listener.acceptHello1(controller.hello1);
  const completed = controller.completeWithHello2(pending.hello2);
  const hostKeys = pending.completeWithHello3(completed.hello3);
  assert.deepEqual(completed.keys.sendKey, hostKeys.receiveKey);
  assert.notDeepEqual(hostKeys.receiveKey, first.hostKeys.receiveKey);
});

test('a newer HELLO1 supersedes an older pending handshake', () => {
  const clock = createClock();
  const listener = createHostHandshakeListener({ k: K, now: clock.now });
  const oldController = createControllerHandshake({ k: K, now: clock.now });
  const oldPending = listener.acceptHello1(oldController.hello1);
  const oldHello3 = oldController.completeWithHello2(oldPending.hello2).hello3;
  const newController = createControllerHandshake({ k: K, now: clock.now });
  const newPending = listener.acceptHello1(newController.hello1);
  expectCode(() => oldPending.completeWithHello3(oldHello3), 'superseded');
  const newHello3 = newController.completeWithHello2(newPending.hello2).hello3;
  assert.ok(newPending.completeWithHello3(newHello3));
});

test('a pending handshake and a controller handshake complete only once', () => {
  const run = runHandshake();
  expectCode(() => run.pending.completeWithHello3(run.completed.hello3), 'bad-state');
  expectCode(() => run.controller.completeWithHello2(run.pending.hello2), 'bad-state');
});

test('waiting longer than 10 seconds for HELLO3 fails with handshake-timeout', () => {
  assert.equal(HANDSHAKE_TIMEOUT_MS, 10_000);
  const clock = createClock();
  const listener = createHostHandshakeListener({ k: K, now: clock.now });
  const controller = createControllerHandshake({ k: K, now: clock.now });
  const pending = listener.acceptHello1(controller.hello1);
  const { hello3 } = controller.completeWithHello2(pending.hello2);
  clock.advance(HANDSHAKE_TIMEOUT_MS - 1);
  assert.equal(pending.isExpired(), false);
  clock.advance(1);
  assert.equal(pending.isExpired(), true);
  expectCode(() => pending.completeWithHello3(hello3), 'handshake-timeout');
});

test('a HELLO3 that arrives just inside the window still completes', () => {
  const clock = createClock();
  const listener = createHostHandshakeListener({ k: K, now: clock.now });
  const controller = createControllerHandshake({ k: K, now: clock.now });
  const pending = listener.acceptHello1(controller.hello1);
  const { hello3 } = controller.completeWithHello2(pending.hello2);
  clock.advance(HANDSHAKE_TIMEOUT_MS - 1);
  assert.ok(pending.completeWithHello3(hello3));
});

test('waiting longer than 10 seconds for HELLO2 fails with handshake-timeout', () => {
  const clock = createClock();
  const listener = createHostHandshakeListener({ k: K, now: clock.now });
  const controller = createControllerHandshake({ k: K, now: clock.now });
  const pending = listener.acceptHello1(controller.hello1);
  assert.equal(controller.isExpired(), false);
  clock.advance(HANDSHAKE_TIMEOUT_MS);
  assert.equal(controller.isExpired(), true);
  expectCode(() => controller.completeWithHello2(pending.hello2), 'handshake-timeout');
});

test('an invalid (low-order) ephemeral public key is rejected as invalid-key', () => {
  const listener = createHostHandshakeListener({ k: K });
  const hello1 = Buffer.concat([Buffer.from([1]), crypto.randomBytes(16), Buffer.alloc(32)]);
  expectCode(() => listener.acceptHello1(hello1), 'invalid-key');
});

test('an all-zero ECDH output is rejected even if the primitive does not throw', () => {
  const listener = createHostHandshakeListener({ k: K, diffieHellman: () => Buffer.alloc(32) });
  expectCode(() => listener.acceptHello1(createControllerHandshake({ k: K }).hello1), 'invalid-key');
});

test('constructors reject keys that are not 32 bytes', () => {
  assert.throws(() => createControllerHandshake({ k: Buffer.alloc(16) }), /32 bytes/);
  assert.throws(() => createHostHandshakeListener({ k: Buffer.alloc(16) } as Deps), /32 bytes/);
});

test('handshake errors never contain key material', () => {
  const controller = createControllerHandshake({ k: OTHER_K });
  const pending = createHostHandshakeListener({ k: K }).acceptHello1(controller.hello1);
  try {
    controller.completeWithHello2(pending.hello2);
    assert.fail('expected a rejection');
  } catch (error) {
    const text = `${(error as Error).message} ${(error as Error).stack ?? ''}`;
    assert.ok(!text.includes(K.toString('hex')));
    assert.ok(!text.includes(K.toString('base64')));
  }
});

test('HELLO2 and HELLO3 MACs match an independent HMAC computation over the documented inputs', () => {
  const macKey = Buffer.from(crypto.hkdfSync('sha256', K, Buffer.alloc(0), 'remotecli/v1/mac', 32));
  const hmac = (...parts: Buffer[]) => {
    const mac = crypto.createHmac('sha256', macKey);
    for (const part of parts) mac.update(part);
    return mac.digest();
  };
  const { controller, pending, completed } = runHandshake();
  const nonceAndKeyH = pending.hello2.subarray(1, 49);
  assert.deepEqual(pending.hello2.subarray(49), hmac(Buffer.from('host'), controller.hello1, nonceAndKeyH));
  assert.deepEqual(completed.hello3.subarray(1), hmac(Buffer.from('controller'), controller.hello1, pending.hello2));
});

test('a HELLO1 altered in transit makes the HELLO2 unverifiable for the real controller', () => {
  for (const index of [1, 16, 17, 48]) {
    const listener = createHostHandshakeListener({ k: K });
    const controller = createControllerHandshake({ k: K });
    const pending = listener.acceptHello1(flipBit(controller.hello1, index));
    expectCode(() => controller.completeWithHello2(pending.hello2), 'bad-mac');
  }
});

test('real low-order X25519 points are rejected as invalid-key', () => {
  const lowOrder = [
    '0000000000000000000000000000000000000000000000000000000000000000', // u = 0
    '0100000000000000000000000000000000000000000000000000000000000000', // u = 1
    'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800', // order 8
    '5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157', // order 8
    'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', // p - 1
  ];
  for (const point of lowOrder) {
    const listener = createHostHandshakeListener({ k: K });
    const hello1 = Buffer.concat([Buffer.from([1]), crypto.randomBytes(16), Buffer.from(point, 'hex')]);
    expectCode(() => listener.acceptHello1(hello1), 'invalid-key');
  }
});

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  ChannelDesync,
  FRAME_HEADER_BYTES,
  FRAME_OVERHEAD_BYTES,
  FRAME_TYPE_DATA,
  MAX_CONSECUTIVE_BAD_FRAMES,
  MAX_FRAME_BYTES,
  MAX_PLAINTEXT_BYTES,
  SecureChannelError,
  createSecureChannel,
} from '../../crypto/secure-channel.js';

const KEY_A = Buffer.alloc(32, 0xa1); // controller -> host
const KEY_B = Buffer.alloc(32, 0xb2); // host -> controller
const MAX_U64 = 2n ** 64n - 1n;

type Options = Partial<Parameters<typeof createSecureChannel>[0]>;

/** Two channels wired with mirrored keys; every frame each side transmits is captured. */
const createPair = (controllerOptions: Options = {}, hostOptions: Options = {}) => {
  const controllerFrames: Buffer[] = [];
  const hostFrames: Buffer[] = [];
  const controller = createSecureChannel({
    sendKey: KEY_A,
    receiveKey: KEY_B,
    transmit: (frame) => {
      controllerFrames.push(frame);
    },
    ...controllerOptions,
  });
  const host = createSecureChannel({
    sendKey: KEY_B,
    receiveKey: KEY_A,
    transmit: (frame) => {
      hostFrames.push(frame);
    },
    ...hostOptions,
  });
  return { controller, host, controllerFrames, hostFrames };
};

const counterOf = (frame: Buffer) => frame.readBigUInt64BE(1);
const text = (value: string) => Buffer.from(value, 'utf8');

const expectDesync = (fn: () => unknown, code: string) =>
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof ChannelDesync, `expected ChannelDesync, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });

const rejectsWith = async (promise: Promise<unknown>, type: new (...args: never[]) => Error, code: string) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof type, `expected ${type.name}, got ${String(error)}`);
    assert.equal((error as unknown as { code: string }).code, code);
    return true;
  });
};

test('frames round-trip in both directions', async () => {
  const { controller, host, controllerFrames, hostFrames } = createPair();
  await controller.send(text('ping'));
  await host.send(text('pong'));
  assert.deepEqual(host.receive(controllerFrames[0]), text('ping'));
  assert.deepEqual(controller.receive(hostFrames[0]), text('pong'));
});

test('frame layout is [0x10][counter u64 BE][ciphertext||tag16] with a strictly increasing counter', async () => {
  const { controller, controllerFrames } = createPair();
  for (const word of ['a', 'bb', 'ccc']) await controller.send(text(word));
  assert.deepEqual(controllerFrames.map(counterOf), [0n, 1n, 2n]);
  assert.equal(FRAME_TYPE_DATA, 0x10);
  assert.equal(FRAME_HEADER_BYTES, 9);
  assert.equal(FRAME_OVERHEAD_BYTES, 25);
  controllerFrames.forEach((frame, index) => {
    assert.equal(frame[0], FRAME_TYPE_DATA);
    assert.equal(frame.length, FRAME_OVERHEAD_BYTES + [1, 2, 3][index]);
  });
});

test('IV is 4 zero bytes || counter and AAD is 0x10 || counter (independent decryption)', async () => {
  const { controller, controllerFrames } = createPair();
  await controller.send(text('first'));
  await controller.send(text('second'));
  const frame = controllerFrames[1];
  const header = frame.subarray(0, 9);
  const iv = Buffer.concat([Buffer.alloc(4), frame.subarray(1, 9)]);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY_A, iv);
  decipher.setAAD(header);
  decipher.setAuthTag(frame.subarray(frame.length - 16));
  const plain = Buffer.concat([decipher.update(frame.subarray(9, frame.length - 16)), decipher.final()]);
  assert.deepEqual(plain, text('second'));
});

test('a modified frame is dropped without advancing the counter and the real frame still arrives', async () => {
  const { controller, controllerFrames } = createPair();
  await controller.send(text('one'));
  const genuine = controllerFrames[0];
  // type byte, counter, ciphertext and tag each flipped independently (fresh receiver per byte so
  // the consecutive-bad-frame limit is not what is being tested here)
  for (const index of [0, 5, 9, genuine.length - 1]) {
    const host = createSecureChannel({ sendKey: KEY_B, receiveKey: KEY_A, transmit: () => undefined });
    const tampered = Buffer.from(genuine);
    tampered[index] ^= 0x01;
    assert.equal(host.receive(tampered), undefined, `byte ${index}`);
    assert.equal(host.isClosed, false);
    assert.deepEqual(host.receive(genuine), text('one'), `genuine frame after tampering byte ${index}`);
  }
});

test('a frame encrypted with the wrong direction key is dropped', async () => {
  const { controller, controllerFrames } = createPair();
  await controller.send(text('mine'));
  // Reflecting the controller\'s own frame back at it must not authenticate.
  assert.equal(controller.receive(controllerFrames[0]), undefined);
});

test('truncated, empty and oversized frames count as bad frames', () => {
  const { host } = createPair();
  assert.equal(host.receive(Buffer.alloc(0)), undefined);
  assert.equal(host.receive(Buffer.alloc(FRAME_OVERHEAD_BYTES - 1, FRAME_TYPE_DATA)), undefined);
  assert.equal(host.isClosed, false);
  expectDesync(() => host.receive(Buffer.alloc(MAX_FRAME_BYTES + 1, FRAME_TYPE_DATA)), 'too-many-bad-frames');
});

test('three consecutive bad frames are fatal; a good frame in between resets the streak', async () => {
  assert.equal(MAX_CONSECUTIVE_BAD_FRAMES, 3);
  const { controller, host, controllerFrames } = createPair();
  const bad = Buffer.alloc(40, 0x10);
  assert.equal(host.receive(bad), undefined);
  assert.equal(host.receive(bad), undefined);
  await controller.send(text('ok'));
  assert.deepEqual(host.receive(controllerFrames[0]), text('ok'));
  assert.equal(host.receive(bad), undefined);
  assert.equal(host.receive(bad), undefined);
  expectDesync(() => host.receive(bad), 'too-many-bad-frames');
  assert.equal(host.isClosed, true);
});

test('a replayed valid frame is fatal', async () => {
  const { controller, host, controllerFrames } = createPair();
  await controller.send(text('a'));
  assert.deepEqual(host.receive(controllerFrames[0]), text('a'));
  expectDesync(() => host.receive(controllerFrames[0]), 'counter-mismatch');
  assert.equal(host.isClosed, true);
});

test('reordered valid frames are fatal', async () => {
  const { controller, host, controllerFrames } = createPair();
  await controller.send(text('a'));
  await controller.send(text('b'));
  expectDesync(() => host.receive(controllerFrames[1]), 'counter-mismatch');
});

test('a lost frame (gap in counters) is fatal', async () => {
  const { controller, host, controllerFrames } = createPair();
  await controller.send(text('a'));
  await controller.send(text('b'));
  await controller.send(text('c'));
  assert.deepEqual(host.receive(controllerFrames[0]), text('a'));
  expectDesync(() => host.receive(controllerFrames[2]), 'counter-mismatch');
});

test('after a fatal desync the channel stays closed for receive and send', async () => {
  const { controller, host, controllerFrames } = createPair();
  await controller.send(text('a'));
  await controller.send(text('b'));
  expectDesync(() => host.receive(controllerFrames[1]), 'counter-mismatch');
  expectDesync(() => host.receive(controllerFrames[0]), 'counter-mismatch');
  await rejectsWith(host.send(text('x')), SecureChannelError, 'closed');
});

test('desync cancels every queued send', async () => {
  const releases: Array<() => void> = [];
  const sent: Buffer[] = [];
  const { controller, host, controllerFrames } = createPair(
    {},
    {
      transmit: (frame) => {
        sent.push(frame);
        return new Promise<void>((resolve) => releases.push(resolve));
      },
    },
  );
  await controller.send(text('a'));
  await controller.send(text('b'));
  const inFlight = host.send(text('1'));
  const queued = [host.send(text('2')), host.send(text('3'))];
  const queuedSettled = Promise.allSettled(queued);
  await new Promise((resolve) => setImmediate(resolve)); // let the first send reach the wire
  expectDesync(() => host.receive(controllerFrames[1]), 'counter-mismatch');
  const results = await queuedSettled;
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.ok((result as PromiseRejectedResult).reason instanceof ChannelDesync);
  }
  releases[0]();
  await inFlight;
  assert.equal(sent.length, 1, 'queued frames must never reach the wire after the desync');
});

test('100 parallel sends keep the counter order and never overlap on the wire', async () => {
  let active = 0;
  let maxActive = 0;
  const wire: Buffer[] = [];
  const { controller } = createPair({
    transmit: async (frame) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 3));
      wire.push(frame);
      active -= 1;
    },
  });
  await Promise.all(Array.from({ length: 100 }, (_, i) => controller.send(text(`m${i}`))));
  assert.equal(maxActive, 1);
  assert.deepEqual(wire.map(counterOf), Array.from({ length: 100 }, (_, i) => BigInt(i)));
  const receiver = createSecureChannel({ sendKey: KEY_B, receiveKey: KEY_A, transmit: () => undefined });
  wire.forEach((frame, i) => assert.deepEqual(receiver.receive(frame), text(`m${i}`)));
});

test('a failing transmit rejects that send and closes the channel', async () => {
  const boom = new Error('socket gone');
  let calls = 0;
  const { controller } = createPair({
    transmit: () => {
      calls += 1;
      throw boom;
    },
  });
  const first = controller.send(text('a'));
  const second = controller.send(text('b'));
  const [firstResult, secondResult] = await Promise.allSettled([first, second]);
  assert.equal(firstResult.status, 'rejected');
  assert.equal((firstResult as PromiseRejectedResult).reason, boom);
  assert.equal(secondResult.status, 'rejected');
  assert.equal(calls, 1);
  assert.equal(controller.isClosed, true);
});

test('counters cross the 32-bit boundary without breaking the IV', async () => {
  const start = 2n ** 32n - 1n;
  const { controller, controllerFrames } = createPair({ startSendCounter: start });
  const receiver = createSecureChannel({
    sendKey: KEY_B,
    receiveKey: KEY_A,
    transmit: () => undefined,
    startReceiveCounter: start,
  });
  await controller.send(text('lo'));
  await controller.send(text('hi'));
  assert.deepEqual(controllerFrames.map(counterOf), [start, start + 1n]);
  assert.deepEqual(receiver.receive(controllerFrames[0]), text('lo'));
  assert.deepEqual(receiver.receive(controllerFrames[1]), text('hi'));
});

test('the sender refuses to wrap a 64-bit counter', async () => {
  const { controller, controllerFrames } = createPair({ startSendCounter: MAX_U64 });
  await controller.send(text('last'));
  assert.equal(counterOf(controllerFrames[0]), MAX_U64);
  await rejectsWith(controller.send(text('overflow')), SecureChannelError, 'counter-exhausted');
  assert.equal(controllerFrames.length, 1);
  assert.equal(controller.isClosed, true);
});

test('the receiver closes after accepting the last possible counter', async () => {
  const { controller, controllerFrames } = createPair({ startSendCounter: MAX_U64 });
  const receiver = createSecureChannel({
    sendKey: KEY_B,
    receiveKey: KEY_A,
    transmit: () => undefined,
    startReceiveCounter: MAX_U64,
  });
  await controller.send(text('last'));
  assert.deepEqual(receiver.receive(controllerFrames[0]), text('last'));
  assert.equal(receiver.isClosed, true);
});

test('the largest payload fits in exactly one 2 MiB frame; one byte more is refused without side effects', async () => {
  assert.equal(MAX_FRAME_BYTES, 2 * 1024 * 1024);
  assert.equal(MAX_PLAINTEXT_BYTES, MAX_FRAME_BYTES - FRAME_OVERHEAD_BYTES);
  const { controller, host, controllerFrames } = createPair();
  const biggest = crypto.randomBytes(MAX_PLAINTEXT_BYTES);
  await controller.send(biggest);
  assert.equal(controllerFrames[0].length, MAX_FRAME_BYTES);
  assert.deepEqual(host.receive(controllerFrames[0]), biggest);
  await rejectsWith(controller.send(Buffer.alloc(MAX_PLAINTEXT_BYTES + 1)), SecureChannelError, 'payload-too-large');
  assert.equal(controller.isClosed, false);
  await controller.send(text('still works'));
  assert.equal(counterOf(controllerFrames[1]), 1n);
});

test('empty payloads are valid frames', async () => {
  const { controller, host, controllerFrames } = createPair();
  await controller.send(Buffer.alloc(0));
  assert.equal(controllerFrames[0].length, FRAME_OVERHEAD_BYTES);
  assert.deepEqual(host.receive(controllerFrames[0]), Buffer.alloc(0));
});

test('close() rejects further sends and receives and leaves the callers keys intact', async () => {
  const sendKey = Buffer.from(KEY_A);
  const receiveKey = Buffer.from(KEY_B);
  const channel = createSecureChannel({ sendKey, receiveKey, transmit: () => undefined });
  channel.close();
  assert.equal(channel.isClosed, true);
  await rejectsWith(channel.send(text('x')), SecureChannelError, 'closed');
  assert.throws(() => channel.receive(Buffer.alloc(30)), SecureChannelError);
  assert.deepEqual(sendKey, KEY_A);
  assert.deepEqual(receiveKey, KEY_B);
  channel.close(); // idempotent
});

test('constructor rejects keys that are not 32 bytes', () => {
  assert.throws(
    () => createSecureChannel({ sendKey: Buffer.alloc(16), receiveKey: KEY_B, transmit: () => undefined }),
    /32 bytes/,
  );
  assert.throws(
    () => createSecureChannel({ sendKey: KEY_A, receiveKey: Buffer.alloc(33), transmit: () => undefined }),
    /32 bytes/,
  );
});

test('each send of the same plaintext yields a different ciphertext', async () => {
  const { controller, controllerFrames } = createPair();
  await controller.send(text('same'));
  await controller.send(text('same'));
  assert.notDeepEqual(controllerFrames[0].subarray(9), controllerFrames[1].subarray(9));
});

test('send() snapshots the payload, so the caller may reuse its buffer immediately', async () => {
  const host = createSecureChannel({ sendKey: KEY_B, receiveKey: KEY_A, transmit: () => undefined });
  const frames: Buffer[] = [];
  const channel = createSecureChannel({
    sendKey: KEY_A,
    receiveKey: KEY_B,
    transmit: async (frame) => {
      await new Promise((resolve) => setImmediate(resolve));
      frames.push(frame);
    },
  });
  const shared = Buffer.from('AAAA');
  const first = channel.send(shared);
  const second = channel.send(shared); // queued behind the first
  shared.fill(0x42); // mutated before the queued frame is encrypted
  await Promise.all([first, second]);
  assert.deepEqual(host.receive(frames[0]), Buffer.from('AAAA'));
  assert.deepEqual(host.receive(frames[1]), Buffer.from('AAAA'));
});

test('non-binary payloads are rejected up front without touching the channel', async () => {
  const { controller, controllerFrames } = createPair();
  for (const bad of [5, 'text', null, undefined, {}, [1, 2, 3]]) {
    await rejectsWith(controller.send(bad as unknown as Uint8Array), SecureChannelError, 'invalid-payload');
  }
  assert.equal(controller.isClosed, false);
  await controller.send(text('fine'));
  assert.equal(counterOf(controllerFrames[0]), 0n);
});

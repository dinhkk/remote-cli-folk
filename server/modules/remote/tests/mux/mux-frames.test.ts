import assert from 'node:assert/strict';
import test from 'node:test';

import type { RemoteMuxFrame } from '@/shared/types.js';

import { MAX_PLAINTEXT_BYTES } from '../../crypto/secure-channel.js';
import {
  MAX_BATCH_MESSAGES,
  MAX_BODY_CHUNK_BYTES,
  MAX_META_BYTES,
  MAX_WS_MESSAGE_BYTES,
  MuxFrameError,
  REMOTE_ERROR_CODES,
  SMALL_MESSAGE_BYTES,
  decodeFrame,
  encodeBatchBody,
  encodeFrame,
  isControlFrame,
  isValidWsCloseCode,
  splitBatchBody,
} from '../../mux/frames.js';
import { rawFrame } from '../support/mux-test-helpers.js';
import { createSeededRandom } from '../support/seeded-random.js';

const EMPTY = Buffer.alloc(0);

const samples = (): RemoteMuxFrame[] => [
  { type: 'APP_HELLO', streamId: 0, meta: { protocolVersion: 1, appVersion: '1.37.7', role: 'host' }, body: EMPTY },
  { type: 'PING', streamId: 0, meta: {}, body: EMPTY },
  { type: 'PONG', streamId: 0, meta: {}, body: EMPTY },
  { type: 'HTTP_REQ', streamId: 1, meta: { method: 'POST', path: '/api/projects?x=1', headers: { 'content-type': 'application/json', accept: ['a', 'b'] } }, body: EMPTY },
  { type: 'REQ_BODY', streamId: 1, meta: { fin: false }, body: Buffer.from('chunk') },
  { type: 'HTTP_RES', streamId: 1, meta: { status: 200, headers: { etag: '"x"' } }, body: EMPTY },
  { type: 'RES_BODY', streamId: 1, meta: { fin: true }, body: Buffer.alloc(MAX_BODY_CHUNK_BYTES, 7) },
  { type: 'WS_OPEN', streamId: 3, meta: { path: '/ws' }, body: EMPTY },
  { type: 'WS_OPEN', streamId: 5, meta: { path: '/shell', protocols: ['cloudcli'] }, body: EMPTY },
  { type: 'WS_MSG', streamId: 3, meta: { binary: false }, body: Buffer.from('{"type":"x"}') },
  { type: 'WS_MSG', streamId: 3, meta: { binary: true, batch: 2 }, body: encodeBatchBody([Buffer.from('a'), Buffer.alloc(0)]) },
  { type: 'WS_CLOSE', streamId: 3, meta: { code: 1013, reason: 'busy' }, body: EMPTY },
  { type: 'CANCEL', streamId: 7, meta: {}, body: EMPTY },
  { type: 'ERROR', streamId: 7, meta: { code: 'REMOTE_TOO_LARGE', message: 'too big' }, body: EMPTY },
  { type: 'ERROR', streamId: 0, meta: { code: 'REMOTE_PROTOCOL', message: 'version' }, body: EMPTY },
];

const expectFrameError = (fn: () => unknown, code: string): MuxFrameError => {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof MuxFrameError, `expected MuxFrameError(${code}), got ${String(caught)}`);
  assert.equal(caught.code, code);
  return caught;
};

test('every frame type survives an encode/decode round trip', () => {
  for (const frame of samples()) {
    const decoded = decodeFrame(encodeFrame(frame));
    assert.equal(decoded.type, frame.type);
    assert.equal(decoded.streamId, frame.streamId);
    assert.deepEqual(decoded.meta, frame.meta);
    assert.ok(decoded.body.equals(frame.body));
  }
});

test('the wire layout is [type][streamId u32 BE][metaLen u32 BE][meta][body]', () => {
  const bytes = encodeFrame({ type: 'REQ_BODY', streamId: 0x01020304, meta: { fin: true }, body: Buffer.from([9, 8]) });
  const meta = Buffer.from('{"fin":true}');
  assert.equal(bytes[0], 0x11);
  assert.equal(bytes.readUInt32BE(1), 0x01020304);
  assert.equal(bytes.readUInt32BE(5), meta.length);
  assert.ok(bytes.subarray(9, 9 + meta.length).equals(meta));
  assert.deepEqual([...bytes.subarray(9 + meta.length)], [9, 8]);
  // The type codes of contracts section 6.
  const codes: Array<[RemoteMuxFrame['type'], number]> = [
    ['APP_HELLO', 0x01], ['PING', 0x02], ['PONG', 0x03], ['HTTP_REQ', 0x10], ['REQ_BODY', 0x11], ['HTTP_RES', 0x12],
    ['RES_BODY', 0x13], ['WS_OPEN', 0x20], ['WS_MSG', 0x21], ['WS_CLOSE', 0x22], ['CANCEL', 0x30], ['ERROR', 0x31],
  ];
  for (const [type, code] of codes) {
    const frame = samples().find((candidate) => candidate.type === type) as RemoteMuxFrame;
    assert.equal(encodeFrame(frame)[0], code, type);
  }
});

test('truncated, oversized and unknown frames are rejected with a code and the stream id when known', () => {
  expectFrameError(() => decodeFrame(Buffer.alloc(8)), 'truncated');
  expectFrameError(() => decodeFrame(Buffer.alloc(0)), 'truncated');
  const truncated = rawFrame(0x10, 1, { method: 'GET', path: '/', headers: {} });
  expectFrameError(() => decodeFrame(truncated.subarray(0, truncated.length - 1)), 'truncated');

  const tooBigMeta = Buffer.alloc(9);
  tooBigMeta[0] = 0x10;
  tooBigMeta.writeUInt32BE(5, 1);
  tooBigMeta.writeUInt32BE(MAX_META_BYTES + 1, 5);
  const metaError = expectFrameError(() => decodeFrame(tooBigMeta), 'meta-too-large');
  assert.equal(metaError.streamId, 5);

  const unknown = expectFrameError(() => decodeFrame(rawFrame(0x77, 9, {})), 'unknown-type');
  assert.equal(unknown.streamId, 9);

  expectFrameError(() => decodeFrame(Buffer.alloc(MAX_PLAINTEXT_BYTES + 1)), 'frame-too-large');
});

test('meta must be valid UTF-8 JSON with the shape of its frame type', () => {
  const notJson = rawFrame(0x02, 0, null, EMPTY, Buffer.from('{nope'));
  expectFrameError(() => decodeFrame(notJson), 'bad-meta');
  expectFrameError(() => decodeFrame(rawFrame(0x02, 0, null, EMPTY, Buffer.from([0xff, 0xfe, 0x7b, 0x7d]))), 'bad-meta');
  for (const nonObject of ['null', '[]', '3', '"x"', 'true']) {
    expectFrameError(() => decodeFrame(rawFrame(0x02, 0, null, EMPTY, Buffer.from(nonObject))), 'bad-meta');
  }

  const badMetas: Array<[number, number, unknown]> = [
    [0x01, 0, { protocolVersion: '1', appVersion: 'x', role: 'host' }],
    [0x01, 0, { protocolVersion: 1, appVersion: 'x', role: 'admin' }],
    [0x01, 0, { protocolVersion: 1, appVersion: 'x'.repeat(65), role: 'host' }],
    [0x01, 0, { protocolVersion: -1, appVersion: 'x', role: 'host' }],
    [0x10, 1, { method: 'GE T', path: '/', headers: {} }],
    [0x10, 1, { method: 'GET', path: 'no-slash', headers: {} }],
    [0x10, 1, { method: 'GET', path: '/', headers: [] }],
    [0x10, 1, { method: 'GET', path: '/', headers: { a: 1 } }],
    [0x10, 1, { method: 'GET', path: '/', headers: { a: [1] } }],
    [0x10, 1, { method: 'GET', path: `/${'x'.repeat(9000)}`, headers: {} }],
    [0x11, 1, { fin: 'yes' }],
    [0x11, 1, {}],
    [0x12, 1, { status: 99, headers: {} }],
    [0x12, 1, { status: 200.5, headers: {} }],
    [0x13, 1, { fin: 1 }],
    [0x20, 1, { path: 5 }],
    [0x20, 1, { path: '/ws', protocols: 'x' }],
    [0x20, 1, { path: '/ws', protocols: [3] }],
    [0x21, 1, { binary: 'no' }],
    [0x21, 1, { binary: true, batch: 0 }],
    [0x21, 1, { binary: true, batch: 1.5 }],
    [0x22, 1, { code: 999, reason: '' }],
    [0x22, 1, { code: 1000, reason: 3 }],
    [0x31, 1, { code: 'NOPE', message: 'x' }],
    [0x31, 1, { code: 'REMOTE_INTERNAL', message: 5 }],
  ];
  for (const [type, streamId, meta] of badMetas) {
    expectFrameError(() => decodeFrame(rawFrame(type, streamId, meta)), 'bad-meta');
  }
});

test('bodies and stream ids follow the frame type rules', () => {
  // Frames without a body must not carry one.
  expectFrameError(() => decodeFrame(rawFrame(0x10, 1, { method: 'GET', path: '/', headers: {} }, Buffer.from('x'))), 'bad-body');
  expectFrameError(() => decodeFrame(rawFrame(0x02, 0, {}, Buffer.from('x'))), 'bad-body');
  expectFrameError(() => decodeFrame(rawFrame(0x30, 1, {}, Buffer.from('x'))), 'bad-body');
  // Body chunks are bounded so the scheduler can interleave streams.
  expectFrameError(() => decodeFrame(rawFrame(0x11, 1, { fin: false }, Buffer.alloc(MAX_BODY_CHUNK_BYTES + 1))), 'bad-body');
  expectFrameError(() => decodeFrame(rawFrame(0x13, 1, { fin: false }, Buffer.alloc(MAX_BODY_CHUNK_BYTES + 1))), 'bad-body');
  expectFrameError(() => decodeFrame(rawFrame(0x21, 1, { binary: false }, Buffer.alloc(MAX_WS_MESSAGE_BYTES + 1))), 'bad-body');
  // Connection-level frames use stream 0 and nothing else does (except ERROR, which may be either).
  expectFrameError(() => decodeFrame(rawFrame(0x02, 4, {})), 'bad-stream-id');
  expectFrameError(() => decodeFrame(rawFrame(0x01, 4, { protocolVersion: 1, appVersion: 'x', role: 'host' })), 'bad-stream-id');
  expectFrameError(() => decodeFrame(rawFrame(0x10, 0, { method: 'GET', path: '/', headers: {} })), 'bad-stream-id');
  expectFrameError(() => decodeFrame(rawFrame(0x30, 0, {})), 'bad-stream-id');
  assert.equal(decodeFrame(rawFrame(0x31, 0, { code: 'REMOTE_INTERNAL', message: 'm' })).streamId, 0);
});

test('batch bodies are length-prefixed items that must add up exactly', () => {
  const items = [Buffer.from('one'), Buffer.alloc(0), Buffer.alloc(300, 1)];
  const body = encodeBatchBody(items);
  assert.equal(body.length, 4 * 3 + 3 + 0 + 300);
  assert.deepEqual(splitBatchBody(body, 3).map((item) => item.length), [3, 0, 300]);
  assert.ok(splitBatchBody(body, 3)[0].equals(Buffer.from('one')));

  expectFrameError(() => splitBatchBody(body, 2), 'bad-body'); // trailing bytes
  expectFrameError(() => splitBatchBody(body, 4), 'bad-body'); // too few items
  expectFrameError(() => splitBatchBody(body.subarray(0, body.length - 1), 3), 'bad-body'); // last item cut
  expectFrameError(() => splitBatchBody(Buffer.from([0, 0, 0]), 1), 'bad-body'); // length prefix cut
  const lying = Buffer.alloc(4);
  lying.writeUInt32BE(0xffffffff);
  expectFrameError(() => splitBatchBody(lying, 1), 'bad-body');

  // A WS_MSG frame with a malformed batch is rejected at decode time.
  expectFrameError(() => decodeFrame(rawFrame(0x21, 1, { binary: false, batch: 2 }, body)), 'bad-body');
  assert.equal(decodeFrame(rawFrame(0x21, 1, { binary: false, batch: 3 }, body)).streamId, 1);
});

test('encodeFrame refuses frames the decoder would refuse', () => {
  const bad = (frame: unknown, code: string) => expectFrameError(() => encodeFrame(frame as RemoteMuxFrame), code);
  bad({ type: 'PING', streamId: 4, meta: {}, body: EMPTY }, 'bad-stream-id');
  bad({ type: 'PING', streamId: -1, meta: {}, body: EMPTY }, 'bad-stream-id');
  bad({ type: 'PING', streamId: 2 ** 32, meta: {}, body: EMPTY }, 'bad-stream-id');
  bad({ type: 'HTTP_RES', streamId: 1, meta: { status: 20, headers: {} }, body: EMPTY }, 'bad-meta');
  bad({ type: 'NOPE', streamId: 1, meta: {}, body: EMPTY }, 'unknown-type');
  bad({ type: 'REQ_BODY', streamId: 1, meta: { fin: false }, body: Buffer.alloc(MAX_BODY_CHUNK_BYTES + 1) }, 'bad-body');
  bad({ type: 'HTTP_REQ', streamId: 1, meta: { method: 'GET', path: '/', headers: { big: 'x'.repeat(8000) } }, body: Buffer.alloc(1) }, 'bad-body');
  const hugeHeaders = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`h${i}`, 'v'.repeat(8000)]));
  bad({ type: 'HTTP_REQ', streamId: 1, meta: { method: 'GET', path: '/', headers: hugeHeaders }, body: EMPTY }, 'meta-too-large');
});

test('control frames are the small ones; bulk body chunks and large messages are not', () => {
  for (const type of ['APP_HELLO', 'PING', 'PONG', 'HTTP_REQ', 'HTTP_RES', 'WS_OPEN', 'WS_CLOSE', 'CANCEL', 'ERROR'] as const) {
    assert.equal(isControlFrame(type, 0), true, type);
  }
  assert.equal(isControlFrame('REQ_BODY', 10), false);
  assert.equal(isControlFrame('RES_BODY', 0), false);
  assert.equal(isControlFrame('WS_MSG', 0), true);
  assert.equal(isControlFrame('WS_MSG', SMALL_MESSAGE_BYTES), true);
  assert.equal(isControlFrame('WS_MSG', SMALL_MESSAGE_BYTES + 1), false);
});

test('10,000 random and mutated frames never throw anything but a controlled MuxFrameError', () => {
  const random = createSeededRandom(0xf00d);
  const corpus = samples().map((frame) => encodeFrame(frame));
  let accepted = 0;
  for (let i = 0; i < 10_000; i += 1) {
    let input: Buffer;
    if (i % 3 === 0) {
      input = random.bytes(random.int(0, 300));
    } else {
      input = Buffer.from(random.pick(corpus));
      const flips = random.int(1, 4);
      for (let flip = 0; flip < flips && input.length > 0; flip += 1) input[random.int(0, input.length - 1)] = random.int(0, 255);
      if (i % 7 === 0) input = input.subarray(0, random.int(0, input.length));
    }
    try {
      const frame = decodeFrame(input);
      accepted += 1;
      // Whatever decodes must re-encode: the decoder never hands out a frame the encoder would refuse.
      assert.doesNotThrow(() => encodeFrame(frame));
    } catch (error) {
      assert.ok(error instanceof MuxFrameError, `unexpected ${String(error)}`);
    }
  }
  assert.ok(accepted > 0, 'mutations of valid frames should sometimes still be valid');
});

test('header keys that would poison an object prototype are refused in requests and responses (encode and decode)', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    // JSON.parse makes "__proto__" an own property, which is exactly what a hostile peer sends.
    const headers = `{"${key}":"x"}`;
    const request = Buffer.from(`{"method":"GET","path":"/","headers":${headers}}`);
    const response = Buffer.from(`{"status":200,"headers":${headers}}`);
    expectFrameError(() => decodeFrame(rawFrame(0x10, 1, null, EMPTY, request)), 'bad-meta');
    expectFrameError(() => decodeFrame(rawFrame(0x12, 1, null, EMPTY, response)), 'bad-meta');
    const own = JSON.parse(`{"${key}":"x"}`) as Record<string, string>;
    expectFrameError(() => encodeFrame({ type: 'HTTP_REQ', streamId: 1, meta: { method: 'GET', path: '/', headers: own }, body: EMPTY }), 'bad-meta');
  }
  // Look-alikes that are ordinary header names stay legal.
  const fine = decodeFrame(rawFrame(0x10, 1, { method: 'GET', path: '/', headers: { 'x-constructor': 'a', proto: 'b', prototypes: 'c' } }));
  assert.equal(fine.type, 'HTTP_REQ');
});

test('WS close codes: reserved ones (1004, 1005, 1006, 1015) and anything outside the valid ranges are refused', () => {
  for (const code of [999, 1004, 1005, 1006, 1015, 1016, 2000, 2999, 5000, 65535]) {
    assert.equal(isValidWsCloseCode(code), false, String(code));
    expectFrameError(() => decodeFrame(rawFrame(0x22, 1, { code, reason: '' })), 'bad-meta');
    expectFrameError(() => encodeFrame({ type: 'WS_CLOSE', streamId: 1, meta: { code, reason: '' }, body: EMPTY }), 'bad-meta');
  }
  for (const code of [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014, 3000, 4403, 4999]) {
    assert.equal(isValidWsCloseCode(code), true, String(code));
    assert.equal(decodeFrame(rawFrame(0x22, 1, { code, reason: 'x' })).type, 'WS_CLOSE');
  }
  assert.equal(isValidWsCloseCode(1000.5), false);
  assert.equal(isValidWsCloseCode(Number.NaN), false);
});

test('a batched WS_MSG is only valid from the Host: when the peer is a Controller it is refused', () => {
  const batched = rawFrame(0x21, 1, { binary: false, batch: 2 }, encodeBatchBody([Buffer.from('a'), Buffer.from('b')]));
  assert.equal(decodeFrame(batched).type, 'WS_MSG', 'default decoding is direction-agnostic');
  assert.equal(decodeFrame(batched, { peerRole: 'host' }).type, 'WS_MSG');
  expectFrameError(() => decodeFrame(batched, { peerRole: 'controller' }), 'bad-meta');
  const plain = rawFrame(0x21, 1, { binary: false }, Buffer.from('keys'));
  assert.equal(decodeFrame(plain, { peerRole: 'controller' }).type, 'WS_MSG', 'a single message from the Controller is the normal case');
});

test('one batch item may not exceed the largest WS message, and the item count stays capped', () => {
  const oversized = encodeBatchBody([Buffer.alloc(MAX_WS_MESSAGE_BYTES + 1, 1)]);
  expectFrameError(() => splitBatchBody(oversized, 1), 'bad-body');
  expectFrameError(() => decodeFrame(rawFrame(0x21, 1, { binary: true, batch: 1 }, oversized)), 'bad-body');
  assert.equal(splitBatchBody(encodeBatchBody([Buffer.alloc(MAX_WS_MESSAGE_BYTES, 1)]), 1)[0].length, MAX_WS_MESSAGE_BYTES);
  expectFrameError(() => decodeFrame(rawFrame(0x21, 1, { binary: true, batch: MAX_BATCH_MESSAGES + 1 }, EMPTY)), 'bad-meta');
});

test('the error code list is one list: exactly the codes of contracts section 9, all decodable, nothing else', () => {
  assert.deepEqual([...REMOTE_ERROR_CODES].sort(), [
    'REMOTE_FORBIDDEN',
    'REMOTE_INTERNAL',
    'REMOTE_LINK_DOWN',
    'REMOTE_PROTOCOL',
    'REMOTE_QUOTA',
    'REMOTE_TOO_LARGE',
    'REMOTE_UNSUPPORTED_MODE',
    'REMOTE_UPSTREAM_AUTH',
  ]);
  for (const code of REMOTE_ERROR_CODES) assert.equal(decodeFrame(rawFrame(0x31, 1, { code, message: 'm' })).type, 'ERROR', code);
  for (const code of ['REMOTE_PAIR_FAILED', 'remote_quota', '', 'REMOTE_QUOTA ']) {
    expectFrameError(() => decodeFrame(rawFrame(0x31, 1, { code, message: 'm' })), 'bad-meta');
  }
});

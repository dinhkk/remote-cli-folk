import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { InvalidPairCodeError, derivePairRoom, normalizePairCode } from '../../crypto/key-derivation.js';
import { formatPairCode, generatePairCode, resolvePairCode } from '../../pairing/pairing-code.js';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Deterministic byte source: SHA-256 of a counter, so uniqueness claims do not depend on luck. */
const counterBytes = (): ((length: number) => Buffer) => {
  let counter = 0;
  return (length) => crypto.createHash('sha256').update(String(counter++)).digest().subarray(0, length);
};

test('a generated code is 8 characters from the Crockford base32 alphabet', () => {
  for (let i = 0; i < 500; i++) {
    const code = generatePairCode();
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{8}$/);
    for (const char of code) assert.ok(ALPHABET.includes(char));
    assert.equal(normalizePairCode(code), code, 'a generated code is already canonical');
  }
});

test('the code carries exactly 40 bits: 5 random bytes map onto 8 symbols without loss', () => {
  assert.equal(generatePairCode(() => Buffer.alloc(5, 0x00)), '00000000');
  assert.equal(generatePairCode(() => Buffer.alloc(5, 0xff)), 'ZZZZZZZZ');
  assert.equal(generatePairCode(() => Buffer.from([0x00, 0x44, 0x32, 0x14, 0xc7])), '01234567');
  assert.throws(() => generatePairCode(() => Buffer.alloc(4)), /5 bytes/);
});

test('100,000 codes from distinct entropy never collide, and real randomness collides at most by chance', () => {
  const next = counterBytes();
  const seen = new Set<string>();
  for (let i = 0; i < 100_000; i++) seen.add(generatePairCode(next));
  assert.equal(seen.size, 100_000);

  // Birthday bound for 1e5 draws from 2^40 is about 0.5%; allow one collision, two is ~1e-5.
  const real = new Set<string>();
  for (let i = 0; i < 100_000; i++) real.add(generatePairCode());
  assert.ok(real.size >= 99_999, `unexpected collisions: ${100_000 - real.size}`);
});

test('symbols are uniform at every position (no biased alphabet mapping)', () => {
  const counts = Array.from({ length: 8 }, () => new Map<string, number>());
  const samples = 64_000;
  for (let i = 0; i < samples; i++) {
    [...generatePairCode()].forEach((char, position) => counts[position].set(char, (counts[position].get(char) ?? 0) + 1));
  }
  const expected = samples / 32;
  for (const position of counts) {
    assert.equal(position.size, 32);
    for (const count of position.values()) assert.ok(Math.abs(count - expected) < expected * 0.25, `skewed symbol count ${count}`);
  }
});

test('formatPairCode shows XXXX-XXXX and rejects anything that is not a code', () => {
  assert.equal(formatPairCode('ABCD1234'), 'ABCD-1234');
  assert.equal(formatPairCode('abcd-1234'), 'ABCD-1234');
  assert.throws(() => formatPairCode('ABC'), InvalidPairCodeError);
});

test('input is normalized: case, separators, and the look-alikes o to 0 and i/l to 1', () => {
  assert.equal(normalizePairCode('abcd-1234'), 'ABCD1234');
  assert.equal(normalizePairCode('  ab cd  12 34 '), 'ABCD1234');
  assert.equal(normalizePairCode('o0Oo-iIlL'), '00001111');
  assert.equal(normalizePairCode('AB-CD-12-34'), 'ABCD1234');
});

test('unknown characters, wrong lengths and non-ASCII look-alikes are rejected', () => {
  for (const bad of ['', 'ABCD123', 'ABCD12345', 'ABCD-123U', 'ABCD-123$', 'ABCD_1234', 'ABCD-12ſ4', 'ＡＢＣＤ1234', 'ABCD-12\n3\u0000']) {
    assert.throws(() => normalizePairCode(bad), InvalidPairCodeError, JSON.stringify(bad));
    assert.throws(() => resolvePairCode(bad), InvalidPairCodeError, JSON.stringify(bad));
  }
});

test('resolvePairCode derives the rendezvous room and token from the normalized code', () => {
  const resolved = resolvePairCode('abcd-efgh');
  assert.equal(resolved.code, 'ABCDEFGH');
  assert.deepEqual({ pairRoomId: resolved.pairRoomId, pairToken: resolved.pairToken }, derivePairRoom('ABCDEFGH'));
  // look-alike spellings of the same code land in the same room
  assert.equal(resolvePairCode('0123-4567').pairRoomId, resolvePairCode('oi23-4567').pairRoomId);
  assert.notEqual(resolvePairCode('ABCDEFGH').pairRoomId, resolvePairCode('ABCDEFGJ').pairRoomId);
  assert.match(resolved.pairRoomId, /^[0-9a-f]{32}$/);
});

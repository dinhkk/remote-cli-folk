import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  REMOTE_LABEL_PREFIX,
  InvalidPairCodeError,
  computeGate,
  deriveLinkKeys,
  derivePairRoom,
  derivePairingKey,
  deriveSessionKeys,
  hkdf,
  normalizePairCode,
} from '../../crypto/key-derivation.js';

// Vectors produced by tests/vectors/generate-derivation-vectors.py (stdlib-only reference HKDF);
// the relay Worker tests assert the same file, so both ends agree byte for byte.
const vectors = JSON.parse(
  readFileSync(new URL('../vectors/derivation.json', import.meta.url), 'utf8'),
) as {
  link: { kHex: string; roomId: string; hostToken: string; controllerToken: string; macKeyHex: string };
  gate: { relaySecret: string; link: string; pair: string };
  pair: { normalizedCode: string; pairRoomId: string; pairToken: string };
  session: {
    ecdhHex: string;
    nonceCHex: string;
    nonceHHex: string;
    keyC2HHex: string;
    keyH2CHex: string;
    pairingKeyHex: string;
  };
};

const hex = (value: string) => Buffer.from(value, 'hex');
const K = hex(vectors.link.kHex);

test('deriveLinkKeys reproduces the fixed reference vector', () => {
  const keys = deriveLinkKeys(K);
  assert.equal(keys.roomId, vectors.link.roomId);
  assert.equal(keys.hostToken, vectors.link.hostToken);
  assert.equal(keys.controllerToken, vectors.link.controllerToken);
  assert.equal(keys.macKey.toString('hex'), vectors.link.macKeyHex);
});

test('derived values have the contracted lengths and encodings', () => {
  const keys = deriveLinkKeys(K);
  assert.match(keys.roomId, /^[0-9a-f]{32}$/);
  assert.equal(Buffer.from(keys.hostToken, 'base64url').length, 32);
  assert.equal(Buffer.from(keys.controllerToken, 'base64url').length, 32);
  assert.match(keys.hostToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(keys.macKey.length, 32);
});

test('host and controller tokens differ so a controller cannot act as the host', () => {
  const keys = deriveLinkKeys(K);
  assert.notEqual(keys.hostToken, keys.controllerToken);
});

test('different labels give different keys from the same input', () => {
  const labels = ['room', 'relay-token-host', 'relay-token-controller', 'mac', 'x'];
  const outputs = new Set(labels.map((label) => hkdf(K, label, 32).toString('hex')));
  assert.equal(outputs.size, labels.length);
});

test('hkdf uses the versioned label prefix and honours salt and length', () => {
  assert.equal(REMOTE_LABEL_PREFIX, 'remotecli/v1/');
  const noSalt = hkdf(K, 'room', 16);
  assert.equal(noSalt.length, 16);
  assert.notDeepEqual(hkdf(K, 'room', 16, Buffer.from('salt')), noSalt);
  assert.equal(hkdf(K, 'room', 64).length, 64);
});

test('a different K yields a completely different room', () => {
  const other = Buffer.from(K);
  other[0] ^= 1;
  assert.notEqual(deriveLinkKeys(other).roomId, deriveLinkKeys(K).roomId);
});

test('deriveLinkKeys rejects a key that is not 32 bytes', () => {
  assert.throws(() => deriveLinkKeys(Buffer.alloc(31)), /32 bytes/);
  assert.throws(() => deriveLinkKeys(Buffer.alloc(33)), /32 bytes/);
});

test('computeGate reproduces the reference vector for link and pair rooms', () => {
  const room = vectors.link.roomId;
  assert.equal(computeGate('link', room, vectors.gate.relaySecret), vectors.gate.link);
  assert.equal(
    computeGate('pair', vectors.pair.pairRoomId, vectors.gate.relaySecret),
    vectors.gate.pair,
  );
});

test('computeGate separates kind, room and secret', () => {
  const base = computeGate('link', vectors.link.roomId, 's');
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.notEqual(computeGate('pair', vectors.link.roomId, 's'), base);
  assert.notEqual(computeGate('link', vectors.pair.pairRoomId, 's'), base);
  assert.notEqual(computeGate('link', vectors.link.roomId, 't'), base);
});

test('computeGate refuses an empty relay secret', () => {
  assert.throws(() => computeGate('link', vectors.link.roomId, ''), /relay secret/i);
});

test('derivePairRoom reproduces the vector from the normalized code', () => {
  const pair = derivePairRoom(vectors.pair.normalizedCode);
  assert.equal(pair.pairRoomId, vectors.pair.pairRoomId);
  assert.equal(pair.pairToken, vectors.pair.pairToken);
});

test('derivePairRoom rejects a code that was not normalized first', () => {
  assert.throws(() => derivePairRoom('abcd-efgh'), InvalidPairCodeError);
});

test('normalizePairCode folds case, dashes, spaces and Crockford look-alikes', () => {
  assert.equal(normalizePairCode('abcd-efgh'), 'ABCDEFGH');
  assert.equal(normalizePairCode(' AB CD-EF GH '), 'ABCDEFGH');
  assert.equal(normalizePairCode('o0il-1lOI'), '00111101');
  assert.equal(normalizePairCode('ABCDEFGH'), normalizePairCode('abcd-efgh'));
});

test('normalizePairCode rejects wrong length and characters outside the alphabet', () => {
  for (const bad of ['', 'ABCDEFG', 'ABCDEFGHJ', 'ABCD-EFGU', 'ABCD-EF!H', 'ÀBCDEFGH', 'ſBCDEFGH', 'ıBCDEFGH']) {
    assert.throws(() => normalizePairCode(bad), InvalidPairCodeError, bad);
  }
});

test('normalizePairCode rejects non-string input', () => {
  assert.throws(() => normalizePairCode(undefined as unknown as string), InvalidPairCodeError);
});

test('deriveSessionKeys reproduces the vector and is direction-separated', () => {
  const s = vectors.session;
  const keys = deriveSessionKeys(K, hex(s.ecdhHex), hex(s.nonceCHex), hex(s.nonceHHex));
  assert.equal(keys.keyC2H.toString('hex'), s.keyC2HHex);
  assert.equal(keys.keyH2C.toString('hex'), s.keyH2CHex);
  assert.notDeepEqual(keys.keyC2H, keys.keyH2C);
});

test('deriveSessionKeys depends on K, the ECDH secret and both nonces', () => {
  const s = vectors.session;
  const base = deriveSessionKeys(K, hex(s.ecdhHex), hex(s.nonceCHex), hex(s.nonceHHex)).keyC2H;
  const flip = (buffer: Buffer) => {
    const copy = Buffer.from(buffer);
    copy[0] ^= 1;
    return copy;
  };
  const variants = [
    deriveSessionKeys(flip(K), hex(s.ecdhHex), hex(s.nonceCHex), hex(s.nonceHHex)),
    deriveSessionKeys(K, flip(hex(s.ecdhHex)), hex(s.nonceCHex), hex(s.nonceHHex)),
    deriveSessionKeys(K, hex(s.ecdhHex), flip(hex(s.nonceCHex)), hex(s.nonceHHex)),
    deriveSessionKeys(K, hex(s.ecdhHex), hex(s.nonceCHex), flip(hex(s.nonceHHex))),
    // swapping the nonces changes the salt order
    deriveSessionKeys(K, hex(s.ecdhHex), hex(s.nonceHHex), hex(s.nonceCHex)),
  ];
  for (const variant of variants) assert.notDeepEqual(variant.keyC2H, base);
});

test('deriveSessionKeys validates input sizes', () => {
  const s = vectors.session;
  assert.throws(() => deriveSessionKeys(Buffer.alloc(8), hex(s.ecdhHex), hex(s.nonceCHex), hex(s.nonceHHex)), /32 bytes/);
  assert.throws(() => deriveSessionKeys(K, Buffer.alloc(31), hex(s.nonceCHex), hex(s.nonceHHex)), /32 bytes/);
  assert.throws(() => deriveSessionKeys(K, hex(s.ecdhHex), Buffer.alloc(15), hex(s.nonceHHex)), /16 bytes/);
  assert.throws(() => deriveSessionKeys(K, hex(s.ecdhHex), hex(s.nonceCHex), Buffer.alloc(17)), /16 bytes/);
});

test('derivePairingKey reproduces the vector', () => {
  const s = vectors.session;
  const key = derivePairingKey(hex(s.ecdhHex), hex(s.nonceCHex), hex(s.nonceHHex));
  assert.equal(key.toString('hex'), s.pairingKeyHex);
  assert.equal(key.length, 32);
});

test('derivePairingKey validates input sizes', () => {
  const s = vectors.session;
  assert.throws(() => derivePairingKey(Buffer.alloc(5), hex(s.nonceCHex), hex(s.nonceHHex)), /32 bytes/);
  assert.throws(() => derivePairingKey(hex(s.ecdhHex), Buffer.alloc(5), hex(s.nonceHHex)), /16 bytes/);
});

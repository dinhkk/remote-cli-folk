/**
 * Key derivation for Remote (contracts section 5).
 *
 * Everything is HKDF-SHA256 over `node:crypto`, with the versioned label prefix
 * `remotecli/v1/`, so the relay Worker (WebCrypto) derives identical bytes. The fixed
 * vectors in `tests/vectors/derivation.json` come from an independent stdlib-only reference.
 */

import crypto from 'node:crypto';

import type { RemoteLinkKeys, RemoteRelayRoomKind } from '@/shared/types.js';

export const REMOTE_LABEL_PREFIX = 'remotecli/v1/';

const KEY_BYTES = 32;
const NONCE_BYTES = 16;
const PAIR_CODE_LENGTH = 8;
const PAIR_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/** Thrown when a pairing code is not 8 Crockford base32 characters after normalization. */
export class InvalidPairCodeError extends Error {
  constructor() {
    super('Pairing code must be 8 characters from the Crockford base32 alphabet.');
    this.name = 'InvalidPairCodeError';
  }
}

const assertLength = (value: Uint8Array, bytes: number, name: string): void => {
  if (!(value instanceof Uint8Array) || value.length !== bytes) {
    throw new Error(`${name} must be ${bytes} bytes.`);
  }
};

/** HKDF-SHA256 with the Remote label prefix; an empty salt means HashLen zero bytes (RFC 5869). */
export const hkdf = (ikm: Uint8Array, info: string, length: number, salt: Uint8Array = Buffer.alloc(0)): Buffer =>
  Buffer.from(crypto.hkdfSync('sha256', ikm, salt, REMOTE_LABEL_PREFIX + info, length));

/** Room id, relay tokens and MAC key of a paired link, all derived from the pairing key K. */
export const deriveLinkKeys = (k: Uint8Array): RemoteLinkKeys => {
  assertLength(k, KEY_BYTES, 'Pairing key K');
  return {
    roomId: hkdf(k, 'room', 16).toString('hex'),
    hostToken: hkdf(k, 'relay-token-host', 32).toString('base64url'),
    controllerToken: hkdf(k, 'relay-token-controller', 32).toString('base64url'),
    macKey: hkdf(k, 'mac', 32),
  };
};

/** `HMAC-SHA256(RELAY_SECRET, kind + ":" + room)` as lowercase hex: the relay's connection gate. */
export const computeGate = (kind: RemoteRelayRoomKind, roomId: string, relaySecret: string): string => {
  if (!relaySecret) throw new Error('A relay secret is required to compute the gate.');
  return crypto.createHmac('sha256', relaySecret).update(`${kind}:${roomId}`).digest('hex');
};

/**
 * Folds user input into the canonical code: upper case, separators and spaces removed, and the
 * Crockford look-alikes O -> 0 and I/L -> 1. Anything else outside the alphabet is rejected.
 */
export const normalizePairCode = (input: string): string => {
  // ASCII only: toUpperCase() would otherwise fold characters like U+017F to 'S'.
  if (typeof input !== 'string' || /[^\u0000-\u007f]/.test(input)) throw new InvalidPairCodeError();
  const folded = input
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (folded.length !== PAIR_CODE_LENGTH || !PAIR_CODE_PATTERN.test(folded)) {
    throw new InvalidPairCodeError();
  }
  return folded;
};

/** Rendezvous room id and relay token derived from an already normalized pairing code. */
export const derivePairRoom = (normalizedCode: string): { pairRoomId: string; pairToken: string } => {
  if (typeof normalizedCode !== 'string' || !PAIR_CODE_PATTERN.test(normalizedCode)) {
    throw new InvalidPairCodeError();
  }
  const ikm = Buffer.from(normalizedCode, 'utf8');
  return {
    pairRoomId: hkdf(ikm, 'pair-room', 16).toString('hex'),
    pairToken: hkdf(ikm, 'pair-token', 32).toString('base64url'),
  };
};

/** Per-connection directional AEAD keys: ikm = K || ECDH secret, salt = nonceC || nonceH. */
export const deriveSessionKeys = (
  k: Uint8Array,
  ecdhSecret: Uint8Array,
  nonceC: Uint8Array,
  nonceH: Uint8Array,
): { keyC2H: Buffer; keyH2C: Buffer } => {
  assertLength(k, KEY_BYTES, 'Pairing key K');
  assertLength(ecdhSecret, KEY_BYTES, 'ECDH secret');
  assertLength(nonceC, NONCE_BYTES, 'Controller nonce');
  assertLength(nonceH, NONCE_BYTES, 'Host nonce');
  const ikm = Buffer.concat([k, ecdhSecret]);
  const salt = Buffer.concat([nonceC, nonceH]);
  try {
    return { keyC2H: hkdf(ikm, 'c2h', 32, salt), keyH2C: hkdf(ikm, 'h2c', 32, salt) };
  } finally {
    ikm.fill(0);
  }
};

/** The long-term key K produced by a pairing ceremony from its ECDH secret and both nonces. */
export const derivePairingKey = (ecdhSecret: Uint8Array, nonceC: Uint8Array, nonceH: Uint8Array): Buffer => {
  assertLength(ecdhSecret, KEY_BYTES, 'ECDH secret');
  assertLength(nonceC, NONCE_BYTES, 'Controller nonce');
  assertLength(nonceH, NONCE_BYTES, 'Host nonce');
  return hkdf(ecdhSecret, 'pairing-key', 32, Buffer.concat([nonceC, nonceH]));
};

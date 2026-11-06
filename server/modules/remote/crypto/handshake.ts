/**
 * Link handshake with an ephemeral X25519 exchange (contracts section 5).
 *
 *   HELLO1 = [1][nonceC 16][ephPubC 32]                               Controller -> Host
 *   HELLO2 = [2][nonceH 16][ephPubH 32][HMAC(macKey,"host"||HELLO1||nonceH||ephPubH)]
 *   HELLO3 = [3][HMAC(macKey,"controller"||HELLO1||HELLO2)]           Controller -> Host
 *
 * `macKey` is derived from the long-term pairing key K, so only a holder of K can produce a valid
 * HELLO2/HELLO3; the fresh ephemeral keys and nonces give every connection new session keys
 * (forward secrecy) and make recorded HELLOs useless on a later connection.
 *
 * The module is transport-free: callers feed it buffers and own the timers. Time is injected so
 * the 10 s handshake window and the HELLO1 rate limit are testable without waiting (default clock
 * is monotonic, so wall-clock changes cannot shorten or extend them). Errors carry
 * a stable `code` and never include key material.
 */

import crypto from 'node:crypto';

import type { RemoteSessionKeys } from '@/shared/types.js';

import { deriveSessionKeys, hkdf } from './key-derivation.js';

const TYPE_HELLO1 = 1;
const TYPE_HELLO2 = 2;
const TYPE_HELLO3 = 3;
const NONCE_BYTES = 16;
const PUBLIC_KEY_BYTES = 32;
const MAC_BYTES = 32;

export const HELLO1_LENGTH = 1 + NONCE_BYTES + PUBLIC_KEY_BYTES;
export const HELLO2_LENGTH = 1 + NONCE_BYTES + PUBLIC_KEY_BYTES + MAC_BYTES;
export const HELLO3_LENGTH = 1 + MAC_BYTES;
export const HANDSHAKE_TIMEOUT_MS = 10_000;
export const HELLO1_RATE_LIMIT = 5;
export const HELLO1_RATE_WINDOW_MS = 10_000;

// DER prefix of an X25519 SubjectPublicKeyInfo; the raw 32-byte key follows.
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const ZERO_SECRET = Buffer.alloc(32);

export type HandshakeErrorCode =
  | 'bad-length'
  | 'bad-type'
  | 'bad-mac'
  | 'bad-state'
  | 'superseded'
  | 'handshake-timeout'
  | 'handshake-rate-limited'
  | 'invalid-key';

export class HandshakeError extends Error {
  readonly code: HandshakeErrorCode;

  constructor(code: HandshakeErrorCode) {
    super(`Handshake failed: ${code}`);
    this.name = 'HandshakeError';
    this.code = code;
  }
}

type DiffieHellman = (options: { privateKey: crypto.KeyObject; publicKey: crypto.KeyObject }) => Buffer;

type HandshakeDeps = {
  /** Pairing key K shared by both sides. */
  k: Uint8Array;
  now?: () => number;
  diffieHellman?: DiffieHellman;
};

const requireKey = (k: Uint8Array): Buffer => {
  if (!(k instanceof Uint8Array) || k.length !== 32) throw new Error('Pairing key K must be 32 bytes.');
  return Buffer.from(k);
};

const hmac = (macKey: Buffer, ...parts: Array<Buffer | string>): Buffer => {
  const mac = crypto.createHmac('sha256', macKey);
  for (const part of parts) mac.update(part);
  return mac.digest();
};

const macMatches = (expected: Buffer, actual: Buffer): boolean =>
  expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

// Consumed by: the pairing ceremony (pairing/pairing-ceremony.ts), which needs the same X25519 primitives.
export const generateEphemeral = (): { privateKey: crypto.KeyObject; publicRaw: Buffer } => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return { privateKey, publicRaw: Buffer.from(der.subarray(der.length - PUBLIC_KEY_BYTES)) };
};

/** X25519 shared secret; a malformed or low-order peer key (all-zero output) is `invalid-key`. */
// Consumed by: the pairing ceremony (pairing/pairing-ceremony.ts).
export const computeSharedSecret = (dh: DiffieHellman, privateKey: crypto.KeyObject, peerPublicRaw: Buffer): Buffer => {
  let secret: Buffer;
  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.concat([X25519_SPKI_PREFIX, peerPublicRaw]),
      format: 'der',
      type: 'spki',
    });
    secret = dh({ privateKey, publicKey });
  } catch {
    throw new HandshakeError('invalid-key');
  }
  if (secret.length !== 32 || crypto.timingSafeEqual(secret, ZERO_SECRET)) throw new HandshakeError('invalid-key');
  return secret;
};

const requireShape = (message: Uint8Array, length: number, type: number): Buffer => {
  if (!(message instanceof Uint8Array) || message.length !== length) throw new HandshakeError('bad-length');
  if (message[0] !== type) throw new HandshakeError('bad-type');
  return Buffer.from(message.buffer, message.byteOffset, message.byteLength);
};

// ---------------------------------------------------------------------------
// Controller (initiator)
// ---------------------------------------------------------------------------

export type ControllerHandshake = {
  /** Message to send to the Host (also whenever the relay reports `peer up`). */
  readonly hello1: Buffer;
  isExpired(): boolean;
  /** Verifies HELLO2 and returns HELLO3 plus the session keys. Completes at most once. */
  completeWithHello2(hello2: Uint8Array): { hello3: Buffer; keys: RemoteSessionKeys };
};

export const createControllerHandshake = ({
  k,
  now = () => performance.now(),
  diffieHellman = crypto.diffieHellman,
}: HandshakeDeps): ControllerHandshake => {
  const key = requireKey(k);
  const macKey = hkdf(key, 'mac', 32);
  const nonceC = crypto.randomBytes(NONCE_BYTES);
  const ephemeral = generateEphemeral();
  const hello1 = Buffer.concat([Buffer.from([TYPE_HELLO1]), nonceC, ephemeral.publicRaw]);
  const startedAt = now();
  let done = false;

  const isExpired = () => now() - startedAt >= HANDSHAKE_TIMEOUT_MS;

  return {
    hello1,
    isExpired,

    completeWithHello2(hello2) {
      if (done) throw new HandshakeError('bad-state');
      if (isExpired()) throw new HandshakeError('handshake-timeout');
      const message = requireShape(hello2, HELLO2_LENGTH, TYPE_HELLO2);
      const macOffset = HELLO2_LENGTH - MAC_BYTES;
      const nonceH = message.subarray(1, 1 + NONCE_BYTES);
      const ephPubH = message.subarray(1 + NONCE_BYTES, macOffset);
      const expected = hmac(macKey, 'host', hello1, nonceH, ephPubH);
      if (!macMatches(expected, message.subarray(macOffset))) throw new HandshakeError('bad-mac');

      const secret = computeSharedSecret(diffieHellman, ephemeral.privateKey, ephPubH);
      const { keyC2H, keyH2C } = deriveSessionKeys(key, secret, nonceC, nonceH);
      secret.fill(0);
      const hello3 = Buffer.concat([Buffer.from([TYPE_HELLO3]), hmac(macKey, 'controller', hello1, message)]);
      done = true;
      return { hello3, keys: { sendKey: keyC2H, receiveKey: keyH2C } };
    },
  };
};

// ---------------------------------------------------------------------------
// Host (responder)
// ---------------------------------------------------------------------------

export type HostPendingHandshake = {
  /** Message to send back to the Controller. */
  readonly hello2: Buffer;
  isExpired(): boolean;
  /** Verifies HELLO3 and returns the session keys. Completes at most once. */
  completeWithHello3(hello3: Uint8Array): RemoteSessionKeys;
};

export type HostHandshakeListener = {
  /**
   * Handles a HELLO1. Length and type are checked before any rate-limit bookkeeping or ECDH, and
   * at most 5 valid-looking HELLO1 are processed per 10 s. A HELLO1 during an established session
   * is simply another call: the caller drops the old session and uses the new pending handshake.
   */
  acceptHello1(hello1: Uint8Array): HostPendingHandshake;
};

export const createHostHandshakeListener = ({
  k,
  now = () => performance.now(),
  diffieHellman = crypto.diffieHellman,
}: HandshakeDeps): HostHandshakeListener => {
  const key = requireKey(k);
  const macKey = hkdf(key, 'mac', 32);
  let generation = 0;
  let accepted: number[] = [];

  return {
    acceptHello1(hello1) {
      const message = requireShape(hello1, HELLO1_LENGTH, TYPE_HELLO1);

      const startedAt = now();
      accepted = accepted.filter((at) => startedAt - at < HELLO1_RATE_WINDOW_MS);
      if (accepted.length >= HELLO1_RATE_LIMIT) throw new HandshakeError('handshake-rate-limited');
      accepted.push(startedAt);

      const nonceC = message.subarray(1, 1 + NONCE_BYTES);
      const ephPubC = message.subarray(1 + NONCE_BYTES);
      const nonceH = crypto.randomBytes(NONCE_BYTES);
      const ephemeral = generateEphemeral();
      const secret = computeSharedSecret(diffieHellman, ephemeral.privateKey, ephPubC);
      const { keyC2H, keyH2C } = deriveSessionKeys(key, secret, nonceC, nonceH);
      secret.fill(0);

      const helloCopy = Buffer.from(message);
      const body = Buffer.concat([Buffer.from([TYPE_HELLO2]), nonceH, ephemeral.publicRaw]);
      const hello2 = Buffer.concat([body, hmac(macKey, 'host', helloCopy, nonceH, ephemeral.publicRaw)]);
      const expectedHello3 = Buffer.concat([Buffer.from([TYPE_HELLO3]), hmac(macKey, 'controller', helloCopy, hello2)]);

      generation += 1;
      const mine = generation;
      let done = false;
      const isExpired = () => now() - startedAt >= HANDSHAKE_TIMEOUT_MS;

      return {
        hello2,
        isExpired,

        completeWithHello3(hello3) {
          if (done) throw new HandshakeError('bad-state');
          if (mine !== generation) throw new HandshakeError('superseded');
          if (isExpired()) throw new HandshakeError('handshake-timeout');
          const received = requireShape(hello3, HELLO3_LENGTH, TYPE_HELLO3);
          if (!macMatches(expectedHello3, received)) throw new HandshakeError('bad-mac');
          done = true;
          return { sendKey: keyH2C, receiveKey: keyC2H };
        },
      };
    },
  };
};

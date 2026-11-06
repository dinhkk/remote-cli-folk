/**
 * Pairing codes: 8 Crockford base32 characters (40 bits), shown as `XXXX-XXXX`.
 *
 * The code is only a rendezvous point (it names the relay pair room). It is *not* what makes the
 * pairing safe: a party that learns the code still has to match the SAS the Host user types
 * (contracts section 5). Normalization and room derivation live in `key-derivation.ts`, shared
 * with the relay vectors; this file adds generation and display.
 */

import crypto from 'node:crypto';

import { derivePairRoom, normalizePairCode } from '../crypto/key-derivation.js';

// Crockford base32: no I, L, O, U (look-alikes and accidental words).
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_ENTROPY_BYTES = 5;
const SYMBOL_BITS = 5n;
const SYMBOL_COUNT = 8;

/**
 * Generates a code from 5 random bytes (exactly 40 bits, no modulo bias: 8 symbols x 5 bits).
 * `randomBytes` is injectable so tests can prove properties without relying on luck.
 * Consumed by: the Host pairing service when it starts a pairing.
 */
export const generatePairCode = (randomBytes: (length: number) => Uint8Array = crypto.randomBytes): string => {
  const bytes = randomBytes(CODE_ENTROPY_BYTES);
  if (bytes.length !== CODE_ENTROPY_BYTES) throw new Error(`A pairing code needs ${CODE_ENTROPY_BYTES} bytes of entropy.`);
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let code = '';
  for (let i = 0; i < SYMBOL_COUNT; i++) {
    code = ALPHABET[Number(bits & 31n)] + code;
    bits >>= SYMBOL_BITS;
  }
  return code;
};

/**
 * Display form `XXXX-XXXX` of any spelling of a valid code.
 * Consumed by: the Host pairing service (the code shown to the user).
 */
export const formatPairCode = (input: string): string => {
  const code = normalizePairCode(input);
  return `${code.slice(0, 4)}-${code.slice(4)}`;
};

/**
 * Normalizes user input and derives the pair room id and relay token from it. Throws
 * `InvalidPairCodeError` for anything that is not a code.
 * Consumed by: the Host and Controller pairing services.
 */
export const resolvePairCode = (input: string): { code: string; pairRoomId: string; pairToken: string } => {
  const code = normalizePairCode(input);
  return { code, ...derivePairRoom(code) };
};

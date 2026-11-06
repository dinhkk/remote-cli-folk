/**
 * Wire format and checks of the pairing ceremony (contracts section 5, "Bat bien ceremony").
 *
 * Every message is one relay binary frame `[type u8][fields]`. Decoders are strict (exact lengths,
 * valid names) and return null on anything else, so the state machine can treat "malformed" and
 * "out of order" alike: abort.
 *
 *   HELLO              [1][pkC 32][nameLen u8][name]            Controller -> Host
 *   HOST_KEY           [2][pkH 32][C 32][nameLen u8][name]      Host -> Controller
 *   NONCE              [3][Nc 16]                               Controller -> Host
 *   REVEAL             [4][Nh 16]                               Host -> Controller
 *   HOST_CONFIRM       [5][HMAC 32]                             Host -> Controller
 *   CONTROLLER_CONFIRM [6][HMAC 32]                             Controller -> Host
 *   ABORT              [7][reason u8]                           either direction
 *
 * `C = HMAC(Nh, pkH || pkC)` commits the Host to its nonce before it learns Nc; the SAS is
 * `SHA256(pkC || pkH || Nc || Nh)` reduced to six digits; the confirmations are HMACs under the
 * macKey derived from K over the same transcript hash, one label per direction.
 *
 * Consumed by: `pairing-ceremony.ts` (all exports); the tests use the encoders to forge frames.
 */

import crypto from 'node:crypto';

import type { RemotePairingFailure } from '@/shared/types.js';

import { REMOTE_LABEL_PREFIX } from '../crypto/key-derivation.js';

export const PAIR_FRAME_TYPE = {
  hello: 1,
  hostKey: 2,
  nonce: 3,
  reveal: 4,
  hostConfirm: 5,
  controllerConfirm: 6,
  abort: 7,
} as const;

const PUBLIC_KEY_BYTES = 32;
const COMMITMENT_BYTES = 32;
const NONCE_BYTES = 16;
const MAC_BYTES = 32;
const MAX_NAME_BYTES = 32;
const SAS_MODULUS = 1_000_000;
const DEFAULT_DEVICE_NAME = 'device';

const NAME_PATTERN = /^[A-Za-z0-9 ._-]{1,32}$/;
const DISALLOWED_NAME_CHARACTERS = /[^A-Za-z0-9 ._-]/g;

// Abort reason codes on the wire. Only decisions that matter to the other side are distinct;
// everything else is reported as a protocol violation.
const ABORT_CODES: Partial<Record<RemotePairingFailure, number>> = {
  expired: 2,
  'sas-attempts-exhausted': 3,
  cancelled: 4,
};
const ABORT_REASONS: Record<number, RemotePairingFailure> = { 2: 'expired', 3: 'sas-attempts-exhausted', 4: 'cancelled' };
const ABORT_PROTOCOL_CODE = 1;

const asBuffer = (frame: Uint8Array): Buffer => Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);

/** True for a name that is 1-32 characters of `[A-Za-z0-9 ._-]` and not only spaces. */
export const isValidDeviceName = (name: string): boolean => typeof name === 'string' && NAME_PATTERN.test(name) && /\S/.test(name);

/**
 * Lenient clean-up of a device name typed locally: drops disallowed characters, trims, cuts to 32
 * characters and falls back to "device" when nothing is left. Never used on received names (those
 * are rejected, not repaired).
 */
export const sanitizeDeviceName = (input: string): string => {
  if (typeof input !== 'string') return DEFAULT_DEVICE_NAME;
  const cleaned = input.replace(DISALLOWED_NAME_CHARACTERS, '').trim().slice(0, MAX_NAME_BYTES).trim();
  return cleaned.length > 0 ? cleaned : DEFAULT_DEVICE_NAME;
};

/** Frame type byte, or null for an empty frame. */
export const pairFrameType = (frame: Uint8Array): number | null => (frame.length > 0 ? frame[0] : null);

const encodeName = (name: string): Buffer => {
  if (!isValidDeviceName(name)) throw new Error('Device name must be 1-32 characters of [A-Za-z0-9 ._-].');
  const bytes = Buffer.from(name, 'ascii');
  return Buffer.concat([Buffer.from([bytes.length]), bytes]);
};

/** Reads `[nameLen][name]` at `offset`; the name must end exactly at the end of the frame. */
const decodeName = (frame: Buffer, offset: number): string | null => {
  if (frame.length < offset + 1) return null;
  const length = frame[offset];
  if (length === 0 || length > MAX_NAME_BYTES || frame.length !== offset + 1 + length) return null;
  const name = frame.toString('latin1', offset + 1);
  return isValidDeviceName(name) ? name : null;
};

const requireLength = (value: Uint8Array, length: number, what: string): void => {
  if (!(value instanceof Uint8Array) || value.length !== length) throw new Error(`${what} must be ${length} bytes.`);
};

// ---------------------------------------------------------------------------
// Encoders / decoders
// ---------------------------------------------------------------------------

export const encodePairHello = (publicKey: Uint8Array, deviceName: string): Buffer => {
  requireLength(publicKey, PUBLIC_KEY_BYTES, 'Public key');
  return Buffer.concat([Buffer.from([PAIR_FRAME_TYPE.hello]), publicKey, encodeName(deviceName)]);
};

export const decodePairHello = (frame: Uint8Array): { publicKey: Buffer; deviceName: string } | null => {
  const buffer = asBuffer(frame);
  if (buffer[0] !== PAIR_FRAME_TYPE.hello || buffer.length < 1 + PUBLIC_KEY_BYTES + 1) return null;
  const deviceName = decodeName(buffer, 1 + PUBLIC_KEY_BYTES);
  if (deviceName === null) return null;
  return { publicKey: Buffer.from(buffer.subarray(1, 1 + PUBLIC_KEY_BYTES)), deviceName };
};

export const encodePairHostKey = (publicKey: Uint8Array, commitment: Uint8Array, hostName: string): Buffer => {
  requireLength(publicKey, PUBLIC_KEY_BYTES, 'Public key');
  requireLength(commitment, COMMITMENT_BYTES, 'Commitment');
  return Buffer.concat([Buffer.from([PAIR_FRAME_TYPE.hostKey]), publicKey, commitment, encodeName(hostName)]);
};

export const decodePairHostKey = (frame: Uint8Array): { publicKey: Buffer; commitment: Buffer; hostName: string } | null => {
  const buffer = asBuffer(frame);
  const fixed = 1 + PUBLIC_KEY_BYTES + COMMITMENT_BYTES;
  if (buffer[0] !== PAIR_FRAME_TYPE.hostKey || buffer.length < fixed + 1) return null;
  const hostName = decodeName(buffer, fixed);
  if (hostName === null) return null;
  return {
    publicKey: Buffer.from(buffer.subarray(1, 1 + PUBLIC_KEY_BYTES)),
    commitment: Buffer.from(buffer.subarray(1 + PUBLIC_KEY_BYTES, fixed)),
    hostName,
  };
};

export const encodePairNonce = (nonce: Uint8Array): Buffer => {
  requireLength(nonce, NONCE_BYTES, 'Nonce');
  return Buffer.concat([Buffer.from([PAIR_FRAME_TYPE.nonce]), nonce]);
};

export const decodePairNonce = (frame: Uint8Array): Buffer | null => {
  const buffer = asBuffer(frame);
  if (buffer[0] !== PAIR_FRAME_TYPE.nonce || buffer.length !== 1 + NONCE_BYTES) return null;
  return Buffer.from(buffer.subarray(1));
};

export const encodePairReveal = (nonce: Uint8Array): Buffer => {
  requireLength(nonce, NONCE_BYTES, 'Nonce');
  return Buffer.concat([Buffer.from([PAIR_FRAME_TYPE.reveal]), nonce]);
};

export const decodePairReveal = (frame: Uint8Array): Buffer | null => {
  const buffer = asBuffer(frame);
  if (buffer[0] !== PAIR_FRAME_TYPE.reveal || buffer.length !== 1 + NONCE_BYTES) return null;
  return Buffer.from(buffer.subarray(1));
};

export const encodePairConfirm = (sender: 'host' | 'controller', mac: Uint8Array): Buffer => {
  requireLength(mac, MAC_BYTES, 'Confirmation');
  return Buffer.concat([Buffer.from([sender === 'host' ? PAIR_FRAME_TYPE.hostConfirm : PAIR_FRAME_TYPE.controllerConfirm]), mac]);
};

/** The MAC of a confirmation frame sent by `sender`, or null when the frame is not exactly that. */
export const decodePairConfirm = (frame: Uint8Array, sender: 'host' | 'controller'): Buffer | null => {
  const buffer = asBuffer(frame);
  const type = sender === 'host' ? PAIR_FRAME_TYPE.hostConfirm : PAIR_FRAME_TYPE.controllerConfirm;
  if (buffer[0] !== type || buffer.length !== 1 + MAC_BYTES) return null;
  return Buffer.from(buffer.subarray(1));
};

export const encodePairAbort = (reason: RemotePairingFailure): Buffer =>
  Buffer.from([PAIR_FRAME_TYPE.abort, ABORT_CODES[reason] ?? ABORT_PROTOCOL_CODE]);

/**
 * How the receiver of an abort should record it: the Host's decisions (`expired`,
 * `sas-attempts-exhausted`, `cancelled`) pass through, anything else is `peer-aborted`. Null when
 * the frame is not a well-formed abort.
 */
export const decodePairAbort = (frame: Uint8Array): RemotePairingFailure | null => {
  const buffer = asBuffer(frame);
  if (buffer[0] !== PAIR_FRAME_TYPE.abort || buffer.length !== 2) return null;
  return ABORT_REASONS[buffer[1]] ?? 'peer-aborted';
};

// ---------------------------------------------------------------------------
// Commitment, SAS, confirmations
// ---------------------------------------------------------------------------

/** `C = HMAC-SHA256(key = Nh, pkH || pkC)`: binds the Host to Nh and both public keys. */
export const computeCommitment = (nonceH: Uint8Array, publicKeyH: Uint8Array, publicKeyC: Uint8Array): Buffer => {
  requireLength(nonceH, NONCE_BYTES, 'Host nonce');
  return crypto.createHmac('sha256', nonceH).update(publicKeyH).update(publicKeyC).digest();
};

/** `SHA256(pkC || pkH || Nc || Nh)`: everything both sides must agree on, hashed once. */
export const computePairTranscript = (
  publicKeyC: Uint8Array,
  publicKeyH: Uint8Array,
  nonceC: Uint8Array,
  nonceH: Uint8Array,
): Buffer => {
  requireLength(publicKeyC, PUBLIC_KEY_BYTES, 'Controller public key');
  requireLength(publicKeyH, PUBLIC_KEY_BYTES, 'Host public key');
  requireLength(nonceC, NONCE_BYTES, 'Controller nonce');
  requireLength(nonceH, NONCE_BYTES, 'Host nonce');
  return crypto.createHash('sha256').update(publicKeyC).update(publicKeyH).update(nonceC).update(nonceH).digest();
};

/** Six decimal digits from the first four transcript bytes (bias below 0.03%, irrelevant at 10^-6 odds). */
export const sasFromTranscript = (transcript: Uint8Array): string =>
  String(asBuffer(transcript).readUInt32BE(0) % SAS_MODULUS).padStart(6, '0');

/** Key confirmation: HMAC under the K-derived macKey over the transcript, with one label per direction. */
export const computeConfirmMac = (sender: 'host' | 'controller', macKey: Uint8Array, transcript: Uint8Array): Buffer =>
  crypto
    .createHmac('sha256', macKey)
    .update(`${REMOTE_LABEL_PREFIX}pair-confirm-${sender}`)
    .update(transcript)
    .digest();

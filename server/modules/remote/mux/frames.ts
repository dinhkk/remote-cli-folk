/**
 * Mux frame codec (contracts section 6): the plaintext carried inside an encrypted DATA frame.
 *
 *   [type u8][streamId u32 BE][metaLen u32 BE][meta JSON utf8][body bytes]
 *
 * Decoding is strict: the peer is authenticated but may still be buggy or hostile, so every length,
 * the type, the meta shape, the body rules and the stream-id rules are checked and a violation
 * throws a `MuxFrameError` (never anything else, whatever the input). `encodeFrame` applies the
 * same rules so this side cannot produce a frame its own decoder would refuse.
 */

import type { RemoteErrorCode, RemoteMuxFrame, RemoteMuxFrameType, RemotePairingRole } from '@/shared/types.js';

import { MAX_PLAINTEXT_BYTES } from '../crypto/secure-channel.js';

export const MUX_HEADER_BYTES = 1 + 4 + 4;
/** Largest meta JSON accepted (headers of a request/response must fit). */
export const MAX_META_BYTES = 64 * 1024;
/** Largest REQ_BODY/RES_BODY chunk, so the scheduler can interleave streams between chunks. */
export const MAX_BODY_CHUNK_BYTES = 64 * 1024;
/** Largest single WebSocket message the mux carries (bigger ones close the stream with 1009). */
export const MAX_WS_MESSAGE_BYTES = 1024 * 1024;
/** WS_MSG payloads up to this size are "small": control priority and eligible for batching. */
export const SMALL_MESSAGE_BYTES = 16 * 1024;

/** Most messages one batched WS_MSG may carry (Host -> Controller only). */
export const MAX_BATCH_MESSAGES = 4096;
/** Longest `path` of HTTP_REQ/WS_OPEN (target with query). Also the canonicalizer's ceiling. */
export const MAX_PATH_CHARS = 8192;
const MAX_HEADER_COUNT = 128;
const MAX_HEADER_VALUES = 64;
/** Longest header value the mux carries. Also the header filter's ceiling, both directions. */
export const MAX_HEADER_VALUE_CHARS = 8192;
const MAX_APP_VERSION_CHARS = 64;
const MAX_REASON_CHARS = 512;
const MAX_MESSAGE_CHARS = 1024;
const MAX_PROTOCOLS = 16;
const MAX_PROTOCOL_CHARS = 128;
const BATCH_ITEM_HEADER_BYTES = 4;
const MAX_U32 = 0xffffffff;

export type MuxFrameErrorCode =
  | 'truncated'
  | 'meta-too-large'
  | 'bad-meta'
  | 'unknown-type'
  | 'bad-body'
  | 'bad-stream-id'
  | 'frame-too-large';

/**
 * The only error the codec throws. `streamId` and `frameType` are filled when the header was
 * readable, so the stream table can answer with an ERROR for that stream.
 */
export class MuxFrameError extends Error {
  readonly code: MuxFrameErrorCode;
  readonly streamId: number | null;
  readonly frameType: number | null;

  constructor(code: MuxFrameErrorCode, streamId: number | null = null, frameType: number | null = null) {
    super(`Invalid mux frame: ${code}`);
    this.name = 'MuxFrameError';
    this.code = code;
    this.streamId = streamId;
    this.frameType = frameType;
  }
}

const TYPE_CODES: Record<RemoteMuxFrameType, number> = {
  APP_HELLO: 0x01,
  PING: 0x02,
  PONG: 0x03,
  HTTP_REQ: 0x10,
  REQ_BODY: 0x11,
  HTTP_RES: 0x12,
  RES_BODY: 0x13,
  WS_OPEN: 0x20,
  WS_MSG: 0x21,
  WS_CLOSE: 0x22,
  CANCEL: 0x30,
  ERROR: 0x31,
};

const TYPE_NAMES = new Map<number, RemoteMuxFrameType>(
  (Object.entries(TYPE_CODES) as Array<[RemoteMuxFrameType, number]>).map(([name, code]) => [code, name]),
);

/** Frames that belong to the connection (stream 0), not to a stream. */
const CONNECTION_TYPES = new Set<RemoteMuxFrameType>(['APP_HELLO', 'PING', 'PONG']);
/** Frame types whose body must be empty. */
const BODYLESS_TYPES = new Set<RemoteMuxFrameType>(['APP_HELLO', 'PING', 'PONG', 'HTTP_REQ', 'HTTP_RES', 'WS_OPEN', 'WS_CLOSE', 'CANCEL', 'ERROR']);

/** The mux error codes of contracts section 9: the one list the decoder accepts. */
export const REMOTE_ERROR_CODES = [
  'REMOTE_LINK_DOWN',
  'REMOTE_FORBIDDEN',
  'REMOTE_UPSTREAM_AUTH',
  'REMOTE_QUOTA',
  'REMOTE_TOO_LARGE',
  'REMOTE_PROTOCOL',
  'REMOTE_UNSUPPORTED_MODE',
  'REMOTE_INTERNAL',
] as const;

// Compile-time exactness: a code added to `RemoteErrorCode` but not listed here (or the reverse) fails the build.
type ListedErrorCode = (typeof REMOTE_ERROR_CODES)[number];
type ErrorCodeListIsExact = [RemoteErrorCode] extends [ListedErrorCode] ? ([ListedErrorCode] extends [RemoteErrorCode] ? true : never) : never;
const errorCodeListIsExact: ErrorCodeListIsExact = true;
void errorCodeListIsExact;

const ERROR_CODES = new Set<string>(REMOTE_ERROR_CODES);

/**
 * WebSocket close codes a peer may put on the wire: the ones `ws` accepts for `close()` (1000-1003,
 * 1007-1014 and the application range 3000-4999). 1004-1006 and 1015 are reserved and make
 * `ws.close` throw; a bridge must map what an upstream reports (for example 1005 "no status") to a valid code.
 */
export const isValidWsCloseCode = (code: unknown): boolean => {
  if (!Number.isInteger(code)) return false;
  const value = code as number;
  if (value >= 3000) return value <= 4999;
  return value >= 1000 && value <= 1014 && value !== 1004 && value !== 1005 && value !== 1006;
};

// ---------------------------------------------------------------------------
// Meta validation
// ---------------------------------------------------------------------------

type Meta = Record<string, unknown>;

const isRecord = (value: unknown): value is Meta => typeof value === 'object' && value !== null && !Array.isArray(value);
const isInteger = (value: unknown, min: number, max: number): boolean => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
const isText = (value: unknown, maxChars: number): boolean => typeof value === 'string' && value.length <= maxChars;

const isHeaderValue = (value: unknown): boolean => {
  if (typeof value === 'string') return value.length <= MAX_HEADER_VALUE_CHARS;
  return Array.isArray(value) && value.length <= MAX_HEADER_VALUES && value.every((item) => isText(item, MAX_HEADER_VALUE_CHARS));
};

/** Keys that would reach an object's prototype if a bridge copied headers with `Object.assign` or bracket writes. */
const FORBIDDEN_HEADER_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const isHeaders = (value: unknown): boolean =>
  isRecord(value) &&
  Object.keys(value).length <= MAX_HEADER_COUNT &&
  Object.keys(value).every((key) => !FORBIDDEN_HEADER_KEYS.has(key)) &&
  Object.values(value).every(isHeaderValue);

const isPath = (value: unknown): boolean => isText(value, MAX_PATH_CHARS) && (value as string).startsWith('/');

const META_VALIDATORS: Record<RemoteMuxFrameType, (meta: Meta) => boolean> = {
  APP_HELLO: (meta) =>
    isInteger(meta.protocolVersion, 0, 0xffff) &&
    isText(meta.appVersion, MAX_APP_VERSION_CHARS) &&
    (meta.role === 'host' || meta.role === 'controller'),
  PING: () => true,
  PONG: () => true,
  HTTP_REQ: (meta) => typeof meta.method === 'string' && /^[A-Za-z]{1,16}$/.test(meta.method) && isPath(meta.path) && isHeaders(meta.headers),
  REQ_BODY: (meta) => typeof meta.fin === 'boolean',
  HTTP_RES: (meta) => isInteger(meta.status, 100, 599) && isHeaders(meta.headers),
  RES_BODY: (meta) => typeof meta.fin === 'boolean',
  WS_OPEN: (meta) =>
    isPath(meta.path) &&
    (meta.protocols === undefined ||
      (Array.isArray(meta.protocols) && meta.protocols.length <= MAX_PROTOCOLS && meta.protocols.every((item) => isText(item, MAX_PROTOCOL_CHARS)))),
  WS_MSG: (meta) => typeof meta.binary === 'boolean' && (meta.batch === undefined || isInteger(meta.batch, 1, MAX_BATCH_MESSAGES)),
  WS_CLOSE: (meta) => isValidWsCloseCode(meta.code) && isText(meta.reason, MAX_REASON_CHARS),
  CANCEL: () => true,
  ERROR: (meta) => typeof meta.code === 'string' && ERROR_CODES.has(meta.code) && isText(meta.message, MAX_MESSAGE_CHARS),
};

// ---------------------------------------------------------------------------
// Batch bodies
// ---------------------------------------------------------------------------

/** Concatenates messages as `[len u32 BE][payload]` items (an array on the wire, never joined text). */
export const encodeBatchBody = (payloads: Uint8Array[]): Buffer => {
  const parts: Buffer[] = [];
  for (const payload of payloads) {
    const header = Buffer.alloc(BATCH_ITEM_HEADER_BYTES);
    header.writeUInt32BE(payload.length);
    parts.push(header, Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength));
  }
  return Buffer.concat(parts);
};

/** Splits a batch body into exactly `count` messages; any leftover or missing byte is `bad-body`. */
export const splitBatchBody = (body: Uint8Array, count: number): Buffer[] => {
  const buffer = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const items: Buffer[] = [];
  let offset = 0;
  for (let i = 0; i < count; i += 1) {
    if (offset + BATCH_ITEM_HEADER_BYTES > buffer.length) throw new MuxFrameError('bad-body');
    const length = buffer.readUInt32BE(offset);
    offset += BATCH_ITEM_HEADER_BYTES;
    if (length > buffer.length - offset || length > MAX_WS_MESSAGE_BYTES) throw new MuxFrameError('bad-body');
    items.push(buffer.subarray(offset, offset + length));
    offset += length;
  }
  if (offset !== buffer.length) throw new MuxFrameError('bad-body');
  return items;
};

// ---------------------------------------------------------------------------
// Frame checks shared by encode and decode
// ---------------------------------------------------------------------------

const checkStreamId = (type: RemoteMuxFrameType, streamId: number, code: number): void => {
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > MAX_U32) throw new MuxFrameError('bad-stream-id', null, code);
  if (CONNECTION_TYPES.has(type)) {
    if (streamId !== 0) throw new MuxFrameError('bad-stream-id', streamId, code);
  } else if (streamId === 0 && type !== 'ERROR') {
    // ERROR is the only type usable on both the connection and a stream.
    throw new MuxFrameError('bad-stream-id', streamId, code);
  }
};

const checkBody = (type: RemoteMuxFrameType, meta: Meta, body: Uint8Array, streamId: number, code: number): void => {
  const bad = () => new MuxFrameError('bad-body', streamId, code);
  if (BODYLESS_TYPES.has(type)) {
    if (body.length !== 0) throw bad();
    return;
  }
  if (type === 'REQ_BODY' || type === 'RES_BODY') {
    if (body.length > MAX_BODY_CHUNK_BYTES) throw bad();
    return;
  }
  // WS_MSG
  if (meta.batch === undefined) {
    if (body.length > MAX_WS_MESSAGE_BYTES) throw bad();
    return;
  }
  try {
    splitBatchBody(body, meta.batch as number);
  } catch {
    throw bad();
  }
};

/**
 * Validates meta, body and stream id of a frame whose type is already known. `peerRole` is the
 * sender's role when the direction is known: only the Host batches WS messages, so a batch from a
 * Controller is refused (one small frame must not fan out into thousands of `onMessage` calls).
 */
const checkFrame = (
  type: RemoteMuxFrameType,
  streamId: number,
  meta: unknown,
  body: Uint8Array,
  code: number,
  peerRole?: RemotePairingRole,
): void => {
  checkStreamId(type, streamId, code);
  if (!isRecord(meta) || !META_VALIDATORS[type](meta)) throw new MuxFrameError('bad-meta', streamId, code);
  if (type === 'WS_MSG' && peerRole === 'controller' && meta.batch !== undefined) throw new MuxFrameError('bad-meta', streamId, code);
  checkBody(type, meta, body, streamId, code);
};

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

/** Serializes a frame; throws `MuxFrameError` when it breaks the frame rules. */
// Consumed by: stream-table (every outgoing frame) and the link session (hello, ping/pong).
export const encodeFrame = (frame: RemoteMuxFrame): Buffer => {
  const code = TYPE_CODES[frame.type];
  if (code === undefined) throw new MuxFrameError('unknown-type', Number.isInteger(frame.streamId) ? frame.streamId : null);
  checkFrame(frame.type, frame.streamId, frame.meta, frame.body, code);
  const meta = Buffer.from(JSON.stringify(frame.meta), 'utf8');
  if (meta.length > MAX_META_BYTES) throw new MuxFrameError('meta-too-large', frame.streamId, code);
  const total = MUX_HEADER_BYTES + meta.length + frame.body.length;
  if (total > MAX_PLAINTEXT_BYTES) throw new MuxFrameError('frame-too-large', frame.streamId, code);
  const out = Buffer.allocUnsafe(total);
  out[0] = code;
  out.writeUInt32BE(frame.streamId, 1);
  out.writeUInt32BE(meta.length, 5);
  meta.copy(out, MUX_HEADER_BYTES);
  out.set(frame.body, MUX_HEADER_BYTES + meta.length);
  return out;
};

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Parses one plaintext; throws `MuxFrameError` (and nothing else) for anything that is not a valid frame. */
// Consumed by: stream-table (every incoming frame, with the sender's role).
export const decodeFrame = (bytes: Uint8Array, { peerRole }: { peerRole?: RemotePairingRole } = {}): RemoteMuxFrame => {
  if (bytes.length > MAX_PLAINTEXT_BYTES) throw new MuxFrameError('frame-too-large');
  if (bytes.length < MUX_HEADER_BYTES) throw new MuxFrameError('truncated');
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const code = buffer[0];
  const streamId = buffer.readUInt32BE(1);
  const metaLength = buffer.readUInt32BE(5);
  const type = TYPE_NAMES.get(code);
  if (type === undefined) throw new MuxFrameError('unknown-type', streamId, code);
  if (metaLength > MAX_META_BYTES) throw new MuxFrameError('meta-too-large', streamId, code);
  if (MUX_HEADER_BYTES + metaLength > buffer.length) throw new MuxFrameError('truncated', streamId, code);

  let meta: unknown;
  try {
    meta = JSON.parse(utf8.decode(buffer.subarray(MUX_HEADER_BYTES, MUX_HEADER_BYTES + metaLength)));
  } catch {
    throw new MuxFrameError('bad-meta', streamId, code);
  }
  const body = buffer.subarray(MUX_HEADER_BYTES + metaLength);
  checkFrame(type, streamId, meta, body, code, peerRole);
  return { type, streamId, meta, body } as RemoteMuxFrame;
};

/**
 * Control frames are small and latency-sensitive (requests, answers, keys, permission responses,
 * cancels, pings); body chunks and large WS messages are bulk. The scheduler serves control first.
 */
// Consumed by: stream-table when it queues a frame on the send scheduler.
export const isControlFrame = (type: RemoteMuxFrameType, bodyLength: number): boolean => {
  if (type === 'REQ_BODY' || type === 'RES_BODY') return false;
  if (type === 'WS_MSG') return bodyLength <= SMALL_MESSAGE_BYTES;
  return true;
};

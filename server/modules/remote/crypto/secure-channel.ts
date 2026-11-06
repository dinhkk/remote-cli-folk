/**
 * Authenticated, ordered AES-256-GCM channel over an unreliable relay (contracts section 5).
 *
 * Frame: `[0x10][counter u64 BE][ciphertext || tag16]`, IV = 4 zero bytes || counter,
 * AAD = `0x10 || counter`. Each direction has its own key and a strictly increasing counter.
 *
 * Receive policy:
 *  - a frame that fails authentication is dropped and never moves the counter (a forged frame
 *    cannot knock a healthy channel out of step); three bad frames in a row are fatal;
 *  - a frame that authenticates but carries an unexpected counter (replay, reorder or a lost
 *    frame) is fatal: the channel closes and every queued send is cancelled, and the caller
 *    performs a fresh handshake with new keys.
 *
 * Sending is serialized through one queue: the counter is assigned only when a frame is about to
 * be transmitted, so wire order always equals counter order.
 */

import crypto from 'node:crypto';

export const FRAME_TYPE_DATA = 0x10;
export const FRAME_HEADER_BYTES = 1 + 8;
const TAG_BYTES = 16;
export const FRAME_OVERHEAD_BYTES = FRAME_HEADER_BYTES + TAG_BYTES;
/** Relay limit per binary frame; the largest plaintext is whatever still fits after the overhead. */
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const MAX_PLAINTEXT_BYTES = MAX_FRAME_BYTES - FRAME_OVERHEAD_BYTES;
export const MAX_CONSECUTIVE_BAD_FRAMES = 3;

const KEY_BYTES = 32;
const MAX_COUNTER = 2n ** 64n - 1n;

export type SecureChannelErrorCode = 'closed' | 'payload-too-large' | 'invalid-payload' | 'counter-exhausted';

/** Non-desync failure of a channel operation. */
export class SecureChannelError extends Error {
  readonly code: SecureChannelErrorCode;

  constructor(code: SecureChannelErrorCode, message: string) {
    super(message);
    this.name = 'SecureChannelError';
    this.code = code;
  }
}

export type ChannelDesyncCode = 'counter-mismatch' | 'too-many-bad-frames';

/** Fatal: the peers no longer agree on the frame sequence. The channel is closed. */
export class ChannelDesync extends Error {
  readonly code: ChannelDesyncCode;

  constructor(code: ChannelDesyncCode) {
    super(
      code === 'counter-mismatch'
        ? 'Frame counter does not match (replayed, reordered or lost frame); channel closed.'
        : 'Too many consecutive invalid frames; channel closed.',
    );
    this.name = 'ChannelDesync';
    this.code = code;
  }
}

export type SecureChannelOptions = {
  /** Encrypts frames this side sends. */
  sendKey: Uint8Array;
  /** Decrypts frames from the peer. */
  receiveKey: Uint8Array;
  /** Puts one encrypted frame on the wire; the next frame is not produced until it settles. */
  transmit: (frame: Buffer) => void | Promise<void>;
  /** Initial counters; only tests need anything other than 0. */
  startSendCounter?: bigint;
  startReceiveCounter?: bigint;
};

export type SecureChannel = {
  readonly isClosed: boolean;
  /** Queues a payload; resolves once its frame has been handed to `transmit`. */
  send(plaintext: Uint8Array): Promise<void>;
  /**
   * Returns the plaintext of an authentic, in-order frame, or `undefined` when the frame was
   * dropped. Throws `ChannelDesync` when the channel can no longer be trusted.
   */
  receive(frame: Uint8Array): Buffer | undefined;
  close(): void;
};

type QueuedSend = {
  plaintext: Uint8Array;
  resolve: () => void;
  reject: (error: unknown) => void;
};

const assertKey = (key: Uint8Array, name: string): void => {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) throw new Error(`${name} must be ${KEY_BYTES} bytes.`);
};

const buildHeader = (counter: bigint): Buffer => {
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header[0] = FRAME_TYPE_DATA;
  header.writeBigUInt64BE(counter, 1);
  return header;
};

const buildIv = (header: Buffer): Buffer => Buffer.concat([Buffer.alloc(4), header.subarray(1)]);

export const createSecureChannel = (options: SecureChannelOptions): SecureChannel => {
  assertKey(options.sendKey, 'sendKey');
  assertKey(options.receiveKey, 'receiveKey');
  // Private copies so closing can wipe them without touching the caller's buffers.
  const sendKey = Buffer.from(options.sendKey);
  const receiveKey = Buffer.from(options.receiveKey);
  const { transmit } = options;

  let sendCounter = options.startSendCounter ?? 0n;
  let expectedCounter = options.startReceiveCounter ?? 0n;
  let badFrames = 0;
  let closed = false;
  let closeReason: unknown;
  let draining = false;
  const queue: QueuedSend[] = [];

  const closedError = (): unknown => closeReason ?? new SecureChannelError('closed', 'Channel is closed.');

  const shutdown = (reason?: unknown): void => {
    if (closed) return;
    closed = true;
    closeReason = reason;
    sendKey.fill(0);
    receiveKey.fill(0);
    const cancelled = queue.splice(0);
    for (const item of cancelled) item.reject(closedError());
  };

  const encryptFrame = (plaintext: Uint8Array): Buffer => {
    const header = buildHeader(sendCounter);
    const cipher = crypto.createCipheriv('aes-256-gcm', sendKey, buildIv(header), { authTagLength: TAG_BYTES });
    cipher.setAAD(header);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([header, body, cipher.getAuthTag()]);
  };

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      while (!closed && queue.length > 0) {
        const item = queue.shift() as QueuedSend;
        if (sendCounter > MAX_COUNTER) {
          const error = new SecureChannelError('counter-exhausted', 'Send counter exhausted; a new handshake is required.');
          item.reject(error);
          shutdown(error);
          return;
        }
        try {
          const frame = encryptFrame(item.plaintext);
          sendCounter += 1n;
          await transmit(frame);
          item.resolve();
        } catch (error) {
          // Either encryption failed or the counter is spent while the frame may be lost, so the
          // stream cannot continue. Settle the item here: an escape would be an unhandled rejection.
          item.reject(error);
          shutdown();
        }
      }
    } finally {
      draining = false;
    }
  };

  const dropBadFrame = (): undefined => {
    badFrames += 1;
    if (badFrames >= MAX_CONSECUTIVE_BAD_FRAMES) {
      const desync = new ChannelDesync('too-many-bad-frames');
      shutdown(desync);
      throw desync;
    }
    return undefined;
  };

  return {
    get isClosed() {
      return closed;
    },

    send(plaintext) {
      if (closed) return Promise.reject(new SecureChannelError('closed', 'Channel is closed.'));
      if (!(plaintext instanceof Uint8Array)) {
        return Promise.reject(new SecureChannelError('invalid-payload', 'Payload must be a Uint8Array.'));
      }
      if (plaintext.length > MAX_PLAINTEXT_BYTES) {
        return Promise.reject(new SecureChannelError('payload-too-large', `Payload exceeds ${MAX_PLAINTEXT_BYTES} bytes.`));
      }
      return new Promise<void>((resolve, reject) => {
        // Copy: the caller may reuse its buffer before this frame is encrypted.
        queue.push({ plaintext: Buffer.from(plaintext), resolve, reject });
        void drain();
      });
    },

    receive(frame) {
      if (closed) throw closedError();
      if (frame.length < FRAME_OVERHEAD_BYTES || frame.length > MAX_FRAME_BYTES || frame[0] !== FRAME_TYPE_DATA) {
        return dropBadFrame();
      }
      const buffer = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
      const header = buffer.subarray(0, FRAME_HEADER_BYTES);
      let plaintext: Buffer;
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', receiveKey, buildIv(header), { authTagLength: TAG_BYTES });
        decipher.setAAD(header);
        decipher.setAuthTag(buffer.subarray(buffer.length - TAG_BYTES));
        plaintext = Buffer.concat([decipher.update(buffer.subarray(FRAME_HEADER_BYTES, buffer.length - TAG_BYTES)), decipher.final()]);
      } catch {
        return dropBadFrame();
      }
      // Authentic frame: from here on the sender is known to be the peer.
      const counter = header.readBigUInt64BE(1);
      if (counter !== expectedCounter) {
        const desync = new ChannelDesync('counter-mismatch');
        shutdown(desync);
        throw desync;
      }
      badFrames = 0;
      if (counter === MAX_COUNTER) shutdown();
      else expectedCounter += 1n;
      return plaintext;
    },

    close() {
      shutdown();
    },
  };
};

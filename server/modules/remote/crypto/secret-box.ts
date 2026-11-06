/**
 * At-rest encryption for Remote secrets (pairing keys, relay secret).
 *
 * Blob = [version u8 = 1][nonce 12][AES-256-GCM ciphertext][tag 16]. The AAD
 * `<table>|<column>|<id>|v1` binds a blob to its row so it cannot be swapped between rows or
 * columns. This protects a leaked database or backup; it does not protect against a process
 * running as the same OS user (which can read the key file too).
 */

import crypto from 'node:crypto';

const BLOB_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const MIN_BLOB_BYTES = 1 + NONCE_BYTES + TAG_BYTES;

export type SecretBoxErrorCode =
  | 'invalid-blob'
  | 'unsupported-version'
  | 'decrypt-failed'
  | 'invalid-aad'
  | 'MASTER_KEY_INVALID'
  | 'MASTER_KEY_MISMATCH';

/** Failure of sealing, opening, or resolving the master key. Messages never contain key material. */
export class SecretBoxError extends Error {
  readonly code: SecretBoxErrorCode;

  constructor(code: SecretBoxErrorCode, message: string) {
    super(message);
    this.name = 'SecretBoxError';
    this.code = code;
  }
}

/** First 8 bytes of SHA-256(master key), hex: identifies a key without revealing it. */
export const computeMasterKeyId = (masterKey: Uint8Array): string =>
  crypto.createHash('sha256').update(masterKey).digest().subarray(0, 8).toString('hex');

/** Builds the AAD that ties a sealed value to `<table>|<column>|<id>|v1`. */
export const secretAad = (table: string, column: string, id: string): string => {
  for (const part of [table, column, id]) {
    if (typeof part !== 'string' || part.length === 0 || part.includes('|')) {
      throw new SecretBoxError('invalid-aad', 'AAD components must be non-empty and must not contain "|".');
    }
  }
  return `${table}|${column}|${id}|v1`;
};

export type SecretBox = {
  /** Identifier of the master key this box was built from. */
  readonly keyId: string;
  seal(plaintext: string | Uint8Array, aad: string): Buffer;
  open(blob: Uint8Array, aad: string): Buffer;
};

/** Creates a box bound to one 32-byte master key. */
export const createSecretBox = (masterKey: Uint8Array): SecretBox => {
  if (!(masterKey instanceof Uint8Array) || masterKey.length !== KEY_BYTES) {
    throw new Error(`Master key must be ${KEY_BYTES} bytes.`);
  }
  const key = Buffer.from(masterKey);
  const keyId = computeMasterKeyId(key);

  return {
    keyId,

    seal(plaintext, aad) {
      const nonce = crypto.randomBytes(NONCE_BYTES);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
      cipher.setAAD(Buffer.from(aad, 'utf8'));
      const body = Buffer.concat([cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext), cipher.final()]);
      return Buffer.concat([Buffer.from([BLOB_VERSION]), nonce, body, cipher.getAuthTag()]);
    },

    open(blob, aad) {
      if (!(blob instanceof Uint8Array) || blob.length < MIN_BLOB_BYTES) {
        throw new SecretBoxError('invalid-blob', 'Sealed value is too short.');
      }
      if (blob[0] !== BLOB_VERSION) {
        throw new SecretBoxError('unsupported-version', `Unsupported sealed value version ${blob[0]}.`);
      }
      const buffer = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
      const nonce = buffer.subarray(1, 1 + NONCE_BYTES);
      const tag = buffer.subarray(buffer.length - TAG_BYTES);
      const body = buffer.subarray(1 + NONCE_BYTES, buffer.length - TAG_BYTES);
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
        decipher.setAAD(Buffer.from(aad, 'utf8'));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(body), decipher.final()]);
      } catch {
        throw new SecretBoxError('decrypt-failed', 'Sealed value could not be authenticated (wrong key, context, or corrupted data).');
      }
    },
  };
};

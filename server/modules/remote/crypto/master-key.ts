/**
 * Master key resolution for Remote's at-rest encryption (contracts section 8).
 *
 * Source order: `CLOUDCLI_REMOTE_MASTER_KEY` (base64, 32 bytes) wins over the key file. The id of
 * the active key is recorded as `remote.master_key_id`. Once any sealed value exists, a key whose
 * id does not match is a hard error: a new key is never generated while sealed data remains,
 * because that data would become unreadable without anyone noticing.
 *
 * Assumes one server process per database and key file: the id check and the id write are not a
 * single transaction, so two processes sealing concurrently could record the wrong id.
 */

import crypto from 'node:crypto';
import nodeFs from 'node:fs';
import path from 'node:path';

import { getConnection } from '@/modules/database/index.js';

import { SecretBoxError, computeMasterKeyId } from './secret-box.js';

export const MASTER_KEY_ENV = 'CLOUDCLI_REMOTE_MASTER_KEY';

const KEY_BYTES = 32;
const KEY_ID_CONFIG_KEY = 'remote.master_key_id';
const RELAY_SECRET_CONFIG_KEY = 'remote.relay_secret_sealed';

/** What master-key resolution needs to know about persisted state. Every method may throw. */
export type MasterKeyStore = {
  readKeyId(): string | null;
  writeKeyId(keyId: string): void;
  /** True when any pairing key, pending-destroy record or relay secret is currently sealed. */
  hasSealedData(): boolean;
};

export type ResolvedMasterKey = {
  key: Buffer;
  keyId: string;
  source: 'env' | 'file';
  /** True only when this call generated and wrote a new key file. */
  created: boolean;
};

type DbStatement = { get(...params: unknown[]): unknown; run(...params: unknown[]): unknown };
type DbLike = { prepare(sql: string): DbStatement };

/**
 * Store backed by `app_config` and `remote_pairings`. Unlike `appConfigDb.get`, reads here let
 * database errors escape: "no row" and "database unavailable" must never look the same when the
 * answer decides whether a key may be created.
 */
export const createAppConfigMasterKeyStore = (getDb: () => DbLike = getConnection as () => DbLike): MasterKeyStore => ({
  readKeyId() {
    const row = getDb().prepare('SELECT value FROM app_config WHERE key = ?').get(KEY_ID_CONFIG_KEY) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  },

  writeKeyId(keyId) {
    getDb()
      .prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(KEY_ID_CONFIG_KEY, keyId);
  },

  hasSealedData() {
    const db = getDb();
    const relaySecret = db.prepare('SELECT 1 AS present FROM app_config WHERE key = ? AND value != ?').get(RELAY_SECRET_CONFIG_KEY, '');
    if (relaySecret) return true;
    const table = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'remote_pairings'").get();
    if (!table) return false;
    return Boolean(
      db.prepare('SELECT 1 AS present FROM remote_pairings WHERE k_sealed IS NOT NULL OR pending_destroy_sealed IS NOT NULL LIMIT 1').get(),
    );
  },
});

const invalidKey = (where: string): SecretBoxError =>
  new SecretBoxError('MASTER_KEY_INVALID', `${where} must contain a base64-encoded 32-byte key.`);

const mismatch = (reason: string): SecretBoxError =>
  new SecretBoxError(
    'MASTER_KEY_MISMATCH',
    `${reason} Remote stays disabled; restore the original master key or re-pair every device.`,
  );

/** Strict canonical base64 decode; rejects anything that is not exactly a 32-byte key. */
const decodeKey = (text: string, where: string): Buffer => {
  const trimmed = text.trim();
  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.length !== KEY_BYTES || decoded.toString('base64') !== trimmed) throw invalidKey(where);
  return decoded;
};

const readKeyFile = (fs: typeof nodeFs, keyFilePath: string): Buffer | null => {
  let content: string;
  try {
    content = fs.readFileSync(keyFilePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return decodeKey(content, 'The master key file');
};

/** Writes `content` to a new file (fails if it exists) and fsyncs before returning. */
const writeNewFileDurably = (fs: typeof nodeFs, filePath: string, content: string): void => {
  const fd = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
};

// link(2) failures that mean "this file system cannot hard-link", not "the target exists".
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV']);

/**
 * Creates the key file without ever exposing a partial file: the key is written and fsynced to a
 * private temp file, then hard-linked into place (link fails if the target exists, so an existing
 * key is never overwritten). On a lost race the winner's key is adopted. File systems without
 * hard links fall back to an exclusive direct write.
 */
const createKeyFile = (fs: typeof nodeFs, keyFilePath: string): { key: Buffer; created: boolean } => {
  fs.mkdirSync(path.dirname(keyFilePath), { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(KEY_BYTES);
  const content = `${key.toString('base64')}
`;
  const tempPath = `${keyFilePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    writeNewFileDurably(fs, tempPath, content);
    try {
      fs.linkSync(tempPath, keyFilePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!LINK_UNSUPPORTED.has(code)) throw error;
      writeNewFileDurably(fs, keyFilePath, content);
    }
    return { key, created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = readKeyFile(fs, keyFilePath);
    if (!existing) throw error;
    return { key: existing, created: false };
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
};

export type ResolveMasterKeyOptions = {
  env?: NodeJS.ProcessEnv;
  keyFilePath: string;
  store: MasterKeyStore;
  fs?: typeof nodeFs;
  /**
   * Remove the env key from `env` once read, so child processes (terminal PTYs inherit
   * `process.env`) never see it. The caller must then keep the returned key for the lifetime of
   * the process: a second resolve would no longer find it.
   */
  scrubEnv?: boolean;
};

/** Resolves the active master key and verifies it against the recorded id (see module comment). */
export const resolveMasterKey = ({ env = process.env, keyFilePath, store, fs = nodeFs, scrubEnv = false }: ResolveMasterKeyOptions): ResolvedMasterKey => {
  const envValue = env[MASTER_KEY_ENV];
  let key: Buffer | null = null;
  let source: 'env' | 'file' = 'env';
  let created = false;

  // A variable that is set but blank is a misconfiguration, not "unset": falling back to a key
  // file (or generating one) behind the operator's back could orphan sealed data.
  if (envValue !== undefined) {
    // Scrub first: a malformed value (a quoted key, a typo) is still a secret that must not reach the PTYs.
    if (scrubEnv) delete env[MASTER_KEY_ENV];
    key = decodeKey(envValue, MASTER_KEY_ENV);
  } else {
    source = 'file';
    key = readKeyFile(fs, keyFilePath);
  }

  const storedKeyId = store.readKeyId();
  const sealed = store.hasSealedData();

  if (!key) {
    if (sealed) throw mismatch('Sealed Remote data exists but no master key is available (key file missing and no environment key).');
    ({ key, created } = createKeyFile(fs, keyFilePath));
  }

  const keyId = computeMasterKeyId(key);
  if (sealed) {
    if (storedKeyId === null) throw mismatch('Sealed Remote data exists but its master key id was never recorded.');
    if (storedKeyId !== keyId) throw mismatch('The master key changed since Remote data was sealed.');
  } else if (storedKeyId !== keyId) {
    store.writeKeyId(keyId);
  }
  return { key, keyId, source, created };
};

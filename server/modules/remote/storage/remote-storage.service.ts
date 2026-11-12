/**
 * Remote storage wiring: master key, relay settings and the pairing store.
 *
 * `initializeRemoteStorage` is called once at server start. It resolves the master key (fail
 * closed: `MASTER_KEY_MISMATCH` when sealed data exists but the key changed or vanished), removes
 * the key from `process.env` (terminal PTYs inherit it), builds the secret box and keeps the only
 * copy of the key inside that box. Relay settings go through the throwing `remoteConfigDb`, so a
 * broken database is never mistaken for "not configured".
 */

import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { remoteConfigDb } from '@/modules/database/index.js';
import type { RemotePairingStore } from '@/shared/types.js';

import { LEGACY_MASTER_KEY_ENV, MASTER_KEY_ENV, createAppConfigMasterKeyStore, resolveMasterKey } from '../crypto/master-key.js';
import { createSecretBox, secretAad, type SecretBox } from '../crypto/secret-box.js';
import { createPairingStore } from '../pairing/pairing-store.service.js';

const RELAY_URL_KEY = 'remote.relay_url';
const RELAY_SECRET_KEY = 'remote.relay_secret_sealed';
const MAX_RELAY_SECRET_LENGTH = 1024;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export const MASTER_KEY_FILE_ENV = 'REMOTECLI_MASTER_KEY_FILE';
export const LEGACY_MASTER_KEY_FILE_ENV = 'CLOUDCLI_REMOTE_MASTER_KEY_FILE';

export type RemoteConfigErrorCode = 'INVALID_RELAY_URL' | 'INVALID_RELAY_SECRET';

/** Rejected relay setting; `code` is stable for the management API (phase 08) to map to a 400. */
export class RemoteConfigError extends Error {
  readonly code: RemoteConfigErrorCode;

  constructor(code: RemoteConfigErrorCode, message: string) {
    super(message);
    this.name = 'RemoteConfigError';
    this.code = code;
  }
}

/** Relay secret blobs are bound to their config key, so they cannot be moved to another setting. */
const relaySecretAad = (): string => secretAad('app_config', 'value', RELAY_SECRET_KEY);

/**
 * Reduces a relay URL to `wss://host[:port]` (or `ws://` for loopback development relays): the
 * path is fixed (`/ws`) and credentials, queries and fragments have no place in it.
 */
const normalizeRelayUrl = (input: string): string => {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new RemoteConfigError('INVALID_RELAY_URL', 'Invalid relay URL.');
  }
  const loopbackWs = url.protocol === 'ws:' && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'wss:' && !loopbackWs) {
    throw new RemoteConfigError('INVALID_RELAY_URL', 'Invalid relay URL: use wss:// (ws:// only for localhost).');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new RemoteConfigError('INVALID_RELAY_URL', 'Invalid relay URL: no credentials, query or fragment allowed.');
  }
  return `${url.protocol}//${url.host}`;
};

/**
 * Relay URL and `RELAY_SECRET` settings. Consumed by: the management API and the relay link
 * (phases 06/08).
 */
export const createRemoteConfigService = ({ box }: { box: SecretBox }) => ({
  getRelayUrl(): string | null {
    return remoteConfigDb.get(RELAY_URL_KEY);
  },

  /** What `setRelayUrl` would save for `input`, or throws `RemoteConfigError`; saves nothing. */
  normalizeRelayUrl(input: string): string {
    return normalizeRelayUrl(input);
  },

  setRelayUrl(input: string): void {
    remoteConfigDb.set(RELAY_URL_KEY, normalizeRelayUrl(input));
  },

  hasRelaySecret(): boolean {
    const stored = remoteConfigDb.get(RELAY_SECRET_KEY);
    return stored !== null && stored !== '';
  },

  /** Decrypts the relay secret; null when none is set, throws when the blob cannot be opened. */
  getRelaySecret(): string | null {
    const stored = remoteConfigDb.get(RELAY_SECRET_KEY);
    if (!stored) return null;
    return box.open(Buffer.from(stored, 'base64'), relaySecretAad()).toString('utf8');
  },

  setRelaySecret(secret: string): void {
    if (typeof secret !== 'string' || secret.length === 0 || secret.length > MAX_RELAY_SECRET_LENGTH) {
      throw new RemoteConfigError('INVALID_RELAY_SECRET', `The relay secret must be 1-${MAX_RELAY_SECRET_LENGTH} characters.`);
    }
    remoteConfigDb.set(RELAY_SECRET_KEY, box.seal(secret, relaySecretAad()).toString('base64'));
  },

  clearRelaySecret(): void {
    remoteConfigDb.delete(RELAY_SECRET_KEY);
  },
});

type RemoteStorageOptions = {
  /** Environment to read the master key from (and scrub); defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Master key file used when the env variable is absent; defaults to `~/.remotecli/remote-master.key`. */
  keyFilePath?: string;
  /** Time source of the pairing records (default: the system clock). Idle expiry compares them with the runtime clock, so both must agree. */
  now?: () => number;
};

const defaultKeyFilePath = (env: NodeJS.ProcessEnv): string =>
  env[MASTER_KEY_FILE_ENV] ||
  env[LEGACY_MASTER_KEY_FILE_ENV] ||
  path.join(
    env.REMOTECLI_CONFIG_DIR || env.CLOUDCLI_CONFIG_DIR || path.join(os.homedir(), '.remotecli'),
    'remote-master.key',
  );

/**
 * True when Remote has been used before or is configured to be: the master key is in the environment, its
 * file exists, or a relay URL / sealed data (relay secret, pairing key, pending DESTROY) is already saved.
 * Only then does the server open the storage when it starts; otherwise nothing is created until Remote is
 * first used, so a Local-only user gets no key file and no `remote.*` rows. When the database cannot be read
 * the answer is "yes", so the usual start-up path reports the problem instead of hiding it.
 * Consumed by: the Remote module's `start()`.
 */
export const shouldOpenRemoteStorageAtStart = ({ env = process.env, keyFilePath }: RemoteStorageOptions = {}): boolean => {
  if (env[MASTER_KEY_ENV] !== undefined || env[LEGACY_MASTER_KEY_ENV] !== undefined) return true;
  if (existsSync(keyFilePath ?? defaultKeyFilePath(env))) return true;
  try {
    return remoteConfigDb.get(RELAY_URL_KEY) !== null || createAppConfigMasterKeyStore().hasSealedData();
  } catch {
    return true;
  }
};

/**
 * True when BOTH a relay URL and a relay secret are saved (the rows only: the secret is not opened, so no master
 * key is needed to ask). This is the question "can anything that needs a relay work yet?", which is different
 * from `shouldOpenRemoteStorageAtStart` ("has Remote been used before?"). A database that cannot be read throws:
 * it must never read as "not configured" nor lead to a key being created.
 * Consumed by: the Remote module (dormant management).
 */
export const isRelayConfigured = (): boolean => {
  const url = remoteConfigDb.get(RELAY_URL_KEY);
  if (url === null || url === '') return false;
  const secret = remoteConfigDb.get(RELAY_SECRET_KEY);
  return secret !== null && secret !== '';
};

/**
 * Resolves the master key once and returns the services built on it. Throws `SecretBoxError`
 * (`MASTER_KEY_MISMATCH` / `MASTER_KEY_INVALID`) when Remote must stay disabled.
 * Consumed by: server start-up (phase 08).
 */
export const initializeRemoteStorage = ({ env = process.env, keyFilePath, now }: RemoteStorageOptions = {}) => {
  const resolved = resolveMasterKey({
    env,
    keyFilePath: keyFilePath ?? defaultKeyFilePath(env),
    store: createAppConfigMasterKeyStore(),
    scrubEnv: true,
  });
  const box = createSecretBox(resolved.key);
  resolved.key.fill(0); // the box holds its own copy; nothing else keeps the key around

  return {
    keyId: resolved.keyId,
    keySource: resolved.source,
    keyCreated: resolved.created,
    config: createRemoteConfigService({ box }),
    pairings: createPairingStore({ box, now }) satisfies RemotePairingStore,
  };
};

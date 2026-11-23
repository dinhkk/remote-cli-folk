import os from 'node:os';
import path from 'node:path';

import { getConnection, type Database } from '../../database/index.js';
import { resolveMasterKey, createAppConfigMasterKeyStore } from '../crypto/master-key.js';
import { createSecretBox, type SecretBox } from '../crypto/secret-box.js';

type MasterSecret = { box: SecretBox; keyId: string; source: 'env' | 'file'; created: boolean };
const cached = new WeakMap<Database, MasterSecret>();

/** Share the existing master key across Remote and MFA, including Local-only installations. */
export function getMasterSecret(options: { env?: NodeJS.ProcessEnv; keyFilePath?: string } = {}): MasterSecret {
  const db = getConnection();
  const env = options.env ?? process.env;
  const useCache = env === process.env && options.keyFilePath === undefined;
  const existing = useCache ? cached.get(db) : undefined;
  if (existing) return existing;
  const remoteStore = createAppConfigMasterKeyStore(() => db);
  const resolved = resolveMasterKey({ env, scrubEnv: true,
    keyFilePath: options.keyFilePath || env.REMOTECLI_MASTER_KEY_FILE || env.CLOUDCLI_REMOTE_MASTER_KEY_FILE
      || path.join(env.REMOTECLI_CONFIG_DIR || env.CLOUDCLI_CONFIG_DIR || path.join(os.homedir(), '.remotecli'), 'remote-master.key'),
    store: { ...remoteStore, hasSealedData: () => {
      if (remoteStore.hasSealedData()) return true;
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='auth_totp'").get()) return false;
      return Boolean(db.prepare('SELECT 1 FROM auth_totp WHERE seed_sealed IS NOT NULL OR pending_sealed IS NOT NULL LIMIT 1').get());
    } },
  });
  const result = { box: createSecretBox(resolved.key), keyId: resolved.keyId, source: resolved.source, created: resolved.created };
  resolved.key.fill(0);
  if (useCache) cached.set(db, result);
  return result;
}

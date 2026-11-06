/**
 * Remote config repository.
 *
 * Reads and writes the `remote.*` keys of `app_config`. Unlike `appConfigDb.get`, which turns any
 * failure into "not set", every method here lets database errors escape: for relay settings and
 * sealed secrets, "unset" and "database unavailable" must never look the same. Only keys that
 * start with `remote.` are accepted so this cannot be used to touch other settings.
 * Consumed by: the Remote module's configuration service.
 */

import { getConnection } from '@/modules/database/connection.js';

const REMOTE_KEY_PREFIX = 'remote.';

const assertRemoteKey = (key: string): void => {
  if (typeof key !== 'string' || !key.startsWith(REMOTE_KEY_PREFIX) || key.length === REMOTE_KEY_PREFIX.length) {
    throw new Error(`Remote config keys must start with "${REMOTE_KEY_PREFIX}".`);
  }
};

export const remoteConfigDb = {
  /** Returns the stored value, or null when the key has no row. Throws on any database error. */
  get(key: string): string | null {
    assertRemoteKey(key);
    const row = getConnection().prepare('SELECT value FROM app_config WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  },

  set(key: string, value: string): void {
    assertRemoteKey(key);
    getConnection()
      .prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  },

  delete(key: string): void {
    assertRemoteKey(key);
    getConnection().prepare('DELETE FROM app_config WHERE key = ?').run(key);
  },
};

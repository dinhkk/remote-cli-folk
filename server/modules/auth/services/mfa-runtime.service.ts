import { getConnection, type Database } from '../../database/index.js';
import { AppError } from '../../../shared/utils.js';
import { getMasterSecret } from '../../remote/index.js';

import { createTotpStore, migrateTotp, MFA_FRESH_MS } from './totp-store.service.js';
import { getSessionRuntime } from './session-runtime.service.js';
import type { AuthSession } from './session-store.service.js';

const stores = new WeakMap<Database, ReturnType<typeof createTotpStore>>();
export function getMfaStore() {
  const db = getConnection();
  let store = stores.get(db);
  if (!store) {
    getSessionRuntime();
    migrateTotp(db);
    store = createTotpStore(db, () => getMasterSecret().box);
    stores.set(db, store);
  }
  return store;
}

export function requireRecentMfa(userId: number, session?: AuthSession, now = Date.now()) {
  if (!getMfaStore().enabled(userId)) return;
  const at = session && getSessionRuntime().store.getActive(session.id)?.mfaVerifiedAt;
  if (at == null || at <= 0 || at > now || now - at >= MFA_FRESH_MS) {
    throw new AppError('Enter an authenticator code to continue', { code: 'MFA_REAUTH_REQUIRED', statusCode: 403 });
  }
}

/** Called after database initialization; no network or Remote runtime is needed. */
export function initializeMfa() {
  getMfaStore();
  if (getConnection().prepare('SELECT 1 FROM auth_totp WHERE seed_sealed IS NOT NULL OR pending_sealed IS NOT NULL LIMIT 1').get()) getMasterSecret();
}

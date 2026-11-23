import type { Database } from '../../database/index.js';

/** Platform's implicit owner login cannot satisfy an enabled second factor. */
export function assertAuthModeCompatible(db: Database, isPlatform: boolean): void {
  if (!isPlatform) return;
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'auth_totp'").get();
  if (!exists) return;
  // Kept compatible with an additive TOTP migration. Unknown populated schemas fail closed.
  const columns = db.prepare<{ name: string }>('PRAGMA table_info(auth_totp)').all();
  const enabled = columns.some((column) => column.name === 'enabled')
    ? db.prepare('SELECT 1 FROM auth_totp WHERE enabled <> 0 LIMIT 1').get()
    : db.prepare('SELECT 1 FROM auth_totp LIMIT 1').get();
  if (enabled) throw new Error('Platform authentication cannot be used while TOTP is enabled.');
}

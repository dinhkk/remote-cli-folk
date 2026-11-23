import { Database } from '../../database/index.js';

/** Local administrative command only. Never mounted in an HTTP router. */
export function resetTotp(databasePath: string): void {
  const db = new Database(databasePath, { fileMustExist: true });
  try {
    db.transaction(() => {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='auth_totp'").get()) {
        db.prepare(`UPDATE auth_totp SET enabled=0, seed_sealed=NULL, pending_sealed=NULL, pending_expires_at=NULL,
          pending_session_id=NULL, last_used_step=-1, generation=generation+1`).run();
        db.prepare('DELETE FROM auth_recovery_codes').run();
        db.prepare('DELETE FROM auth_throttle').run();
      }
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='auth_sessions'").get()) {
        db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE revoked_at IS NULL').run(Date.now());
      }
    })();
  } finally { db.close(); }
}

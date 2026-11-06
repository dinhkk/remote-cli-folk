/**
 * Remote pairings repository.
 *
 * Plain row access to `remote_pairings` (contracts section 8). It never encrypts or decrypts:
 * `k_sealed` and `pending_destroy_sealed` are opaque blobs sealed by the Remote pairing store, and
 * errors are never swallowed. Consumed by: the Remote module's pairing store.
 */

import { getConnection } from '@/modules/database/connection.js';
import type { RemotePairingRole, RemotePairingRow } from '@/shared/types.js';

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const remotePairingsDb = {
  /** Inserts a new row; throws if the id exists or the role is not host/controller. */
  insert(row: RemotePairingRow): void {
    getConnection()
      .prepare(
        `INSERT INTO remote_pairings
           (id, role, peer_name, alias, k_sealed, pending_destroy_sealed, room_id, relay_url,
            created_at, last_connected_at, last_activity_at, revoked_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.role,
        row.peer_name,
        row.alias,
        row.k_sealed,
        row.pending_destroy_sealed,
        row.room_id,
        row.relay_url,
        row.created_at,
        row.last_connected_at,
        row.last_activity_at,
        row.revoked_at,
        row.expires_at,
      );
  },

  getById(id: string): RemotePairingRow | null {
    const row = getConnection().prepare('SELECT * FROM remote_pairings WHERE id = ?').get(id) as RemotePairingRow | undefined;
    return row ?? null;
  },

  /** Rows newest first (ties broken by insertion order), optionally only one role. */
  list(role?: RemotePairingRole): RemotePairingRow[] {
    const order = 'ORDER BY created_at DESC, rowid DESC';
    const db = getConnection();
    return (
      role
        ? db.prepare(`SELECT * FROM remote_pairings WHERE role = ? ${order}`).all(role)
        : db.prepare(`SELECT * FROM remote_pairings ${order}`).all()
    ) as RemotePairingRow[];
  },

  /** Rows of `role` that are not revoked. */
  countActive(role: RemotePairingRole): number {
    const row = getConnection()
      .prepare('SELECT COUNT(*) AS total FROM remote_pairings WHERE role = ? AND revoked_at IS NULL')
      .get(role) as { total: number };
    return row.total;
  },

  /**
   * Marks a pairing revoked, erases `k_sealed` and stores the sealed pending-destroy blob in one
   * statement. Returns false when the row is missing or already revoked (nothing changes then).
   */
  revoke(id: string, revokedAt: number, pendingDestroySealed: Buffer | null): boolean {
    const result = getConnection()
      .prepare(
        `UPDATE remote_pairings
            SET revoked_at = ?, k_sealed = NULL, pending_destroy_sealed = ?
          WHERE id = ? AND revoked_at IS NULL`,
      )
      .run(revokedAt, pendingDestroySealed, id);
    return result.changes > 0;
  },

  /** Rows that still owe the relay a DESTROY. */
  listPendingDestroy(): RemotePairingRow[] {
    return getConnection()
      .prepare('SELECT * FROM remote_pairings WHERE pending_destroy_sealed IS NOT NULL ORDER BY created_at, rowid')
      .all() as RemotePairingRow[];
  },

  clearPendingDestroy(id: string): void {
    getConnection().prepare('UPDATE remote_pairings SET pending_destroy_sealed = NULL WHERE id = ?').run(id);
  },

  /** Records a successful link connection; it also counts as activity unless `renewActivity` is false. */
  markConnected(id: string, at: number, renewActivity = true): void {
    if (renewActivity) {
      getConnection().prepare('UPDATE remote_pairings SET last_connected_at = ?, last_activity_at = ? WHERE id = ?').run(at, at, id);
    } else {
      getConnection().prepare('UPDATE remote_pairings SET last_connected_at = ? WHERE id = ?').run(at, id);
    }
  },

  touchActivity(id: string, at: number): void {
    getConnection().prepare('UPDATE remote_pairings SET last_activity_at = ? WHERE id = ?').run(at, id);
  },

  /**
   * Idle expiry: stamps `expires_at` and erases `k_sealed` in one statement (a Host pairing's revoke
   * stays separate, see the store). Returns false when the row is missing.
   */
  markExpired(id: string, at: number): boolean {
    return (
      getConnection()
        .prepare('UPDATE remote_pairings SET expires_at = MIN(COALESCE(expires_at, ?), ?), k_sealed = NULL WHERE id = ?')
        .run(at, at, id).changes > 0
    );
  },

  delete(id: string): void {
    getConnection().prepare('DELETE FROM remote_pairings WHERE id = ?').run(id);
  },

  /** Sets (or, with null, clears) the local alias. Returns false when the row is missing. */
  setAlias(id: string, alias: string | null): boolean {
    return getConnection().prepare('UPDATE remote_pairings SET alias = ? WHERE id = ?').run(alias, id).changes > 0;
  },
};

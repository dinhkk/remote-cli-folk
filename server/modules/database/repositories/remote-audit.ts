/**
 * Remote audit repository (FR-42): plain row access to `remote_audit`. It stores whatever the Remote
 * audit service hands it (already sanitised) and never interprets it. Errors are not swallowed here:
 * the audit service decides that a failed write must not fail the request being audited.
 * Consumed by: the Remote module's audit service.
 */

import { getConnection } from '@/modules/database/connection.js';
import type { RemoteAuditRow } from '@/shared/types.js';

export type RemoteAuditInsert = Omit<RemoteAuditRow, 'id'>;

export const remoteAuditDb = {
  insert(row: RemoteAuditInsert): void {
    getConnection()
      .prepare('INSERT INTO remote_audit (at, pairing_id, controller, event, target, result, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(row.at, row.pairing_id, row.controller, row.event, row.target, row.result, row.detail);
  },

  /** Newest first; `before` is an exclusive id cursor, `pairingId` filters one Controller. */
  list(options: { limit: number; before?: number; pairingId?: string }): RemoteAuditRow[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.before !== undefined) {
      clauses.push('id < ?');
      params.push(options.before);
    }
    if (options.pairingId !== undefined) {
      clauses.push('pairing_id = ?');
      params.push(options.pairingId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return getConnection()
      .prepare(`SELECT * FROM remote_audit ${where} ORDER BY id DESC LIMIT ?`)
      .all(...params, options.limit) as RemoteAuditRow[];
  },

  /** One row per Controller present in the audit (latest label wins). */
  listControllers(): Array<{ pairing_id: string; controller: string }> {
    return getConnection()
      .prepare(
        `SELECT pairing_id, controller FROM remote_audit
          WHERE pairing_id IS NOT NULL AND id IN (SELECT MAX(id) FROM remote_audit WHERE pairing_id IS NOT NULL GROUP BY pairing_id)
          ORDER BY controller, pairing_id`,
      )
      .all() as Array<{ pairing_id: string; controller: string }>;
  },

  /** Deletes rows older than `cutoffMs`; returns how many went. */
  purgeBefore(cutoffMs: number): number {
    return getConnection().prepare('DELETE FROM remote_audit WHERE at < ?').run(cutoffMs).changes;
  },

  /** Keeps at most the newest `maxRows` rows (ids grow with time); returns how many went. A hard bound on disk use. */
  trimToNewest(maxRows: number): number {
    return getConnection()
      .prepare('DELETE FROM remote_audit WHERE id <= (SELECT MAX(id) FROM remote_audit) - ?')
      .run(maxRows).changes;
  },
};

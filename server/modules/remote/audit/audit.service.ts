/**
 * Host audit service (FR-42, AC-32): `record` turns an event into one sanitised `remote_audit` row,
 * `list` pages them for the read-only UI, a periodic `purge` removes rows past the retention (30 days).
 *
 * A failed write NEVER fails or slows the request being audited: `record` swallows every error (and tells
 * `onWriteError`, a diagnostics hook that gets an error name only). Nothing here logs the content of a row.
 *
 * The table lives in the same SQLite file as everything else, so a Controller that owns the Terminal of
 * this Host can edit it: the audit is best-effort evidence, not a tamper-proof log (documented).
 */

import type {
  RemoteAuditEntry,
  RemoteAuditEvent,
  RemoteAuditPage,
  RemoteAuditQuery,
  RemoteAuditRecorder,
  RemoteAuditRow,
  RemoteAuditSubject,
  RemoteClock,
} from '@/shared/types.js';

import { sanitizeAuditDetail, sanitizeAuditText } from './audit-sanitizer.js';

export const DEFAULT_AUDIT_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
const PURGE_INTERVAL_MS = 3_600_000;
export const MAX_AUDIT_PAGE = 200;
export const DEFAULT_AUDIT_PAGE = 50;
const LABEL_MAX = 64;

/** The slice of the audit repository the service uses (the real one is `remoteAuditDb`). */
export type AuditRepository = {
  insert(row: Omit<RemoteAuditRow, 'id'>): void;
  list(options: { limit: number; before?: number; pairingId?: string }): RemoteAuditRow[];
  listControllers(): Array<{ pairing_id: string; controller: string }>;
  purgeBefore(cutoffMs: number): number;
  /** Keeps only the newest rows (a hard size bound next to the 30-day retention). */
  trimToNewest?(maxRows: number): number;
};

/** Upper bound of stored rows (about 30 MB), enforced at every purge (hourly) on top of the age limit. */
export const MAX_AUDIT_ROWS = 100_000;
const DEFAULT_TRIM_EVERY = 1_000;

export type AuditServiceOptions = {
  repository: AuditRepository;
  clock: RemoteClock;
  /** Days an entry is kept (default 30); 0 or less keeps nothing past the next purge, so use a positive number. */
  retentionDays?: number;
  /** Most rows kept (default 100000); older ones go at the next purge and, between purges, after every `trimEvery` inserts. */
  maxRows?: number;
  /** Inserts between two size trims (default 1000): the table stays within `maxRows` + this under a flood, without counting rows on each insert. */
  trimEvery?: number;
  /** A write or purge failed (error name only, never row content). */
  onWriteError?: (errorName: string) => void;
};

const parseDetail = (text: string): RemoteAuditEntry['detail'] => {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as RemoteAuditEntry['detail']) : {};
  } catch {
    return {};
  }
};

const toEntry = (row: RemoteAuditRow): RemoteAuditEntry => ({
  id: row.id,
  at: row.at,
  pairingId: row.pairing_id,
  controller: row.controller,
  event: row.event,
  target: row.target,
  result: row.result,
  detail: parseDetail(row.detail),
});

/** Clamps a requested page size to 1..200 (default 50). */
export const clampAuditLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_AUDIT_PAGE;
  return Math.min(MAX_AUDIT_PAGE, Math.max(1, Math.trunc(limit)));
};

/**
 * Creates the audit service.
 * Consumed by: the Remote runtime (Host accept, bridges, pairing expiry) and the management API.
 */
export function createAuditService(options: AuditServiceOptions) {
  const { repository, clock } = options;
  const retentionMs = Math.max(1, options.retentionDays ?? DEFAULT_AUDIT_RETENTION_DAYS) * DAY_MS;
  let cancelPurge: (() => void) | undefined;
  let insertsSinceTrim = 0;
  const trimEvery = Math.max(1, options.trimEvery ?? DEFAULT_TRIM_EVERY);

  const reportError = (error: unknown): void => {
    try {
      options.onWriteError?.(error instanceof Error ? error.name : 'Error');
    } catch {
      // diagnostics must not throw either
    }
  };

  const purge = (): number => {
    try {
      const expired = repository.purgeBefore(clock.now() - retentionMs);
      return expired + (repository.trimToNewest?.(options.maxRows ?? MAX_AUDIT_ROWS) ?? 0);
    } catch (error) {
      reportError(error);
      return 0;
    }
  };

  const schedulePurge = (): void => {
    cancelPurge = clock.setTimer(() => {
      purge();
      schedulePurge();
    }, PURGE_INTERVAL_MS);
  };

  const recorder: RemoteAuditRecorder = {
    record(subject: RemoteAuditSubject, event: RemoteAuditEvent): void {
      try {
        repository.insert({
          at: clock.now(),
          pairing_id: subject.pairingId === null ? null : sanitizeAuditText(subject.pairingId, LABEL_MAX),
          controller: sanitizeAuditText(subject.label, LABEL_MAX),
          event: event.event,
          target: sanitizeAuditText(event.target),
          result: event.result,
          detail: JSON.stringify(sanitizeAuditDetail(event.detail)),
        });
        // A flood (quota refusals, writes) must not push the table far past its cap until the hourly purge.
        insertsSinceTrim += 1;
        if (insertsSinceTrim >= trimEvery) {
          insertsSinceTrim = 0;
          repository.trimToNewest?.(options.maxRows ?? MAX_AUDIT_ROWS);
        }
      } catch (error) {
        reportError(error);
      }
    },
  };

  return {
    ...recorder,
    purge,

    /** Newest first; `nextBefore` is the id to pass for the next page (null at the end). */
    list(query: Partial<RemoteAuditQuery> = {}): RemoteAuditPage {
      const limit = clampAuditLimit(query.limit);
      // One extra row tells whether another page exists.
      const rows = repository.list({ limit: limit + 1, before: query.before, pairingId: query.controller });
      const page = rows.slice(0, limit);
      return {
        entries: page.map(toEntry),
        nextBefore: rows.length > limit ? page[page.length - 1].id : null,
        controllers: repository.listControllers().map((row) => ({ pairingId: row.pairing_id, label: row.controller })),
      };
    },

    /** Purges once now (rows left from a stopped server) and then every hour. */
    start(): void {
      if (cancelPurge) return;
      purge();
      schedulePurge();
    },

    stop(): void {
      cancelPurge?.();
      cancelPurge = undefined;
    },
  };
}

export type AuditService = ReturnType<typeof createAuditService>;

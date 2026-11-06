import { useCallback, useEffect, useRef, useState } from 'react';

import { useRemoteApi } from '@/modules/remote/hooks/useRemoteApi';
import type { RemoteApiResult, RemoteAuditController, RemoteAuditEntry } from '@/shared/types';

/** Rows per page the owner can choose. The log is never listed in full, however long it is. */
export const AUDIT_PAGE_SIZES = [5, 10, 15] as const;
export type AuditPageSize = (typeof AUDIT_PAGE_SIZES)[number];
export const DEFAULT_AUDIT_PAGE_SIZE: AuditPageSize = 10;

const UNSUPPORTED_MODE = 'REMOTE_UNSUPPORTED_MODE';

/** `loading` first read or refresh in flight; `ready` last read worked; `failed` last read failed; `hidden` the server has no Host audit to show. */
export type AuditPhase = 'loading' | 'ready' | 'failed' | 'hidden';

/** A server without the Remote module (404) or in a mode that cannot host (409) has no audit to show. */
const hasNoAudit = (result: RemoteApiResult<unknown>): boolean =>
  !result.ok && (result.status === 404 || result.code === UNSUPPORTED_MODE);

/** Keeps every Controller seen so far so the filter does not lose options while a filter is applied. */
const mergeControllers = (known: RemoteAuditController[], seen: RemoteAuditController[]): RemoteAuditController[] => {
  const byId = new Map(known.map((controller) => [controller.pairingId, controller]));
  for (const controller of seen) byId.set(controller.pairingId, controller);
  return [...byId.values()];
};

/** One read of the log: which Controller, how many rows, and the `before` cursors that lead to the page. */
type PageRequest = { filter: string; size: AuditPageSize; cursors: number[] };

/**
 * The Host audit log as the panel shows it: ONE page of entries (newest first), the
 * Controller filter, the page size, and the actions that move between pages. The
 * server pages by cursor (`before` = the id to continue after, no page count), so
 * the hook keeps the cursor that opened each page after the first: Previous pops
 * one, Next pushes `nextBefore`. Changing the filter or the page size, and Refresh,
 * start again from the newest page. It reads once on mount and then only on those
 * actions; it never polls. An answer that arrives after a newer read started is
 * ignored. Used by AuditPanel.
 */
export function useAuditFeed() {
  const remote = useRemoteApi();
  const [controllerFilter, setControllerFilter] = useState('');
  const [pageSize, setPageSize] = useState<AuditPageSize>(DEFAULT_AUDIT_PAGE_SIZE);
  // The cursors of the pages after the first one; its length + 1 is the page number shown.
  const [cursors, setCursors] = useState<number[]>([]);
  const [entries, setEntries] = useState<RemoteAuditEntry[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [controllers, setControllers] = useState<RemoteAuditController[]>([]);
  const [phase, setPhase] = useState<AuditPhase>('loading');
  // Counts fresh reads; a read whose number is no longer current has been superseded.
  const latestRead = useRef(0);

  /**
   * Reads one page and, only when that worked, makes it the page shown. `keepShown` is for moving
   * between pages: a failed read then leaves the page already on screen (and its cursors) in place
   * instead of emptying it, so the owner can simply try again.
   */
  const load = useCallback(
    async ({ filter, size, cursors: wanted }: PageRequest, keepShown: boolean) => {
      latestRead.current += 1;
      const read = latestRead.current;
      setPhase('loading');
      const result = await remote.loadAudit({
        limit: size,
        before: wanted[wanted.length - 1],
        controller: filter || undefined,
      });
      if (read !== latestRead.current) return;
      if (result.ok) {
        setEntries(result.data.entries);
        setNextBefore(result.data.nextBefore);
        setCursors(wanted);
        setControllers((known) => mergeControllers(known, result.data.controllers));
        setPhase('ready');
        return;
      }
      if (!keepShown) {
        setEntries([]);
        setNextBefore(null);
        setCursors([]);
      }
      setPhase(hasNoAudit(result) ? 'hidden' : 'failed');
    },
    [remote],
  );

  useEffect(() => {
    void load({ filter: '', size: DEFAULT_AUDIT_PAGE_SIZE, cursors: [] }, false);
    // Whatever is still in flight when the panel closes is ignored.
    return () => {
      latestRead.current += 1;
    };
  }, [load]);

  const changeFilter = (filter: string) => {
    setControllerFilter(filter);
    void load({ filter, size: pageSize, cursors: [] }, false);
  };

  const changePageSize = (size: AuditPageSize) => {
    setPageSize(size);
    void load({ filter: controllerFilter, size, cursors: [] }, false);
  };

  /** Back to the newest page, so a Refresh also shows what happened since the log was opened. */
  const refresh = () => void load({ filter: controllerFilter, size: pageSize, cursors: [] }, false);

  const nextPage = () => {
    if (nextBefore === null || phase === 'loading') return;
    void load({ filter: controllerFilter, size: pageSize, cursors: [...cursors, nextBefore] }, true);
  };

  const previousPage = () => {
    if (cursors.length === 0 || phase === 'loading') return;
    void load({ filter: controllerFilter, size: pageSize, cursors: cursors.slice(0, -1) }, true);
  };

  return {
    controllerFilter,
    pageSize,
    pageNumber: cursors.length + 1,
    entries,
    controllers,
    phase,
    hasPrevious: cursors.length > 0,
    hasNext: nextBefore !== null,
    changeFilter,
    changePageSize,
    refresh,
    nextPage,
    previousPage,
  };
}

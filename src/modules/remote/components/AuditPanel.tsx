import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { AuditEntryRow } from '@/modules/remote/components/AuditEntryRow';
import { AUDIT_PAGE_SIZES, type AuditPageSize, useAuditFeed } from '@/modules/remote/hooks/useAuditFeed';
import { Button } from '@/shared/ui';

/** The page size a `<select>` value stands for, or null for anything that is not one of the offered sizes. */
const toPageSize = (value: string): AuditPageSize | null =>
  AUDIT_PAGE_SIZES.find((size) => String(size) === value) ?? null;

/**
 * The Host's audit log, read-only (best-effort evidence: a Controller owns a
 * terminal on this Host and could alter the audit database). Newest first, one
 * page at a time (5, 10 or 15 rows, never the whole log) with Previous / Next, a
 * Controller filter and Refresh; it reads on open, on a filter, page-size or page
 * change and on request, never on a timer. Shows nothing on a server that has no
 * Host audit. Rendered by RemoteSettingsTab, as its last section.
 */
export function AuditPanel() {
  const { t } = useTranslation('remote');
  const feed = useAuditFeed();
  const filterId = useId();
  const pageSizeId = useId();

  if (feed.phase === 'hidden') return null;

  const isLoading = feed.phase === 'loading';
  // What stands in for the list: a wait, or "nothing recorded"; a failed read has its own alert.
  let emptyMessage = '';
  if (isLoading) emptyMessage = t('audit.loading');
  else if (feed.phase === 'ready') emptyMessage = t('audit.empty');

  return (
    <section className="space-y-3 rounded-xl border border-border bg-card/50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-foreground">{t('audit.title')}</h4>
          <p className="mt-1 text-sm text-muted-foreground">{t('audit.description')}</p>
        </div>
        <Button size="sm" variant="outline" disabled={isLoading} onClick={feed.refresh}>
          {t('audit.refresh')}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-foreground">
        <div className="flex min-w-0 items-center gap-2">
          <label htmlFor={filterId}>{t('audit.filterLabel')}</label>
          <select
            id={filterId}
            value={feed.controllerFilter}
            onChange={(event) => feed.changeFilter(event.target.value)}
            className="min-w-0 rounded-md border border-border bg-background px-2 py-1 text-sm"
          >
            <option value="">{t('audit.filterAll')}</option>
            {feed.controllers.map((controller) => (
              <option key={controller.pairingId} value={controller.pairingId}>
                {t('audit.filterOption', { label: controller.label })}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor={pageSizeId}>{t('audit.pageSizeLabel')}</label>
          <select
            id={pageSizeId}
            value={feed.pageSize}
            onChange={(event) => {
              const size = toPageSize(event.target.value);
              if (size !== null) feed.changePageSize(size);
            }}
            className="rounded-md border border-border bg-background px-2 py-1 text-sm"
          >
            {AUDIT_PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </div>
      </div>

      {feed.phase === 'failed' && (
        <p role="alert" className="text-sm text-destructive">
          {t('audit.loadFailed')}
        </p>
      )}

      {feed.entries.length > 0 ? (
        <ul className="divide-y divide-border">
          {feed.entries.map((entry) => (
            <AuditEntryRow key={entry.id} entry={entry} />
          ))}
        </ul>
      ) : (
        emptyMessage && <p className="text-sm text-muted-foreground">{emptyMessage}</p>
      )}

      {(feed.hasPrevious || feed.hasNext) && (
        <nav aria-label={t('audit.pagination')} className="flex items-center justify-between gap-2 pt-1">
          <Button size="sm" variant="outline" disabled={isLoading || !feed.hasPrevious} onClick={feed.previousPage}>
            {t('audit.previous')}
          </Button>
          <span className="text-sm text-muted-foreground" aria-live="polite">
            {t('audit.pageLabel', { page: feed.pageNumber })}
          </span>
          <Button size="sm" variant="outline" disabled={isLoading || !feed.hasNext} onClick={feed.nextPage}>
            {t('audit.next')}
          </Button>
        </nav>
      )}
    </section>
  );
}

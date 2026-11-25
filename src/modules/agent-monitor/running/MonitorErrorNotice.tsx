import { useTranslation } from 'react-i18next';

import type { MonitorErrorKind } from '@/modules/agent-monitor/data/readMonitorJson';

type MonitorErrorNoticeProps = {
  kind: MonitorErrorKind | null;
  /** The server's own message (only shown for an `http` error; an unreachable API has none worth showing). */
  message: string | null;
  onRetry: () => void;
};

/**
 * What the Running tab shows when no picture could be loaded: for an answer that is not the monitor's JSON, a plain
 * "cannot reach the monitor API, the server may be outdated: restart it" (never a blank screen that reads as "nothing is
 * running"), for a server error its message; both with a retry button of touch size. Rendered by the Running tab's list and
 * the main pane.
 */
export function MonitorErrorNotice({ kind, message, onRetry }: MonitorErrorNoticeProps) {
  const { t } = useTranslation('agentMonitor');
  return (
    <div className="space-y-3 p-3" role="alert" data-testid="monitor-error" data-kind={kind ?? 'unreachable'}>
      <p className="text-sm text-destructive">{kind === 'http' ? t('state.error', { message: message ?? '' }) : t('state.unreachable')}</p>
      <button
        type="button"
        onClick={onRetry}
        className="min-h-[44px] rounded-md border border-border px-4 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60 active:bg-accent"
      >
        {t('state.retry')}
      </button>
    </div>
  );
}

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { formatTokenCount } from '@/modules/agent-monitor/format/monitorFormat';
import { useAnimatedNumber } from '@/modules/agent-monitor/hooks/useAnimatedNumber';
import { Sparkline } from '@/modules/agent-monitor/kpi/Sparkline';
import type { AgentMonitorSnapshot } from '@/shared/types';

type KpiStripProps = {
  kpi: AgentMonitorSnapshot['kpi'];
  /** Counts roll toward their new value; false (reduced motion, hidden tab) shows them at once. */
  animate: boolean;
  /** How the cards sit: four on a row (wide), the three counts on a row with `trailing` under them (narrow), or one per row (stacked). */
  layout?: 'row' | 'narrow' | 'stacked';
  /** The card after the three counts (the machine's numbers): the fourth of the row, or a full-width row of its own. */
  trailing?: ReactNode;
};

const GRID_CLASS = { row: 'grid-cols-4', narrow: 'grid-cols-3', stacked: 'grid-cols-1' } as const;

type KpiCardProps = {
  label: string;
  value: string;
  series: Array<number | null>;
  minimumMax?: number;
  testId: string;
  /** A small pill beside the label. */
  badge?: ReactNode;
  /** Smaller type and padding, and a shorter sparkline: for the narrow layouts. */
  compact: boolean;
};

function KpiCard({ label, value, series, minimumMax, testId, badge, compact }: KpiCardProps) {
  const { t } = useTranslation('agentMonitor');
  return (
    <div className={`min-w-0 rounded-xl border border-border bg-card ${compact ? 'p-2' : 'p-3'}`} data-testid={testId}>
      <div className="flex items-center justify-between gap-2">
        <div className={`min-w-0 truncate text-muted-foreground ${compact ? 'text-[11px]' : 'text-xs'}`} title={label}>{label}</div>
        {badge}
      </div>
      <div className={`font-semibold tabular-nums text-foreground ${compact ? 'text-base' : 'mt-1 text-xl'}`} data-testid={`${testId}-value`}>{value}</div>
      {(series.length > 0 || !compact) && (
        <div className={compact ? 'h-4' : 'mt-1 h-6'}>
          {series.length > 0 && <Sparkline values={series} minimumMax={minimumMax} label={t('kpi.sparkline', { label })} className={compact ? 'h-4 w-full' : 'h-6 w-full'} />}
        </div>
      )}
    </div>
  );
}

/**
 * The strip of headline counts above the graph: agents working, tokens per minute and today. CPU and memory are not here:
 * the server's are on its own card and a session's on the detail of the selected node. Counts roll to their new value.
 */
export function KpiStrip({ kpi, animate, layout = 'row', trailing }: KpiStripProps) {
  const { t } = useTranslation('agentMonitor');
  const agents = useAnimatedNumber(kpi.runningAgents, animate);
  const perMinute = useAnimatedNumber(kpi.tokensPerMinute, animate);
  const today = useAnimatedNumber(kpi.tokensToday, animate);

  const active = kpi.runningAgents > 0;
  const compact = layout !== 'row';

  return (
    <div className={`grid ${compact ? 'gap-2' : 'gap-3'} ${GRID_CLASS[layout]}`} data-testid="monitor-kpi-strip">
      <KpiCard
        compact={compact}
        testId="kpi-agents"
        label={t('kpi.runningAgents')}
        value={String(Math.round(agents))}
        series={[]}
        badge={active && <span className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400" data-testid="kpi-agents-active">{t('kpi.active')}</span>}
      />
      <KpiCard compact={compact} testId="kpi-token-rate" label={t('kpi.tokensPerMinute')} value={formatTokenCount(perMinute)} series={kpi.tokenSeries} />
      <KpiCard compact={compact} testId="kpi-tokens-today" label={t('kpi.tokensToday')} value={formatTokenCount(today)} series={[]} />
      {trailing && <div className={`min-w-0 ${layout === 'narrow' ? 'col-span-3' : ''}`}>{trailing}</div>}
    </div>
  );
}

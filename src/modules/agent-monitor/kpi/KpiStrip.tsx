import { useTranslation } from 'react-i18next';

import { formatTokenCount } from '@/modules/agent-monitor/format/monitorFormat';
import { useAnimatedNumber } from '@/modules/agent-monitor/hooks/useAnimatedNumber';
import { Sparkline } from '@/modules/agent-monitor/kpi/Sparkline';
import type { AgentMonitorSnapshot } from '@/shared/types';

type KpiStripProps = {
  kpi: AgentMonitorSnapshot['kpi'];
  /** Counts roll toward their new value; false (reduced motion, hidden tab) shows them at once. */
  animate: boolean;
  /** A narrow pane: smaller cards so the three still fit on one row. */
  compact?: boolean;
};

type KpiCardProps = {
  label: string;
  value: string;
  series: Array<number | null>;
  minimumMax?: number;
  testId: string;
  compact: boolean;
};

function KpiCard({ label, value, series, minimumMax, testId, compact }: KpiCardProps) {
  const { t } = useTranslation('agentMonitor');
  return (
    <div className={`min-w-0 rounded-lg border border-border bg-card ${compact ? 'p-2' : 'p-3'}`} data-testid={testId}>
      <div className="truncate text-xs text-muted-foreground" title={label}>{label}</div>
      <div className={`mt-1 font-semibold tabular-nums text-foreground ${compact ? 'text-base' : 'text-xl'}`} data-testid={`${testId}-value`}>{value}</div>
      <div className="mt-1 h-6">
        {series.length > 0 && <Sparkline values={series} minimumMax={minimumMax} label={t('kpi.sparkline', { label })} className="h-6 w-full" />}
      </div>
    </div>
  );
}

/**
 * The strip of headline counts above the graph: agents working, tokens per minute and today. CPU and memory are not here:
 * the server's are on its own card and a session's on the detail of the selected node. Counts roll to their new value.
 */
export function KpiStrip({ kpi, animate, compact = false }: KpiStripProps) {
  const { t } = useTranslation('agentMonitor');
  const agents = useAnimatedNumber(kpi.runningAgents, animate);
  const perMinute = useAnimatedNumber(kpi.tokensPerMinute, animate);
  const today = useAnimatedNumber(kpi.tokensToday, animate);

  return (
    <div className={`grid grid-cols-3 ${compact ? 'gap-1.5' : 'gap-2'}`} data-testid="monitor-kpi-strip">
      <KpiCard compact={compact} testId="kpi-agents" label={t('kpi.runningAgents')} value={String(Math.round(agents))} series={[]} />
      <KpiCard compact={compact} testId="kpi-token-rate" label={t('kpi.tokensPerMinute')} value={formatTokenCount(perMinute)} series={kpi.tokenSeries} />
      <KpiCard compact={compact} testId="kpi-tokens-today" label={t('kpi.tokensToday')} value={formatTokenCount(today)} series={[]} />
    </div>
  );
}

import { MonitorGraphCard } from '@/modules/agent-monitor/graph/MonitorGraphCard';
import type { WidthTier } from '@/modules/agent-monitor/hooks/useElementWidth';
import { KpiStrip } from '@/modules/agent-monitor/kpi/KpiStrip';
import { MonitorColumns } from '@/modules/agent-monitor/running/MonitorColumns';
import { MonitorRail } from '@/modules/agent-monitor/running/MonitorRail';
import type { AgentMonitorSnapshot } from '@/shared/types';

type MonitorOverviewProps = {
  snapshot: AgentMonitorSnapshot;
  now: number;
  animate: boolean;
  /** How wide the pane is: decides where the server card goes relative to the graph. */
  tier: WidthTier;
  onSelectNode: (sessionId: string, nodeId: string | null) => void;
};

/**
 * The overview of everything running: the KPI strip, the graph of ALL sessions (each one the root of its own tree) and the
 * server card beside, under or above it by the pane's width. Purely presentational: it draws the snapshot it is given, and
 * the pane that shows it owns the polling, the clock and the motion setting. Shown by the Running pane while nothing is focused.
 */
export function MonitorOverview({ snapshot, now, animate, tier, onSelectNode }: MonitorOverviewProps) {
  return (
    <div className="space-y-3" data-testid="monitor-overview">
      <KpiStrip kpi={snapshot.kpi} animate={animate} compact={tier === 'narrow'} />
      <MonitorColumns
        tier={tier}
        fill={false}
        main={<MonitorGraphCard sessions={snapshot.sessions} now={now} animate={animate} onSelectNode={onSelectNode} />}
        // Nothing is selected in the overview: the rail is the server alone.
        rail={<MonitorRail snapshot={snapshot} now={now} focus={null} />}
      />
    </div>
  );
}

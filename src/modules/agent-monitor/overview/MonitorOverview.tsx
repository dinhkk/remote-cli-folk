import type { CSSProperties } from 'react';

import { OVERVIEW_GRAPH_HEIGHT_VAR } from '@/modules/agent-monitor/graph/GraphFrame';
import { MonitorGraphCard } from '@/modules/agent-monitor/graph/MonitorGraphCard';
import type { WidthTier } from '@/modules/agent-monitor/hooks/useElementWidth';
import { KpiStrip } from '@/modules/agent-monitor/kpi/KpiStrip';
import { MachineCard } from '@/modules/agent-monitor/usage/MachineCard';
import type { AgentMonitorSnapshot } from '@/shared/types';

type MonitorOverviewProps = {
  snapshot: AgentMonitorSnapshot;
  now: number;
  animate: boolean;
  /** How wide the pane is: decides how the cards of the strip are arranged. */
  tier: WidthTier;
  /** The pane is too narrow for three cards on a row: one card per row. */
  stacked?: boolean;
  onSelectNode: (sessionId: string, nodeId: string | null) => void;
};

/** The overview graph on a narrow pane: short enough that the strip above it and the graph fit one screen without scrolling. */
const NARROW_GRAPH_HEIGHT = 'clamp(272px, calc(36vh + 72px), 412px)';

/**
 * The overview of everything running: one strip of cards (the three counts and the server's numbers), then the graph of ALL
 * sessions (each one the root of its own tree), always under the strip. Wide: four cards on a row. Narrow: smaller cards, the
 * three counts on one row and the server card under them, and a shorter graph, so the whole overview fits a phone's screen; a
 * pane too narrow for even that stacks the cards one per row. Purely presentational: it draws the snapshot it is given, and
 * the pane that shows it owns the polling, the clock and the motion setting. Shown by the Running pane while nothing is focused.
 */
export function MonitorOverview({ snapshot, now, animate, tier, stacked = false, onSelectNode }: MonitorOverviewProps) {
  const narrow = tier === 'narrow';
  const layout = narrow ? (stacked ? 'stacked' : 'narrow') : 'row';
  return (
    <div className={narrow ? 'space-y-2' : 'space-y-3'} data-testid="monitor-overview">
      <KpiStrip kpi={snapshot.kpi} animate={animate} layout={layout} trailing={<MachineCard snapshot={snapshot} compact={narrow} />} />
      <div style={narrow ? { [OVERVIEW_GRAPH_HEIGHT_VAR]: NARROW_GRAPH_HEIGHT } as CSSProperties : undefined}>
        <MonitorGraphCard sessions={snapshot.sessions} now={now} animate={animate} onSelectNode={onSelectNode} />
      </div>
    </div>
  );
}

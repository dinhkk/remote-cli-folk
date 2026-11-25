import { useTranslation } from 'react-i18next';

import { LazyMonitorGraph } from '@/modules/agent-monitor/graph/MonitorGraphLazy';
import { ProcessToggle } from '@/modules/agent-monitor/graph/ProcessToggle';
import { useRunningFocus } from '@/modules/agent-monitor/running/RunningFocusContext';
import type { AgentMonitorSession } from '@/shared/types';

type MonitorGraphCardProps = {
  sessions: AgentMonitorSession[];
  now: number;
  animate: boolean;
  highlightId?: string | null;
  onSelectNode: (sessionId: string, nodeId: string | null) => void;
  /** Fill the pane (the single-session view) instead of the overview's fixed height. */
  fill?: boolean;
};

/**
 * The graph with its title, in a card. Shared by the overview (every running session, a fixed-height card inside the
 * scrolling column) and the single-session view (one session, one box focused, filling the pane), so the two read the same.
 * With no session there is one short line and no graph (so React Flow is not even loaded).
 */
export function MonitorGraphCard({ sessions, now, animate, highlightId = null, onSelectNode, fill = false }: MonitorGraphCardProps) {
  const { t } = useTranslation('agentMonitor');
  const { showProcesses, setShowProcesses } = useRunningFocus();
  return (
    <section
      aria-labelledby="monitor-graph-title"
      className={`rounded-lg border border-border bg-card p-3 ${fill ? 'flex flex-1 flex-col' : ''}`}
      data-testid="monitor-graph-card"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 id="monitor-graph-title" className="text-sm font-semibold text-foreground">{t('graph.title')}</h3>
        <ProcessToggle shown={showProcesses} onToggle={() => setShowProcesses(!showProcesses)} />
      </div>
      {sessions.length === 0
        ? <p className="text-sm text-muted-foreground" data-testid="monitor-empty">{t('graph.empty')}</p>
        : <LazyMonitorGraph sessions={sessions} now={now} animate={animate} highlightId={highlightId} onSelectNode={onSelectNode} fill={fill} showProcesses={showProcesses} />}
    </section>
  );
}

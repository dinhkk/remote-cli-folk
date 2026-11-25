import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';

import { GraphFrame } from '@/modules/agent-monitor/graph/GraphFrame';
import type { MonitorGraphProps } from '@/modules/agent-monitor/graph/MonitorGraph';

// React Flow and its stylesheet load with this import, the first time a graph is drawn, not with the app's first bundle.
const MonitorGraph = lazy(() => import('@/modules/agent-monitor/graph/MonitorGraph').then((module) => ({ default: module.MonitorGraph })));

/** What stands where the graph will be while its code arrives: a quiet block of the graph's own size, no text. */
function GraphPlaceholder({ fill }: { fill: boolean }) {
  const { t } = useTranslation('agentMonitor');
  return <GraphFrame fill={fill} role="status" aria-busy="true" aria-label={t('state.loading')} className="animate-pulse bg-muted" data-testid="monitor-graph-loading" />;
}

/** The live graph, loaded on demand. Same props as `MonitorGraph`. */
export function LazyMonitorGraph(props: MonitorGraphProps) {
  return (
    <Suspense fallback={<GraphPlaceholder fill={props.fill ?? false} />}>
      <MonitorGraph {...props} />
    </Suspense>
  );
}

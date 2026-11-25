import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react';

import type { MonitorFlowEdge as MonitorFlowEdgeType } from '@/modules/agent-monitor/graph/buildFlowGraph';
import { useMonitorFlowEnv } from '@/modules/agent-monitor/graph/monitorFlowEnv';
import { PROCESS_STYLE, QUIET_EDGE_STROKE, STATE_STYLE } from '@/modules/agent-monitor/graph/stateStyle';

/**
 * A connector between two boxes. Its width is the child's token rate (`edgeThickness`, already in `data.thickness`; a
 * process edge stays thin); its colour is the child's state while it works and a quiet grey when it does not; a working
 * edge also flows (dashes moving from parent to child) unless motion is off, in which case colour and width carry it.
 */
export function MonitorFlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<MonitorFlowEdgeType>) {
  const { animate } = useMonitorFlowEnv();
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const flowing = data?.flowing ?? false;
  const active = data?.kind === 'process' ? PROCESS_STYLE.stroke : STATE_STYLE[data?.state ?? 'done'].stroke;

  return (
    <BaseEdge
      id={id}
      path={path}
      interactionWidth={0}
      className={`${flowing ? active : QUIET_EDGE_STROKE} ${animate && flowing ? 'monitor-edge-flow' : ''}`}
      style={{ strokeWidth: data?.thickness ?? 1.5, strokeLinecap: 'round', strokeOpacity: flowing ? 0.75 : 1 }}
      data-edge-id={id}
      data-edge-kind={data?.kind}
      data-edge-flowing={flowing}
    />
  );
}

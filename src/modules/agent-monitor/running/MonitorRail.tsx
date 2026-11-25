import { useMemo } from 'react';

import { resolveSelection } from '@/modules/agent-monitor/running/resolveSelection';
import type { RunningFocus } from '@/modules/agent-monitor/running/RunningFocusContext';
import { MachineCard } from '@/modules/agent-monitor/usage/MachineCard';
import { SelectionDetail } from '@/modules/agent-monitor/usage/SelectionDetail';
import type { AgentMonitorSnapshot } from '@/shared/types';

type MonitorRailProps = {
  snapshot: AgentMonitorSnapshot;
  now: number;
  /** The focus in effect, if any: with none (the overview) the rail is the machine's numbers. */
  focus: RunningFocus | null;
  /** Given on a narrow pane, where the Activity is its own view: the detail of a sub-agent then has a button that opens it. */
  onOpenActivity?: () => void;
};

/**
 * What sits beside or under the graph: the numbers of the whole machine while nothing is selected (the overview), or the
 * numbers (CPU, memory, processes, tokens) of the selected session or node while one is. Never both: all sessions show the
 * machine, one session shows that session.
 */
export function MonitorRail({ snapshot, now, focus, onOpenActivity }: MonitorRailProps) {
  const selection = useMemo(() => resolveSelection(snapshot, focus), [snapshot, focus]);
  return (
    <div className="space-y-3" data-testid="monitor-rail">
      {selection ? <SelectionDetail selection={selection} now={now} onOpenActivity={onOpenActivity} /> : <MachineCard snapshot={snapshot} />}
    </div>
  );
}

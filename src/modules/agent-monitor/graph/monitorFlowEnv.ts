import { createContext, useContext } from 'react';

import type { GraphNode } from '@/modules/agent-monitor/graph/layoutMonitorTree';

/**
 * What every box and edge of the graph needs besides its own data: the server's clock (running timers), whether motion is on,
 * which box is focused and what a click on a box does. Passed by context because React Flow builds the node and edge
 * components itself (the `nodeTypes` tables are fixed, module-level objects) and cannot take props from the graph.
 */
export type MonitorFlowEnv = {
  /** The server's clock now (ms): running timers count up from it. */
  now: number;
  /** Motion on: spinner, pulse, blink, flowing edges. Off: colour and glyph only. */
  animate: boolean;
  /** The id of the focused box, drawn with a ring; null = none. */
  highlightId: string | null;
  /** A click (or Enter/Space) on a box. */
  onSelect: (graphNode: GraphNode) => void;
};

const INERT_ENV: MonitorFlowEnv = { now: 0, animate: false, highlightId: null, onSelect: () => undefined };

export const MonitorFlowEnvContext = createContext<MonitorFlowEnv>(INERT_ENV);
export const useMonitorFlowEnv = (): MonitorFlowEnv => useContext(MonitorFlowEnvContext);

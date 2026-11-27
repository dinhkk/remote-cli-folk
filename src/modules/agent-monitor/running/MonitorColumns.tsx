import type { ReactNode } from 'react';

import type { WidthTier } from '@/modules/agent-monitor/hooks/useElementWidth';

type MonitorColumnsProps = {
  tier: WidthTier;
  /** The graph fills the pane's height (the single-session view) instead of a fixed card. */
  fill: boolean;
  /** The graph card. */
  main: ReactNode;
  /** The server card and the detail of the selected node. */
  rail: ReactNode;
};

/**
 * Where the graph and the rail go, by the width of the PANE (not the window: the sidebar takes a variable share of it):
 * wide = side by side, the rail scrolling by itself; medium = the graph, then the rail under it; narrow = the same one
 * column as medium: the graph first, the rail (the detail of what is selected) under it.
 * Only classes and DOM order change with the tier; there is no scrolling logic here.
 */
export function MonitorColumns({ tier, fill, main, rail }: MonitorColumnsProps) {
  if (tier === 'wide') {
    return (
      <div
        className={`grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-3 ${fill ? 'min-h-0 flex-1' : 'items-start'}`}
        data-testid="monitor-columns"
        data-layout="side-by-side"
      >
        <div className={`flex min-w-0 flex-col ${fill ? 'min-h-0' : ''}`}>{main}</div>
        <div className={`min-w-0 overflow-y-auto ${fill ? 'min-h-0' : 'max-h-[min(70vh,720px)]'}`}>{rail}</div>
      </div>
    );
  }
  return (
    // No `min-h-0` here: the graph has a least height of its own, and a column that could shrink below it would let the rail
    // draw over the graph. The pane scrolls when the two do not fit.
    <div className={`flex flex-col gap-3 ${fill ? 'flex-1' : ''}`} data-testid="monitor-columns" data-layout="rail-below">
      <div className={`flex min-w-0 flex-col ${fill ? 'flex-1' : ''}`}>{main}</div>
      <div className="min-w-0 shrink-0">{rail}</div>
    </div>
  );
}

import type { AgentMonitorState } from '@/shared/types';

/** Border, stroke, text and fill colours per state. Colour alone carries the state when motion is off (reduced motion). */
export const STATE_STYLE: Record<AgentMonitorState, { border: string; stroke: string; text: string; fill: string }> = {
  running: { border: 'border-blue-500', stroke: 'stroke-blue-500', text: 'text-blue-600 dark:text-blue-400', fill: 'fill-blue-500' },
  waiting: { border: 'border-amber-500', stroke: 'stroke-amber-500', text: 'text-amber-600 dark:text-amber-400', fill: 'fill-amber-500' },
  done: { border: 'border-emerald-500', stroke: 'stroke-emerald-500', text: 'text-emerald-600 dark:text-emerald-400', fill: 'fill-emerald-500' },
  failed: { border: 'border-red-500', stroke: 'stroke-red-500', text: 'text-red-600 dark:text-red-400', fill: 'fill-red-500' },
  stopped: { border: 'border-slate-400', stroke: 'stroke-slate-400', text: 'text-slate-500 dark:text-slate-400', fill: 'fill-slate-400' },
};

/** Background of the small round state dot used by list rows (the graph uses `STATE_STYLE`); the same hues, plus `idle` for a session that is not working. */
export const STATE_DOT: Record<AgentMonitorState | 'idle', string> = {
  running: 'bg-blue-500',
  waiting: 'bg-amber-500',
  done: 'bg-emerald-500',
  failed: 'bg-red-500',
  stopped: 'bg-slate-400',
  idle: 'bg-slate-400',
};

/** Process groups are not agents and have no state machine: one muted colour whatever the session does, so they never read as an agent. */
export const PROCESS_STYLE = { border: 'border-slate-400', stroke: 'stroke-slate-400', fill: 'fill-slate-400', box: 'bg-muted' } as const;

/** An edge that carries nothing right now. */
export const QUIET_EDGE_STROKE = 'stroke-slate-400/70';

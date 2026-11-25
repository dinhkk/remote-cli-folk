import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

type NodeStatProps = {
  icon: LucideIcon;
  /** What is drawn next to the icon: already formatted. */
  value: string;
  /** The chip's accessible name and tooltip, for example "CPU 12%": the icon alone says nothing to a screen reader. */
  label: string;
};

/**
 * One small icon + value chip on a graph box. A picture with a name, not a control: it never takes focus or a click (the
 * box around it is the button), so a screen reader reads `label` and a pointer reads it as the tooltip.
 */
export function NodeStat({ icon: Icon, value, label }: NodeStatProps) {
  return (
    <span role="img" aria-label={label} title={label} className="inline-flex shrink-0 items-center gap-0.5 tabular-nums">
      <Icon className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
      <span aria-hidden="true">{value}</span>
    </span>
  );
}

/** A row of chips under a box's title; what does not fit is cut at the box's edge rather than spilling out of it. */
export function NodeStatRow({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[10px] leading-tight text-muted-foreground">{children}</div>;
}

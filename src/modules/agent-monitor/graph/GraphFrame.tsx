import type { HTMLAttributes, ReactNode } from 'react';

/**
 * Height of the graph in the overview: a card inside the scrolling column, so the page above and below stays reachable.
 * It follows the window's height (a bit over half), never under 320 px and never over 600 px.
 */
export const OVERVIEW_GRAPH_HEIGHT = 'clamp(320px, 55vh, 600px)';
/** The least height the single-session graph keeps when the pane is short (a phone in landscape). */
const FILL_MIN_HEIGHT = 320;

type GraphFrameProps = HTMLAttributes<HTMLDivElement> & {
  /** Fill the pane (the single-session view) instead of the overview's height. */
  fill: boolean;
  children?: ReactNode;
};

/**
 * The box the graph lives in. React Flow needs a parent with a real size; the real graph and its loading placeholder both
 * sit in this frame, so nothing jumps when the graph arrives. Its content is positioned absolutely inside, which keeps the
 * size independent of what is drawn.
 */
export function GraphFrame({ fill, children, className = '', ...rest }: GraphFrameProps) {
  return (
    <div
      {...rest}
      className={`relative w-full min-w-0 overflow-hidden rounded-md border border-border ${fill ? 'flex-1' : ''} ${className}`}
      style={fill ? { minHeight: FILL_MIN_HEIGHT } : { height: OVERVIEW_GRAPH_HEIGHT }}
    >
      <div className="absolute inset-0">{children}</div>
    </div>
  );
}

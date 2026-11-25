import { screen, waitFor } from '@testing-library/react';

/**
 * Helpers for tests that look at the live graph. The graph is a lazy chunk (React Flow), so a test warms it once
 * (`preloadGraph`, in `beforeAll`: the first import transforms the library and can take seconds) and then waits for it
 * to appear (`findGraph`) instead of reading it the moment the pane shows.
 */

/** Loads the graph module so the lazy import in the component resolves at once. */
export const preloadGraph = () => import('@/modules/agent-monitor/graph/MonitorGraph');
export const PRELOAD_TIMEOUT_MS = 60_000;

/** A box of the graph by its node id (`session:`, `orch:`, `agent:`, `proc:` or `folded:` ids), null if it is not drawn. */
export const graphNode = (id: string): HTMLElement | null => document.querySelector(`[data-node-id="${id}"]`);

/** The edge path of the graph between two node ids, null if it is not drawn. */
export const graphEdge = (id: string): SVGPathElement | null => document.querySelector(`[data-edge-id="${id}"]`);

/** Waits until the graph (not its placeholder) is on screen. */
export const findGraph = () => screen.findByTestId('monitor-graph', undefined, { timeout: 10_000 });

/** Waits until a box is drawn and returns it. */
export const findGraphNode = (id: string) => waitFor(() => {
  const found = graphNode(id);
  if (!found) throw new Error(`graph node ${id} is not drawn yet`);
  return found;
}, { timeout: 10_000 });

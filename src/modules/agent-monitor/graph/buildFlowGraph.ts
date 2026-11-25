import { Position, type Edge, type Node } from '@xyflow/react';

import type { GraphEdge, GraphLayout, GraphNode } from '@/modules/agent-monitor/graph/layoutMonitorTree';
import type { AgentMonitorState } from '@/shared/types';

/**
 * Turns the pure layout into what React Flow draws. The node and edge `type` strings are the layout's own kinds, so the
 * `nodeTypes` / `edgeTypes` tables of the graph are keyed by them. Node ids and edge ids are the layout's ids.
 */

export type MonitorFlowNode = Node<{ graphNode: GraphNode }, GraphNode['kind']>;
export type MonitorFlowEdge = Edge<{ kind: GraphEdge['kind']; flowing: boolean; thickness: number; state: AgentMonitorState }, 'monitor'>;

/** Diameter of a connector dot (`.monitor-flow .react-flow__handle` in `monitorFlow.css` draws the same size). */
const HANDLE_SIZE = 8;

/**
 * The connectors a box has, so there is a dot exactly where an edge starts or ends: an incoming one at the left-middle and an
 * outgoing one at the right-middle. The session is a root (outgoing only), the main agent has both, an agent or a process
 * group is a leaf (incoming only), the fold has none. Declared here as well as drawn by the node component, so the edges
 * can be placed before the boxes are measured.
 */
function handlesFor(graphNode: GraphNode): MonitorFlowNode['handles'] {
  const y = graphNode.h / 2 - HANDLE_SIZE / 2;
  const target = { type: 'target' as const, position: Position.Left, x: -HANDLE_SIZE / 2, y, width: HANDLE_SIZE, height: HANDLE_SIZE };
  const source = { type: 'source' as const, position: Position.Right, x: graphNode.w - HANDLE_SIZE / 2, y, width: HANDLE_SIZE, height: HANDLE_SIZE };
  switch (graphNode.kind) {
    case 'session': return [source];
    case 'orchestrator': return [target, source];
    case 'agent':
    case 'process': return [target];
    default: return [];
  }
}

/** One React Flow node per layout box, at the layout's position. Boxes have a fixed size, so they count as measured at once. */
export function toFlowNodes(layout: GraphLayout): MonitorFlowNode[] {
  return layout.nodes.map((graphNode) => ({
    id: graphNode.id,
    type: graphNode.kind,
    position: { x: graphNode.x, y: graphNode.y },
    width: graphNode.w,
    height: graphNode.h,
    data: { graphNode },
    handles: handlesFor(graphNode),
    // The box is a button of its own (tab stop, Enter/Space); the wrapper React Flow puts around it must not be a second one.
    focusable: false,
    selectable: false,
    connectable: false,
    deletable: false,
  }));
}

/** One edge per layout edge. What the line looks like (width, colour, flow) is in `data`; `MonitorFlowEdge` draws it. */
export function toFlowEdges(layout: GraphLayout): MonitorFlowEdge[] {
  return layout.edges.map((edge) => ({
    id: edge.id,
    type: 'monitor',
    source: edge.from,
    target: edge.to,
    data: { kind: edge.kind, flowing: edge.flowing, thickness: edge.thickness, state: edge.state },
    // A line is decoration: the boxes carry the information (their own names and states), so a screen reader skips it.
    ariaRole: 'presentation',
    domAttributes: { 'aria-hidden': true },
    focusable: false,
    selectable: false,
    deletable: false,
    reconnectable: false,
  }));
}

/**
 * The set of sessions in a layout, as one string (sorted: the server reorders sessions as they get busier, and a reorder alone
 * is not a new set). When it changes the graph is fitted to the view again; when it does not, the user's pan and zoom stay.
 */
export const sessionSetKey = (layout: GraphLayout): string => [...new Set(layout.nodes.map((node) => node.sessionId))].sort().join('|');

import '@xyflow/react/dist/style.css';
import '@/modules/agent-monitor/graph/monitorFlow.css';

import { Background, ControlButton, Controls, ReactFlow, type NodeTypes, type EdgeTypes, type NodeChangeset } from '@xyflow/react';
import { RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { sessionSetKey, toFlowEdges, toFlowNodes, type MonitorFlowNode } from '@/modules/agent-monitor/graph/buildFlowGraph';
import { FIT_VIEW_OPTIONS } from '@/modules/agent-monitor/graph/fitViewOptions';
import { FitOnResize } from '@/modules/agent-monitor/graph/FitOnResize';
import { GraphFrame } from '@/modules/agent-monitor/graph/GraphFrame';
import { layoutMonitorTree, type GraphNode } from '@/modules/agent-monitor/graph/layoutMonitorTree';
import { MonitorFlowCardNode } from '@/modules/agent-monitor/graph/MonitorFlowCardNode';
import { MonitorFlowEdge } from '@/modules/agent-monitor/graph/MonitorFlowEdge';
import { MonitorFlowEnvContext, type MonitorFlowEnv } from '@/modules/agent-monitor/graph/monitorFlowEnv';
import { MonitorFlowProcessNode } from '@/modules/agent-monitor/graph/MonitorFlowProcessNode';
import { NO_SAVED_POSITIONS, placeNodes, pruneSavedPositions, recordPositions, type SavedPositions } from '@/modules/agent-monitor/graph/nodePositions';
import { useDragClickGuard } from '@/modules/agent-monitor/graph/useDragClickGuard';
import type { AgentMonitorSession } from '@/shared/types';

export type MonitorGraphProps = {
  sessions: AgentMonitorSession[];
  /** The server's clock now (ms) for the running timers. */
  now: number;
  /** Motion on (the user did not ask for less, and the tab is visible). Off: colour only. */
  animate: boolean;
  /** The id of the focused box (`session:`, `orch:`, `agent:` or `proc:` ids, see `layoutMonitorTree`), drawn with a ring; null = none. */
  highlightId?: string | null;
  /** A click (or Enter/Space) on a box. `nodeId` is null for a session box, else the id of the orchestrator, agent or process box. */
  onSelectNode: (sessionId: string, nodeId: string | null) => void;
  /** Fill the pane (the single-session view) instead of the overview's fixed height. */
  fill?: boolean;
  /** Draw the child process boxes. Default true; the card passes the user's choice. */
  showProcesses?: boolean;
};

// Stable references, defined once: React Flow re-creates every node and edge component when these objects change.
const NODE_TYPES: NodeTypes = {
  session: MonitorFlowCardNode,
  orchestrator: MonitorFlowCardNode,
  agent: MonitorFlowCardNode,
  folded: MonitorFlowCardNode,
  process: MonitorFlowProcessNode,
};
const EDGE_TYPES: EdgeTypes = { monitor: MonitorFlowEdge };
/** Hold Ctrl (or Cmd) and use the wheel to zoom: a plain wheel scrolls the page, which holds the graph in a column. */
const ZOOM_KEYS = ['Control', 'Meta'];

/**
 * The live graph, one tree per session, drawn by React Flow: the session is the root, then its orchestrator, then the leaves
 * (the level-2 agents, the "+N finished" fold and the groups of child OS processes). Boxes can be dragged and the view
 * panned and zoomed; nothing can be connected or deleted by hand. `layoutMonitorTree` supplies the INITIAL positions.
 *
 * A fresh snapshot arrives every second. It updates what the boxes say, never where the user put them: a dragged box keeps its
 * position (`nodePositions.ts`), only a new box takes the layout's position, and the view is fitted again only when the set
 * of shown sessions changes (the flow is keyed by it), never on a tick. Loaded lazily (`MonitorGraphLazy`) so React Flow
 * stays out of the first bundle.
 */
export function MonitorGraph({ sessions, now, animate, highlightId = null, onSelectNode, fill = false, showProcesses = true }: MonitorGraphProps) {
  const { t } = useTranslation('agentMonitor');
  const layout = useMemo(() => layoutMonitorTree(sessions, undefined, undefined, { showProcesses }), [sessions, showProcesses]);
  const layoutNodes = useMemo(() => toFlowNodes(layout), [layout]);
  const edges = useMemo(() => toFlowEdges(layout), [layout]);

  // Where the user dragged boxes to, by node id; and how many times they asked for the layout back.
  const [saved, setSaved] = useState<SavedPositions>(NO_SAVED_POSITIONS);
  const [resets, setResets] = useState(0);
  // A box that left the picture forgets its position (adjusting state while rendering, the pattern React documents for this).
  const stillDrawn = pruneSavedPositions(saved, layoutNodes.map((node) => node.id));
  if (stillDrawn !== saved) setSaved(stillDrawn);
  const nodes = useMemo(() => placeNodes(layoutNodes, saved), [layoutNodes, saved]);

  const onNodesChange = useCallback((changes: NodeChangeset<MonitorFlowNode>) => setSaved((before) => recordPositions(before, changes)), []);
  // Whether the user panned or zoomed since the view was last fitted: then a resize leaves their view alone.
  const moved = useRef(false);
  // The child process boxes are turned on or off: a view fitted without them would leave them outside the frame (on a phone, past
  // the right edge), so that starts a fresh, fitted view too.
  const flowKey = `${sessionSetKey(layout)}#${resets}#${showProcesses ? 'p' : '-'}`;
  useEffect(() => { moved.current = false; }, [flowKey]);
  const onMoveStart = useCallback((event: MouseEvent | TouchEvent | null) => { if (event) moved.current = true; }, []);
  const onFit = useCallback(() => { moved.current = false; }, []);
  const resetLayout = useCallback(() => { setSaved(NO_SAVED_POSITIONS); setResets((count) => count + 1); }, []);

  const { onNodeDragStart, onNodeDragStop, isDragging } = useDragClickGuard();
  const onSelect = useCallback((node: GraphNode) => {
    if (isDragging()) return;
    onSelectNode(node.sessionId, node.kind === 'session' ? null : node.id);
  }, [isDragging, onSelectNode]);
  const env = useMemo<MonitorFlowEnv>(() => ({ now, animate, highlightId, onSelect }), [now, animate, highlightId, onSelect]);

  const ariaLabelConfig = useMemo(() => ({
    'controls.ariaLabel': t('graph.controls'),
    'controls.zoomIn.ariaLabel': t('graph.zoomIn'),
    'controls.zoomOut.ariaLabel': t('graph.zoomOut'),
    'controls.fitView.ariaLabel': t('graph.fitView'),
  }), [t]);

  return (
    <div className={fill ? 'flex flex-1 flex-col' : ''}>
      <GraphFrame fill={fill} role="group" aria-label={t('graph.title')} data-testid="monitor-graph">
        <MonitorFlowEnvContext.Provider value={env}>
          <ReactFlow
            // The set of sessions (or a reset) starts a fresh view, fitted to the tree; a snapshot tick never does.
            key={flowKey}
            className="monitor-flow"
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            onNodesChange={onNodesChange}
            onNodeDragStart={onNodeDragStart}
            onNodeDragStop={onNodeDragStop}
            onMoveStart={onMoveStart}
            // Drag boxes, pan and zoom: yes. Connect, delete, select, edit by hand: no.
            nodesDraggable
            nodesConnectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            edgesReconnectable={false}
            elementsSelectable={false}
            deleteKeyCode={null}
            selectionKeyCode={null}
            multiSelectionKeyCode={null}
            disableKeyboardA11y
            // The graph sits in a scrolling column: the wheel scrolls the page, Ctrl/Cmd + wheel, a pinch or the buttons zoom.
            panOnDrag
            zoomOnScroll={false}
            zoomOnDoubleClick={false}
            zoomOnPinch
            zoomActivationKeyCode={ZOOM_KEYS}
            preventScrolling={false}
            minZoom={0.2}
            maxZoom={1.75}
            fitView
            fitViewOptions={FIT_VIEW_OPTIONS}
            attributionPosition="bottom-right"
            ariaLabelConfig={ariaLabelConfig}
          >
            <Background gap={20} size={1} />
            <FitOnResize moved={moved} />
            <Controls showInteractive={false} fitViewOptions={FIT_VIEW_OPTIONS} onFitView={onFit} position="bottom-left">
              <ControlButton onClick={resetLayout} title={t('graph.resetLayout')} aria-label={t('graph.resetLayout')}>
                <RotateCcw className="monitor-reset-icon" aria-hidden="true" />
              </ControlButton>
            </Controls>
          </ReactFlow>
        </MonitorFlowEnvContext.Provider>
      </GraphFrame>
      {layout.omittedAgents > 0 && (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="monitor-graph-omitted">{t('graph.omitted', { count: layout.omittedAgents })}</p>
      )}
      {layout.omittedProcesses > 0 && (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="monitor-graph-omitted-processes">{t('graph.omittedProcesses', { count: layout.omittedProcesses })}</p>
      )}
    </div>
  );
}

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { orchestratorNodeId, sessionNodeId } from '@/modules/agent-monitor/graph/layoutMonitorTree';
import { MonitorErrorNotice } from '@/modules/agent-monitor/running/MonitorErrorNotice';
import { buildRunningTree, type RunningSessionNode, type RunningTree } from '@/modules/agent-monitor/running/buildRunningTree';
import { useEffectiveRunningFocus, useRunningFocus, useRunningMonitorData, type RunningFocus } from '@/modules/agent-monitor/running/RunningFocusContext';
import type { Project } from '@/shared/types';

/** What the rows of the Running tab's tree read: the model, the focus in effect, which nodes are open, and the toggles. */
export type RunningTreeContextValue = {
  tree: RunningTree;
  focus: RunningFocus | null;
  isExpanded: (key: string, byDefault: boolean) => boolean;
  toggleExpanded: (key: string, byDefault: boolean) => void;
  onToggleNode: (sessionKey: string, nodeKey: string) => void;
  onToggleSession: (node: RunningSessionNode) => void;
};

// No provider = not the Running tab: the session rows then draw nothing beyond themselves.
const RunningTreeContext = createContext<RunningTreeContextValue | null>(null);

export const useRunningTree = (): RunningTreeContextValue | null => useContext(RunningTreeContext);

type RunningTreeScopeProps = {
  /** The project rows the list draws (those with a running app session). */
  displayedProjects: readonly Project[];
  allProjects: readonly Project[];
  /** The sidebar's search text. */
  search: string;
  /** Receives the built tree, so the caller can tell whether anything is running at all. */
  children: (tree: RunningTree) => ReactNode;
};

/**
 * Wraps the Running tab's list. It builds the tree from the shared snapshot (the poll lives in the focus provider, so the
 * tree and the main pane read ONE answer), keeps which nodes the user opened or closed, and opens the path to a node that
 * is focused from the graph. The rows below read it through `useRunningTree`.
 */
export function RunningTreeScope({ displayedProjects, allProjects, search, children }: RunningTreeScopeProps) {
  const { snapshot, status, errorKind, errorMessage, retry } = useRunningMonitorData();
  const { explicit, toggleNode, toggleSession, showProcesses } = useRunningFocus();
  const focus = useEffectiveRunningFocus();
  const [opened, setOpened] = useState<ReadonlyMap<string, boolean>>(new Map());

  const sessions = snapshot?.sessions;
  const keepSessionKey = focus?.sessionKey ?? null;
  const tree = useMemo(
    () => buildRunningTree({ sessions: sessions ?? [], displayedProjects, allProjects, search, keepSessionKey, showProcesses }),
    [sessions, displayedProjects, allProjects, search, keepSessionKey, showProcesses],
  );

  // A node focused from the graph must be visible in the list: open its session and its main agent.
  useEffect(() => {
    if (!explicit?.nodeKey) return;
    setOpened((previous) => new Map(previous).set(sessionNodeId(explicit.sessionKey), true).set(orchestratorNodeId(explicit.sessionKey), true));
  }, [explicit]);

  const isExpanded = useCallback((key: string, byDefault: boolean) => opened.get(key) ?? byDefault, [opened]);
  const toggleExpanded = useCallback((key: string, byDefault: boolean) => {
    setOpened((previous) => new Map(previous).set(key, !(previous.get(key) ?? byDefault)));
  }, []);
  // A session row only focuses the session (its numbers show in the pane); it never opens the chat.
  const onToggleSession = useCallback((node: RunningSessionNode) => toggleSession({ sessionKey: node.sessionKey, chatId: null }), [toggleSession]);

  const value = useMemo<RunningTreeContextValue>(
    () => ({ tree, focus, isExpanded, toggleExpanded, onToggleNode: toggleNode, onToggleSession }),
    [tree, focus, isExpanded, toggleExpanded, toggleNode, onToggleSession],
  );

  return (
    <RunningTreeContext.Provider value={value}>
      {!snapshot && status === 'error' && <MonitorErrorNotice kind={errorKind} message={errorMessage} onRetry={retry} />}
      {children(tree)}
    </RunningTreeContext.Provider>
  );
}

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useAgentMonitor } from '@/modules/agent-monitor/hooks/useAgentMonitor';
import { useShowProcesses } from '@/modules/agent-monitor/hooks/useShowProcesses';
import { usePageVisible } from '@/modules/agent-monitor/hooks/usePageVisible';
import { usePrefersReducedMotion } from '@/modules/agent-monitor/hooks/usePrefersReducedMotion';

/**
 * What the sidebar's Running tab and the main pane share: whether the tab is on show, which node of which session is
 * focused, and the ONE monitor poll (made only while the tab is on show and the page is visible, so the server's
 * lease-gated sampler runs only while somebody looks).
 *
 * Two contexts on purpose. The focus one changes only when the user acts, so the workspace can read it without
 * re-rendering every second; the data one carries the snapshot, which changes with every poll.
 */

/** A focus: a session (`nodeKey` null) or one node of its tree (the graph's node id: main agent, sub-agent or process group). */
export type RunningFocus = { sessionKey: string; nodeKey: string | null };

/** What the main area shows over the workspace: the overview of everything running, the graph of one session, or nothing (the route's own view). */
export type RunningMainPane = 'overview' | 'graph' | null;

export type RunningFocusApi = {
  /** The Running tab is the one on show. */
  runningActive: boolean;
  /** A focus set by clicking a node (or a terminal session with no chat). A focused app chat is not stored here: the route says it. */
  explicit: RunningFocus | null;
  /** The chat session in the URL, if any. */
  routeSessionId: string | null;
  mainPane: RunningMainPane;
  setRunningActive: (active: boolean) => void;
  /** Focuses a node of a session's tree, or releases it when it is the focused one. */
  toggleNode: (sessionKey: string, nodeKey: string) => void;
  /** Focuses a session, or releases it when it is the focused one: an app chat opens (`/session/:id`, release goes to `/`), a session with no chat shows its graph. */
  toggleSession: (target: { sessionKey: string; chatId: string | null }) => void;
  /** The chat in the URL is the focused session (no node focus overrides it): clicking it again releases it. */
  isChatFocused: (chatId: string) => boolean;
  /** Drops a node focus before a chat is opened by another path (the sidebar's own session rows). */
  clearNodeFocus: () => void;
  /** Releases the focused chat: back to `/`, which shows the overview again. */
  releaseChat: () => void;
  /** The child OS processes are drawn (graph boxes and tree rows). The user's choice, hidden until turned on; outside a provider they are drawn. */
  showProcesses: boolean;
  setShowProcesses: (show: boolean) => void;
};

export type RunningMonitorData = ReturnType<typeof useAgentMonitor> & { visible: boolean; animate: boolean };

const noop = () => undefined;
const INERT_FOCUS: RunningFocusApi = {
  runningActive: false, explicit: null, routeSessionId: null, mainPane: null,
  setRunningActive: noop, toggleNode: noop, toggleSession: noop, isChatFocused: () => false, clearNodeFocus: noop, releaseChat: noop,
  showProcesses: true, setShowProcesses: noop,
};
const INERT_DATA: RunningMonitorData = { snapshot: null, status: 'loading', clockOffsetMs: 0, errorMessage: null, errorKind: null, retry: noop, visible: true, animate: false };

// Outside a provider (the sidebar rendered alone, tests) the hooks answer "not active": every consumer then draws nothing extra.
const RunningFocusContext = createContext<RunningFocusApi>(INERT_FOCUS);
const RunningMonitorDataContext = createContext<RunningMonitorData>(INERT_DATA);

export const useRunningFocus = (): RunningFocusApi => useContext(RunningFocusContext);
export const useRunningMonitorData = (): RunningMonitorData => useContext(RunningMonitorDataContext);
/** For the workspace: which pane covers the route's own view. Changes only on a user action. */
export const useRunningMainPane = (): RunningMainPane => useContext(RunningFocusContext).mainPane;

/**
 * The focus that is in effect: a clicked node, else the chat session in the URL (when the monitor knows it). Null while
 * the Running tab is not on show.
 */
export function useEffectiveRunningFocus(): RunningFocus | null {
  const { runningActive, explicit, routeSessionId } = useRunningFocus();
  const { snapshot } = useRunningMonitorData();
  return useMemo(() => {
    if (!runningActive) return null;
    if (explicit) return explicit;
    if (!routeSessionId || !snapshot) return null;
    const shown = snapshot.sessions.find((session) => session.openSessionId === routeSessionId || session.id === routeSessionId);
    return shown ? { sessionKey: shown.id, nodeKey: null } : null;
  }, [runningActive, explicit, routeSessionId, snapshot]);
}

type RunningFocusProviderProps = {
  /** The chat session in the URL (`/session/:id`), if any. */
  routeSessionId?: string | null;
  navigate: (path: string) => void;
  /** Leaves the open chat for the start page (no session selected, route `/`). Defaults to a plain `navigate('/')`. */
  onReleaseChat?: () => void;
  /** Called after any focus change, so a phone's sidebar drawer can close and show the pane. */
  onFocusChosen?: () => void;
  children: ReactNode;
};

/** Mounted once by the workspace route, above both the sidebar and the main region. */
export function RunningFocusProvider({ routeSessionId = null, navigate, onReleaseChat, onFocusChosen, children }: RunningFocusProviderProps) {
  const [runningActive, setRunningActive] = useState(false);
  const [explicit, setExplicit] = useState<RunningFocus | null>(null);
  const route = routeSessionId ?? null;
  const [showProcesses, setShowProcesses] = useShowProcesses();

  const visible = usePageVisible();
  const reducedMotion = usePrefersReducedMotion();
  const monitor = useAgentMonitor(runningActive && visible);

  // The handlers read the latest values from refs, so the api object only changes when the focus itself does.
  const live = useRef({ explicit, route, navigate, onReleaseChat, onFocusChosen });
  live.current = { explicit, route, navigate, onReleaseChat, onFocusChosen };
  const leaveChat = useCallback(() => {
    const { onReleaseChat: release, navigate: go } = live.current;
    if (release) release();
    else go('/');
  }, []);

  // Any change of the route drops a graph focus (the route's own view takes over); leaving the tab drops it too.
  useEffect(() => { setExplicit(null); }, [route]);
  useEffect(() => { if (!runningActive) setExplicit(null); }, [runningActive]);
  // Turning the Running tab on takes the user to the monitor at once: an open chat is left for the start page, where the overview
  // shows. Only the off -> on change does this (a chat opened later from inside the tab, e.g. the Activity's "view in chat", stays).
  const wasActive = useRef(false);
  useEffect(() => {
    if (runningActive && !wasActive.current && live.current.route) leaveChat();
    wasActive.current = runningActive;
  }, [runningActive, leaveChat]);
  // Hiding the processes takes away the box a process focus points at.
  useEffect(() => {
    if (!showProcesses && explicit?.nodeKey?.startsWith('proc:')) setExplicit(null);
  }, [showProcesses, explicit]);
  // A focus on a session that has left the picture has nothing to show.
  const sessions = monitor.snapshot?.sessions;
  useEffect(() => {
    if (explicit && sessions && !sessions.some((session) => session.id === explicit.sessionKey)) setExplicit(null);
  }, [explicit, sessions]);

  const toggleNode = useCallback((sessionKey: string, nodeKey: string) => {
    const { explicit: current, onFocusChosen: chosen } = live.current;
    const releasing = current?.sessionKey === sessionKey && current.nodeKey === nodeKey;
    setExplicit(releasing ? null : { sessionKey, nodeKey });
    chosen?.();
  }, []);

  const toggleSession = useCallback(({ sessionKey, chatId }: { sessionKey: string; chatId: string | null }) => {
    const { explicit: current, route: currentRoute, navigate: go, onFocusChosen: chosen } = live.current;
    if (chatId) {
      const releasing = current === null && currentRoute === chatId;
      setExplicit(null);
      if (releasing) leaveChat();
      else go(`/session/${chatId}`);
    } else {
      setExplicit(current?.sessionKey === sessionKey && current.nodeKey === null ? null : { sessionKey, nodeKey: null });
    }
    chosen?.();
  }, [leaveChat]);

  const isChatFocused = useCallback((chatId: string) => live.current.explicit === null && live.current.route === chatId, []);
  const clearNodeFocus = useCallback(() => setExplicit(null), []);
  const releaseChat = useCallback(() => {
    setExplicit(null);
    leaveChat();
    live.current.onFocusChosen?.();
  }, [leaveChat]);

  const mainPane: RunningMainPane = !runningActive ? null : explicit ? 'graph' : route ? null : 'overview';
  const focusApi = useMemo<RunningFocusApi>(
    () => ({ runningActive, explicit, routeSessionId: route, mainPane, setRunningActive, toggleNode, toggleSession, isChatFocused, clearNodeFocus, releaseChat, showProcesses, setShowProcesses }),
    [runningActive, explicit, route, mainPane, toggleNode, toggleSession, isChatFocused, clearNodeFocus, releaseChat, showProcesses, setShowProcesses],
  );

  const { snapshot, status, clockOffsetMs, errorMessage, errorKind, retry } = monitor;
  const animate = visible && !reducedMotion;
  const data = useMemo<RunningMonitorData>(
    () => ({ snapshot, status, clockOffsetMs, errorMessage, errorKind, retry, visible, animate }),
    [snapshot, status, clockOffsetMs, errorMessage, errorKind, retry, visible, animate],
  );

  return (
    <RunningFocusContext.Provider value={focusApi}>
      <RunningMonitorDataContext.Provider value={data}>{children}</RunningMonitorDataContext.Provider>
    </RunningFocusContext.Provider>
  );
}

import { useCallback } from 'react';

import { useRunningFocus, useRunningMonitorData } from '@/modules/agent-monitor/running/RunningFocusContext';

/**
 * Replaces the sidebar's own "open this session" handler in the Running tab, where a session row is a node of the monitor:
 * a click only FOCUSES the session (its numbers show in the main pane) and a second click lets go. It never opens the chat;
 * the Projects tab and the Activity's "view in chat" do that.
 *
 * The row knows the chat's id; the monitor names a session by its own key (a terminal session that the app has a chat for is
 * keyed by the terminal id and points at the chat through `openSessionId`), so the key is looked up in the snapshot.
 */
export function useRunningSessionClick<S extends { id: string }, P>(): (session: S, projectId: P) => void {
  const { toggleSession } = useRunningFocus();
  const { snapshot } = useRunningMonitorData();
  return useCallback((session: S) => {
    const shown = snapshot?.sessions.find((candidate) => candidate.id === session.id || candidate.openSessionId === session.id);
    toggleSession({ sessionKey: shown?.id ?? session.id, chatId: null });
  }, [snapshot, toggleSession]);
}

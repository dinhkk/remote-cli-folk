import { useCallback, type ReactNode } from 'react';
import { useParams, type NavigateFunction } from 'react-router-dom';

import { RunningFocusProvider } from '@/modules/agent-monitor';
import { useProjectSidebarState } from '@/modules/project-workspace/context/ProjectsStateContext';

type RunningFocusBoundaryProps = {
  isMobile: boolean;
  navigate: NavigateFunction;
  children: ReactNode;
};

/**
 * Rendered by ProjectWorkspaceRoute around the shell, so the sidebar (its Running tab) and the main region (the overview
 * and graph pane) share one focus state and one monitor poll. Binds the provider to this route: the chat session in the URL,
 * navigation, and the phone's sidebar drawer, which closes after a focus change so the pane behind it is visible.
 */
export default function RunningFocusBoundary({ isMobile, navigate, children }: RunningFocusBoundaryProps) {
  const { sessionId } = useParams<{ sessionId?: string }>();
  const { setSidebarOpen, handleSessionRelease } = useProjectSidebarState();

  const closeDrawer = useCallback(() => {
    if (isMobile) setSidebarOpen(false);
  }, [isMobile, setSidebarOpen]);

  return (
    <RunningFocusProvider routeSessionId={sessionId ?? null} navigate={navigate} onReleaseChat={handleSessionRelease} onFocusChosen={closeDrawer}>
      {children}
    </RunningFocusProvider>
  );
}

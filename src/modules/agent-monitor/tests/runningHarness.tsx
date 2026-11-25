import { render } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';

import { SHOW_PROCESSES_KEY } from '@/modules/agent-monitor/hooks/useShowProcesses';
import { RunningFocusProvider, useRunningFocus } from '@/modules/agent-monitor/running/RunningFocusContext';

/**
 * Test stand-ins for what the app wires around the Running tab: the router with the two workspace routes (`/` and
 * `/session/:sessionId`, the same element on both, as in App), the focus provider bound to them, and the sidebar's tab switch.
 */

type BoundaryHooks = { onFocusChosen?: () => void; onReleaseChat?: () => void };

function Boundary({ children, hooks }: { children: ReactNode; hooks: BoundaryHooks }) {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId?: string }>();
  return (
    <RunningFocusProvider routeSessionId={sessionId ?? null} navigate={navigate} onFocusChosen={hooks.onFocusChosen} onReleaseChat={hooks.onReleaseChat}>
      {children}
    </RunningFocusProvider>
  );
}

/** Where the router is, so a test can assert a click navigated. */
export const Where = () => <span data-testid="where">{useLocation().pathname}</span>;

/** What the sidebar does with its tab: tells the provider whether the Running tab is the one on show. */
export function RunningTabSwitch({ initiallyOn = true }: { initiallyOn?: boolean }) {
  const { setRunningActive, runningActive } = useRunningFocus();
  useEffect(() => { setRunningActive(initiallyOn); }, [initiallyOn, setRunningActive]);
  return (
    <button type="button" data-testid="tab-switch" aria-pressed={runningActive} onClick={() => setRunningActive(!runningActive)}>
      running tab
    </button>
  );
}

/**
 * Renders `ui` inside the router and the focus provider, at `path`. `hooks` are what the workspace route binds (drawer
 * close, session release). The child processes are drawn unless `showProcesses` is false (the app itself hides them until
 * the user turns them on, and remembers that in storage, which this sets before the provider reads it).
 */
export function renderRunning(ui: ReactNode, path = '/', hooks: BoundaryHooks = {}, { showProcesses = true }: { showProcesses?: boolean } = {}) {
  if (showProcesses) localStorage.setItem(SHOW_PROCESSES_KEY, 'true');
  else localStorage.removeItem(SHOW_PROCESSES_KEY);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<Boundary hooks={hooks}>{ui}</Boundary>} />
        <Route path="/session/:sessionId" element={<Boundary hooks={hooks}>{ui}</Boundary>} />
      </Routes>
    </MemoryRouter>,
  );
}

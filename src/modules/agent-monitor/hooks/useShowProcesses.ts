import { useCallback, useState } from 'react';

/** Where the choice is kept. */
export const SHOW_PROCESSES_KEY = 'agentMonitor.showProcesses';

function readStored(): boolean {
  try {
    return localStorage.getItem(SHOW_PROCESSES_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Whether the monitor draws the child OS processes of a session (graph boxes and tree rows). Hidden until the user turns
 * it on, remembered across loads; a browser that blocks storage still works, forgetting the choice on reload.
 */
export function useShowProcesses(): [boolean, (show: boolean) => void] {
  const [show, setShowState] = useState(readStored);
  const setShow = useCallback((next: boolean) => {
    setShowState(next);
    try {
      localStorage.setItem(SHOW_PROCESSES_KEY, String(next));
    } catch {
      // Storage unavailable: the choice lasts until the page reloads.
    }
  }, []);
  return [show, setShow];
}

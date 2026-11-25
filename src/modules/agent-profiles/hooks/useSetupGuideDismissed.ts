import { useCallback, useEffect, useState } from 'react';

// Browser-local on purpose: the app's synced user preferences only accept the keys the server lists, and
// "I do not want the guide on this device" needs no sync.
const STORAGE_KEY = 'agentProfiles.setupGuideDismissed';
const CHANGE_EVENT = 'agent-profiles:setup-guide-dismissed';

function readDismissed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Whether the user already skipped or finished the first-run guide, shared by everything that invites to it: the
 * wizard that opens by itself in Agent Profiles settings. `dismiss` remembers the answer (and tells every other user
 * of this hook); `reset` brings the invitation back.
 * Used by the agent-profiles panel.
 */
export function useSetupGuideDismissed() {
  // Mirrors the stored flag; re-read on the change event so the hint and the wizard agree without a reload.
  const [dismissed, setDismissed] = useState(readDismissed);

  useEffect(() => {
    const sync = () => setDismissed(readDismissed());
    window.addEventListener(CHANGE_EVENT, sync);
    return () => window.removeEventListener(CHANGE_EVENT, sync);
  }, []);

  const write = useCallback((value: boolean) => {
    try {
      if (value) localStorage.setItem(STORAGE_KEY, '1');
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage unavailable: the answer then only lasts until this component unmounts.
    }
    setDismissed(value);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return { dismissed, dismiss: useCallback(() => write(true), [write]), reset: useCallback(() => write(false), [write]) };
}

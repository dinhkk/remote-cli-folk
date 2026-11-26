import { useEffect, useRef } from 'react';

/**
 * Calls `poll` every `intervalMs` while the page is visible, once more at once when it becomes visible again, and not at all
 * while it is hidden or `enabled` is false. The first read is the caller's job (it differs: with or without a spinner).
 * Used by the pending proposals list and the pending count, which must not load the server while nobody looks.
 */
export function useVisiblePolling(poll: () => void, intervalMs: number, enabled = true): void {
  // The latest `poll`, so a new callback identity does not restart the timer.
  const pollRef = useRef(poll);
  useEffect(() => {
    pollRef.current = poll;
  }, [poll]);

  useEffect(() => {
    if (!enabled) return undefined;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null) timer = setInterval(() => pollRef.current(), intervalMs);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        pollRef.current();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [enabled, intervalMs]);
}

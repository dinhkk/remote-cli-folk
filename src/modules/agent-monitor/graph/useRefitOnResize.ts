import { useEffect, useRef, type MutableRefObject } from 'react';

/** A resize is acted on this long after the last one. */
export const REFIT_DEBOUNCE_MS = 150;

/**
 * Calls `fit` when the graph's frame changes size (the window, the sidebar or the layout around it), unless the user has
 * panned or zoomed since the last fit (`moved`): their view is theirs, and the Fit button or a new set of sessions gives
 * it back. The first size is not a change (the graph is fitted when it opens), and nothing is done for a frame with no size.
 */
export function useRefitOnResize(width: number, height: number, moved: MutableRefObject<boolean>, fit: () => void): void {
  const previous = useRef<{ width: number; height: number } | null>(null);
  const fitRef = useRef(fit);
  useEffect(() => { fitRef.current = fit; }, [fit]);

  useEffect(() => {
    const before = previous.current;
    previous.current = { width, height };
    if (!before || width <= 0 || height <= 0) return undefined;
    if (before.width === width && before.height === height) return undefined;
    const timer = setTimeout(() => {
      if (!moved.current) fitRef.current();
    }, REFIT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [width, height, moved]);
}

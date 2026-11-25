import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

const readPreference = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches;

/**
 * Whether the user asked the system for less motion. The monitor then drops every animation and keeps only colour
 * changes; the preference is followed live, so toggling the system setting takes effect without a reload.
 */
export function usePrefersReducedMotion(): boolean {
  // The current value of the media query; updated by its change event.
  const [reduced, setReduced] = useState(readPreference);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia(QUERY);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);

  return reduced;
}

import { useEffect, useState } from 'react';

/**
 * Whether the browser tab is showing. The monitor stops polling and pauses its animations while the tab is hidden, which
 * also lets the server's CPU/RAM sampler wind down.
 */
export function usePageVisible(): boolean {
  // Mirrors `document.visibilityState`; flips on the `visibilitychange` event.
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');

  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== 'hidden');
    onChange();
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  return visible;
}

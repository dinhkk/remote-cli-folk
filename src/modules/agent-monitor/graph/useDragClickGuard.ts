import { useCallback, useEffect, useRef } from 'react';

/**
 * A drag of a box must not count as a click on it. Browsers (and the drag library) usually swallow the click that ends a drag,
 * but not on every pointer type, so this is the second line: while a drag runs, and for the rest of the task in which it
 * ends (the click, if one comes, is dispatched right after the pointer is released), `isDragging()` says yes and the click
 * handler ignores the click.
 */
export function useDragClickGuard() {
  const dragging = useRef(false);
  const release = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onNodeDragStart = useCallback(() => {
    if (release.current) clearTimeout(release.current);
    release.current = null;
    dragging.current = true;
  }, []);

  const onNodeDragStop = useCallback(() => {
    if (release.current) clearTimeout(release.current);
    release.current = setTimeout(() => {
      dragging.current = false;
      release.current = null;
    }, 0);
  }, []);

  useEffect(() => () => { if (release.current) clearTimeout(release.current); }, []);

  const isDragging = useCallback(() => dragging.current, []);
  return { onNodeDragStart, onNodeDragStop, isDragging };
}

import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** How wide the pane is, in three steps. The layout follows the PANE, not the window: the sidebar changes how much room the pane has. */
export type WidthTier = 'narrow' | 'medium' | 'wide';

/** Below this the pane is one column; from `WIDE_FROM` the graph and the rail sit side by side. Tuned in the live check. */
export const MEDIUM_FROM = 640;
export const WIDE_FROM = 1000;
/** Below this the pane is too narrow for three cards on a row: the cards of the overview then stack one per row. */
export const STACK_BELOW = 340;
/** A resize is acted on this long after the last one, so dragging the sidebar edge does not re-flow on every pixel. */
export const WIDTH_DEBOUNCE_MS = 150;

/** The tier of a width in px. An unknown width (0: not laid out yet, or no layout engine) reads as wide, the desktop shape. */
export function widthTier(width: number): WidthTier {
  if (!(width > 0)) return 'wide';
  if (width < MEDIUM_FROM) return 'narrow';
  return width < WIDE_FROM ? 'medium' : 'wide';
}

/** True for a measured pane too narrow for a row of three cards (an unknown width, 0, is not). */
export function isStackedWidth(width: number): boolean {
  return width > 0 && width < STACK_BELOW;
}

/**
 * The width of the element `ref` points at, rounded, following its size changes (a ResizeObserver, debounced). Measured
 * before the first paint so a phone never flashes the desktop layout. 0 until measured.
 */
export function useElementWidth<T extends HTMLElement>(): { ref: RefObject<T>; width: number } {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    setWidth(Math.round(element.getBoundingClientRect().width));
    if (typeof ResizeObserver === 'undefined') return undefined;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[entries.length - 1]?.contentRect.width ?? element.getBoundingClientRect().width);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setWidth(next), WIDTH_DEBOUNCE_MS);
    });
    observer.observe(element);
    return () => {
      if (timer) clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

  return { ref, width };
}

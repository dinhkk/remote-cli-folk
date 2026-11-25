import { useReactFlow } from '@xyflow/react';
import { useCallback, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';

import { FIT_VIEW_OPTIONS } from '@/modules/agent-monitor/graph/fitViewOptions';
import { useRefitOnResize } from '@/modules/agent-monitor/graph/useRefitOnResize';

/**
 * Draws nothing: sits inside the graph and fits the view again when the graph's frame changes size, unless the user moved
 * the view since the last fit (`moved`). The size is that of the frame this marker sits in (watched with a ResizeObserver),
 * so the pane growing, shrinking or being re-laid-out all count; a snapshot tick never does.
 */
export function FitOnResize({ moved }: { moved: MutableRefObject<boolean> }) {
  const { fitView } = useReactFlow();
  const marker = useRef<HTMLSpanElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const frame = marker.current?.parentElement;
    if (!frame || typeof ResizeObserver === 'undefined') return undefined;
    const read = () => {
      const box = frame.getBoundingClientRect();
      const width = Math.round(box.width);
      const height = Math.round(box.height);
      setSize((before) => (before.width === width && before.height === height ? before : { width, height }));
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  const fit = useCallback(() => { void fitView(FIT_VIEW_OPTIONS); }, [fitView]);
  useRefitOnResize(size.width, size.height, moved, fit);
  return <span ref={marker} hidden aria-hidden="true" />;
}

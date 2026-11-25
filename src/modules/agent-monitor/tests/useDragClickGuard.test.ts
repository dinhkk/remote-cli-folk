import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDragClickGuard } from '@/modules/agent-monitor/graph/useDragClickGuard';

/** A drag of a box must not count as a click on it: the guard says "dragging" until the click that may end the drag has gone by. */

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('useDragClickGuard', () => {
  it('is quiet until a drag starts, so a plain click goes through', () => {
    const { result } = renderHook(() => useDragClickGuard());
    expect(result.current.isDragging()).toBe(false);
  });

  it('says dragging while the drag runs and still right after it ends (the click a browser may send on release), then lets clicks through', () => {
    const { result } = renderHook(() => useDragClickGuard());

    act(() => result.current.onNodeDragStart());
    expect(result.current.isDragging()).toBe(true);

    act(() => result.current.onNodeDragStop());
    expect(result.current.isDragging()).toBe(true);

    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current.isDragging()).toBe(false);
  });

  it('a new drag cancels the pending release of the previous one', () => {
    const { result } = renderHook(() => useDragClickGuard());
    act(() => result.current.onNodeDragStart());
    act(() => result.current.onNodeDragStop());
    act(() => result.current.onNodeDragStart());
    act(() => { vi.advanceTimersByTime(5); });
    expect(result.current.isDragging()).toBe(true);
  });
});

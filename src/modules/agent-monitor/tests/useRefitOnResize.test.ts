import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REFIT_DEBOUNCE_MS, useRefitOnResize } from '@/modules/agent-monitor/graph/useRefitOnResize';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const setup = (moved = false) => {
  const fit = vi.fn();
  const movedRef = { current: moved };
  const view = renderHook(({ width, height }) => useRefitOnResize(width, height, movedRef, fit), { initialProps: { width: 800, height: 400 } });
  return { fit, movedRef, ...view };
};

const settle = () => act(() => { vi.advanceTimersByTime(REFIT_DEBOUNCE_MS); });

describe('useRefitOnResize', () => {
  it('does nothing for the first size: the graph is fitted when it opens', () => {
    const { fit } = setup();
    settle();
    expect(fit).not.toHaveBeenCalled();
  });

  it('fits once when the frame changes size, after it has settled', () => {
    const { fit, rerender } = setup();
    rerender({ width: 500, height: 400 });
    rerender({ width: 480, height: 400 });
    act(() => { vi.advanceTimersByTime(REFIT_DEBOUNCE_MS - 1); });
    expect(fit).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(fit).toHaveBeenCalledTimes(1);
  });

  it('fits when only the height changes', () => {
    const { fit, rerender } = setup();
    rerender({ width: 800, height: 600 });
    settle();
    expect(fit).toHaveBeenCalledTimes(1);
  });

  it('does not fit when the size did not change', () => {
    const { fit, rerender } = setup();
    rerender({ width: 800, height: 400 });
    settle();
    expect(fit).not.toHaveBeenCalled();
  });

  it('leaves the view alone once the user moved it', () => {
    const { fit, rerender } = setup(true);
    rerender({ width: 500, height: 400 });
    settle();
    expect(fit).not.toHaveBeenCalled();
  });

  it('fits again after the user gave the view back (Fit, reset, a new set of sessions)', () => {
    const { fit, movedRef, rerender } = setup(true);
    rerender({ width: 500, height: 400 });
    settle();
    movedRef.current = false;
    rerender({ width: 900, height: 400 });
    settle();
    expect(fit).toHaveBeenCalledTimes(1);
  });

  it('ignores a frame with no size (hidden, not laid out)', () => {
    const { fit, rerender } = setup();
    rerender({ width: 0, height: 0 });
    settle();
    expect(fit).not.toHaveBeenCalled();
  });
});

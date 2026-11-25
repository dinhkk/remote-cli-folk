import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MEDIUM_FROM, WIDE_FROM, WIDTH_DEBOUNCE_MS, useElementWidth, widthTier } from '@/modules/agent-monitor/hooks/useElementWidth';

describe('widthTier', () => {
  it('is narrow below 640, medium from 640 to 999, wide from 1000', () => {
    expect([639, 640, 999, 1000].map(widthTier)).toEqual(['narrow', 'medium', 'medium', 'wide']);
    expect([MEDIUM_FROM, WIDE_FROM]).toEqual([640, 1000]);
  });

  it('reads an unknown width as wide (the desktop shape), so a screen with no layout still draws', () => {
    expect(widthTier(0)).toBe('wide');
  });
});

/** A ResizeObserver the test fires by hand. */
let fire: (width: number) => void = () => undefined;
class ControlledObserver {
  constructor(private readonly callback: ResizeObserverCallback) {
    fire = (width) => this.callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }

  observe() {}
  unobserve() {}
  disconnect() {}
}

function Probe() {
  const { ref, width } = useElementWidth<HTMLDivElement>();
  return <div ref={ref} data-testid="probe">{width}</div>;
}

describe('useElementWidth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('ResizeObserver', ControlledObserver);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 412.6 } as DOMRect);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('measures before anything is observed, rounded', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('413');
  });

  it('follows a resize, but only once it has settled for a moment', () => {
    render(<Probe />);
    act(() => fire(700.4));
    act(() => fire(701.2));
    expect(screen.getByTestId('probe').textContent).toBe('413');
    act(() => { vi.advanceTimersByTime(WIDTH_DEBOUNCE_MS - 1); });
    expect(screen.getByTestId('probe').textContent).toBe('413');
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByTestId('probe').textContent).toBe('701');
  });

  it('stops listening when it unmounts', () => {
    const { unmount } = render(<Probe />);
    act(() => fire(900));
    unmount();
    expect(() => act(() => { vi.advanceTimersByTime(WIDTH_DEBOUNCE_MS * 2); })).not.toThrow();
  });
});

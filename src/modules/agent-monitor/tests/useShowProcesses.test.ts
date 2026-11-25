import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SHOW_PROCESSES_KEY, useShowProcesses } from '@/modules/agent-monitor/hooks/useShowProcesses';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('useShowProcesses', () => {
  it('hides the processes until the user asks for them', () => {
    const { result } = renderHook(() => useShowProcesses());
    expect(result.current[0]).toBe(false);
  });

  it('remembers the choice across loads', () => {
    const first = renderHook(() => useShowProcesses());
    act(() => first.result.current[1](true));
    expect(first.result.current[0]).toBe(true);
    expect(localStorage.getItem(SHOW_PROCESSES_KEY)).toBe('true');
    first.unmount();

    const second = renderHook(() => useShowProcesses());
    expect(second.result.current[0]).toBe(true);
    act(() => second.result.current[1](false));
    expect(localStorage.getItem(SHOW_PROCESSES_KEY)).toBe('false');
  });

  it('ignores a stored value it does not understand', () => {
    localStorage.setItem(SHOW_PROCESSES_KEY, 'maybe');
    expect(renderHook(() => useShowProcesses()).result.current[0]).toBe(false);
  });

  it('still works, hidden by default, when the browser blocks storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const { result } = renderHook(() => useShowProcesses());
    expect(result.current[0]).toBe(false);
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
  });
});

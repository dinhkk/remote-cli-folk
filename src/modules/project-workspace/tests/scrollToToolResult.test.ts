import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { scrollToToolResult } from '@/modules/project-workspace/agents/scrollToToolResult';

/** A chat row as the transcript draws it: `id="tool-result-<toolId>"`, whose `scrollIntoView` we watch. */
const addRow = (toolId: string) => {
  const row = document.createElement('div');
  row.id = `tool-result-${toolId}`;
  row.scrollIntoView = vi.fn();
  document.body.appendChild(row);
  return row;
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

describe('scrollToToolResult', () => {
  it('scrolls to the row once the route has switched to the chat (a short wait first)', () => {
    const row = addRow('toolu_1');
    scrollToToolResult('toolu_1');
    expect(row.scrollIntoView).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(row.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(row.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
  });

  it('keeps looking while the chat loads, and scrolls when the row appears', () => {
    scrollToToolResult('toolu_2');
    vi.advanceTimersByTime(1000);
    const row = addRow('toolu_2');
    vi.advanceTimersByTime(400);
    expect(row.scrollIntoView).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(row.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('gives up after a few seconds when the row never appears', () => {
    scrollToToolResult('toolu_3');
    vi.advanceTimersByTime(10_000);
    const late = addRow('toolu_3');
    vi.advanceTimersByTime(1000);
    expect(late.scrollIntoView).not.toHaveBeenCalled();
  });

  it('can be cancelled', () => {
    const row = addRow('toolu_4');
    const cancel = scrollToToolResult('toolu_4');
    cancel();
    vi.advanceTimersByTime(1000);
    expect(row.scrollIntoView).not.toHaveBeenCalled();
  });
});

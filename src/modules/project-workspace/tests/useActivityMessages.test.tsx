import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionStore } from '@/modules/chat';
import { useActivityMessages } from '@/modules/project-workspace/agents/useActivityMessages';

// The store hands out normalized rows; the hook only needs "some rows" and the chat messages built from them.
vi.mock('@/modules/chat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/chat')>()),
  normalizedToChatMessages: (rows: unknown[]) => rows,
}));

type FakeStore = {
  rows: unknown[];
  getMessages: ReturnType<typeof vi.fn>;
  getSessionSlot: ReturnType<typeof vi.fn>;
  fetchFromServer: ReturnType<typeof vi.fn>;
  refreshLatestFromServer: ReturnType<typeof vi.fn>;
};

/** A stand-in for the session store: `rows` is what the cache holds; a fetch fills it. */
const makeStore = (initial: unknown[] = [], fetched: unknown[] = [{ id: 'm1' }], fetchStatus: 'idle' | 'error' = 'idle'): FakeStore => {
  const store: FakeStore = {
    rows: initial,
    getMessages: vi.fn(() => store.rows),
    getSessionSlot: vi.fn(() => ({ status: fetchStatus })),
    fetchFromServer: vi.fn(async () => { store.rows = fetched; return { status: fetchStatus }; }),
    refreshLatestFromServer: vi.fn(async () => ({ changed: true })),
  };
  return store;
};

const asStore = (store: FakeStore) => store as unknown as SessionStore;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('useActivityMessages', () => {
  it('fetches the history of a chat the store does not hold, then returns its messages', async () => {
    const store = makeStore();
    const { result } = renderHook(() => useActivityMessages(asStore(store), 'chat-1', false));
    expect(result.current.status).toBe('loading');
    expect(result.current.messages).toEqual([]);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(store.fetchFromServer).toHaveBeenCalledTimes(1);
    expect(store.fetchFromServer).toHaveBeenCalledWith('chat-1');
    expect(result.current.status).toBe('ready');
    expect(result.current.messages).toEqual([{ id: 'm1' }]);
  });

  it('does not fetch a chat the store already holds (the open chat keeps itself current)', async () => {
    const store = makeStore([{ id: 'held' }]);
    const { result } = renderHook(() => useActivityMessages(asStore(store), 'chat-1', false));
    expect(result.current.status).toBe('ready');
    expect(result.current.messages).toEqual([{ id: 'held' }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(store.fetchFromServer).not.toHaveBeenCalled();
    expect(store.refreshLatestFromServer).not.toHaveBeenCalled();
  });

  it('reports an error when the fetch fails', async () => {
    const store = makeStore([], [], 'error');
    const { result } = renderHook(() => useActivityMessages(asStore(store), 'chat-1', false));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.status).toBe('error');
  });

  it('while polling, re-reads the latest history every 3 seconds, and once more when polling stops', async () => {
    const store = makeStore([{ id: 'held' }]);
    const { rerender } = renderHook(({ polling }) => useActivityMessages(asStore(store), 'chat-1', polling), { initialProps: { polling: true } });
    expect(store.refreshLatestFromServer).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(store.refreshLatestFromServer).toHaveBeenCalledTimes(1);
    expect(store.refreshLatestFromServer).toHaveBeenCalledWith('chat-1');
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(store.refreshLatestFromServer).toHaveBeenCalledTimes(3);

    rerender({ polling: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(store.refreshLatestFromServer).toHaveBeenCalledTimes(4);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(store.refreshLatestFromServer).toHaveBeenCalledTimes(4);
  });

  it('does not poll while the page is hidden, and stops when unmounted', async () => {
    const store = makeStore([{ id: 'held' }]);
    const { unmount } = renderHook(() => useActivityMessages(asStore(store), 'chat-1', true));
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(store.refreshLatestFromServer).not.toHaveBeenCalled();

    Reflect.deleteProperty(document, 'hidden');
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(store.refreshLatestFromServer).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(store.refreshLatestFromServer).toHaveBeenCalledTimes(1);
  });

  it('starts over for another chat', async () => {
    const store = makeStore();
    const { rerender } = renderHook(({ chatId }) => useActivityMessages(asStore(store), chatId, false), { initialProps: { chatId: 'chat-1' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    store.rows = [];
    rerender({ chatId: 'chat-2' });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(store.fetchFromServer).toHaveBeenLastCalledWith('chat-2');
  });
});

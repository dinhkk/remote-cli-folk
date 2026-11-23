import { act, renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { LLMProvider, NormalizedMessage } from '@/shared/types';

const history = vi.hoisted(() => vi.fn());
vi.mock('@/shared/api', () => ({ api: { providers: { sessionMessages: history } } }));

test.each(['claude', 'codex'] as LLMProvider[])('UI-23: %s reload merges persisted and live response without duplicating the turn', async provider => {
  const sessionId = 'restored-session';
  const message = (id: string, role: 'user' | 'assistant', content: string): NormalizedMessage => ({
    id, sessionId, provider, kind: 'text', role, content, timestamp: '2026-01-01T00:00:00.000Z',
  });
  const prompt = message('prompt', 'user', 'synthetic question');
  const answer = message('answer', 'assistant', 'complete answer');
  let persisted = [prompt];
  history.mockImplementation(async () => ({ ok: true, json: async () => ({
    data: { messages: persisted, total: persisted.length, hasMore: false },
  }) }));
  const before = renderHook(() => useSessionStore());
  act(() => before.result.current.updateStreaming(sessionId, 'partial answer', provider));
  before.unmount();
  const restored = renderHook(() => useSessionStore());
  await act(async () => { await restored.result.current.fetchFromServer(sessionId); });
  act(() => restored.result.current.appendRealtime(sessionId, answer));
  persisted = [prompt, answer];
  await act(async () => { await restored.result.current.refreshLatestFromServer(sessionId); });
  expect(restored.result.current.getMessages(sessionId).map(m => m.content)).toEqual(['synthetic question', 'complete answer']);
  expect(restored.result.current.getMessages('other-session')).toEqual([]);
});

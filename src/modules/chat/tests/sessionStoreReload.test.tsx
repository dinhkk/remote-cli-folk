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


test.each([true, false])('R7-10: replay error merges in its original turn, before REST=%s', async beforeRest => {
 const sessionId = 'error-session';
 const prompt: NormalizedMessage = { id: 'u1', sessionId, provider: 'codex', kind: 'text', role: 'user', content: 'question', timestamp: '2026-01-01T00:00:00.000Z' };
 const later: NormalizedMessage = { ...prompt, id: 'u2', content: 'next question', timestamp: '2026-01-01T00:00:02.000Z' };
 const failure: NormalizedMessage = { id: 'e1', sessionId, provider: 'codex', kind: 'error', content: 'Synthetic rejected model', timestamp: '2026-01-01T00:00:01.000Z' };
 let messages = [prompt, later];
 history.mockImplementation(async () => ({ ok: true, json: async () => ({ data: { messages, total: messages.length, hasMore: false } }) }));
 const view = renderHook(() => useSessionStore());
 if (beforeRest) act(() => view.result.current.appendRealtime(sessionId, failure));
 await act(async () => { await view.result.current.fetchFromServer(sessionId); });
 act(() => { view.result.current.appendRealtime(sessionId, failure); view.result.current.appendRealtime(sessionId, failure); });
 expect(view.result.current.getMessages(sessionId).map(m => m.id)).toEqual(['u1','e1','u2']);
 expect(view.result.current.getMessages('other-session')).toEqual([]);
 messages = [prompt, { ...failure, id: 'persisted-error' }, later];
 await act(async () => { await view.result.current.refreshLatestFromServer(sessionId); });
 expect(view.result.current.getMessages(sessionId).filter(m => m.kind === 'error')).toHaveLength(1);
});

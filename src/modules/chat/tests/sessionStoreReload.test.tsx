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

test.each([true, false])('EH-03: persisted and replay errors with different clocks merge in their own turn, REST first=%s', async restFirst => {
  const sessionId = 'persisted-error-session';
  const row = (id: string, seconds: number, kind: 'text' | 'error', content: string): NormalizedMessage => ({
    id, sessionId, provider: 'codex', kind, ...(kind === 'text' ? { role: 'user' as const } : {}),
    content, timestamp: `2026-01-01T00:00:0${seconds}.000Z`,
  });
  const prompt = row('u1', 0, 'text', 'first');
  const error = row('disk1', 1, 'error', 'rejected model');
  const next = row('u2', 3, 'text', 'second');
  const secondError = row('disk2', 4, 'error', 'rejected model');
  const messages = [prompt, error, next, secondError];
  const replay = { ...error, id: 'live1', timestamp: '2026-01-01T00:00:01.300Z', content: JSON.stringify({ message: 'rejected model' }) };
  history.mockImplementation(async () => ({ ok: true, json: async () => ({ data: { messages, total: messages.length, hasMore: false } }) }));
  const view = renderHook(() => useSessionStore());
  if (!restFirst) act(() => view.result.current.appendRealtime(sessionId, replay));
  await act(async () => { await view.result.current.fetchFromServer(sessionId); });
  act(() => {
    view.result.current.appendRealtime(sessionId, replay);
    view.result.current.appendRealtime(sessionId, { ...secondError, id: 'live2', timestamp: '2026-01-01T00:00:04.400Z' });
  });
  for (let reload = 0; reload < 2; reload++) {
    await act(async () => { await view.result.current.refreshLatestFromServer(sessionId); });
    expect(view.result.current.getMessages(sessionId).map(m => m.id)).toEqual(['u1', 'disk1', 'u2', 'disk2']);
  }
  act(() => view.result.current.appendRealtime(sessionId, { ...secondError, id: 'different-error', content: 'other failure' }));
  expect(view.result.current.getMessages(sessionId).filter(m => m.kind === 'error')).toHaveLength(3);
});

test.each(['claude', 'codex'] as LLMProvider[])('EH-03: %s live error wrappers and history render once, retaining distinct failures', async provider => {
  const sessionId = `wrapped-${provider}`;
  const content = provider === 'claude' ? 'Not logged in · Please run /login' : 'nested model error';
  const wrapped = provider === 'claude' ? `Claude Code returned an error result: ${content}`
    : JSON.stringify({ error: { message: content, type: 'invalid_request_error' } });
  const prompt: NormalizedMessage = { id: 'u', sessionId, provider, kind: 'text', role: 'user', content: 'test', timestamp: '2026-01-01T00:00:00.000Z' };
  const error: NormalizedMessage = { id: 'sdk', sessionId, provider, kind: 'error', content, timestamp: '2026-01-01T00:00:01.000Z' };
  const terminal = { ...error, id: 'runtime', content: wrapped, timestamp: '2026-01-01T00:00:01.200Z' };
  const other = { ...error, id: 'other', content: 'A different error in the same turn', timestamp: '2026-01-01T00:00:01.400Z' };
  const persisted = [prompt, { ...error, id: 'disk' }];
  history.mockImplementation(async () => ({ ok: true, json: async () => ({ data: { messages: persisted, total: 2, hasMore: false } }) }));
  const live = renderHook(() => useSessionStore());
  act(() => {
    live.result.current.appendRealtime(sessionId, prompt);
    live.result.current.appendRealtime(sessionId, error);
    live.result.current.appendRealtime(sessionId, terminal);
  });
  expect(live.result.current.getMessages(sessionId).map(m => m.kind)).toEqual(['text', 'error']);
  act(() => live.result.current.appendRealtime(sessionId, other));
  expect(live.result.current.getMessages(sessionId).filter(m => m.kind === 'error')).toHaveLength(2);
  live.unmount();
  for (const beforeRest of [true, false]) {
    const reloaded = renderHook(() => useSessionStore());
    if (beforeRest) act(() => reloaded.result.current.appendRealtime(sessionId, terminal));
    await act(async () => { await reloaded.result.current.fetchFromServer(sessionId); });
    act(() => reloaded.result.current.appendRealtime(sessionId, terminal));
    for (let refresh = 0; refresh < 2; refresh++) {
      await act(async () => { await reloaded.result.current.refreshLatestFromServer(sessionId); });
      expect(reloaded.result.current.getMessages(sessionId).map(m => m.kind)).toEqual(['text', 'error']);
    }
    act(() => reloaded.result.current.appendRealtime(sessionId, other));
    expect(reloaded.result.current.getMessages(sessionId).filter(m => m.kind === 'error')).toHaveLength(2);
    reloaded.unmount();
  }
});

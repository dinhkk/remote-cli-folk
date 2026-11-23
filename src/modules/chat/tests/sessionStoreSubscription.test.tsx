import { memo } from 'react';
import { act, render, renderHook, screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import { useSessionStore, useSessionStoreRevision } from '@/modules/chat/hooks/useSessionStore';

test('UI-21/UI-22: visible memoized consumer updates without its parent, hidden consumer catches up on activation', () => {
  const owner = renderHook(() => useSessionStore());
  const store = owner.result.current;
  let renders = 0;
  const Consumer = memo(({ active, sessionId }: { active: boolean; sessionId: string }) => {
    renders++;
    useSessionStoreRevision(store, active ? sessionId : null);
    return <output data-testid="messages">{store.getMessages(sessionId).map(m => m.content).join('|')}</output>;
  });
  const append = (sessionId: string, content: string) => store.appendRealtime(sessionId, {
    id: content, sessionId, provider: 'claude', kind: 'text', role: 'assistant', content,
    timestamp: '2026-01-01T00:00:00.000Z',
  });
  const view = render(<Consumer active sessionId="viewed" />);
  act(() => append('viewed', 'first'));
  expect(screen.getByTestId('messages').textContent).toBe('first');
  const shownRenders = renders;
  act(() => append('another', 'unrelated'));
  expect(renders).toBe(shownRenders);
  view.rerender(<Consumer active={false} sessionId="viewed" />);
  const hiddenRenders = renders;
  act(() => { append('viewed', 'second'); append('viewed', 'third'); });
  expect(renders).toBe(hiddenRenders);
  view.rerender(<Consumer active sessionId="viewed" />);
  expect(screen.getByTestId('messages').textContent).toBe('first|second|third');
});

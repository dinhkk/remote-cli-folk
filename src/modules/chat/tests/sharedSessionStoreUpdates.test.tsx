import { memo } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useSessionStore, useSessionStoreRevision, type SessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { NormalizedMessage } from '@/shared/types';

vi.mock('@/shared/api', () => ({ api: { providers: {} } }));
afterEach(cleanup);

it('updates a memoized transcript sharing its parent store after replay, without resending', () => {
  let store: SessionStore;
  let renders = 0;
  const Transcript = memo(({ store, active }: { store: SessionStore; active: boolean }) => {
    useSessionStoreRevision(store, active ? 'resumed-session' : null);
    renders++;
    return <div data-testid="transcript">{store.getMessages('resumed-session').map(m => m.content).join('|')}</div>;
  });
  function Owner({ active = true }: { active?: boolean }) {
    store = useSessionStore();
    store.setActiveSession(active ? 'resumed-session' : null);
    return <Transcript store={store} active={active} />;
  }
  const row = (id: string, content: string, sessionId = 'resumed-session') => ({
    id, content, sessionId, provider: 'codex', kind: 'text', role: 'assistant', timestamp: '2026-11-19T04:00:00Z',
  } as NormalizedMessage);
  const view = render(<Owner />);
  const originalStore = store!;
  act(() => store.appendRealtime('resumed-session', row('start', 'before reload')));
  expect(screen.getByTestId('transcript').textContent).toBe('before reload');
  act(() => store.appendRealtime('resumed-session', row('end', 'after reload')));
  expect(screen.getByTestId('transcript').textContent).toBe('before reload|after reload');
  expect(store!).toBe(originalStore);

  const previousRenders = renders;
  act(() => store.appendRealtime('other-session', row('other', 'unrelated', 'other-session')));
  expect(renders).toBe(previousRenders);
  view.rerender(<Owner active={false} />);
  const hiddenRenders = renders;
  act(() => store.appendRealtime('resumed-session', row('hidden', 'arrived while hidden')));
  expect(renders).toBe(hiddenRenders);
  view.rerender(<Owner />);
  expect(screen.getByTestId('transcript').textContent).toBe('before reload|after reload|arrived while hidden');
});

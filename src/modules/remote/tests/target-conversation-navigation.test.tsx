import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TargetConversationNavigation, TARGET_CONVERSATION_KEY } from '@/modules/remote/TargetConversationNavigation';
import { applyTabStorageWrite, readTabStorageSnapshot } from '@/shared/transport/controller-tab-storage';

const mode = vi.hoisted(() => ({ target: true }));
vi.mock('@/shared/transport/target-context', () => ({ isTargetMode: () => mode.target }));

function Location() {
  const location = useLocation();
  const navigate = useNavigate();
  return <><output data-testid="path">{location.pathname}</output><button onClick={() => navigate('/')}>Root</button></>;
}
function mount(initial = '/') {
  return render(<StrictMode><MemoryRouter initialEntries={[initial]}>
    <TargetConversationNavigation /><Location />
  </MemoryRouter></StrictMode>);
}

beforeEach(() => { localStorage.clear(); mode.target = true; });

describe('Host conversation navigation', () => {
  it('UI-13/UI-16/UI-18: restores once without sending a request; returning to root clears it', async () => {
    localStorage.setItem(TARGET_CONVERSATION_KEY, '/session/remembered-1');
    const request = vi.spyOn(globalThis, 'fetch');
    try {
      mount();
      await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/session/remembered-1'));
      expect(request).not.toHaveBeenCalled();
      fireEvent.click(screen.getByText('Root'));
      await waitFor(() => expect(localStorage.getItem(TARGET_CONVERSATION_KEY)).toBeNull());
      expect(screen.getByTestId('path').textContent).toBe('/');
      expect(request).not.toHaveBeenCalled();
    } finally { request.mockRestore(); }
  });

  it('UI-15: an explicit conversation link overrides the stored conversation', () => {
    localStorage.setItem(TARGET_CONVERSATION_KEY, '/session/old');
    mount('/session/explicit');
    expect(screen.getByTestId('path').textContent).toBe('/session/explicit');
    expect(localStorage.getItem(TARGET_CONVERSATION_KEY)).toBe('/session/explicit');
  });

  it.each(['//example.invalid', '/session/', '/session/a/b', '/session/%2f', '/session/' + 'x'.repeat(129)])(
    'UI-14/KU-08: rejects malformed stored path %s', path => {
      localStorage.setItem(TARGET_CONVERSATION_KEY, path);
      mount();
      expect(screen.getByTestId('path').textContent).toBe('/');
      expect(localStorage.getItem(TARGET_CONVERSATION_KEY)).toBeNull();
    },
  );

  it('UI-19: Local mode neither restores nor changes stored navigation', () => {
    mode.target = false;
    localStorage.setItem(TARGET_CONVERSATION_KEY, '/session/remote');
    mount('/session/local');
    expect(screen.getByTestId('path').textContent).toBe('/session/local');
    expect(localStorage.getItem(TARGET_CONVERSATION_KEY)).toBe('/session/remote');
  });

  it('UI-17: the Controller storage bridge keeps conversation paths separate per Host', () => {
    applyTabStorageWrite('host-a', { area: 'local', key: TARGET_CONVERSATION_KEY, value: '/session/a' });
    applyTabStorageWrite('host-b', { area: 'local', key: TARGET_CONVERSATION_KEY, value: '/session/b' });
    expect(readTabStorageSnapshot('host-a').local[TARGET_CONVERSATION_KEY]).toBe('/session/a');
    expect(readTabStorageSnapshot('host-b').local[TARGET_CONVERSATION_KEY]).toBe('/session/b');
    expect(readTabStorageSnapshot('host-c').local[TARGET_CONVERSATION_KEY]).toBeUndefined();
  });
});

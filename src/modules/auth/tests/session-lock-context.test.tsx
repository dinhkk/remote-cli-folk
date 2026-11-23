import { useEffect } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { AuthProvider, useAuth } from '@/modules/auth/context/AuthContext';
import { lockAuthSession } from '@/shared/authToken';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

it('L-02: reload of a locked session preserves remote navigation, then TOTP unlock reloads account state', async () => {
  let locked = true;
  let auth!: ReturnType<typeof useAuth>;
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    let status = 200;
    let body: unknown = {};
    if (url === '/api/auth/status') body = { needsSetup: false };
    if (url === '/api/auth/session-status') body = { locked };
    if (url === '/api/auth/user') {
      status = locked ? 423 : 200;
      body = locked ? { code: 'AUTH_SESSION_LOCKED' } : { user: { id: 1, username: 'test-user' } };
    }
    if (url === '/api/user/onboarding-status') body = { hasCompletedOnboarding: true };
    if (url === '/api/auth/unlock') {
      if (JSON.parse(String(options?.body)).code !== '123456') status = 403;
      else { locked = false; body = { locked: false }; }
    }
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal('fetch', fetcher);
  localStorage.setItem('remote:peer_one11111:local:draft', 'keep');
  function Probe() { const current = useAuth(); useEffect(() => { auth = current; }); return null; }
  render(<AuthProvider><Probe /></AuthProvider>);
  await waitFor(() => expect(auth.isLoading).toBe(false));
  expect(auth.isLocked).toBe(true);
  expect(auth.user).toBeNull();
  expect(localStorage.getItem('remote:peer_one11111:local:draft')).toBe('keep');
  await act(async () => { expect((await auth.unlock('000000')).success).toBe(false); });
  expect(auth.isLocked).toBe(true);
  await act(async () => { expect((await auth.unlock('123456')).success).toBe(true); });
  expect(auth.isLocked).toBe(false);
  expect(auth.user?.username).toBe('test-user');
  act(() => lockAuthSession());
  expect(auth.isLocked).toBe(true);
  expect(auth.user?.username).toBe('test-user');
  expect(localStorage.getItem('remote:peer_one11111:local:draft')).toBe('keep');
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/auth/unlock')).toHaveLength(2);
});

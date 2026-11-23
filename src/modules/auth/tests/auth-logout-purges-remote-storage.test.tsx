import assert from 'node:assert/strict';

import { act, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { AUTH_SESSION_EXPIRED_EVENT } from '@/shared/authToken';
import { SELECTED_REMOTE_TAB_KEY } from '@/shared/transport/navigation-storage';
import { AuthProvider, useAuth } from '@/modules/auth/context/AuthContext';

/**
 * What a Remote tab kept in this browser (drafts, last project, ...) came from a
 * Host. Signing out of the Controller must not leave it for the next person who
 * uses the device (contracts.md section 10).
 */

const makeToken = () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ userId: 1, username: 'alice', iat: now, exp: now + 86_400 })}.sig`;
};

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = url === '/api/auth/status'
        ? { needsSetup: false }
        : url === '/api/auth/user'
          ? { user: { id: 1, username: 'alice' } }
          : url === '/api/user/onboarding-status'
            ? { hasCompletedOnboarding: true }
            : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

test('logout deletes every remote:* entry and leaves the rest of localStorage alone', async () => {
  localStorage.setItem('auth-token', makeToken());
  localStorage.setItem('remote:peer_one11111:local:activeTab', 'git');
  localStorage.setItem('remote:peer_two22222:local:draft', 'hello');
  localStorage.setItem('unrelated-setting', 'keep');
  let logout: (() => void) | null = null;
  let user: unknown = null;
  function Probe() {
    const auth = useAuth();
    useEffect(() => {
      logout = auth.logout;
      user = auth.user;
    });
    return null;
  }
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  await waitFor(() => assert.notEqual(user, null));

  await act(async () => { await logout?.(); });

  assert.equal(localStorage.getItem('remote:peer_one11111:local:activeTab'), null);
  assert.equal(localStorage.getItem('remote:peer_two22222:local:draft'), null);
  assert.equal(localStorage.getItem('unrelated-setting'), 'keep');
});


test.each(['logout', 'expired', 'revoked', 'new-account'] as const)('UI-12/KU-09: clears saved Host on %s', async (reason) => {
  let auth: ReturnType<typeof useAuth> | null = null;
  function NavigationProbe() {
    const value = useAuth();
    useEffect(() => { auth = value; });
    return null;
  }
  render(<AuthProvider><NavigationProbe /></AuthProvider>);
  await waitFor(() => assert.ok(auth?.user));
  sessionStorage.setItem(SELECTED_REMOTE_TAB_KEY, 'host-A');
  sessionStorage.setItem('unrelated-preference', 'keep');
  await act(async () => {
    if (reason === 'logout') await auth?.logout();
    else if (reason === 'new-account') {
      const previousFetch = globalThis.fetch;
      vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => url === '/api/auth/login'
        ? new Response(JSON.stringify({ user: { id: 2, username: 'another-user' } }), { status: 200 })
        : previousFetch(url, options)));
      await auth?.login('another-user', 'synthetic-password');
    } else window.dispatchEvent(new Event(AUTH_SESSION_EXPIRED_EVENT));
  });
  assert.equal(sessionStorage.getItem(SELECTED_REMOTE_TAB_KEY), null);
  assert.equal(sessionStorage.getItem('unrelated-preference'), 'keep');
});

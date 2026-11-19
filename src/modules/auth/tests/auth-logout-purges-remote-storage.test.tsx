import assert from 'node:assert/strict';

import { act, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { AuthProvider, useAuth } from '@/modules/auth/context/AuthContext';
import { storeAuthToken } from '@/shared/authToken';

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
  localStorage.clear();
});

test('logout deletes every remote:* entry and leaves the rest of localStorage alone', async () => {
  storeAuthToken(makeToken());
  localStorage.setItem('remote:peer_one11111:local:activeTab', 'git');
  localStorage.setItem('remote:peer_two22222:local:draft', 'hello');
  localStorage.setItem('unrelated-setting', 'keep');
  sessionStorage.setItem('remotecli:selected-host', 'peer_one11111');
  localStorage.setItem('remote:peer_one11111:local:remotecli:last-session-path', '/session/old-session');
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

  act(() => logout?.());

  assert.equal(localStorage.getItem('remote:peer_one11111:local:activeTab'), null);
  assert.equal(localStorage.getItem('remote:peer_two22222:local:draft'), null);
  assert.equal(localStorage.getItem('unrelated-setting'), 'keep');
  assert.equal(sessionStorage.getItem('remotecli:selected-host'), null);
  assert.equal(localStorage.getItem('remote:peer_one11111:local:remotecli:last-session-path'), null);
});

import '@/modules/i18n';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { AuthProvider } from '@/modules/auth/context/AuthContext';
import ProtectedRoute from '@/modules/auth/ProtectedRoute';
import { expireAuthSession } from '@/shared/authToken';

const EXPIRED = 'Your session expired. Please log in again.';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

// Drives the real AuthProvider: `/api/auth/user` answers with the given status and X-Auth-Error.
function stubStartup(userStatus: number, reason?: string) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/auth/status') return Response.json({ needsSetup: false });
    if (url === '/api/user/onboarding-status') return Response.json({ hasCompletedOnboarding: true });
    if (url === '/api/auth/user') {
      return userStatus === 200
        ? Response.json({ user: { id: 1, username: 'synthetic' } })
        : Response.json({ code: 'AUTH_TOKEN_INVALID' }, { status: userStatus, headers: reason ? { 'X-Auth-Error': reason } : {} });
    }
    return Response.json({});
  }));
}

const renderApp = () => render(<AuthProvider><ProtectedRoute><p>Signed-in content</p></ProtectedRoute></AuthProvider>);

it('SF-01: a browser that never signed in sees the login page without the expiry notice', async () => {
  stubStartup(401, 'session-required');
  renderApp();
  await screen.findByRole('button', { name: 'Sign In' });
  expect(screen.queryByText(EXPIRED)).toBeNull();
});

it('SF-01: a cookie the server no longer accepts still shows the expiry notice at startup', async () => {
  stubStartup(401, 'session-expired');
  renderApp();
  await screen.findByRole('button', { name: 'Sign In' });
  expect(screen.getByText(EXPIRED)).toBeTruthy();
});

it.each(['session-required', 'session-expired', undefined])('SF-01: a signed-in page that loses its session (%s) shows the expiry notice', async reason => {
  stubStartup(200);
  renderApp();
  await screen.findByText('Signed-in content');
  act(() => expireAuthSession(reason));
  await screen.findByRole('button', { name: 'Sign In' });
  expect(screen.getByText(EXPIRED)).toBeTruthy();
});

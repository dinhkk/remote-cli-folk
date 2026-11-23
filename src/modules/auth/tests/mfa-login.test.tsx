import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import '@/modules/i18n';
import { AuthProvider, ProtectedRoute } from '@/modules/auth';

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });
it('A-01/A-02: only a challenge remains between password and MFA; successful verification opens the workspace', async () => {
  const challenge = 'synthetic-challenge';
  const fetcher = vi.fn(async (url: string) => {
    if (url === '/api/auth/status') return reply({ needsSetup: false });
    if (url === '/api/auth/user') return reply({}, 401);
    if (url === '/api/auth/login') return reply({ success: true, mfaRequired: true, challenge });
    if (url === '/api/auth/mfa/verify') return reply({ success: true, user: { id: 1, username: 'alice' } });
    if (url === '/api/user/onboarding-status') return reply({ hasCompletedOnboarding: true });
    return reply({});
  });
  vi.stubGlobal('fetch', fetcher);
  render(<AuthProvider><ProtectedRoute><div data-testid="workspace" /></ProtectedRoute></AuthProvider>);
  fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'alice' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'synthetic-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));
  const input = await screen.findByLabelText('Authenticator code');
  expect(screen.queryByLabelText('Password')).toBeNull();
  expect(screen.queryByTestId('workspace')).toBeNull();
  expect(JSON.stringify(localStorage).includes(challenge)).toBe(false);
  expect(JSON.stringify(sessionStorage).includes(challenge)).toBe(false);
  fireEvent.change(input, { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
  await screen.findByTestId('workspace');
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/auth/mfa/verify')).toHaveLength(1);
});

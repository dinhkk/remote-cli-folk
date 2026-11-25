import '@/modules/i18n';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import TotpSettings from '@/modules/settings/tabs/TotpSettings';
import { AUTH_SESSION_LOCKED_EVENT } from '@/shared/authToken';

vi.mock('qrcode', () => ({ default: { toCanvas: async () => undefined } }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each([false, true])('L-09/L-10: lock controls only appear with TOTP enabled=%s', async enabled => {
  const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(
    url === '/api/auth/mfa/status' ? { enabled } : { autoLock: true },
  ), { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  render(<TotpSettings />);
  await screen.findByText(enabled ? 'Enabled. New sign-ins require your authenticator.' : 'Disabled. Enable it to protect new sign-ins.');
  if (enabled) {
    await waitFor(() => expect(screen.getByRole('checkbox').getAttribute('disabled')).toBeNull());
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('button', { name: 'Lock now' })).toBeTruthy();
    // No optimistic disabling when the server refuses a change.
    fetcher.mockImplementation(async () => new Response('{}', { status: 403 }));
    fireEvent.click(screen.getByRole('checkbox'));
    await screen.findByRole('alert');
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    const locked = vi.fn();
    window.addEventListener(AUTH_SESSION_LOCKED_EVENT, locked);
    try {
      fetcher.mockImplementation(async () => new Response('{"locked":true}', { status: 200 }));
      fireEvent.click(screen.getByRole('button', { name: 'Lock now' }));
      await waitFor(() => expect(locked).toHaveBeenCalledTimes(1));
    } finally { window.removeEventListener(AUTH_SESSION_LOCKED_EVENT, locked); }
  } else {
    expect(screen.queryByRole('button', { name: 'Lock now' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(fetcher.mock.calls.some(([url]) => url === '/api/auth/session-status')).toBe(false);
  }
});


it('K-23: activation reveals lock controls with the server default enabled', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const body = url === '/api/auth/mfa/status' ? { enabled: false }
      : url === '/api/auth/mfa/enroll' ? { secret: 'TESTONLY', uri: 'otpauth://totp/test', expiresAt: Date.now() + 60_000 }
        : url === '/api/auth/mfa/activate' ? { recoveryCodes: ['test-recovery'] }
          : { autoLock: true };
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  render(<TotpSettings />);
  await screen.findByText('Disabled. Enable it to protect new sign-ins.');
  fireEvent.change(screen.getAllByLabelText('Current password')[0], { target: { value: 'test-password-only' } });
  fireEvent.click(screen.getByRole('button', { name: 'Set up authenticator' }));
  const code = await screen.findByLabelText('Authenticator code');
  fireEvent.change(code, { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Activate' }));
  await screen.findByRole('button', { name: 'Lock now' });
  await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true));
});


it('R7-02: loads account hours, confirms increase through reauth and preserves saved hours on failure', async () => {
  const { registerMfaReauth } = await import('@/shared/authToken');
  const prompt = vi.fn(async () => true);
  const unregister = registerMfaReauth(prompt);
  let attempts = 0;
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/auth/mfa/status') return new Response('{"enabled":true}');
    if (url === '/api/auth/auto-lock') {
      expect(options?.body).toBe('{"idleHours":48}');
      return ++attempts === 1
        ? new Response('{"code":"MFA_REAUTH_REQUIRED"}', { status: 403 })
        : new Response('{"autoLock":true,"idleHours":48}');
    }
    return new Response('{"autoLock":true,"idleHours":12}');
  });
  vi.stubGlobal('fetch', fetcher);
  try {
    render(<TotpSettings />);
    const hours = await screen.findByRole('spinbutton', { name: 'Hours before automatic lock' });
    await waitFor(() => expect((hours as HTMLInputElement).value).toBe('12'));
    expect(screen.getByText('Automatically lock after 12 hours without web activity')).toBeTruthy();
    fireEvent.change(hours, { target: { value: '48' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save hours' }));
    await screen.findByText('Automatically lock after 48 hours without web activity');
    expect(prompt).toHaveBeenCalledTimes(1); expect(attempts).toBe(2);
    fetcher.mockImplementation(async () => new Response('{}', { status: 400 }));
    fireEvent.change(hours, { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save hours' }));
    await screen.findByRole('alert');
    expect(screen.getByText('Automatically lock after 48 hours without web activity')).toBeTruthy();
    fireEvent.change(hours, { target: { value: '169' } });
    expect(screen.getByRole('button', { name: 'Save hours' }).getAttribute('aria-disabled')).toBe('true');
  } finally { unregister(); }
});

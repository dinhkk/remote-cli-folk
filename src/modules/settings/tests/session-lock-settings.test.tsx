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

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import SessionLockSettings from '@/modules/settings/tabs/SessionLockSettings';
import { registerMfaReauth } from '@/shared/authToken';
const locales = import.meta.glob('../../i18n/locales/*/auth.json', { eager: true, import: 'default' }) as Record<string, { security: Record<string, string> }>;
afterEach(async () => { cleanup(); vi.unstubAllGlobals(); await i18n.changeLanguage('en'); });
it('R7-03: all locales translate every security key and English hour pluralizes', () => {
 const required = Object.keys(locales['../../i18n/locales/en/auth.json'].security);
 expect(Object.keys(locales)).toHaveLength(15);
 for (const value of Object.values(locales)) for (const key of required) expect(value.security[key], key).toBeTruthy();
 expect(i18n.t('auth:security.lockDescription', { count: 1 })).toBe('Automatically lock after 1 hour without web activity');
 expect(i18n.t('auth:security.lockDescription', { count: 2 })).toBe('Automatically lock after 2 hours without web activity');
});
it('R7-03: cancelling recent MFA keeps policy without displaying a failure', async () => {
 const remove = registerMfaReauth(async () => false);
 const fetcher = vi.fn(async (url: string) => url.endsWith('session-status')
  ? new Response('{"autoLock":true,"idleHours":1}')
  : new Response('{"code":"MFA_REAUTH_REQUIRED"}', { status: 403 }));
 vi.stubGlobal('fetch', fetcher);
 try {
  render(<SessionLockSettings />);
  const input = screen.getByRole('spinbutton');
  await waitFor(() => expect((input as HTMLInputElement).value).toBe('1'));
  fireEvent.change(input, { target: { value: '5' } }); fireEvent.click(screen.getByText('Save hours'));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('Automatically lock after 1 hour without web activity')).toBeTruthy();
 } finally { remove(); }
});

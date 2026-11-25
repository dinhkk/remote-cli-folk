import '@/modules/i18n';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { MfaReauthDialog } from '@/modules/auth';
import { api } from '@/shared/api';
import { requestMfaReauth } from '@/shared/authToken';
import SessionLockSettings from '@/modules/settings/tabs/SessionLockSettings';
import ApiKeysSection from '@/modules/settings/tabs/api-settings/sections/ApiKeysSection';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('R7-04: Save hours remains focusable after successful reauth and unchanged saved value', async () => {
  vi.spyOn(api.auth, 'sessionStatus').mockResolvedValue(new Response(JSON.stringify({ autoLock: true, idleHours: 1 })));
  vi.spyOn(api.auth, 'mfaReauth').mockResolvedValue(new Response(JSON.stringify({ success: true })));
  const update = vi.spyOn(api.auth, 'setIdleLockHours').mockImplementation(async () => {
    await requestMfaReauth();
    return new Response(JSON.stringify({ idleHours: 7 }));
  });
  render(<><SessionLockSettings /><MfaReauthDialog /></>);
  const hours = await screen.findByRole('spinbutton');
  await waitFor(() => expect((hours as HTMLInputElement).value).toBe('1'));
  fireEvent.change(hours, { target: { value: '7' } });
  const opener = screen.getByRole('button', { name: 'Save hours' });
  opener.focus(); fireEvent.click(opener);
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(dialog.querySelector('input')!, { target: { value: '123456' } });
  fireEvent.submit(dialog);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(opener));
  expect(opener.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(opener);
  expect(update).toHaveBeenCalledTimes(1);
});

it('R7-04: API key activation restores focus to its toggle after verification', async () => {
  vi.spyOn(api.auth, 'mfaReauth').mockResolvedValue(new Response(JSON.stringify({ success: true })));
  const toggle = vi.fn(async () => { await requestMfaReauth(); });
  render(<><ApiKeysSection apiKeys={[{ id: 'test-key', key_name: 'Synthetic', api_key: 'masked', created_at: '2026-01-01', is_active: false }]}
    showNewKeyForm={false} newKeyName="" onShowNewKeyFormChange={vi.fn()} onNewKeyNameChange={vi.fn()}
    onCreateApiKey={vi.fn()} onCancelCreateApiKey={vi.fn()} onDeleteApiKey={vi.fn()} onToggleApiKey={toggle} />
    <MfaReauthDialog /></>);
  const opener = screen.getByRole('button', { name: 'Inactive' });
  opener.focus(); fireEvent.click(opener);
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(dialog.querySelector('input')!, { target: { value: '123456' } });
  fireEvent.submit(dialog);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(document.activeElement).toBe(opener);
  expect(toggle).toHaveBeenCalledTimes(1);
});

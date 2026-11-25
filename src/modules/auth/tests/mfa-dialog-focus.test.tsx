import '@/modules/i18n';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import MfaReauthDialog from '@/modules/auth/MfaReauthDialog';
import { requestMfaReauth } from '@/shared/authToken';
import { api } from '@/shared/api';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('R7-04: traps both tab directions, Escape cancels and restores focus', async () => {
  render(<><button>Open</button><MfaReauthDialog /><button>Outside</button></>);
  const opener = screen.getByText('Open'); opener.focus();
  let result!: Promise<boolean>;
  act(() => { result = requestMfaReauth(); });
  const dialog = screen.getByRole('dialog');
  const first = dialog.querySelector('input')!;
  const buttons = dialog.querySelectorAll('button');
  const last = buttons[buttons.length - 1];
  first.focus(); fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(last);
  fireEvent.keyDown(last, { key: 'Tab' }); expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: 'Escape' });
  expect(await result).toBe(false); expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(opener);
});

it.each(['Escape', 'Cancel', 'Verify'])('R7-04: %s restores focus after a disabled trigger becomes enabled', async action => {
  vi.spyOn(api.auth, 'mfaReauth').mockResolvedValue(new Response(JSON.stringify({ success: true })));
  render(<><button>Enable API key</button><MfaReauthDialog /></>);
  const opener = screen.getByText('Enable API key') as HTMLButtonElement;
  opener.focus(); opener.disabled = true;
  let result!: Promise<boolean>;
  act(() => { result = requestMfaReauth(); });
  const input = screen.getByRole('dialog').querySelector('input')!;
  if (action === 'Escape') fireEvent.keyDown(input, { key: 'Escape' });
  else if (action === 'Cancel') fireEvent.click(screen.getByText('Cancel'));
  else {
    fireEvent.change(input, { target: { value: '123456' } });
    fireEvent.submit(screen.getByRole('dialog'));
  }
  await act(async () => { expect(await result).toBe(action === 'Verify'); });
  expect(screen.queryByRole('dialog')).toBeNull();
  // The original API call settles after the dialog promise, not before it.
  opener.disabled = false;
  await waitFor(() => expect(document.activeElement).toBe(opener));
});

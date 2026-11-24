import '@/modules/i18n';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import MfaReauthDialog from '@/modules/auth/MfaReauthDialog';
import { requestMfaReauth } from '@/shared/authToken';
afterEach(cleanup);
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

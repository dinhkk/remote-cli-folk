import '@/modules/i18n';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import TotpSettings from '@/modules/settings/tabs/TotpSettings';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('R7-05: enrollment and password change retain separate current passwords', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"enabled":false}')));
  const { container } = render(<TotpSettings />);
  await waitFor(() => expect(container.querySelector('button')?.disabled).toBe(false));
  const enrollment = container.querySelector<HTMLInputElement>('#totp-password')!;
  const change = container.querySelector<HTMLInputElement>('#change-current-password')!;
  fireEvent.change(enrollment, { target: { value: 'enroll-only' } });
  expect(change.value).toBe('');
  fireEvent.change(change, { target: { value: 'change-only' } });
  expect(enrollment.value).toBe('enroll-only'); expect(change.value).toBe('change-only');
});

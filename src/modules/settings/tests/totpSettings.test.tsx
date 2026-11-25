import '@/modules/i18n';
import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import QRCode from 'qrcode';

import TotpSettings from '@/modules/settings/tabs/TotpSettings';

const reply = (body: unknown) => new Response(JSON.stringify(body));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('T-09: QR matrix generation is local and requires no network', () => {
  const network = vi.fn(() => { throw new Error('No network allowed'); });
  vi.stubGlobal('fetch', network);
  const result = QRCode.create('otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP&issuer=Example');
  expect(result.modules.size).toBeGreaterThan(20);
  expect(result.modules.data.length).toBe(result.modules.size ** 2);
  expect(network).not.toHaveBeenCalled();
});
it('T-00/T-05/T-06/T-09: setup draws locally, clears password and displays recovery codes only until dismissed', async () => {
  const renderQr = vi.spyOn(QRCode, 'toCanvas').mockResolvedValue(undefined);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const codes = Array.from({ length: 10 }, (_, i) => `synthetic-recovery-${i}`);
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  const fetcher = vi.fn(async (url: string) => {
    if (url === '/api/auth/mfa/status') return reply({ enabled: false });
    if (url === '/api/auth/mfa/enroll') return reply({ secret: 'synthetic-setup-key', uri: 'otpauth://totp/Example?secret=JBSWY3DPEHPK3PXP', expiresAt: Date.now() + 600000 });
    if (url === '/api/auth/mfa/activate') return reply({ enabled: true, recoveryCodes: codes });
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetcher);
  render(<TotpSettings />);
  await screen.findByText(/Disabled. Enable/);
  fireEvent.change(screen.getAllByLabelText('Current password')[0], { target: { value: 'synthetic-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Set up authenticator' }));
  const input = await screen.findByLabelText('Authenticator code');
  await waitFor(() => expect(renderQr).toHaveBeenCalledTimes(1));
  expect(screen.getByLabelText('Current password')).toHaveProperty('value', '');
  fireEvent.change(input, { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Activate' }));
  await screen.findByText(codes[0]);
  expect(storage.mock.calls.some(args => args.some(v => /synthetic-setup|synthetic-recovery/.test(String(v))))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'I saved my recovery codes' }));
  expect(screen.queryByText(codes[0])).toBeNull();
  expect(fetcher.mock.calls.every(([url]) => url.startsWith('/api/auth/'))).toBe(true);
});

it('L-10/K-23: loading status preserves the expected Unicode text', () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
  const { container, unmount } = render(<TotpSettings />);
  expect(container.querySelector('p')?.textContent).toBe('Loading\u2026');
  unmount();
});

import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { HostAcceptToggle } from '@/modules/remote/components/HostAcceptToggle';
import { failure, installFakeRemoteApi, reply } from '@/modules/remote/tests/fake-remote-api';
import type { RemoteHostStatus } from '@/shared/types';

/**
 * Accept is the one switch that lets other browsers in, so it asks for the
 * password both ways (contracts.md: PUT /host/accept is `*`), shows when it will
 * turn itself off, and refuses to turn on before a relay exists.
 */

const ACCEPT = '/api/remote/host/accept';

const off: RemoteHostStatus = {
  acceptEnabled: false,
  autoOffHours: 8,
  autoOffAt: null,
  relayState: 'stopped',
  approvalTimeoutMs: 300000,
  controllers: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const setup = (status: RemoteHostStatus | null, relayReady = true) => {
  const api = installFakeRemoteApi({ [`PUT ${ACCEPT}`]: reply({ acceptEnabled: true }) });
  const onChanged = vi.fn();
  render(<HostAcceptToggle status={status} relayReady={relayReady} onChanged={onChanged} />);
  const toggle = () => screen.getByRole('switch', { name: 'Accept Controllers' }) as HTMLButtonElement;
  return { api, onChanged, toggle };
};

const confirmWithPassword = async (password: string) => {
  fireEvent.change(await screen.findByLabelText('Account password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
};

test('turning Accept on asks for the password and then sends enabled with the auto-off hours', async () => {
  const { api, onChanged, toggle } = setup(off);
  assert.equal(toggle().getAttribute('aria-checked'), 'false');

  fireEvent.change(screen.getByLabelText(/Turn off automatically after/), { target: { value: '24' } });
  fireEvent.click(toggle());
  assert.equal(api.calls.length, 0, 'nothing is sent before the password was given');
  await confirmWithPassword('account-password-1');

  await waitFor(() => assert.equal(onChanged.mock.calls.length, 1));
  assert.deepEqual(api.to('PUT', ACCEPT)[0]?.body, {
    enabled: true,
    autoOffHours: 24,
    password: 'account-password-1',
  });
});

test('the auto-off field starts from what the Host reports and is kept between 0 and 168', async () => {
  const { api, toggle } = setup(off);
  const hours = screen.getByLabelText(/Turn off automatically after/) as HTMLInputElement;
  assert.equal(hours.value, '8');

  fireEvent.change(hours, { target: { value: '9999' } });
  assert.equal(hours.value, '168');
  fireEvent.change(hours, { target: { value: '-3' } });
  assert.equal(hours.value, '0');

  fireEvent.click(toggle());
  await confirmWithPassword('account-password-1');
  await waitFor(() => assert.equal(api.to('PUT', ACCEPT).length, 1));
  assert.equal(api.to('PUT', ACCEPT)[0]?.body?.autoOffHours, 0);
});

test('turning Accept off also needs the password and sends enabled: false', async () => {
  const { api, onChanged, toggle } = setup({ ...off, acceptEnabled: true, autoOffAt: '2026-11-04T20:30:00.000Z' });
  assert.equal(toggle().getAttribute('aria-checked'), 'true');

  fireEvent.click(toggle());
  await confirmWithPassword('account-password-1');

  await waitFor(() => assert.equal(onChanged.mock.calls.length, 1));
  assert.deepEqual(api.to('PUT', ACCEPT)[0]?.body, { enabled: false, password: 'account-password-1' });
});

test('while Accept is on it shows when it will turn itself off', () => {
  setup({ ...off, acceptEnabled: true, autoOffAt: '2026-11-04T20:30:00.000Z' });

  assert.ok(screen.getByText(/Turns off automatically at/));
});

test('with auto-off disabled there is no turn-off time', () => {
  setup({ ...off, acceptEnabled: true, autoOffHours: 0, autoOffAt: null });

  assert.equal(screen.queryByText(/Turns off automatically at/), null);
});

test('without a saved relay the switch is disabled and says why', () => {
  const { toggle } = setup(off, false);

  assert.equal(toggle().disabled, true);
  assert.ok(screen.getByText('Save the relay settings first.'));
});

test('a wrong password leaves the switch where it was and keeps asking', async () => {
  const { api, onChanged, toggle } = setup(off);
  api.set(`PUT ${ACCEPT}`, failure(401, 'INVALID_PASSWORD'));

  fireEvent.click(toggle());
  await confirmWithPassword('bad-password-1');

  assert.ok(await screen.findByText('Wrong password. Try again.'));
  assert.equal(onChanged.mock.calls.length, 0);
  assert.equal(toggle().getAttribute('aria-checked'), 'false');
});

test('an unsupported server mode is explained instead of failing silently', async () => {
  const { api, onChanged, toggle } = setup(off);
  api.set(`PUT ${ACCEPT}`, failure(409, 'REMOTE_UNSUPPORTED_MODE'));

  fireEvent.click(toggle());
  await confirmWithPassword('account-password-1');

  assert.ok(await screen.findByText('Remote work cannot be turned on in this server mode.'));
  assert.equal(onChanged.mock.calls.length, 0);
});

test('Escape on the password prompt cancels and sends nothing', async () => {
  const { api, toggle } = setup(off);

  fireEvent.click(toggle());
  await screen.findByLabelText('Account password');
  fireEvent.keyDown(window, { key: 'Escape' });

  await waitFor(() => assert.equal(screen.queryByLabelText('Account password'), null));
  assert.equal(api.calls.length, 0);
});

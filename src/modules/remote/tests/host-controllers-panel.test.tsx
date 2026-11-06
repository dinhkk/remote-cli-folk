import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { HostControllersPanel } from '@/modules/remote/components/HostControllersPanel';
import { failure, installFakeRemoteApi, reply } from '@/modules/remote/tests/fake-remote-api';
import type { RemoteHostController } from '@/shared/types';

/**
 * What the Host owner sees about the Controllers: who is connected, since when
 * and with how many streams. Disconnect closes a link right now (no password);
 * Revoke deletes the pairing for good and needs the password, and the Host says
 * plainly when the relay could not confirm the revocation.
 */

const controller = (pairingId: string, name: string, overrides: Partial<RemoteHostController> = {}): RemoteHostController => ({
  pairingId,
  name,
  connected: true,
  connectedAt: '2026-11-04T08:15:00.000Z',
  streams: 2,
  suspendedUntil: null,
  ...overrides,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const setup = (controllers: RemoteHostController[]) => {
  const api = installFakeRemoteApi({
    'POST /api/remote/host/controllers/:id/disconnect': reply({ ok: true }),
    'DELETE /api/remote/host/pairings/:id': reply({ ok: true, relayConfirmed: true }),
  });
  const onChanged = vi.fn();
  render(<HostControllersPanel controllers={controllers} onChanged={onChanged} />);
  return { api, onChanged };
};

const rowOf = (name: string) => screen.getByText(name).closest('li') as HTMLElement;

test('each Controller shows its name marked unverified, when it connected and how many streams are open', () => {
  setup([controller('p1', 'Alice-PC', { streams: 3 }), controller('p2', 'Bob-Phone', { streams: 1 })]);

  const alice = rowOf('Alice-PC');
  assert.ok(within(alice).getByText('Unverified'));
  assert.ok(within(alice).getByText(/^Connected at /));
  assert.ok(within(alice).getByText('3 open streams'));
  assert.ok(within(rowOf('Bob-Phone')).getByText('1 open stream'));
});

test('a pairing that is not linked right now says so and keeps only what still works', () => {
  setup([controller('p1', 'Alice-PC', { connected: false, connectedAt: null, streams: 0 })]);

  const row = rowOf('Alice-PC');
  assert.ok(within(row).getByText('Not connected'));
  assert.equal((within(row).getByRole('button', { name: 'Disconnect' }) as HTMLButtonElement).disabled, true);
  assert.equal((within(row).getByRole('button', { name: 'Revoke' }) as HTMLButtonElement).disabled, false);
});

test('a Controller suspended for too many quota refusals says until when it cannot reconnect', () => {
  const until = Date.UTC(2026, 10, 5, 9, 30);
  setup([controller('p1', 'Alice-PC', { connected: false, connectedAt: null, streams: 0, suspendedUntil: until })]);

  const row = rowOf('Alice-PC');
  assert.ok(within(row).getByText(/^Suspended until /), 'the suspension and its end are shown');
  assert.ok(within(row).getByText(/too many refused requests/i));
  assert.equal(within(row).queryByText('Not connected'), null, 'it is more than "not connected"');
});

test('a Controller that is not suspended shows no suspension line', () => {
  setup([controller('p1', 'Alice-PC')]);
  assert.equal(screen.queryByText(/Suspended until/), null);
});

test('with no Controllers it says so', () => {
  setup([]);

  assert.ok(screen.getByText('No Controllers are paired with this Host.'));
});

test('Disconnect closes that Controller at once, with no password', async () => {
  const { api, onChanged } = setup([controller('p1', 'Alice-PC')]);

  fireEvent.click(within(rowOf('Alice-PC')).getByRole('button', { name: 'Disconnect' }));

  await waitFor(() => assert.equal(onChanged.mock.calls.length, 1));
  assert.deepEqual(
    api.calls.map((call) => `${call.method} ${call.path}`),
    ['POST /api/remote/host/controllers/p1/disconnect'],
  );
  assert.equal(screen.queryByLabelText('Account password'), null);
});

test('Revoke asks for the password and then deletes the pairing with it', async () => {
  const { api, onChanged } = setup([controller('p1', 'Alice-PC')]);

  fireEvent.click(within(rowOf('Alice-PC')).getByRole('button', { name: 'Revoke' }));
  assert.equal(api.calls.length, 0);
  fireEvent.change(await screen.findByLabelText('Account password'), { target: { value: 'account-password-1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

  await waitFor(() => assert.equal(onChanged.mock.calls.length, 1));
  assert.equal(api.calls[0]?.method, 'DELETE');
  assert.equal(api.calls[0]?.path, '/api/remote/host/pairings/p1');
  assert.deepEqual(api.calls[0]?.body, { password: 'account-password-1' });
  assert.ok(screen.getByText('Pairing with Alice-PC was revoked.'));
});

test('when the relay did not confirm the revocation that is spelled out and stays until dismissed', async () => {
  const { api } = setup([controller('p1', 'Alice-PC')]);
  api.set('DELETE /api/remote/host/pairings/:id', reply({ ok: true, relayConfirmed: false }));

  fireEvent.click(within(rowOf('Alice-PC')).getByRole('button', { name: 'Revoke' }));
  fireEvent.change(await screen.findByLabelText('Account password'), { target: { value: 'account-password-1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

  const notice = await screen.findByText(/the relay has not confirmed it yet/);
  assert.match(notice.textContent ?? '', /Alice-PC/);

  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  assert.equal(screen.queryByText(/the relay has not confirmed it yet/), null);
});

test('a wrong password on Revoke keeps the pairing and asks again', async () => {
  const { api, onChanged } = setup([controller('p1', 'Alice-PC')]);
  api.set('DELETE /api/remote/host/pairings/:id', failure(401, 'INVALID_PASSWORD'));

  fireEvent.click(within(rowOf('Alice-PC')).getByRole('button', { name: 'Revoke' }));
  fireEvent.change(await screen.findByLabelText('Account password'), { target: { value: 'bad-password-1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

  assert.ok(await screen.findByText('Wrong password. Try again.'));
  assert.equal(onChanged.mock.calls.length, 0);
});

test('a failed Disconnect is reported and the row stays', async () => {
  const { api, onChanged } = setup([controller('p1', 'Alice-PC')]);
  api.set('POST /api/remote/host/controllers/:id/disconnect', failure(500, 'REMOTE_INTERNAL'));

  fireEvent.click(within(rowOf('Alice-PC')).getByRole('button', { name: 'Disconnect' }));

  assert.ok(await screen.findByText('That action failed.'));
  assert.equal(onChanged.mock.calls.length, 0);
});

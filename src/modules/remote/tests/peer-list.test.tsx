import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { PeerList } from '@/modules/remote/components/PeerList';
import { failure, installFakeRemoteApi, reply } from '@/modules/remote/tests/fake-remote-api';
import type { RemotePeer, RemotePeerState } from '@/shared/types';

/**
 * Hosts this browser controls. Each row says what state its link is in, opens
 * the Host's tab, and can forget the pairing. Forgetting is the Controller's own
 * `DELETE /peers/:peerId`, which the contract does not mark as needing the
 * password, so it asks for a plain confirmation instead.
 */

const peer = (
  peerId: string,
  name: string,
  state: RemotePeerState,
  lastConnectedAt: RemotePeer['lastConnectedAt'] = null,
  alias: string | null = null,
): RemotePeer => ({
  peerId,
  name,
  alias,
  state,
  lastConnectedAt,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const setup = (peers: RemotePeer[]) => {
  const api = installFakeRemoteApi({
    'DELETE /api/remote/peers/:peerId': reply({ ok: true }),
    'PUT /api/remote/peers/:peerId/alias': reply({ ok: true }),
  });
  const onOpen = vi.fn();
  const onChanged = vi.fn();
  render(<PeerList peers={peers} onOpen={onOpen} onChanged={onChanged} />);
  return { api, onOpen, onChanged };
};

const rowOf = (name: string) => screen.getByText(name).closest('li') as HTMLElement;

test('every state is told in words, with the state on the row for styling', () => {
  setup([
    peer('peer_online1', 'Online box', 'online'),
    peer('peer_offline', 'Offline box', 'offline'),
    peer('peer_locked11', 'Locked box', 'locked'),
    peer('peer_replaced', 'Replaced box', 'replaced'),
  ]);

  const expected: Array<[string, string, RemotePeerState]> = [
    ['Online box', 'Online', 'online'],
    ['Offline box', 'Offline', 'offline'],
    ['Locked box', 'Locked', 'locked'],
    ['Replaced box', 'Replaced', 'replaced'],
  ];
  for (const [name, label, state] of expected) {
    const row = rowOf(name);
    assert.ok(within(row).getByText(label), `${name} should read ${label}`);
    assert.equal(row.getAttribute('data-state'), state);
  }
});

test('a pairing that can no longer work explains what to do about it', () => {
  setup([peer('peer_locked11', 'Locked box', 'locked'), peer('peer_revoked1', 'Gone box', 'revoked')]);

  assert.ok(within(rowOf('Locked box')).getByText('The Host is locked. Unlock it on the Host to continue.'));
  assert.ok(
    within(rowOf('Gone box')).getByText('This pairing was revoked on the Host. Remove it and pair again to reconnect.'),
  );
});

test('with no pairings it says so', () => {
  setup([]);

  assert.ok(screen.getByText('No Hosts are paired yet.'));
  assert.equal(screen.queryByRole('list'), null);
});

test('Open tab hands the peer id to the caller', () => {
  const { onOpen } = setup([peer('peer_online1', 'Online box', 'online')]);

  fireEvent.click(within(rowOf('Online box')).getByRole('button', { name: /Open tab/ }));

  assert.deepEqual(onOpen.mock.calls, [['peer_online1']]);
});

test('the last connection time is shown, or that there never was one', () => {
  setup([
    peer('peer_online1', 'Seen box', 'online', '2026-11-04T08:15:00.000Z'),
    peer('peer_offline', 'New box', 'offline', null),
  ]);

  assert.ok(within(rowOf('Seen box')).getByText(/^Last connected /));
  assert.ok(within(rowOf('New box')).getByText('Never connected'));
});

test('forgetting asks for confirmation first and sends nothing until it is given', async () => {
  const { api, onChanged } = setup([peer('peer_online1', 'Online box', 'online')]);

  fireEvent.click(within(rowOf('Online box')).getByRole('button', { name: 'Forget' }));
  assert.ok(screen.getByText(/Forget Online box\?/));
  assert.equal(api.calls.length, 0);
  assert.equal(screen.queryByLabelText('Account password'), null, 'no password: the contract does not ask for one');

  fireEvent.click(screen.getByRole('button', { name: 'Forget pairing' }));

  await waitFor(() => assert.equal(onChanged.mock.calls.length, 1));
  assert.deepEqual(
    api.calls.map((call) => `${call.method} ${call.path}`),
    ['DELETE /api/remote/peers/peer_online1'],
  );
  assert.equal(api.calls[0]?.body, null);
});

test('forgetting a pairing also deletes what its tab stored in this browser, and nothing else', async () => {
  localStorage.setItem('remote:peer_online1:local:activeTab', 'git');
  localStorage.setItem('remote:peer_other111:local:activeTab', 'chat');
  localStorage.setItem('auth-token', 'controller-jwt');
  const { onChanged } = setup([peer('peer_online1', 'Online box', 'online')]);

  fireEvent.click(within(rowOf('Online box')).getByRole('button', { name: 'Forget' }));
  fireEvent.click(screen.getByRole('button', { name: 'Forget pairing' }));

  await waitFor(() => assert.equal(onChanged.mock.calls.length, 1));
  assert.equal(localStorage.getItem('remote:peer_online1:local:activeTab'), null);
  assert.equal(localStorage.getItem('remote:peer_other111:local:activeTab'), 'chat');
  assert.equal(localStorage.getItem('auth-token'), 'controller-jwt');
  localStorage.clear();
});

test('a forget that failed keeps the stored tab data', async () => {
  localStorage.setItem('remote:peer_online1:local:activeTab', 'git');
  const { api } = setup([peer('peer_online1', 'Online box', 'online')]);
  api.set('DELETE /api/remote/peers/:peerId', failure(500, 'REMOTE_INTERNAL'));

  fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
  fireEvent.click(screen.getByRole('button', { name: 'Forget pairing' }));

  await screen.findByText('The pairing could not be removed.');
  assert.equal(localStorage.getItem('remote:peer_online1:local:activeTab'), 'git');
  localStorage.clear();
});

test('a Host with an alias is listed under the alias, and the name it declared stays visible beside it', () => {
  setup([peer('peer_online1', 'b3f9c2e81a7d', 'online', null, 'Home PC'), peer('peer_offline', 'Plain box', 'offline')]);

  const row = screen.getByText('Home PC').closest('li') as HTMLElement;
  assert.equal(within(row).getByTestId('declared-name').textContent, 'b3f9c2e81a7d');
  assert.equal(within(rowOf('Plain box')).queryByTestId('declared-name'), null, 'no alias: nothing extra to show');
});

test('renaming sends the new name, closes the form and asks the screen to re-read the list', async () => {
  const { api, onChanged } = setup([peer('peer_online1', 'b3f9c2e81a7d', 'online')]);

  fireEvent.click(within(rowOf('b3f9c2e81a7d')).getByRole('button', { name: 'Rename' }));
  const field = screen.getByLabelText('Name for this Host') as HTMLInputElement;
  assert.equal(field.value, '', 'no alias yet: the field starts empty and shows the declared name as its placeholder');
  assert.equal(field.placeholder, 'b3f9c2e81a7d');
  fireEvent.change(field, { target: { value: '  Home PC  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));

  await waitFor(() => assert.equal(onChanged.mock.calls.length, 1));
  assert.deepEqual(api.calls.map((call) => `${call.method} ${call.path}`), ['PUT /api/remote/peers/peer_online1/alias']);
  assert.deepEqual(api.calls[0]?.body, { alias: 'Home PC' });
  assert.equal(screen.queryByLabelText('Name for this Host'), null);
});

test('saving an empty name clears the alias', async () => {
  const { api, onChanged } = setup([peer('peer_online1', 'b3f9c2e81a7d', 'online', null, 'Home PC')]);

  fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
  const field = screen.getByLabelText('Name for this Host') as HTMLInputElement;
  assert.equal(field.value, 'Home PC', 'editing starts from the current alias');
  fireEvent.change(field, { target: { value: '   ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));

  await waitFor(() => assert.equal(onChanged.mock.calls.length, 1));
  assert.deepEqual(api.calls[0]?.body, { alias: null });
});

test('a name that could not be saved is reported and the form stays open for another try', async () => {
  const { api, onChanged } = setup([peer('peer_online1', 'Online box', 'online')]);
  api.set('PUT /api/remote/peers/:peerId/alias', failure(400, 'REMOTE_BAD_REQUEST', 'alias must be at most 40 characters.'));

  fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
  fireEvent.change(screen.getByLabelText('Name for this Host'), { target: { value: 'x' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));

  await screen.findByText('The name could not be saved.');
  assert.ok(screen.getByLabelText('Name for this Host'));
  assert.equal(onChanged.mock.calls.length, 0);
});

test('cancelling a rename sends nothing', () => {
  const { api } = setup([peer('peer_online1', 'Online box', 'online')]);

  fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
  fireEvent.change(screen.getByLabelText('Name for this Host'), { target: { value: 'Changed my mind' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

  assert.equal(screen.queryByLabelText('Name for this Host'), null);
  assert.equal(api.calls.length, 0);
});

test('cancelling the confirmation leaves the pairing alone', () => {
  const { api, onChanged } = setup([peer('peer_online1', 'Online box', 'online')]);

  fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

  assert.equal(screen.queryByText(/Forget Online box\?/), null);
  assert.equal(api.calls.length, 0);
  assert.equal(onChanged.mock.calls.length, 0);
});

test('when forgetting fails the row stays and says so', async () => {
  const { api, onChanged } = setup([peer('peer_online1', 'Online box', 'online')]);
  api.set('DELETE /api/remote/peers/:peerId', failure(500, 'REMOTE_INTERNAL'));

  fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
  fireEvent.click(screen.getByRole('button', { name: 'Forget pairing' }));

  assert.ok(await screen.findByText('The pairing could not be removed.'));
  assert.equal(onChanged.mock.calls.length, 0);
  assert.ok(screen.getByText('Online box'));
});

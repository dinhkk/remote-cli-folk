import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { installFakeRemoteApi, reply, failure } from '@/modules/remote/tests/fake-remote-api';
import { RelayConfigPanel } from '@/modules/remote/components/RelayConfigPanel';
import type { RemoteRelayConfig } from '@/shared/types';

/**
 * The relay address and its shared secret are entered once. The secret goes to
 * the server and nowhere else: it is never read back, never prefilled, and the
 * field is empty again as soon as it was sent. Every change needs the password.
 */

const RELAY_PUT = '/api/remote/relay-config';
const SECRET = 'relay-secret-value-0123456789-abcdefghij';

const unconfigured: RemoteRelayConfig = { url: '', hasSecret: false, masterKeySource: 'env' };
const configured: RemoteRelayConfig = { url: 'wss://relay.example.dev', hasSecret: true, masterKeySource: 'env' };

afterEach(() => {
  vi.unstubAllGlobals();
});

const setup = (config: RemoteRelayConfig) => {
  const api = installFakeRemoteApi({ [`PUT ${RELAY_PUT}`]: reply({ ok: true }) });
  const onSaved = vi.fn();
  render(<RelayConfigPanel config={config} onSaved={onSaved} />);
  const url = screen.getByLabelText('Relay URL') as HTMLInputElement;
  const secret = screen.getByLabelText('Relay secret') as HTMLInputElement;
  const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save relay' }));
  return { api, onSaved, url, secret, save };
};

const confirmWithPassword = async (password: string) => {
  const field = (await screen.findByLabelText('Account password')) as HTMLInputElement;
  fireEvent.change(field, { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  return field;
};

test('saving sends the URL, the secret and the password to PUT /relay-config, and the secret field is empty afterwards', async () => {
  const { api, onSaved, url, secret, save } = setup(unconfigured);

  fireEvent.change(url, { target: { value: 'wss://relay.example.dev' } });
  fireEvent.change(secret, { target: { value: SECRET } });
  save();
  await confirmWithPassword('account-password-1');

  await waitFor(() => assert.equal(onSaved.mock.calls.length, 1));
  const put = api.to('PUT', RELAY_PUT);
  assert.equal(put.length, 1);
  assert.deepEqual(put[0]?.body, {
    url: 'wss://relay.example.dev',
    secret: SECRET,
    password: 'account-password-1',
  });
  assert.equal(secret.value, '');
  assert.ok(await screen.findByText('Relay saved.'));
  assert.equal(document.body.innerHTML.includes(SECRET), false, 'the secret must not linger anywhere in the DOM');
  assert.equal(document.body.innerHTML.includes('account-password-1'), false);
});

test('the secret is a masked field that password managers are told to leave alone', () => {
  const { secret, url } = setup(unconfigured);

  assert.equal(secret.type, 'password');
  // `off` is ignored by Chrome and Firefox on password fields; `new-password` is not offered for autofill
  // and the vendor attributes opt the field out of the common managers.
  assert.equal(secret.autocomplete, 'new-password');
  assert.equal(secret.getAttribute('data-lpignore'), 'true');
  assert.equal(secret.getAttribute('data-1p-ignore'), 'true');
  assert.equal(secret.getAttribute('data-bwignore'), 'true');
  // Neither field is named like a login, so the pair does not read as a username + password form.
  for (const field of [secret, url]) {
    assert.equal(/user|login|pass|email/i.test(field.name), false, `name "${field.name}" looks like a login field`);
  }
  assert.equal(url.getAttribute('data-lpignore'), 'true');
});

test('a stored secret is never filled back in: the field is empty and says one is stored', () => {
  const { url, secret } = setup(configured);

  assert.equal(url.value, 'wss://relay.example.dev');
  assert.equal(secret.value, '');
  assert.ok(screen.getByText('A secret is stored. Enter it again to save a change.'));
});

test('setting the relay up for the first time carries no revoke warning', () => {
  const { url } = setup(unconfigured);

  fireEvent.change(url, { target: { value: 'wss://relay.example.dev' } });

  assert.equal(screen.queryByText(/revokes every pairing/), null);
});

test('changing the URL of a configured relay warns that every pairing is revoked', () => {
  const { url } = setup(configured);
  assert.equal(screen.queryByText(/revokes every pairing/), null);

  fireEvent.change(url, { target: { value: 'wss://other.example.dev' } });

  assert.ok(screen.getByText(/Changing the relay revokes every pairing/));
});

test('entering a new secret for a configured relay warns as well', () => {
  const { secret } = setup(configured);

  fireEvent.change(secret, { target: { value: SECRET } });

  assert.ok(screen.getByText(/Changing the relay revokes every pairing/));
});

test('nothing is sent without a usable URL and a secret', () => {
  const { api, url, secret, save } = setup(unconfigured);

  save();
  assert.ok(screen.getByText('Enter a valid relay address starting with wss:// (or https://).'));

  fireEvent.change(url, { target: { value: 'not a url' } });
  save();
  assert.ok(screen.getByText('Enter a valid relay address starting with wss:// (or https://).'));

  fireEvent.change(url, { target: { value: 'wss://relay.example.dev' } });
  save();
  assert.ok(screen.getByText('Enter the relay secret.'));

  fireEvent.change(secret, { target: { value: SECRET } });
  assert.equal(screen.queryByLabelText('Account password'), null);
  assert.equal(api.calls.length, 0);
});

test('a wrong password keeps the form and the typed secret so nothing has to be entered twice', async () => {
  const { api, onSaved, url, secret, save } = setup(unconfigured);
  api.set(`PUT ${RELAY_PUT}`, failure(401, 'INVALID_PASSWORD'));

  fireEvent.change(url, { target: { value: 'wss://relay.example.dev' } });
  fireEvent.change(secret, { target: { value: SECRET } });
  save();
  await confirmWithPassword('bad-password-1');

  assert.ok(await screen.findByText('Wrong password. Try again.'));
  assert.equal(onSaved.mock.calls.length, 0);
  assert.equal(secret.value, SECRET);
});

test('an answer that is not about the password is shown on the panel', async () => {
  const { api, url, secret, save } = setup(unconfigured);
  api.set(`PUT ${RELAY_PUT}`, failure(409, 'REMOTE_UNSUPPORTED_MODE', 'Not supported here'));

  fireEvent.change(url, { target: { value: 'wss://relay.example.dev' } });
  fireEvent.change(secret, { target: { value: SECRET } });
  save();
  await confirmWithPassword('account-password-1');

  assert.ok(await screen.findByText('The relay settings could not be saved.'));
  assert.equal(screen.queryByLabelText('Account password'), null);
});

test('the reason the server gave is shown under the generic line', async () => {
  const { api, url, secret, save } = setup(unconfigured);
  api.set(`PUT ${RELAY_PUT}`, failure(400, 'INVALID_RELAY_SECRET', 'The relay secret must be 32-1024 characters.'));

  fireEvent.change(url, { target: { value: 'wss://relay.example.dev' } });
  fireEvent.change(secret, { target: { value: SECRET } });
  save();
  await confirmWithPassword('account-password-1');

  assert.ok(await screen.findByText('The relay settings could not be saved.'));
  assert.ok(await screen.findByText('The relay secret must be 32-1024 characters.'));
});

test('a secret shorter than the server accepts is refused on the panel before any password is asked', async () => {
  const { api, onSaved, url, secret, save } = setup(unconfigured);

  fireEvent.change(url, { target: { value: 'wss://relay.example.dev' } });
  fireEvent.change(secret, { target: { value: 'too-short-secret' } });
  save();

  assert.ok(await screen.findByText(/must be at least 32 characters/));
  assert.equal(screen.queryByLabelText('Account password'), null);
  assert.equal(api.to('PUT', RELAY_PUT).length, 0);
  assert.equal(onSaved.mock.calls.length, 0);
});

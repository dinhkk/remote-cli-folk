import assert from 'node:assert/strict';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { test, vi } from 'vitest';

import '@/modules/i18n';
import { ReauthModal } from '@/modules/remote/modals/ReauthModal';
import type { RemoteApiFailure, RemoteApiResult } from '@/shared/types';

/**
 * Sensitive actions (contracts.md section 2, endpoints marked `*`) ask for the
 * account password again. The modal collects it, hands it to the action, and
 * stays open only when the password itself was the problem.
 */

const wrongPassword: RemoteApiFailure = { ok: false, status: 401, code: null, message: null };
// contracts.md section 10: a wrong password on a `*` endpoint is 403 + AUTH_INVALID_CREDENTIALS (401 is what an expired session looks like).
const wrongPassword403: RemoteApiFailure = { ok: false, status: 403, code: 'AUTH_INVALID_CREDENTIALS', message: null };
const rateLimited: RemoteApiFailure = { ok: false, status: 429, code: 'AUTH_RATE_LIMITED', message: null };

const renderModal = (submit: (password: string) => Promise<RemoteApiResult<unknown>>) => {
  const onDone = vi.fn();
  const onCancel = vi.fn();
  render(
    <ReauthModal title="Confirm change" description="Enter it." submit={submit} onDone={onDone} onCancel={onCancel} />,
  );
  const input = screen.getByLabelText('Account password') as HTMLInputElement;
  const confirm = () => fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  return { onDone, onCancel, input, confirm };
};

test('asks for the account password in a masked field, offered to the browser as an existing password', () => {
  const { input } = renderModal(async () => ({ ok: true, data: null }));

  assert.equal(input.type, 'password');
  assert.equal(input.autocomplete, 'current-password');
  assert.equal(screen.getByRole('dialog').getAttribute('aria-modal'), 'true');
  assert.ok(screen.getByRole('heading', { name: 'Confirm change' }));
  assert.equal((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled, true);
});

test('a correct password calls the action again with it and reports the result, leaving nothing in the field', async () => {
  const submit = vi.fn(async (): Promise<RemoteApiResult<unknown>> => ({ ok: true, data: { done: 1 } }));
  const { input, confirm, onDone } = renderModal(submit);

  fireEvent.change(input, { target: { value: 'hunter2-hunter2' } });
  confirm();

  await waitFor(() => assert.equal(onDone.mock.calls.length, 1));
  assert.deepEqual(submit.mock.calls[0], ['hunter2-hunter2']);
  assert.deepEqual(onDone.mock.calls[0]?.[0], { ok: true, data: { done: 1 } });
  assert.equal(input.value, '', 'the password must not stay in the DOM after submit');
});

test('a wrong password shows an error, empties the field and lets the user try again', async () => {
  const submit = vi
    .fn<(password: string) => Promise<RemoteApiResult<unknown>>>()
    .mockResolvedValueOnce(wrongPassword)
    .mockResolvedValueOnce({ ok: true, data: null });
  const { input, confirm, onDone } = renderModal(submit);

  fireEvent.change(input, { target: { value: 'nope-nope-nope' } });
  confirm();

  assert.ok(await screen.findByText('Wrong password. Try again.'));
  assert.equal(onDone.mock.calls.length, 0);
  assert.equal(input.value, '');

  fireEvent.change(input, { target: { value: 'right-right-right' } });
  confirm();
  await waitFor(() => assert.equal(onDone.mock.calls.length, 1));
  assert.deepEqual(submit.mock.calls[1], ['right-right-right']);
});

test('403 with AUTH_INVALID_CREDENTIALS is a wrong password, and so is 401 for compatibility', async () => {
  for (const failure of [wrongPassword403, wrongPassword]) {
    const { input, confirm, onDone } = renderModal(async () => failure);
    fireEvent.change(input, { target: { value: 'nope-nope-nope' } });
    confirm();

    assert.ok(await screen.findByText('Wrong password. Try again.'));
    assert.equal(onDone.mock.calls.length, 0);
    cleanup();
  }
});

test('a 403 for another reason (no such code) is not blamed on the password', async () => {
  const forbidden: RemoteApiFailure = { ok: false, status: 403, code: 'REMOTE_FORBIDDEN', message: null };
  const { input, confirm, onDone } = renderModal(async () => forbidden);

  fireEvent.change(input, { target: { value: 'password-123456' } });
  confirm();

  await waitFor(() => assert.equal(onDone.mock.calls.length, 1));
  assert.equal(screen.queryByText('Wrong password. Try again.'), null);
});

test('a lockout (429) is explained rather than reported as a wrong password', async () => {
  const { input, confirm, onDone } = renderModal(async () => rateLimited);

  fireEvent.change(input, { target: { value: 'whatever-it-is' } });
  confirm();

  assert.ok(await screen.findByText('Too many attempts. Wait a few minutes before trying again.'));
  assert.equal(screen.queryByText('Wrong password. Try again.'), null);
  assert.equal(onDone.mock.calls.length, 0);
});

test('a failure that is not about the password is handed back to the caller', async () => {
  const refused: RemoteApiFailure = { ok: false, status: 409, code: 'REMOTE_UNSUPPORTED_MODE', message: null };
  const { input, confirm, onDone } = renderModal(async () => refused);

  fireEvent.change(input, { target: { value: 'password-123456' } });
  confirm();

  await waitFor(() => assert.equal(onDone.mock.calls.length, 1));
  assert.deepEqual(onDone.mock.calls[0]?.[0], refused);
});

test('Escape and Cancel close it without running the action', () => {
  const submit = vi.fn(async (): Promise<RemoteApiResult<unknown>> => ({ ok: true, data: null }));
  const { onCancel, input } = renderModal(submit);

  fireEvent.change(input, { target: { value: 'typed-something' } });
  fireEvent.keyDown(window, { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

  assert.equal(onCancel.mock.calls.length, 2);
  assert.equal(submit.mock.calls.length, 0);
});

test('it is marked as an escape layer so Settings does not close underneath it', () => {
  renderModal(async () => ({ ok: true, data: null }));

  assert.ok(document.querySelector('[data-escape-layer]'));
});

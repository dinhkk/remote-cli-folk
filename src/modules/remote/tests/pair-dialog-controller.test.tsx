import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { failure, installFakeRemoteApi, reply, settle } from '@/modules/remote/tests/fake-remote-api';
import { PairControllerDialog } from '@/modules/remote/modals/PairControllerDialog';

/**
 * The Controller side of pairing: type the Host's code, then read the 6-digit
 * verification code off the screen and type it on the Host. This side only ever
 * displays the code; there is nothing here that can approve a pairing.
 */

const JOIN = '/api/remote/peers/join';
const PROGRESS = '/api/remote/peers/join/join_1';

let api: ReturnType<typeof installFakeRemoteApi>;
let progress: Record<string, unknown>;

beforeEach(() => {
  vi.useFakeTimers();
  progress = { state: 'connecting' };
  api = installFakeRemoteApi({
    [`POST ${JOIN}`]: reply({ joinId: 'join_1' }),
    [`GET ${PROGRESS}`]: () => reply(progress),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const setup = () => {
  const onClose = vi.fn();
  const onPaired = vi.fn();
  const view = render(<PairControllerDialog onClose={onClose} onPaired={onPaired} />);
  const code = screen.getByLabelText('Pairing code') as HTMLInputElement;
  const name = screen.getByLabelText('Name of this browser') as HTMLInputElement;
  const join = () => screen.getByRole('button', { name: 'Pair' }) as HTMLButtonElement;
  return { onClose, onPaired, code, name, join, unmount: view.unmount };
};

const submitCode = async (typed = 'abcd1234') => {
  const view = setup();
  fireEvent.change(view.code, { target: { value: typed } });
  fireEvent.click(view.join());
  await settle();
  return view;
};

test('the code is shown upper-case as XXXX-XXXX while it is typed and Pair stays disabled until it is complete', () => {
  const { code, join } = setup();

  fireEvent.change(code, { target: { value: 'ab cd-1' } });
  assert.equal(code.value, 'ABCD-1');
  assert.equal(join().disabled, true);

  fireEvent.change(code, { target: { value: 'abcd123o' } });
  assert.equal(code.value, 'ABCD-1230');
  assert.equal(join().disabled, false);
});

test('joining sends the normalised code and the chosen browser name', async () => {
  const { name, code, join } = setup();
  assert.equal(name.value, 'My browser');

  fireEvent.change(code, { target: { value: 'abcd1234' } });
  fireEvent.change(name, { target: { value: 'Work laptop' } });
  fireEvent.click(join());
  await settle();

  assert.deepEqual(api.to('POST', JOIN)[0]?.body, { code: 'ABCD-1234', deviceName: 'Work laptop' });
  assert.ok(screen.getByText('Connecting to the Host…'));
});

test('the browser name only allows what the contract allows and is capped at 32 characters', () => {
  const { name } = setup();

  fireEvent.change(name, { target: { value: 'Büro <b>PC</b> 1234567890123456789012345' } });

  assert.match(name.value, /^[A-Za-z0-9 ._-]{1,32}$/);
});

test('the 6-digit verification code is displayed and the dialog waits for the Host', async () => {
  await submitCode();

  progress = { state: 'awaiting-sas', sas: '482913' };
  await settle(2100);

  assert.equal(screen.getByLabelText('Verification code').textContent?.replace(/\s/g, ''), '482913');
  assert.ok(screen.getByText('Waiting for the Host to confirm…'));
});

test('there is nothing to press that could accept the pairing from this side', async () => {
  await submitCode();
  progress = { state: 'awaiting-sas', sas: '482913' };
  await settle(2100);

  const names = screen.getAllByRole('button').map((button) => button.textContent?.toLowerCase() ?? '');
  assert.equal(names.some((label) => label.includes('accept') || label.includes('confirm') || label.includes('skip')), false);
});

test('when the Host confirms, the dialog reports success once and stops asking', async () => {
  const { onPaired } = await submitCode();
  progress = { state: 'done', peerId: 'peer_one11111' };
  await settle(2100);

  assert.ok(screen.getByText('Paired. The Host now appears in the list and as a tab.'));
  assert.equal(onPaired.mock.calls.length, 1);
  const asked = api.to('GET', PROGRESS).length;
  await settle(10_000);
  assert.equal(api.to('GET', PROGRESS).length, asked);
});

test.each([
  ['expired', 'This pairing code has expired. Ask the Host for a new one.'],
  ['invalid-code', 'That pairing code was not recognised. Check it and try again.'],
  ['pairing-full', 'The Host already has the maximum number of pairings.'],
  ['sas-rejected', 'The Host did not accept the verification code. Start again with a new code.'],
  ['something-odd', 'Pairing failed. Try again with a new code.'],
])('a failed join (%s) is explained in plain words', async (reason, message) => {
  const { onPaired } = await submitCode();
  progress = { state: 'failed', failure: reason };
  await settle(2100);

  assert.ok(screen.getByText(message));
  assert.equal(onPaired.mock.calls.length, 0);
  const asked = api.to('GET', PROGRESS).length;
  await settle(10_000);
  assert.equal(api.to('GET', PROGRESS).length, asked, 'a failed pairing is not polled any more');
});

test('after a failure Try again returns to the form with the code still there', async () => {
  const { code } = await submitCode();
  progress = { state: 'failed', failure: 'expired' };
  await settle(2100);

  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

  assert.equal((screen.getByLabelText('Pairing code') as HTMLInputElement).value, 'ABCD-1234');
  assert.equal(code.isConnected, false, 'the form is a fresh one');
});

test('a code the server refuses outright is reported on the form', async () => {
  api.set(`POST ${JOIN}`, failure(404, 'PAIRING_NOT_FOUND'));
  const { code } = await submitCode();

  assert.ok(screen.getByText('That pairing code was not recognised. Check it and try again.'));
  assert.equal(code.value, 'ABCD-1234');
  assert.equal(api.to('GET', PROGRESS).length, 0);
});

test('Escape closes the dialog and unmounting it stops asking about the join', async () => {
  const { onClose, unmount } = await submitCode();
  fireEvent.keyDown(window, { key: 'Escape' });
  assert.equal(onClose.mock.calls.length, 1);

  unmount();
  const asked = api.to('GET', PROGRESS).length;
  await settle(10_000);
  assert.equal(api.to('GET', PROGRESS).length, asked);
});

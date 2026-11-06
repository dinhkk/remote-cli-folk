import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { failure, installFakeRemoteApi, reply, settle } from '@/modules/remote/tests/fake-remote-api';
import { PairHostDialog } from '@/modules/remote/modals/PairHostDialog';
import type { RemoteHostPairingStart } from '@/shared/types';

/**
 * The Host side of pairing: show the code and its 5-minute clock, then take the
 * 6 digits the Controller displays. The Host never sees the verification code
 * itself, only what the person types, and three misses lock pairing for 15 min.
 */

const NOW = new Date('2026-11-04T10:00:00.000Z');
const PAIRING = '/api/remote/host/pairings/p1';
const CONFIRM = `${PAIRING}/confirm`;

const pairing: RemoteHostPairingStart = {
  pairingId: 'p1',
  code: 'ABCD1234',
  expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
};

let api: ReturnType<typeof installFakeRemoteApi>;
let current: Record<string, unknown>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  current = { state: 'waiting-controller', attemptsLeft: 3 };
  api = installFakeRemoteApi({
    [`GET ${PAIRING}`]: () => reply(current),
    [`POST ${CONFIRM}`]: reply({ ok: true }),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const setup = async () => {
  const onClose = vi.fn();
  const onPaired = vi.fn();
  const onLocked = vi.fn();
  const view = render(<PairHostDialog pairing={pairing} onClose={onClose} onPaired={onPaired} onLocked={onLocked} />);
  await settle();
  return { onClose, onPaired, onLocked, unmount: view.unmount };
};

const controllerJoined = async () => {
  current = { state: 'awaiting-sas', controllerName: 'Alice-PC', attemptsLeft: 3 };
  await settle(2100);
};

const typeSas = (value: string) => {
  const input = screen.getByLabelText('Verification code shown on the Controller') as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  return input;
};
const confirm = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  await settle();
};

test('it shows the code as XXXX-XXXX with a five-minute countdown that ticks down', async () => {
  await setup();

  assert.equal(screen.getByLabelText('Pairing code').textContent, 'ABCD-1234');
  assert.ok(screen.getByText('Code expires in 5:00'));

  await settle(61_000);
  assert.ok(screen.getByText('Code expires in 3:59'));
});

test('while nobody has entered the code it waits and asks the server every 2 seconds', async () => {
  await setup();
  assert.ok(screen.getByText('Waiting for the Controller to enter the code…'));
  assert.equal(api.to('GET', PAIRING).length, 1);

  await settle(2100);
  assert.equal(api.to('GET', PAIRING).length, 2);
  assert.equal(screen.queryByLabelText('Verification code shown on the Controller'), null);
});

test('once a Controller joined the SAS box appears with its name marked unverified', async () => {
  await setup();
  await controllerJoined();

  assert.ok(screen.getByText('Alice-PC'));
  assert.ok(screen.getByText('Unverified'));
  assert.ok(screen.getByLabelText('Verification code shown on the Controller'));
});

test('the SAS field takes digits only, at most six, and Confirm waits for all six', async () => {
  await setup();
  await controllerJoined();

  const input = typeSas('12a3-4 5678');
  assert.equal(input.value, '123456');
  assert.equal(input.inputMode, 'numeric');
  assert.equal(input.autocomplete, 'off');

  typeSas('123');
  assert.equal((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled, true);
});

test('the Host never displays a verification code and offers no way to skip it', async () => {
  const { onPaired } = await setup();
  await controllerJoined();

  const shown = document.body.textContent ?? '';
  assert.equal(/\b\d{6}\b/.test(shown), false);
  const labels = screen.getAllByRole('button').map((button) => button.textContent?.toLowerCase() ?? '');
  assert.equal(labels.some((label) => label.includes('accept') || label.includes('skip')), false);
  assert.equal(onPaired.mock.calls.length, 0);
});

test('typing the right SAS sends it to confirm and finishes when the server reports done', async () => {
  const { onPaired } = await setup();
  await controllerJoined();

  typeSas('482913');
  await confirm();
  assert.deepEqual(api.to('POST', CONFIRM)[0]?.body, { sas: '482913' });

  current = { state: 'done', controllerName: 'Alice-PC' };
  await settle(2100);
  assert.ok(screen.getByText('Paired. The Controller can now connect while Accept is on.'));
  assert.equal(onPaired.mock.calls.length, 1);
  const asked = api.to('GET', PAIRING).length;
  await settle(10_000);
  assert.equal(api.to('GET', PAIRING).length, asked);
});

test('a wrong SAS says how many attempts are left and empties the field', async () => {
  const { onLocked } = await setup();
  await controllerJoined();
  api.set(`POST ${CONFIRM}`, reply({ ok: false, attemptsLeft: 2 }));

  const input = typeSas('111111');
  await confirm();

  assert.ok(screen.getByText('Wrong code. 2 attempts left.'));
  assert.equal(input.value, '');
  assert.equal(onLocked.mock.calls.length, 0);
});

test('the last attempt reads in the singular', async () => {
  await setup();
  await controllerJoined();
  api.set(`POST ${CONFIRM}`, reply({ ok: false, attemptsLeft: 1 }));

  typeSas('111111');
  await confirm();

  assert.ok(screen.getByText('Wrong code. 1 attempt left.'));
});

test('three misses lock pairing for 15 minutes and say until when', async () => {
  const { onLocked } = await setup();
  await controllerJoined();
  const until = NOW.getTime() + 15 * 60_000;
  api.set(`POST ${CONFIRM}`, reply({ ok: false, attemptsLeft: 0, lockedUntil: new Date(until).toISOString() }));

  typeSas('111111');
  await confirm();

  assert.ok(screen.getByText(/Pairing was cancelled and is locked for 15 minutes/));
  assert.equal(screen.queryByLabelText('Verification code shown on the Controller'), null);
  assert.deepEqual(onLocked.mock.calls[0], [until]);
});

test('without a lockedUntil from the server the lock is still shown for 15 minutes from now', async () => {
  const { onLocked } = await setup();
  await controllerJoined();
  api.set(`POST ${CONFIRM}`, reply({ ok: false, attemptsLeft: 0 }));

  typeSas('111111');
  await confirm();

  assert.deepEqual(onLocked.mock.calls[0], [NOW.getTime() + 2100 + 15 * 60_000]);
});

test('a pairing the server reports as failed with a lock shows the lock', async () => {
  const { onLocked } = await setup();
  const until = NOW.getTime() + 14 * 60_000;
  current = { state: 'failed', attemptsLeft: 0, lockedUntil: new Date(until).toISOString() };
  await settle(2100);

  assert.ok(screen.getByText(/locked for 15 minutes/));
  assert.deepEqual(onLocked.mock.calls[0], [until]);
});

test('a pairing that failed for another reason says so', async () => {
  const { onLocked } = await setup();
  current = { state: 'failed', attemptsLeft: 2 };
  await settle(2100);

  assert.ok(screen.getByText('Pairing failed. Close this window and start again.'));
  assert.equal(onLocked.mock.calls.length, 0);
});

test('when the five minutes run out the code is declared expired and the polling stops', async () => {
  await setup();

  await settle(301_000);
  assert.ok(screen.getByText('The code has expired. Close this window and start again.'));
  const asked = api.to('GET', PAIRING).length;
  await settle(20_000);
  assert.equal(api.to('GET', PAIRING).length, asked);
});

test('a server error while confirming does not look like a wrong SAS', async () => {
  await setup();
  await controllerJoined();
  api.set(`POST ${CONFIRM}`, failure(500, 'REMOTE_INTERNAL'));

  typeSas('111111');
  await confirm();

  assert.equal(screen.queryByText(/Wrong code/), null);
  assert.ok(screen.getByText('The code could not be checked. Try again.'));
});

test('Escape closes the dialog', async () => {
  const { onClose } = await setup();

  fireEvent.keyDown(window, { key: 'Escape' });

  assert.equal(onClose.mock.calls.length, 1);
});

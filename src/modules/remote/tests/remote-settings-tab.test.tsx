import assert from 'node:assert/strict';

import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { RemoteSettingsTab } from '@/modules/remote/RemoteSettingsTab';
import { onOpenRemoteTabRequest } from '@/modules/remote/utils/open-remote-tab-request';
import { failure, installFakeRemoteApi, reply, settle } from '@/modules/remote/tests/fake-remote-api';

/**
 * The Remote work tab of Settings, wired to a fake `/api/remote/*`: one poll
 * feeds every section, warnings come from what the server reports, and a server
 * with no Remote module leaves a single quiet line instead of a broken form.
 */

const RELAY = '/api/remote/relay-config';
const HOST = '/api/remote/host/status';
const PEERS = '/api/remote/peers';

const relay = { url: 'wss://relay.example.dev', hasSecret: true, masterKeySource: 'env' };
const host = {
  acceptEnabled: false,
  autoOffHours: 8,
  autoOffAt: null,
  relay: { state: 'stopped' },
  approvalTimeoutMs: 300000,
  controllers: [],
};
const peer = { peerId: 'peer_one11111', name: 'Laptop', state: 'online', lastConnectedAt: null };

let api: ReturnType<typeof installFakeRemoteApi>;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  api = installFakeRemoteApi({
    [`GET ${RELAY}`]: reply(relay),
    [`GET ${HOST}`]: reply(host),
    [`GET ${PEERS}`]: reply([peer]),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const open = async (onClose = vi.fn()) => {
  render(<RemoteSettingsTab onClose={onClose} />);
  await settle();
  return { onClose };
};

test('it loads the relay, the Host status and the paired Hosts and shows each section', async () => {
  await open();

  assert.ok(screen.getByRole('heading', { name: 'Remote work' }));
  assert.equal((screen.getByLabelText('Relay URL') as HTMLInputElement).value, 'wss://relay.example.dev');
  assert.ok(screen.getByRole('switch', { name: 'Accept Controllers' }));
  assert.ok(screen.getByText('Laptop'));
  assert.ok(screen.getByText('No Controllers are paired with this Host.'));
  assert.equal(api.to('GET', RELAY).length, 1);
});

test('one poll serves every section: host status and peers are each read once per cycle', async () => {
  await open();
  await settle(2100);

  assert.equal(api.to('GET', HOST).length, 2);
  assert.equal(api.to('GET', PEERS).length, 2);
});

test('a healthy setup shows no warnings', async () => {
  await open();

  assert.equal(screen.queryByRole('alert'), null);
});

test('a file-based master key is warned about next to the settings (FR-41)', async () => {
  api.set(`GET ${RELAY}`, reply({ ...relay, masterKeySource: 'file' }));
  await open();

  assert.match(screen.getByRole('alert').textContent ?? '', /REMOTECLI_MASTER_KEY/);
});

test('a master key mismatch reported by the server is shown as a warning', async () => {
  api.set(`GET ${HOST}`, failure(409, 'MASTER_KEY_MISMATCH'));
  await open();

  assert.match(screen.getByRole('alert').textContent ?? '', /changed or is missing/);
});

test('a relay-config answer that carries the mismatch code counts too', async () => {
  api.set(`GET ${RELAY}`, failure(409, 'MASTER_KEY_MISMATCH'));
  await open();

  assert.match(screen.getByRole('alert').textContent ?? '', /changed or is missing/);
});

test('an unsupported mode is warned about and Accept cannot be switched on', async () => {
  api.set(`GET ${HOST}`, failure(409, 'REMOTE_UNSUPPORTED_MODE'));
  await open();

  assert.match(screen.getByRole('alert').textContent ?? '', /not supported in this server mode/);
  assert.equal((screen.getByRole('switch', { name: 'Accept Controllers' }) as HTMLButtonElement).disabled, true);
});

test('a short approval timeout is warned about once the Host reports it (FR-31)', async () => {
  api.set(`GET ${HOST}`, reply({ ...host, approvalTimeoutMs: 55000 }));
  await open();

  assert.match(screen.getByRole('alert').textContent ?? '', /time out after 55 seconds/);
});

test('on a server without the Remote module there is one line and nothing to configure', async () => {
  api.set(`GET ${RELAY}`, { status: 404, body: {} });
  api.set(`GET ${HOST}`, { status: 404, body: {} });
  await open();

  assert.ok(screen.getByText('Remote work is not available on this server.'));
  assert.equal(screen.queryByLabelText('Relay URL'), null);
  assert.equal(screen.queryByRole('switch'), null);
});

test('the Host audit log is read once on open, not on every status poll', async () => {
  api.set('GET /api/remote/host/audit', reply({
    entries: [{ id: 1, at: Date.now(), pairingId: 'p1', controller: 'Alice-PC', event: 'connect', target: 'link-1', result: 'ok', detail: {} }],
    nextBefore: null,
    controllers: [{ pairingId: 'p1', label: 'Alice-PC' }],
  }));
  await open();
  await settle(6100);

  assert.ok(screen.getByText('link-1'));
  assert.equal(api.calls.filter((call) => call.path.startsWith('/api/remote/host/audit')).length, 1);
});

test('the Audit log is the last section of the tab, after the paired Hosts', async () => {
  api.set('GET /api/remote/host/audit', reply({ entries: [], nextBefore: null, controllers: [] }));
  await open();

  const hosts = screen.getByRole('heading', { name: 'Paired Hosts' });
  const audit = screen.getByRole('heading', { name: 'Audit log' });
  assert.ok(hosts.compareDocumentPosition(audit) & Node.DOCUMENT_POSITION_FOLLOWING, 'the audit log comes after the paired Hosts');
  const headings = [...document.querySelectorAll('h3, h4')].map((heading) => heading.textContent);
  assert.equal(headings[headings.length - 1], 'Audit log', 'no section follows it');
});

test('in an unsupported mode the audit log is not even requested', async () => {
  api.set(`GET ${HOST}`, failure(409, 'REMOTE_UNSUPPORTED_MODE'));
  await open();

  assert.equal(api.calls.filter((call) => call.path.startsWith('/api/remote/host/audit')).length, 0);
});

test('Open tab on a Host asks the tab bar to select it and closes Settings', async () => {
  const requests: string[] = [];
  const stop = onOpenRemoteTabRequest((peerId) => requests.push(peerId));
  const { onClose } = await open();

  fireEvent.click(screen.getByRole('button', { name: /Open tab/ }));
  stop();

  assert.deepEqual(requests, ['peer_one11111']);
  assert.equal(onClose.mock.calls.length, 1);
});

test('pairing a Controller needs the password, then shows the code on the Host', async () => {
  api.set('POST /api/remote/host/pairings/start', reply({
    pairingId: 'p1',
    code: 'ABCD1234',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  }));
  api.set('GET /api/remote/host/pairings/:id', reply({ state: 'waiting-controller', attemptsLeft: 3 }));
  await open();

  fireEvent.click(screen.getByRole('button', { name: 'Pair a Controller' }));
  await settle();
  fireEvent.change(screen.getByLabelText('Account password'), { target: { value: 'account-password-1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  await settle();

  assert.deepEqual(api.to('POST', '/api/remote/host/pairings/start')[0]?.body, { password: 'account-password-1' });
  assert.equal(screen.getByLabelText('Pairing code').textContent, 'ABCD-1234');
});

test('after a lockout, starting another pairing is blocked until the lock is over', async () => {
  api.set('POST /api/remote/host/pairings/start', reply({
    pairingId: 'p1',
    code: 'ABCD1234',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  }));
  api.set('GET /api/remote/host/pairings/:id', reply({ state: 'awaiting-sas', controllerName: 'Mallory', attemptsLeft: 3 }));
  api.set('POST /api/remote/host/pairings/p1/confirm', reply({ ok: false, attemptsLeft: 0 }));
  await open();

  fireEvent.click(screen.getByRole('button', { name: 'Pair a Controller' }));
  await settle();
  fireEvent.change(screen.getByLabelText('Account password'), { target: { value: 'account-password-1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  await settle(2100);
  fireEvent.change(screen.getByLabelText('Verification code shown on the Controller'), { target: { value: '111111' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  await settle();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));

  assert.equal((screen.getByRole('button', { name: 'Pair a Controller' }) as HTMLButtonElement).disabled, true);
  assert.match(document.body.textContent ?? '', /Pairing is locked until /);

  await settle(15 * 60_000 + 1000);
  assert.equal((screen.getByRole('button', { name: 'Pair a Controller' }) as HTMLButtonElement).disabled, false);
});

test('Pair with a Host opens the Controller dialog and a finished pairing refreshes the list', async () => {
  api.set('POST /api/remote/peers/join', reply({ joinId: 'join_1' }));
  api.set('GET /api/remote/peers/join/join_1', reply({ state: 'done', peerId: 'peer_two22222' }));
  await open();
  const peersBefore = api.to('GET', PEERS).length;

  fireEvent.click(screen.getByRole('button', { name: 'Pair with a Host' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Pairing code'), { target: { value: 'abcd1234' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Pair' }));
  await settle(2100);

  assert.ok(api.to('GET', PEERS).length > peersBefore);
  assert.ok(screen.getByText('Paired. The Host now appears in the list and as a tab.'));
});

test('while the tab is open the status poll runs and when it closes nothing is left polling', async () => {
  const view = render(<RemoteSettingsTab onClose={() => {}} />);
  await settle();
  view.unmount();
  const settled = api.to('GET', HOST).length;

  await settle(20_000);

  assert.equal(api.to('GET', HOST).length, settled);
});

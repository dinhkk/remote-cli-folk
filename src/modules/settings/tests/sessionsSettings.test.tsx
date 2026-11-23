import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import SessionsSettingsTab from '@/modules/settings/tabs/SessionsSettingsTab';

const state = vi.hoisted(() => ({ target: false, sessions: vi.fn(), revoke: vi.fn(), logoutAll: vi.fn(), logout: vi.fn(), expire: vi.fn() }));
vi.mock('@/modules/auth', () => ({ useAuth: () => ({ logout: state.logout }) }));
vi.mock('@/shared/authToken', () => ({ expireAuthSession: state.expire }));
vi.mock('@/shared/transport/target-context', () => ({ isTargetMode: () => state.target }));
vi.mock('@/shared/api', () => ({
  api: { auth: { sessions: state.sessions, revokeSession: state.revoke, logoutAll: state.logoutAll } },
  readApiJson: async (response: Response) => { if (!response.ok) throw new Error('refused'); return response.json(); },
}));
const ok = (value: unknown) => new Response(JSON.stringify(value));
const devices = [
  { id: 'a', browser: 'Chrome', current: true, createdAt: 1000, lastSeenAt: 1000, expiresAt: 2000 },
  { id: 'b', browser: 'Firefox', current: false, createdAt: 1000, lastSeenAt: 1000, expiresAt: 2000 },
];
beforeEach(() => {
  vi.resetAllMocks(); state.target = false;
  state.sessions.mockImplementation(async () => ok({ sessions: devices }));
  state.revoke.mockImplementation(async () => ok({ success: true }));
  state.logoutAll.mockImplementation(async () => ok({ success: true }));
});

test('K-11: revoke another device refreshes the list without logging out the current device', async () => {
  render(<SessionsSettingsTab />);
  const other = await screen.findByText('Firefox');
  fireEvent.click(within(other.closest('li')!).getByRole('button'));
  await waitFor(() => assert.equal(state.sessions.mock.calls.length, 2));
  assert.deepEqual(state.revoke.mock.calls[0], ['b']);
  assert.equal(state.expire.mock.calls.length, 0);
});

test('K-11: revoking this device clears local authenticated UI state after the server succeeds', async () => {
  render(<SessionsSettingsTab />);
  const current = await screen.findByText(/Chrome/);
  fireEvent.click(within(current.closest('li')!).getByRole('button'));
  await waitFor(() => assert.equal(state.expire.mock.calls.length, 1));
  assert.deepEqual(state.revoke.mock.calls[0], ['a']);
});

test('K-11: logout-all sends the confirmation password, clears the input and preserves login on rejection', async () => {
  state.logoutAll.mockImplementation(async () => new Response('{}', { status: 401 }));
  const { container } = render(<SessionsSettingsTab />);
  await screen.findByText('Firefox');
  const input = container.querySelector('input')!;
  fireEvent.change(input, { target: { value: 'synthetic-password' } });
  fireEvent.submit(container.querySelector('form')!);
  await screen.findByRole('alert');
  assert.deepEqual(state.logoutAll.mock.calls[0], ['synthetic-password']);
  assert.equal(input.value, '');
  assert.equal(state.expire.mock.calls.length, 0);
});

test('the Host frame cannot manage Controller browser sessions', () => {
  state.target = true;
  const { container } = render(<SessionsSettingsTab />);
  assert.equal(container.textContent, '');
  assert.equal(state.sessions.mock.calls.length, 0);
});

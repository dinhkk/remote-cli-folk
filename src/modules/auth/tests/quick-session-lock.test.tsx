import assert from 'node:assert/strict';

import { act, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type * as ApiModule from '@/shared/api';
import type * as TargetModule from '@/shared/transport/target-context';
import QuickSessionLockButton from '@/modules/auth/QuickSessionLockButton';
import { MFA_STATUS_CHANGED_EVENT } from '@/modules/auth/mfa-status-event';
import { AUTH_SESSION_LOCKED_EVENT } from '@/shared/authToken';

const mocks = vi.hoisted(() => ({ status: vi.fn(), lock: vi.fn(), target: false }));
vi.mock('@/shared/api', async importOriginal => ({
  ...await importOriginal<typeof ApiModule>(),
  api: { auth: { mfaStatus: mocks.status, lock: mocks.lock } },
}));
vi.mock('@/shared/transport/target-context', async importOriginal => ({
  ...await importOriginal<typeof TargetModule>(),
  isTargetMode: () => mocks.target,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const locked = vi.fn();
beforeEach(() => {
  mocks.target = false;
  mocks.status.mockReset().mockImplementation(async () => response({ enabled: true }));
  mocks.lock.mockReset().mockImplementation(async () => response({ success: true }));
  locked.mockReset();
  window.addEventListener(AUTH_SESSION_LOCKED_EVENT, locked);
});
afterEach(() => window.removeEventListener(AUTH_SESSION_LOCKED_EVENT, locked));

test('QL-02/05: accessible native button announces lock only after server success', async () => {
  let finish!: (r: Response) => void;
  mocks.lock.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
  const view = render(<QuickSessionLockButton />);
  const button = await view.findByRole('button', { name: 'quickLock.label' });
  assert.equal(button.tagName, 'BUTTON');
  assert.equal(button.getAttribute('type'), 'button');
  assert.equal(button.tabIndex, 0);
  assert.equal(button.getAttribute('title'), 'quickLock.label');
  button.focus();
  assert.equal(document.activeElement, button);
  fireEvent.click(button, { detail: 0 });
  assert.equal(mocks.lock.mock.calls.length, 1);
  assert.equal(locked.mock.calls.length, 0);
  await act(async () => { finish(response({ success: true })); });
  assert.equal(locked.mock.calls.length, 1);
});

test('QL-03: hidden while status loads and when TOTP is disabled', async () => {
  let finish!: (r: Response) => void;
  mocks.status.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
  const view = render(<QuickSessionLockButton />);
  assert.equal(Boolean(view.queryByRole('button')), false);
  await act(async () => { finish(response({ enabled: false })); });
  assert.equal(Boolean(view.queryByRole('button')), false);
  assert.equal(mocks.lock.mock.calls.length, 0);
});

test('QL-04: repeated activation during an outstanding request sends only one lock', async () => {
  let finish!: (r: Response) => void;
  mocks.lock.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
  const view = render(<QuickSessionLockButton />);
  const button = await view.findByRole('button', { name: 'quickLock.label' });
  act(() => { fireEvent.click(button); fireEvent.click(button); fireEvent.click(button); });
  assert.equal(mocks.lock.mock.calls.length, 1);
  assert.equal(button.getAttribute('aria-busy'), 'true');
  await act(async () => { finish(response({ success: true })); });
  assert.equal(locked.mock.calls.length, 1);
});

for (const failure of ['network', 'server', 'mfa-disabled']) {
  test(`QL-04: ${failure} failure reports an error without a fake lock and permits retry`, async () => {
    mocks.lock.mockImplementationOnce(() => failure === 'network'
      ? Promise.reject(new Error('Network unavailable'))
      : Promise.resolve(response({ success: false, error: { code: failure === 'mfa-disabled' ? 'MFA_DISABLED' : 'INTERNAL_ERROR' } }, failure === 'mfa-disabled' ? 409 : 500)));
    const view = render(<QuickSessionLockButton />);
    const button = await view.findByRole('button', { name: 'quickLock.label' });
    fireEvent.click(button);
    assert.equal((await view.findByRole('alert')).textContent, 'quickLock.error');
    assert.equal(locked.mock.calls.length, 0);
    fireEvent.click(button);
    await waitFor(() => assert.equal(locked.mock.calls.length, 1));
    assert.equal(view.queryByRole('alert'), null);
  });
}

test('QL-03/06: enrollment metadata refresh reveals or hides the button without storage', async () => {
  mocks.status.mockResolvedValueOnce(response({ enabled: false }));
  const view = render(<QuickSessionLockButton />);
  await act(async () => {});
  assert.equal(Boolean(view.queryByRole('button')), false);
  mocks.status.mockResolvedValueOnce(response({ enabled: true }));
  fireEvent(window, new Event(MFA_STATUS_CHANGED_EVENT));
  await view.findByRole('button', { name: 'quickLock.label' });
  mocks.status.mockResolvedValueOnce(response({ enabled: false }));
  fireEvent(window, new Event(MFA_STATUS_CHANGED_EVENT));
  await waitFor(() => assert.equal(Boolean(view.queryByRole('button')), false));
  assert.equal(mocks.lock.mock.calls.length, 0);
});

test('QL-03: failed or stale status reads do not expose an enabled button', async () => {
  let old!: (r: Response) => void;
  mocks.status.mockImplementationOnce(() => new Promise<Response>(resolve => { old = resolve; }));
  const view = render(<QuickSessionLockButton />);
  mocks.status.mockRejectedValueOnce(new Error('Unavailable'));
  fireEvent(window, new Event('focus'));
  await act(async () => {});
  await act(async () => { old(response({ enabled: true })); });
  assert.equal(Boolean(view.queryByRole('button')), false);
});

test('QL-06: target iframe never calls its Host auth endpoints', () => {
  mocks.target = true;
  const view = render(<QuickSessionLockButton />);
  assert.equal(Boolean(view.queryByRole('button')), false);
  assert.equal(mocks.status.mock.calls.length, 0);
  assert.equal(mocks.lock.mock.calls.length, 0);
});

test('QL-05: every locale supplies translated accessible label and error', () => {
  const locales = import.meta.glob<{ quickLock: { label: string; error: string } }>('../../i18n/locales/*/auth.json', { eager: true, import: 'default' });
  assert.equal(Object.keys(locales).length, 15);
  for (const [path, locale] of Object.entries(locales)) {
    assert.ok(locale.quickLock.label && locale.quickLock.error, path);
    if (!path.includes('/en/')) assert.notEqual(locale.quickLock.label, 'Lock session', path);
  }
});


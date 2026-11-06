import assert from 'node:assert/strict';

import { afterEach, test, vi } from 'vitest';

import { frameWindow } from '@/shared/tests/framed-window';

// A Remote tab only exists inside a frame.
frameWindow();

/**
 * A Remote tab keeps its preferences (theme, permission mode, ...) in the
 * tab's own storage, which the Controller stores per Host. They are never
 * synced to the Host: PATCH /api/user/preferences is refused for Remote, and
 * reading the Host's own preferences would mix its settings into the tab.
 */

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.name = '';
  window.history.replaceState(null, '', '/');
});

const load = async (target: boolean) => {
  vi.resetModules();
  window.history.replaceState(null, '', target ? '/?target=peer_abc12345' : '/');
  window.name = '';
  localStorage.clear();
  const ctx = await import('@/shared/transport/target-context');
  ctx.initTargetContext();
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ preferences: {} }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return { settings: await import('@/shared/userSettings'), fetchMock };
};

test('in a tab a preference write stays in storage and is never sent to the Host', async () => {
  vi.useFakeTimers();
  const { settings, fetchMock } = await load(true);

  settings.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(2000);

  assert.equal(settings.readUserPreference('theme', 'light'), 'dark');
  assert.match(localStorage.getItem('user-preferences') ?? '', /dark/);
  assert.equal(fetchMock.mock.calls.length, 0);
});

test('in a tab hydrating preferences does not read the Host', async () => {
  const { settings, fetchMock } = await load(true);

  await settings.hydrateUserPreferences();

  assert.equal(fetchMock.mock.calls.length, 0);
});

test('locally a write is still pushed to the server after the debounce', async () => {
  vi.useFakeTimers();
  const { settings, fetchMock } = await load(false);

  settings.writeUserPreference('theme', 'dark');
  await vi.advanceTimersByTimeAsync(2000);

  assert.equal(fetchMock.mock.calls.length, 1);
});

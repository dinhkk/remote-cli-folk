import assert from 'node:assert/strict';

import { fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import SettingsSidebar from '@/modules/settings/SettingsSidebar';
import { useSettingsController } from '@/modules/settings/hooks/useSettingsController';

/**
 * "Remote work" is a fixed entry of the settings dialog, reachable like any
 * other tab, and it is the only tab hidden inside a Remote tab frame, where the
 * management API is not available.
 */

const TARGET = vi.hoisted(() => ({ active: false }));
vi.mock('@/shared/transport/target-context', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isTargetMode: () => TARGET.active,
}));

vi.mock('@/shared/api', () => {
  const ok = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  return {
    api: {
      settings: {
        notificationPreferences: () => Promise.resolve({ ok: false }),
        saveNotificationPreferences: () => Promise.resolve({ ok: true, json: async () => ({}) }),
      },
      user: {
        preferences: async () => new Response(JSON.stringify({ preferences: {} }), { status: 200 }),
        savePreferences: ok,
        drafts: ok,
        saveDraft: ok,
        deleteDraft: ok,
      },
    },
  };
});
vi.mock('@/shared/context/ThemeContext', () => {
  const theme = { isDarkMode: false, toggleDarkMode: () => undefined };
  return { useTheme: () => theme };
});
vi.mock('@/modules/provider-auth', () => {
  const authStatus = {
    providerAuthStatus: {},
    checkProviderAuthStatus: () => Promise.resolve({ authenticated: false }),
    refreshProviderAuthStatuses: () => Promise.resolve(),
  };
  return { useProviderAuthStatus: () => authStatus };
});

beforeEach(() => {
  TARGET.active = false;
  localStorage.clear();
});
afterEach(() => {
  TARGET.active = false;
});

const desktopTabs = (container: HTMLElement) =>
  within(container.querySelector('aside nav') as HTMLElement)
    .getAllByRole('button')
    .map((button) => button.textContent);

test('the tab list is exactly the known tabs with Remote work just before About', () => {
  const { container } = render(<SettingsSidebar activeTab="agents" onChange={() => undefined} />);

  assert.deepEqual(desktopTabs(container), [
    'Agents',
    'Appearance',
    'Git',
    'API & Tokens',
    'Voice',
    'Tasks',
    'Browser',
    'Plugins',
    'Notifications',
    'Remote work',
    'Sessions',
    'About',
  ]);
});

test('Remote work is on the mobile pill bar too and selecting it reports the remote tab', () => {
  const onChange = vi.fn();
  const { container } = render(<SettingsSidebar activeTab="agents" onChange={onChange} />);

  const mobile = container.querySelector('div.md\\:hidden') as HTMLElement;
  fireEvent.click(within(mobile).getByRole('button', { name: 'Remote work' }));

  assert.deepEqual(onChange.mock.calls, [['remote']]);
});

test('inside a Remote tab frame the entry is not offered', () => {
  TARGET.active = true;
  const { container } = render(<SettingsSidebar activeTab="agents" onChange={() => undefined} />);

  assert.equal(desktopTabs(container).includes('Remote work'), false);
  assert.equal(screen.queryByRole('button', { name: 'Remote work' }), null);
});

test('the controller opens straight on the remote tab when asked to', () => {
  const { result } = renderHook(() => useSettingsController({ isOpen: true, initialTab: 'remote' }));

  assert.equal(result.current.activeTab, 'remote');
});

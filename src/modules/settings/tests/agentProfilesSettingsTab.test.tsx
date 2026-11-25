import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import '@/modules/i18n';
import AgentProfilesSettingsTab from '@/modules/settings/tabs/agent-profiles-settings/AgentProfilesSettingsTab';

/**
 * The Agent Profiles tab is web only: the Host denies its management routes to a Remote tab, so inside a Remote tab
 * frame the tab explains that instead of rendering screens that would only fail; elsewhere it shows the screens.
 */

const TARGET = vi.hoisted(() => ({ active: false }));
vi.mock('@/shared/transport/target-context', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isTargetMode: () => TARGET.active,
}));
vi.mock('@/modules/agent-profiles', () => ({
  AgentProfilesPanel: () => <div>panel</div>,
}));

const TAB_PROPS = {
  claudeAuth: { authenticated: true, email: null, loading: false },
  onSignIn: () => undefined,
  onClose: () => undefined,
};

beforeEach(() => {
  TARGET.active = false;
});
afterEach(() => {
  TARGET.active = false;
});

test('shows the management screens on the Host itself', () => {
  render(<AgentProfilesSettingsTab {...TAB_PROPS} />);

  expect(screen.getByText('Agent Profiles')).toBeTruthy();
  expect(screen.getByText('panel')).toBeTruthy();
});

test('inside a Remote tab it says the profiles are managed on the Host and renders no management screen', () => {
  TARGET.active = true;
  render(<AgentProfilesSettingsTab {...TAB_PROPS} />);

  expect(screen.getByText(/managed on the Host computer/)).toBeTruthy();
  expect(screen.queryByText('panel')).toBeNull();
});

import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import WorkspaceHeader from '@/modules/project-workspace/WorkspaceHeader';
import type { Project } from '@/shared/types';

vi.mock('@/modules/auth', () => ({ QuickSessionLockButton: () => <button aria-label="Lock session" /> }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/modules/project-workspace/WorkspaceTitle', () => ({ default: () => null }));
vi.mock('@/modules/project-workspace/WorkspaceConnectionStatus', () => ({ default: () => null }));
vi.mock('@/modules/project-workspace/WorkspaceTabs', () => ({ default: () => null }));
vi.mock('@/modules/project-workspace/WorkspaceTabsDropdown', () => ({ default: () => null }));
vi.mock('@/modules/project-workspace/MobileMenuButton', () => ({ default: () => null }));

for (const isMobile of [false, true]) {
  test(`QL-01: WorkspaceHeader includes the lock control without a sidebar (mobile ${isMobile})`, () => {
    const view = render(<WorkspaceHeader activeTab="chat" setActiveTab={() => {}}
      selectedProject={{ projectId: 'demo', displayName: 'Demo', name: 'demo', fullPath: '/demo', sessions: [] } as unknown as Project}
      selectedSession={null} shouldShowTasksTab={false} shouldShowBrowserTab={false}
      isMobile={isMobile} onMenuClick={() => {}} onRenameSession={async () => true} />);
    const button = view.getByRole('button', { name: 'Lock session' });
    assert.ok(button.closest('header'));
    assert.equal(view.getAllByRole('button', { name: 'Lock session' }).length, 1);
  });
}

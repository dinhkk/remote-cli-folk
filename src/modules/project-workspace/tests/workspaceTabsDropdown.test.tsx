import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

import WorkspaceTabsDropdown from '@/modules/project-workspace/WorkspaceTabsDropdown';
import WorkspaceHeader from '@/modules/project-workspace/WorkspaceHeader';
import type { AppTab, Project } from '@/shared/types';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: any) => (typeof options === 'string' ? options : options?.defaultValue || key),
    }),
  };
});

vi.mock('@/modules/plugins', () => ({
  usePlugins: () => ({ plugins: [] }),
  PluginIcon: () => <span data-testid="plugin-icon" />,
}));

vi.mock('@/modules/project-workspace/WorkspaceConnectionStatus', () => ({
  default: () => <span data-testid="connection-status" />,
}));

describe('WorkspaceTabsDropdown (Mobile Tab Switcher)', () => {
  it('renders trigger button with active tab', () => {
    const setActiveTab = vi.fn();
    render(
      <WorkspaceTabsDropdown
        activeTab="chat"
        setActiveTab={setActiveTab}
        shouldShowTasksTab={false}
        shouldShowBrowserTab={false}
      />,
    );

    const button = screen.getByRole('button', { name: /switch view/i });
    expect(button).toBeTruthy();
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens menu and selects a different tab', () => {
    const setActiveTab = vi.fn();
    render(
      <WorkspaceTabsDropdown
        activeTab="chat"
        setActiveTab={setActiveTab}
        shouldShowTasksTab={true}
        shouldShowBrowserTab={true}
      />,
    );

    const button = screen.getByRole('button', { name: /switch view/i });
    fireEvent.click(button);

    expect(button.getAttribute('aria-expanded')).toBe('true');
    const menu = screen.getByRole('menu');
    expect(menu).toBeTruthy();

    const shellItem = screen.getByRole('menuitem', { name: /tabs\.shell/i });
    fireEvent.click(shellItem);

    expect(setActiveTab).toHaveBeenCalledWith('shell');
  });

  it('lists no Agents view: the sub-agents live in the Running tab\'s Monitoring pane', () => {
    render(
      <WorkspaceTabsDropdown
        activeTab="chat"
        setActiveTab={vi.fn()}
        shouldShowTasksTab={true}
        shouldShowBrowserTab={true}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /switch view/i }));
    const labels = screen.getAllByRole('menuitem').map((item) => item.textContent);
    expect(labels).toEqual(['tabs.chat', 'tabs.shell', 'tabs.files', 'tabs.git', 'tabs.browser', 'tabs.tasks']);
  });

  it('closes menu when Escape is pressed', () => {
    const setActiveTab = vi.fn();
    render(
      <WorkspaceTabsDropdown
        activeTab="chat"
        setActiveTab={setActiveTab}
        shouldShowTasksTab={false}
        shouldShowBrowserTab={false}
      />,
    );

    const button = screen.getByRole('button', { name: /switch view/i });
    fireEvent.click(button);
    expect(screen.getByRole('menu')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('WorkspaceHeader mobile vs desktop layout', () => {
  const dummyProject: Project = {
    projectId: 'p1',
    name: 'test-project',
    displayName: 'Test Project',
    fullPath: '/path/to/test',
  };

  it('renders dropdown instead of scrollable tabs when isMobile is true', () => {
    const setActiveTab = vi.fn();
    render(
      <WorkspaceHeader
        activeTab="chat"
        setActiveTab={setActiveTab}
        selectedProject={dummyProject}
        selectedSession={null}
        shouldShowTasksTab={false}
        shouldShowBrowserTab={false}
        isMobile={true}
        onMenuClick={vi.fn()}
        onRenameSession={vi.fn()}
      />,
    );

    // Dropdown trigger is rendered on mobile
    expect(screen.getByRole('button', { name: /switch view/i })).toBeTruthy();
    // Scrollable tablist should not be rendered
    expect(screen.queryByRole('tablist')).toBeNull();
    // The monitor lives in the sidebar's Running tab: the header carries no Activity entry.
    expect(screen.queryByTestId('activity-button')).toBeNull();
  });

  it('renders scrollable tabs when isMobile is false', () => {
    const setActiveTab = vi.fn();
    render(
      <WorkspaceHeader
        activeTab="chat"
        setActiveTab={setActiveTab}
        selectedProject={dummyProject}
        selectedSession={null}
        shouldShowTasksTab={false}
        shouldShowBrowserTab={false}
        isMobile={false}
        onMenuClick={vi.fn()}
        onRenameSession={vi.fn()}
      />,
    );

    // Scrollable tablist is rendered on desktop
    expect(screen.getByRole('tablist')).toBeTruthy();
    // Mobile dropdown is not rendered
    expect(screen.queryByRole('button', { name: /switch view/i })).toBeNull();
    // No Activity entry in the desktop header either.
    expect(screen.queryByTestId('activity-button')).toBeNull();
  });
});

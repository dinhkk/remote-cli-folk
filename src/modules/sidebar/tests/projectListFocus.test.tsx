import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import React, { useState } from 'react';
import { test, vi } from 'vitest';

import type { ActiveSidebarRename, Project, SidebarProjectListProps, SidebarSessionSelection } from '@/shared/types';
import SidebarProjectList from '@/modules/sidebar/SidebarProjectList';
import SidebarContent from '@/modules/sidebar/SidebarContent';
import { getAllSessions } from '@/modules/sidebar/utils/sidebarProjectFormatting';

vi.mock('@/modules/sidebar/SidebarHeader', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/SidebarFooter', () => ({ default: () => null }));

vi.mock('@/shared/hooks/useProviderCapabilities', () => ({ useSessionForkingProviders: () => new Set() }));
vi.mock('@/modules/sidebar/hooks/useCompactSidebar', () => ({ useCompactSidebar: () => false }));

const makeProject = (projectId: string, sessionIds: string[]): Project => ({
  projectId,
  name: projectId,
  displayName: projectId,
  fullPath: `/tmp/${projectId}`,
  sessions: sessionIds.map((id) => ({
    id,
    summary: id,
    lastActivity: '2026-08-21T10:00:00.000Z',
  })),
}) as unknown as Project;

const PROJECT_A = makeProject('a', ['a1', 'a2']);
const PROJECT_B = makeProject('b', ['b1']);

const noop = () => {};
const t = ((key: string) => key) as unknown as SidebarProjectListProps['t'];
const NOW = new Date('2026-08-21T10:00:00.000Z');

// Held outside listProps because the caller owns their stability in production:
// activeSessions is useBusySessionIdSet(), which only changes identity when
// membership changes, and attentionSessionIds is passed into Sidebar from above.
// Rebuilding them per render here would test the harness, not the component.
const NO_SESSION_IDS: ReadonlySet<string> = new Set<string>();

const listProps = (
  activeRename: ActiveSidebarRename | null,
  sessionSelection: SidebarSessionSelection | null = null,
): SidebarProjectListProps => ({
  projects: [PROJECT_A, PROJECT_B],
  filteredProjects: [PROJECT_A, PROJECT_B],
  selectedProject: null,
  selectedSession: null,
  isLoading: false,
  loadingProgress: null,
  isProjectExpanded: () => false,
  activeRename,
  initialSessionsLoaded: new Set(),
  currentTime: NOW,
  deletingProjects: new Set(),
  tasksEnabled: false,
  mcpServerStatus: null,
  getProjectSessions: getAllSessions,
  onLoadMoreSessions: noop,
  loadingMoreProjects: new Set(),
  activeSessions: NO_SESSION_IDS,
  backgroundSessionIds: NO_SESSION_IDS,
  attentionSessionIds: NO_SESSION_IDS,
  isProjectStarred: () => false,
  onRenameDraftChange: noop,
  onToggleProject: noop,
  onProjectSelect: noop,
  onToggleStarProject: noop,
  onStartEditingProject: noop,
  onCancelEditingProject: noop,
  onSaveProjectName: noop,
  onDeleteProject: noop,
  onSessionSelect: noop,
  onDeleteSession: noop,
  onNewSession: noop,
  onStartEditingSession: noop,
  onCancelEditingSession: noop,
  onSaveEditingSession: noop,
  sessionSelection,
  onSetSessionSelection: noop,
  onToggleSessionSelected: noop,
  onCancelSessionSelection: noop,
  onDeleteSelectedSessions: noop,
  t,
});


const projects = Array.from({ length: 14 }, (_, index) => makeProject(`project-${index}`, []));

function ListHarness() {
  const [selected, select] = useState<Project | null>(null);
  const [expanded, expand] = useState<string | null>(null);
  const [starred, star] = useState<string | null>(null);
  return <SidebarProjectList {...listProps(null)} projects={projects} filteredProjects={projects}
    selectedProject={selected} onProjectSelect={select}
    isProjectExpanded={id => expanded === id} onToggleProject={id => expand(value => value === id ? null : id)}
    isProjectStarred={id => starred === id} onToggleStarProject={id => star(id)} />;
}

test('PL-04: selecting an overflow project preserves focus on its new row', () => {
  const view = render(<ListHarness />);
  fireEvent.click(view.getByRole('button', { name: 'projectOrganization.other' }));
  const row = view.getByRole('button', { name: /project-10/ });
  row.focus();
  assert.equal(document.activeElement, row);
  // Native button activation dispatches click for Enter/Space.
  fireEvent.click(row, { detail: 0 });
  const moved = view.getByRole('button', { name: /project-10/ });
  assert.notEqual(moved, row, 'row is remounted in the always-visible group');
  assert.equal(document.activeElement, moved);
  fireEvent.click(view.getByRole('button', { name: 'projectOrganization.other' }));
  assert.ok(view.getByRole('button', { name: /project-10/ }));
  view.unmount();
});

test('PL-04: moving an unfocused project does not steal external focus', () => {
  const props = { ...listProps(null), projects, filteredProjects: projects };
  const view = render(<><button>Outside</button><SidebarProjectList {...props} /></>);
  fireEvent.click(view.getByRole('button', { name: 'projectOrganization.other' }));
  view.getByRole('button', { name: /project-10/ }).focus();
  const outside = view.getByRole('button', { name: 'Outside' });
  outside.focus();
  view.rerender(<><button>Outside</button><SidebarProjectList {...props} selectedProject={projects[10]} /></>);
  assert.equal(document.activeElement, outside);
  view.unmount();
});

test('PL-04: pinning a focused project keeps focus after moving to pinned group', () => {
  const props = { ...listProps(null), projects, filteredProjects: projects };
  const view = render(<SidebarProjectList {...props} />);
  const row = view.getByRole('button', { name: /project-2/ });
  row.focus();
  view.rerender(<SidebarProjectList {...props} isProjectStarred={id => id === 'project-2'} />);
  assert.equal(document.activeElement, view.getByRole('button', { name: /project-2/ }));
  view.unmount();
});

const contentProps: React.ComponentProps<typeof SidebarContent> = {
  isPWA: false, isMobile: false, isLoading: false, projects, runningSessionsCount: 14,
  archivedProjects: [], archivedSessions: [], archivedSessionsCount: 0, isArchivedSessionsLoading: false,
  recentConversations: [], recentConversationsTotal: 0, recentConversationsHasMore: false,
  isRecentConversationsLoading: false, isLoadingMoreRecentConversations: false, recentConversationsError: false,
  searchFilter: '', searchMode: 'projects', conversationResults: null, isSearching: false, searchProgress: null,
  onSearchFilterChange: noop, onClearSearchFilter: noop, onSearchModeChange: noop,
  onRestoreArchivedProject: noop, onLoadMoreRecentConversations: noop, onRetryRecentConversations: noop,
  onArchivedSessionClick: noop, onRestoreArchivedSession: noop, onDeleteArchivedSession: noop,
  onConversationResultClick: noop, onRefresh: noop, isRefreshing: false, onCreateProject: noop,
  onCollapseSidebar: noop, updateAvailable: false, restartRequired: false, releaseInfo: null,
  latestVersion: null, currentVersion: '0.0.0-test', onShowVersionModal: noop, onShowSettings: noop,
  projectListProps: { ...listProps(null), projects, filteredProjects: projects }, t,
};

test('PL-03: SidebarContent bypasses grouping for Running and project search', () => {
  const view = render(<SidebarContent {...contentProps} />);
  assert.equal(view.container.querySelectorAll('[data-project-toggle]').length, 8);
  view.rerender(<SidebarContent {...contentProps} searchMode="running" />);
  assert.equal(view.container.querySelectorAll('[data-project-toggle]').length, 14);
  assert.equal(view.queryByRole('button', { name: 'projectOrganization.other' }), null);
  view.rerender(<SidebarContent {...contentProps} searchFilter="project" />);
  assert.equal(view.container.querySelectorAll('[data-project-toggle]').length, 14);
  assert.equal(view.queryByRole('button', { name: 'projectOrganization.other' }), null);
  view.unmount();
});

test('PL-04: all project organization labels are localized with the count placeholder', () => {
  const locales = import.meta.glob<{ projectOrganization: { pinned: string; other: string } }>(
    '../../i18n/locales/*/sidebar.json', { eager: true, import: 'default' },
  );
  assert.equal(Object.keys(locales).length, 15);
  for (const [path, locale] of Object.entries(locales)) {
    assert.ok(locale.projectOrganization.other.includes('{{count}}'), path);
    if (path.includes('/en/')) continue;
    assert.notEqual(locale.projectOrganization.pinned, 'Pinned projects', path);
    assert.notEqual(locale.projectOrganization.other, 'Other projects ({{count}})', path);
  }
});

import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import type { ActiveSidebarRename, Project, SidebarProjectListProps, SidebarSessionSelection } from '@/shared/types';
import SidebarProjectList from '@/modules/sidebar/SidebarProjectList';
import { getAllSessions } from '@/modules/sidebar/utils/sidebarProjectFormatting';

vi.mock('@/modules/sidebar/SidebarHeader', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/SidebarFooter', () => ({ default: () => null }));

vi.mock('@/shared/hooks/useProviderCapabilities', () => ({ useSessionForkingProviders: () => new Set() }));
vi.mock('@/modules/sidebar/hooks/useCompactSidebar', () => ({ useCompactSidebar: () => true }));

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

test('R7-08: compact project rows have an accessible name and keyboard activation', () => {
 const toggle = vi.fn();
 const props = { ...listProps(null), onToggleProject: toggle };
 const view = render(<SidebarProjectList {...props} />);
 const row = view.getByRole('button', { name: 'a', exact: true });
 row.focus(); assert.equal(document.activeElement, row);
 assert.equal(row.getAttribute('aria-expanded'), 'false');
 fireEvent.keyDown(row, { key: 'Enter' }); fireEvent.keyDown(row, { key: ' ' });
 assert.equal(toggle.mock.calls.length, 2);
 const nested = row.querySelector('button')!;
 fireEvent.keyDown(nested, { key: 'Enter' });
 assert.equal(toggle.mock.calls.length, 2);
});

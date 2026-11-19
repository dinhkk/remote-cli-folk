import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { beforeEach, test, vi } from 'vitest';

import type { Project, RecentConversationListItem } from '@/shared/types';

/**
 * The Conversations list keeps its own copy of each session's title and is
 * fetched only when its tab opens. A session renamed from the workspace header
 * is patched straight into `projects`, so the list has to fold that title in
 * itself, or the highlighted row would keep the old name beside the new header.
 */

const recentConversationsResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    recentConversations: (args: unknown) => recentConversationsResponse(args),
    archivedProjects: () => Promise.resolve({ ok: true, json: async () => ({ data: { projects: [] } }) }),
    getArchivedSessions: () => Promise.resolve({ ok: true, json: async () => ({ data: { sessions: [] } }) }),
  },
}));

const { useSidebarController } = await import('@/modules/sidebar/hooks/useSidebarController');

const t = ((key: string) => key) as unknown as TFunction;

const conversation = (sessionId: string, sessionTitle: string): RecentConversationListItem => ({
  sessionId,
  provider: 'claude',
  projectId: 'project-1',
  projectDisplayName: 'repo',
  sessionTitle,
  lastActivity: '2026-09-22T09:30:00.000Z',
});

const buildProject = (summaries: Record<string, string>): Project => ({
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'repo',
  isStarred: false,
  sessions: Object.entries(summaries).map(([id, summary]) => ({ id, summary, __provider: 'claude' as const })),
  sessionMeta: { hasMore: false, total: Object.keys(summaries).length },
});

const renderController = (initialProjects: Project[]) => renderHook(
  ({ projects }: { projects: Project[] }) => useSidebarController({
    projects,
    selectedProject: null,
    selectedSession: null,
    activeSessions: new Set<string>(),
    backgroundSessionIds: new Set<string>(),
    isLoading: false,
    isMobile: false,
    t,
    onRefresh: vi.fn(),
    onProjectSelect: vi.fn(),
    onSessionSelect: vi.fn(),
    setCurrentProject: vi.fn(),
    setSidebarVisible: vi.fn(),
    sidebarVisible: true,
  }),
  { initialProps: { projects: initialProjects } },
);

const openConversationsTab = async (initialProjects: Project[]) => {
  const rendered = renderController(initialProjects);
  act(() => {
    rendered.result.current.setSearchMode('conversations');
  });
  await waitFor(() => {
    assert.equal(rendered.result.current.recentConversations.length, 2);
  });
  return rendered;
};

beforeEach(() => {
  localStorage.clear();
  recentConversationsResponse.mockReset();
  recentConversationsResponse.mockResolvedValue({
    ok: true,
    json: async () => ({
      data: {
        conversations: [conversation('session-1', 'Original title'), conversation('session-2', 'session-2')],
        total: 2,
        hasMore: false,
      },
    }),
  });
});


test('provider pagination covers older sessions, load more, switching, and refresh', async () => {
  const rows = Array.from({ length: 145 }, (_, i) => ({ ...conversation(`s-${i}`, `Session ${i}`), provider: i < 100 ? 'claude' as const : 'codex' as const }));
  recentConversationsResponse.mockImplementation(async ({ limit, offset }: { limit: number; offset: number }) => ({
    ok: true,
    json: async () => ({ data: { conversations: rows.slice(offset, offset + limit), total: rows.length, hasMore: offset + limit < rows.length } }),
  }));
  const { result } = renderController([]);
  act(() => result.current.setSearchMode('conversations'));
  await waitFor(() => assert.equal(result.current.recentConversations.length, 40));
  assert.equal(result.current.recentConversationsTotal, 145);
  act(() => result.current.setConversationProvider('codex'));
  await waitFor(() => assert.equal(result.current.recentConversationsTotal, 45));
  assert.equal(result.current.recentConversations.length, 40);
  assert(result.current.recentConversations.every(row => row.provider === 'codex'));
  assert.equal(result.current.recentConversationsHasMore, true);
  const before = recentConversationsResponse.mock.calls.length;
  act(() => result.current.loadMoreRecentConversations());
  await waitFor(() => assert.equal(result.current.recentConversations.length, 45));
  assert.equal(result.current.recentConversationsHasMore, false);
  assert.equal(recentConversationsResponse.mock.calls.length, before);
  rows.push({ ...conversation('new-codex', 'New'), provider: 'codex' });
  act(() => result.current.reloadRecentConversations());
  await waitFor(() => assert.equal(result.current.recentConversationsTotal, 46));
  act(() => result.current.setConversationProvider('claude'));
  await waitFor(() => assert.equal(result.current.recentConversationsTotal, 100));
  assert(result.current.recentConversations.every(row => row.provider === 'claude'));
  act(() => result.current.setConversationProvider('all'));
  await waitFor(() => assert.equal(result.current.recentConversationsTotal, 146));
});

test('an old filter response cannot overwrite a newer filter', async () => {
  const rows = [conversation('a', 'A'), { ...conversation('b', 'B'), provider: 'codex' as const }];
  const response = { ok: true, json: async () => ({ data: { conversations: rows, total: 2, hasMore: false } }) };
  recentConversationsResponse.mockResolvedValue(response);
  const { result } = await openConversationsTab([]);
  let resolveOld!: (value: typeof response) => void;
  recentConversationsResponse.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  act(() => result.current.setConversationProvider('codex'));
  await waitFor(() => assert.equal(typeof resolveOld, 'function'));
  act(() => result.current.setConversationProvider('claude'));
  await waitFor(() => assert.equal(result.current.recentConversationsTotal, 1));
  await act(async () => resolveOld(response));
  assert.deepEqual(result.current.recentConversations.map(row => row.sessionId), ['a']);
  assert.equal(result.current.isRecentConversationsLoading, false);
});

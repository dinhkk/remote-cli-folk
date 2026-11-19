import type { ConversationSearchResults, Project, RecentConversationListItem } from '@/shared/types';

export type ConversationProviderFilter = 'all' | 'claude' | 'codex';

// Only known, disposable QA directories. A UUID or the word "test" alone is
// not evidence that a user's project is a test workspace.
export function isLegacyTestProject(project: Pick<Project, 'path' | 'fullPath'>): boolean {
  const path = (project.fullPath || project.path || '').replace(/\\/g, '/').replace(/\/$/, '');
  return /^\/home\/dinhtt\/claude-pocket-local-test-[^/]+(?:\/|$)/.test(path)
    || /^\/home\/dinhtt\/pocket-project-qa-[^/]+(?:\/|$)/.test(path)
    || /^\/tmp\/(?:pocket-live|remotecli-sdk-test)-[^/]+(?:\/|$)/.test(path)
    || path === '/home/dinhtt/remotecli-relay-smoke';
}

export function filterConversationSearch(
  search: ConversationSearchResults | null,
  provider: ConversationProviderFilter,
): ConversationSearchResults | null {
  if (!search || provider === 'all') return search;
  const results = search.results.map(project => ({
    ...project,
    sessions: project.sessions.filter(session =>
      (session.provider || session.matches[0]?.provider || 'claude') === provider),
  })).filter(project => project.sessions.length > 0);
  return {
    ...search,
    titleResults: search.titleResults.filter(session => session.provider === provider),
    results,
    totalMatches: results.reduce((total, project) =>
      total + project.sessions.reduce((count, session) => count + session.matches.length, 0), 0),
  };
}

export type RecentPage = { conversations: RecentConversationListItem[]; total: number; hasMore: boolean };

// v1.0.10 has no provider query on its recent endpoint. Read metadata pages
// (never message bodies) so older Codex sessions are included too. The caller
// caches this snapshot for pagination and discards it on refresh/filter change.
export async function collectProviderConversations(
  provider: Exclude<ConversationProviderFilter, 'all'>,
  fetchPage: (offset: number, limit: number) => Promise<RecentPage>,
  isCurrent: () => boolean,
): Promise<RecentConversationListItem[] | null> {
  const matches = new Map<string, RecentConversationListItem>();
  let offset = 0;
  while (isCurrent()) {
    const page = await fetchPage(offset, 100);
    if (!isCurrent()) return null;
    for (const conversation of page.conversations) {
      if (conversation.provider === provider) matches.set(conversation.sessionId, conversation);
    }
    if (!page.hasMore) return [...matches.values()];
    if (page.conversations.length === 0) throw new Error('Recent conversation pagination made no progress');
    offset += page.conversations.length;
  }
  return null;
}

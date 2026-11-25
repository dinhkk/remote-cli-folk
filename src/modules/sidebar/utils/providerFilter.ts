import type { ConversationSearchResults, LLMProvider, RecentConversationListItem } from '@/shared/types';

export type ConversationProviderFilter = 'all' | LLMProvider;

export function filterConversationSearch(result: ConversationSearchResults | null, provider: ConversationProviderFilter) {
  if (!result || provider === 'all') return result;
  const results = result.results.map(project => ({ ...project,
    sessions: project.sessions.filter(session => (session.provider ?? session.matches[0]?.provider) === provider),
  })).filter(project => project.sessions.length > 0);
  const titleResults = result.titleResults.filter(session => session.provider === provider);
  return { ...result, results, titleResults,
    totalMatches: results.reduce((total, project) => total + project.sessions.reduce((sum, session) => sum + session.matches.length, 0), 0),
  };
}

/** Load metadata only; cancellation is checked before and after every page. */
export async function collectProviderConversations(
  provider: LLMProvider,
  readPage: (offset: number) => Promise<{ conversations: RecentConversationListItem[]; hasMore: boolean }>,
  cancelled: () => boolean,
): Promise<RecentConversationListItem[] | null> {
  let offset = 0;
  const rows = new Map<string, RecentConversationListItem>();
  while (!cancelled()) {
    const page = await readPage(offset);
    if (cancelled()) return null;
    if (page.hasMore && page.conversations.length === 0) throw new Error('Empty conversation metadata page has more results');
    for (const row of page.conversations) if (row.provider === provider) rows.set(row.sessionId, row);
    if (!page.hasMore) return [...rows.values()];
    offset += page.conversations.length;
  }
  return null;
}

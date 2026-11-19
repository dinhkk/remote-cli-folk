import { expect, test } from 'vitest';

import { collectProviderConversations, filterConversationSearch, isLegacyTestProject } from '@/modules/sidebar/utils/sidebarOrganization';
import type { RecentConversationListItem } from '@/shared/types';

const row = (id: string, provider = 'claude') => ({ sessionId: id, provider } as RecentConversationListItem);

test('groups known QA paths without treating UUIDs or ordinary test projects as disposable', () => {
  for (const path of ['/home/dinhtt/claude-pocket-local-test-jjLF6R', '/home/dinhtt/claude-pocket-local-test-jjLF6R/workspace/uuid', '/tmp/pocket-live-GG9fr9', '/tmp/remotecli-sdk-test-EmS0pi', '/home/dinhtt/remotecli-relay-smoke']) {
    expect(isLegacyTestProject({ path, fullPath: path })).toBe(true);
  }
  for (const path of ['/work/51dd9d5b-b515-46c8-b4e2-73e382f14f5b', '/work/test', '/work/claude-pocket-local-test-jjLF6R', '/home/dinhtt/remotecli-relay-smoke-production']) {
    expect(isLegacyTestProject({ path, fullPath: path })).toBe(false);
  }
});

test('finds Codex beyond first page and deduplicates sessions across moving pages', async () => {
  const offsets: number[] = [];
  const result = await collectProviderConversations('codex', async offset => {
    offsets.push(offset);
    return offset === 0
      ? { conversations: [row('a'), row('b', 'codex')], total: 4, hasMore: true }
      : { conversations: [row('b', 'codex'), row('c', 'codex')], total: 4, hasMore: false };
  }, () => true);
  expect(offsets).toEqual([0, 2]);
  expect(result?.map(item => item.sessionId)).toEqual(['b', 'c']);
});

test('stops stale pagination when the user changes provider', async () => {
  let current = true;
  const result = await collectProviderConversations('codex', async () => {
    current = false;
    return { conversations: [row('a', 'codex')], total: 200, hasMore: true };
  }, () => current);
  expect(result).toBeNull();
});

test('does not return a misleading partial list on a failed later page', async () => {
  await expect(collectProviderConversations('codex', async offset => {
    if (offset) throw new Error('offline');
    return { conversations: [row('a', 'codex')], total: 200, hasMore: true };
  }, () => true)).rejects.toThrow('offline');
});

test('filters title and message search together and recalculates match count', () => {
  const search = {
    query: 'hello', totalMatches: 3,
    titleResults: [row('a'), row('b', 'codex')],
    results: [{ projectId: 'p', projectName: 'p', projectDisplayName: 'p', sessions: [
      { sessionId: 'a', sessionSummary: 'a', provider: 'claude', matches: [{ role: 'user', snippet: 'hello', highlights: [], timestamp: null }] },
      { sessionId: 'b', sessionSummary: 'b', matches: [{ role: 'user', snippet: 'hello', provider: 'codex', highlights: [], timestamp: null }, { role: 'assistant', snippet: 'hello', highlights: [], timestamp: null }] },
    ] }],
  };
  expect(filterConversationSearch(search, 'all')).toBe(search);
  const filtered = filterConversationSearch(search, 'codex')!;
  expect(filtered.titleResults.map(item => item.sessionId)).toEqual(['b']);
  expect(filtered.results[0].sessions.map(item => item.sessionId)).toEqual(['b']);
  expect(filtered.totalMatches).toBe(2);
  expect(filterConversationSearch({ ...search, results: [], titleResults: [row('a')] }, 'codex')?.titleResults).toEqual([]);
});

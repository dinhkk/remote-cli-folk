import { fireEvent, render, screen } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { expect, test, vi } from 'vitest';

import { SidebarProviderFilter } from '@/modules/sidebar/SidebarProviderFilter';
import { collectProviderConversations, filterConversationSearch } from '@/modules/sidebar/utils/providerFilter';
import { PROVIDER_LABELS } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import type { RecentConversationListItem } from '@/shared/types';

const row = (sessionId: string, provider: 'claude' | 'codex'): RecentConversationListItem => ({
  sessionId, provider, projectId: null, projectDisplayName: 'Example project', sessionTitle: sessionId, lastActivity: null,
});

test('UI-01/UI-02/UI-06: provider buttons use the shared catalog and expose pressed state', () => {
  const change = vi.fn();
  const t = ((key: string, options?: { provider?: string }) => options?.provider ?? key) as TFunction;
  render(<SidebarProviderFilter value="all" onChange={change} t={t} />);
  const buttons = screen.getAllByRole('button');
  expect(buttons).toHaveLength(Object.keys(PROVIDER_LABELS).length + 1);
  expect(buttons[0].getAttribute('aria-pressed')).toBe('true');
  for (const [provider, label] of Object.entries(PROVIDER_LABELS)) {
    const button = screen.getByRole('button', { name: label });
    expect(button.tabIndex).toBe(0);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(change).toHaveBeenLastCalledWith(provider);
  }
});

test('UI-03/UI-07: paginates metadata and returns only matching unique conversations', async () => {
  const page = vi.fn(async (offset: number) => offset === 0
    ? { conversations: [row('a', 'claude'), row('b', 'codex')], hasMore: true }
    : { conversations: [row('c', 'codex'), row('b', 'codex')], hasMore: false });
  expect((await collectProviderConversations('codex', page, () => false))?.map(r => r.sessionId)).toEqual(['b', 'c']);
  expect(page.mock.calls.map(c => c[0])).toEqual([0, 2]);
});

test('UI-04/UI-07: a cancelled metadata request cannot return rows or fetch the next page', async () => {
  let cancelled = false;
  const page = vi.fn(async () => {
    cancelled = true;
    return { conversations: [row('a', 'claude')], hasMore: true };
  });
  expect(await collectProviderConversations('claude', page, () => cancelled)).toBeNull();
  expect(page).toHaveBeenCalledTimes(1);
});

test('UI-07/KU-04: empty page with more results fails instead of looping', async () => {
  const page = vi.fn(async () => ({ conversations: [], hasMore: true }));
  await expect(collectProviderConversations('claude', page, () => false)).rejects.toThrow('Empty conversation');
  expect(page).toHaveBeenCalledTimes(1);
});

test('UI-03: title and message search results both follow the selected provider', () => {
  const result = filterConversationSearch({ query: 'hello', totalMatches: 2,
    titleResults: [{ sessionId: 'a', provider: 'claude', projectId: null, projectDisplayName: 'Example', sessionTitle: 'hello', lastActivity: null }],
    results: [{ projectId: null, projectName: 'Example', projectDisplayName: 'Example', sessions: [
      { sessionId: 'a', provider: 'claude', sessionSummary: 'hello', matches: [{ role: 'user', snippet: 'hello', highlights: [], timestamp: null }] },
      { sessionId: 'b', provider: 'codex', sessionSummary: 'hello', matches: [{ role: 'user', snippet: 'hello', highlights: [], timestamp: null }] },
    ] }],
  }, 'codex');
  expect(result?.titleResults).toEqual([]);
  expect(result?.results[0].sessions.map(s => s.sessionId)).toEqual(['b']);
  expect(result?.totalMatches).toBe(1);
});

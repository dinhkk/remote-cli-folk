import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import { PendingTab } from '@/modules/agent-profiles/pending/PendingTab';
import {
  failure,
  installFakeProfilesApi,
  makeImportResult,
  makePendingProposal,
  makeReviewItem,
  reply,
} from '@/modules/agent-profiles/tests/fake-profiles-api';
import type { PendingProposalView } from '@/shared/types';

/** The Pending tab: readable review of what a manager agent proposed, ticks, confirm with the basis, reject, results, expiry and polling. */

const LIST = 'GET /api/agent-profiles/pending';
const CONFIRM = 'POST /api/agent-profiles/pending/:id/confirm';
const REJECT = 'POST /api/agent-profiles/pending/:id/reject';

const LONG_TEXT = `${'You review code carefully. '.repeat(20)}END-OF-PROMPT`;

const CREATE = makeReviewItem({ key: 'template:beta-helper', lines: ['Creates the template "beta-helper".'] });
const OVERWRITE = makeReviewItem({
  key: 'template:alpha-reviewer',
  action: 'overwrite',
  needsTick: true,
  basis: 4,
  lines: ['Changes description, instructions.'],
  changes: [
    { field: 'description', before: 'Old words', after: 'New words' },
    { field: 'instructions', before: 'short', after: LONG_TEXT },
  ],
});
const DELETE = makeReviewItem({
  key: 'block:alpha-notes',
  action: 'delete',
  needsTick: true,
  basis: 7,
  lines: ['Deletes the memory block "alpha-notes": 1,200 characters of text in 3 folders are lost (a snapshot is taken first).'],
});
const SENSITIVE = makeReviewItem({
  key: 'template:beta-power',
  sensitive: ['mcpServers', 'tool:Bash'],
  lines: ['Creates the template "beta-power".'],
});
const REFUSED = makeReviewItem({
  key: 'block:beta-locked',
  action: 'refused',
  refusal: { code: 'BLOCK_READ_ONLY', message: 'This block is read-only.' },
});

const proposal = (items = [CREATE, OVERWRITE, DELETE, SENSITIVE], overrides: Partial<PendingProposalView> = {}) =>
  makePendingProposal({ id: 'p-1', items, ...overrides });

const setup = (proposals: PendingProposalView[] = [proposal()]) => {
  let current = proposals;
  const api = installFakeProfilesApi({
    [LIST]: () => reply(current),
    'GET /api/agent-profiles/pending/count': () => reply({ count: current.length }),
    [CONFIRM]: () => reply(makeImportResult({ items: [], snapshot: null })),
    [REJECT]: () => reply({ rejected: true }),
  });
  return { api, setProposals: (next: PendingProposalView[]) => { current = next; } };
};

const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
};

beforeEach(() => {
  setVisibility('visible');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const confirmButton = (agent = 'alpha-manager') => screen.getByRole('button', { name: `Confirm proposal of ${agent}` });

describe('PendingTab review', () => {
  it('shows the agent, age, expiry and a readable diff per item, never raw JSON', async () => {
    setup();
    render(<PendingTab />);

    const card = await screen.findByRole('article', { name: /alpha-manager/ });
    expect(within(card).getByText(/1 min ago/)).toBeTruthy();
    expect(within(card).getByText(/Expires in 23 h/)).toBeTruthy();
    expect(within(card).getByText('Creates the template "beta-helper".')).toBeTruthy();
    expect(within(card).getByText(/1,200 characters of text in 3 folders are lost/)).toBeTruthy();
    // Before and after of a changed field.
    expect(within(card).getByText('Old words')).toBeTruthy();
    expect(within(card).getByText('New words')).toBeTruthy();
    // The sensitive badge lists the reasons in words.
    expect(within(card).getByText('Sensitive')).toBeTruthy();
    expect(within(card).getByText(/defines MCP servers, may use the tool Bash/)).toBeTruthy();
    expect(card.textContent).not.toContain('"upsert"');
    expect(card.textContent).not.toContain('{');
  });

  it('cuts a long changed text and shows all of it on expand', async () => {
    setup();
    render(<PendingTab />);
    await screen.findByRole('article');

    expect(screen.queryByText(/END-OF-PROMPT/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show full text of instructions' }));
    expect(screen.getByText(/END-OF-PROMPT/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show less of instructions' }));
    expect(screen.queryByText(/END-OF-PROMPT/)).toBeNull();
  });

  it('shows why an item is refused and gives it no tick', async () => {
    setup([proposal([REFUSED])]);
    render(<PendingTab />);

    await screen.findByRole('article');
    expect(screen.getByText('This block is read-only.')).toBeTruthy();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('says so when nothing waits', async () => {
    setup([]);
    render(<PendingTab />);
    expect(await screen.findByText('No proposals are waiting.')).toBeTruthy();
  });

  it('shows a failed load with its reason and reloads on the refresh button', async () => {
    const { api } = setup();
    api.set(LIST, failure(500, 'INTERNAL', 'boom'));
    render(<PendingTab />);

    expect(await screen.findByRole('alert')).toBeTruthy();
    api.set(LIST, reply([proposal()]));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('article')).toBeTruthy();
    expect(api.to('GET', '/api/agent-profiles/pending')).toHaveLength(2);
  });
});

describe('PendingTab confirm', () => {
  it('ticks nothing by default and sends the ticked keys with the basis exactly as listed', async () => {
    const { api } = setup();
    render(<PendingTab />);
    await screen.findByRole('article');

    for (const box of screen.getAllByRole('checkbox')) expect((box as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Overwrite alpha-reviewer' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Delete alpha-notes' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Allow sensitive beta-power' }));
    fireEvent.click(confirmButton());

    await waitFor(() => expect(api.to('POST', '/api/agent-profiles/pending/p-1/confirm')).toHaveLength(1));
    expect(api.to('POST', '/api/agent-profiles/pending/p-1/confirm')[0]!.body).toEqual({
      overwrite: ['template:alpha-reviewer', 'block:alpha-notes'],
      acceptSensitive: ['template:beta-power'],
      basis: { 'template:alpha-reviewer': 4, 'block:alpha-notes': 7, 'template:beta-power': 'absent' },
    });
  });

  it('sends nothing ticked as empty lists', async () => {
    const { api } = setup();
    render(<PendingTab />);
    await screen.findByRole('article');
    fireEvent.click(confirmButton());

    await waitFor(() => expect(api.to('POST', '/api/agent-profiles/pending/p-1/confirm')).toHaveLength(1));
    expect(api.to('POST', '/api/agent-profiles/pending/p-1/confirm')[0]!.body).toEqual({ overwrite: [], acceptSensitive: [], basis: {} });
  });

  it('Select all sensitive ticks every sensitive item and only those', async () => {
    setup([proposal([OVERWRITE, SENSITIVE, makeReviewItem({ key: 'template:beta-more', sensitive: ['skills'] })])]);
    render(<PendingTab />);
    await screen.findByRole('article');

    fireEvent.click(screen.getByRole('button', { name: 'Select all sensitive' }));

    expect((screen.getByRole('checkbox', { name: 'Allow sensitive beta-power' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Allow sensitive beta-more' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Overwrite alpha-reviewer' }) as HTMLInputElement).checked).toBe(false);
  });

  it('shows per-item results, the partial warning and the snapshot name, and drops the proposal from the list', async () => {
    const { api, setProposals } = setup();
    api.set(CONFIRM, () => {
      setProposals([]);
      return reply(makeImportResult({
        partial: true,
        snapshot: 'snapshot-2026-11-26.json',
        items: [
          { key: 'template:beta-helper', status: 'applied' },
          { key: 'template:alpha-reviewer', status: 'skipped', code: 'STALE' },
          { key: 'block:alpha-notes', status: 'failed', reason: 'disk full' },
        ],
      }));
    });
    render(<PendingTab />);
    await screen.findByRole('article');
    fireEvent.click(confirmButton());

    const results = await screen.findByRole('list', { name: 'Import result' });
    expect(within(results).getByText('beta-helper').closest('li')!.textContent).toContain('Applied');
    expect(within(results).getByText('alpha-reviewer').closest('li')!.textContent).toContain('It changed since the preview');
    expect(within(results).getByText('alpha-notes').closest('li')!.textContent).toContain('Failed');
    expect(screen.getByText(/Some items or folders were not applied/)).toBeTruthy();
    expect(screen.getByText(/snapshot-2026-11-26\.json/)).toBeTruthy();
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('keeps the proposal and shows the error when confirm fails', async () => {
    const { api } = setup();
    api.set(CONFIRM, failure(404, 'PENDING_NOT_FOUND', 'That proposal is gone.'));
    render(<PendingTab />);
    await screen.findByRole('article');
    fireEvent.click(confirmButton());

    expect(await screen.findByText('That proposal is gone.')).toBeTruthy();
  });
});

describe('PendingTab reject, expiry and polling', () => {
  it('Reject removes the proposal', async () => {
    const { api, setProposals } = setup();
    api.set(REJECT, () => {
      setProposals([]);
      return reply({ rejected: true });
    });
    render(<PendingTab />);
    await screen.findByRole('article');
    fireEvent.click(screen.getByRole('button', { name: 'Reject proposal of alpha-manager' }));

    await waitFor(() => expect(screen.queryByRole('article')).toBeNull());
    expect(api.to('POST', '/api/agent-profiles/pending/p-1/reject')).toHaveLength(1);
  });

  it('an expired proposal disappears on the next poll', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { setProposals } = setup();
    render(<PendingTab />);
    await screen.findByRole('article');

    setProposals([]);
    await act(async () => { vi.advanceTimersByTime(15_000); });
    await waitFor(() => expect(screen.queryByRole('article')).toBeNull());
  });

  it('polls every 15 s while visible and not at all while the page is hidden', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { api } = setup();
    render(<PendingTab />);
    await screen.findByRole('article');
    const listCalls = () => api.to('GET', '/api/agent-profiles/pending').length;
    expect(listCalls()).toBe(1);

    await act(async () => { vi.advanceTimersByTime(15_000); });
    await waitFor(() => expect(listCalls()).toBe(2));

    act(() => setVisibility('hidden'));
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(listCalls()).toBe(2);

    // Coming back reads at once.
    act(() => setVisibility('visible'));
    await waitFor(() => expect(listCalls()).toBe(3));
  });

  it('stops polling when the tab unmounts', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { api } = setup();
    const view = render(<PendingTab />);
    await screen.findByRole('article');
    view.unmount();

    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(api.to('GET', '/api/agent-profiles/pending')).toHaveLength(1);
  });
});

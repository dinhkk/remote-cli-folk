import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import { PendingSettingsBadge } from '@/modules/agent-profiles/pending/PendingSettingsBadge';
import { PendingTab } from '@/modules/agent-profiles/pending/PendingTab';
import {
  installFakeProfilesApi,
  makeImportResult,
  makePendingProposal,
  makeReviewItem,
  reply,
} from '@/modules/agent-profiles/tests/fake-profiles-api';
import * as targetContext from '@/shared/transport/target-context';

/** The pending count on the Settings entry: Host only, about once a minute while the page is visible, refreshed after confirm and reject. */

const COUNT_PATH = '/api/agent-profiles/pending/count';

const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
};

beforeEach(() => {
  setVisibility('visible');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const setup = (count = 3) => {
  const state = { count };
  const api = installFakeProfilesApi({ 'GET /api/agent-profiles/pending/count': () => reply({ count: state.count }) });
  return { api, state };
};

describe('PendingSettingsBadge', () => {
  it('shows the number on a Host and nothing when it is zero', async () => {
    const { state } = setup(3);
    const view = render(<PendingSettingsBadge />);
    expect(await screen.findByText('3')).toBeTruthy();
    view.unmount();

    state.count = 0;
    render(<PendingSettingsBadge />);
    await waitFor(() => expect(screen.queryByText('0')).toBeNull());
    expect(document.body.textContent).toBe('');
  });

  it('caps a large number', async () => {
    setup(250);
    render(<PendingSettingsBadge />);
    expect(await screen.findByText('99+')).toBeTruthy();
  });

  it('in a Remote target renders nothing and never calls the endpoint', async () => {
    vi.spyOn(targetContext, 'isTargetMode').mockReturnValue(true);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { api } = setup(3);
    render(<PendingSettingsBadge />);

    await act(async () => { vi.advanceTimersByTime(180_000); });
    act(() => setVisibility('visible'));
    expect(api.calls).toHaveLength(0);
    expect(document.body.textContent).toBe('');
  });

  it('asks again about every 60 s while visible, not while hidden, and at once on coming back', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { api, state } = setup(1);
    render(<PendingSettingsBadge />);
    await screen.findByText('1');
    const calls = () => api.to('GET', COUNT_PATH).length;
    expect(calls()).toBe(1);

    state.count = 2;
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(await screen.findByText('2')).toBeTruthy();
    expect(calls()).toBe(2);

    act(() => setVisibility('hidden'));
    await act(async () => { vi.advanceTimersByTime(180_000); });
    expect(calls()).toBe(2);

    state.count = 4;
    act(() => setVisibility('visible'));
    expect(await screen.findByText('4')).toBeTruthy();
  });

  it('keeps the last number when a request fails and shows no toast', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { api } = setup(2);
    render(<PendingSettingsBadge />);
    await screen.findByText('2');

    api.set('GET /api/agent-profiles/pending/count', { status: 500, body: { success: false, error: { code: 'X', message: 'x' } } });
    await act(async () => { vi.advanceTimersByTime(60_000); });
    await waitFor(() => expect(api.to('GET', COUNT_PATH)).toHaveLength(2));
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('drops after a confirm and after a reject', async () => {
    const proposals = [
      makePendingProposal({ id: 'p-1', items: [makeReviewItem({ key: 'template:beta-one' })] }),
      makePendingProposal({ id: 'p-2', agentName: 'beta-manager', items: [makeReviewItem({ key: 'template:beta-two' })] }),
    ];
    const api = installFakeProfilesApi({
      'GET /api/agent-profiles/pending': () => reply(proposals),
      'GET /api/agent-profiles/pending/count': () => reply({ count: proposals.length }),
      'POST /api/agent-profiles/pending/:id/confirm': (call) => {
        proposals.splice(proposals.findIndex((entry) => entry.id === call.path.split('/')[4]), 1);
        return reply(makeImportResult());
      },
      'POST /api/agent-profiles/pending/:id/reject': (call) => {
        proposals.splice(proposals.findIndex((entry) => entry.id === call.path.split('/')[4]), 1);
        return reply({ rejected: true });
      },
    });
    render(<><PendingSettingsBadge /><PendingTab /></>);
    await screen.findByText('2', { selector: '[data-pending-count]' });

    fireEvent.click(screen.getByRole('button', { name: 'Confirm proposal of alpha-manager' }));
    expect(await screen.findByText('1', { selector: '[data-pending-count]' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Reject proposal of beta-manager' }));
    await waitFor(() => expect(document.querySelector('[data-pending-count]')).toBeNull());
    expect(api.to('GET', COUNT_PATH).length).toBeGreaterThanOrEqual(3);
  });
});

describe('Pending tab of the panel', () => {
  it('carries the count in the tab bar and opens the review', async () => {
    localStorage.setItem('agentProfiles.setupGuideDismissed', '1');
    const proposals = [makePendingProposal({ id: 'p-1', items: [makeReviewItem({ key: 'template:beta-one' })] })];
    installFakeProfilesApi({
      'GET /api/agent-profiles/templates': reply({ items: [], corrupt: [] }),
      'GET /api/agent-profiles/claude-agents': reply({ items: [], hiddenNames: [], hiddenRev: 1, managerNames: [], builtinSource: 'sdk' }),
      'GET /api/agent-profiles/pending': () => reply(proposals),
      'GET /api/agent-profiles/pending/count': () => reply({ count: proposals.length }),
    });
    const { AgentProfilesPanel } = await import('@/modules/agent-profiles/AgentProfilesPanel');
    render(<AgentProfilesPanel />);

    const tab = await screen.findByRole('tab', { name: /Pending/ });
    await waitFor(() => expect(tab.querySelector('[data-pending-tab-count]')?.textContent).toBe('1'));
    fireEvent.click(tab);
    expect(await screen.findByRole('article', { name: /alpha-manager/ })).toBeTruthy();
  });
});

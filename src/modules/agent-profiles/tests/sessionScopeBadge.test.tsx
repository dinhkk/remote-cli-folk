import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import { SessionScopeBadge } from '@/modules/agent-profiles';
import { installFakeProfilesApi, reply } from '@/modules/agent-profiles/tests/fake-profiles-api';

/** An open session names the main agent it was started with, read-only; a chat without one shows nothing. */

afterEach(() => {
  vi.unstubAllGlobals();
});

const details = (agentScope: unknown) => reply({ success: true, data: { sessionId: 's1', agentScope } });

const install = (agentScope: unknown) => installFakeProfilesApi({ 'GET /api/providers/sessions/:id': details(agentScope) });

describe('session scope badge', () => {
  it('names the main agent of the session, with nothing to click or change', async () => {
    install({ agentName: 'orchestrator' });
    render(<SessionScopeBadge sessionId="s1" enabled />);

    expect(await screen.findByText('Main agent: orchestrator')).toBeTruthy();
    // Read-only: the agent is fixed with the session.
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('reads only the session details: no project list, no agent list', async () => {
    const api = install({ agentName: 'review-code' });
    render(<SessionScopeBadge sessionId="s1" enabled />);

    await screen.findByText('Main agent: review-code');
    expect(api.calls.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /api/providers/sessions/s1']);
  });

  it('shows nothing for a chat without a scope or a scoped chat without a main agent', async () => {
    for (const agentScope of [null, { agentName: null }]) {
      const api = install(agentScope);
      const { container, unmount } = render(<SessionScopeBadge sessionId="s1" enabled />);

      await waitFor(() => expect(api.to('GET', '/api/providers/sessions/s1')).toHaveLength(1));
      await act(async () => { await Promise.resolve(); });
      expect(container.textContent).toBe('');
      unmount();
    }
  });

  it('shows nothing when the lookup fails: the badge never breaks the chat', async () => {
    installFakeProfilesApi({ 'GET /api/providers/sessions/:id': { status: 500, body: { success: false, error: { code: 'X', message: 'down' } } } });
    const { container } = render(<SessionScopeBadge sessionId="s1" enabled />);

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.textContent).toBe('');
  });

  it('does not look anything up for a provider without scopes or without a session', async () => {
    const api = install({ agentName: 'orchestrator' });
    const first = render(<SessionScopeBadge sessionId="s1" enabled={false} />);
    first.unmount();
    render(<SessionScopeBadge sessionId={null} enabled />);

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(api.calls).toEqual([]);
  });

  it('follows the session: a switch to another session replaces the badge instead of keeping the old one', async () => {
    const api = installFakeProfilesApi({
      'GET /api/providers/sessions/:id': (call) => details(call.path.endsWith('/s1') ? { agentName: 'orchestrator' } : null),
    });
    const view = render(<SessionScopeBadge sessionId="s1" enabled />);
    await screen.findByText('Main agent: orchestrator');

    view.rerender(<SessionScopeBadge sessionId="s2" enabled />);
    await waitFor(() => expect(screen.queryByText(/Main agent/)).toBeNull());
    expect(api.to('GET', '/api/providers/sessions/s2')).toHaveLength(1);
  });
});

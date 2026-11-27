import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import { AgentsTab } from '@/modules/agent-profiles/agents/AgentsTab';
import { useClaudeAgents } from '@/modules/agent-profiles/hooks/useClaudeAgents';
import {
  SIDEBAR_ALPHA,
  failure,
  installFakeProfilesApi,
  listing,
  makeClaudeAgent,
  reply,
} from '@/modules/agent-profiles/tests/fake-profiles-api';

/** The "Profile manager" switch of an agent row: saved through `PUT /claude-agents/managers` with the settings rev, sharing it with the hide list. */

afterEach(() => {
  vi.unstubAllGlobals();
});

const MANAGER = makeClaudeAgent({ source: 'user', name: 'alpha-manager', generated: true, generatedFrom: 'alpha-manager', path: '/home/me/.claude/agents/alpha-manager.md', prompt: 'Manage.' });
const EXPLORE = makeClaudeAgent({ name: 'Explore' });

/** The real hook feeding the real tab, like the panel does. */
function Harness() {
  const claude = useClaudeAgents(null);
  return (
    <AgentsTab
      projects={[SIDEBAR_ALPHA]}
      targetId=""
      onTargetChange={() => undefined}
      templates={[]}
      entries={claude.entries}
      status={claude.status}
      loadError={claude.error}
      builtinSource={claude.builtinSource}
      managerNames={claude.managerNames}
      onChangeHidden={claude.changeHidden}
      onChangeManagers={claude.changeManagers}
      onReload={claude.reload}
    />
  );
}

const setup = () => {
  const stored = { hidden: [] as string[], managers: [] as string[], rev: 5 };
  const api = installFakeProfilesApi({
    'GET /api/agent-profiles/claude-agents': () => reply(listing(
      [MANAGER, EXPLORE].map((entry) => ({ ...entry, hidden: stored.hidden.includes(entry.name) })),
      { hiddenNames: stored.hidden, managerNames: stored.managers, hiddenRev: stored.rev },
    )),
    'PUT /api/agent-profiles/claude-agents/managers': (call) => {
      const body = call.body as { names: string[]; rev: number };
      if (body.rev !== stored.rev) return failure(409, 'PROFILE_STALE', 'stale');
      stored.managers = body.names;
      stored.rev += 1;
      return reply({ profileManagerAgents: stored.managers, rev: stored.rev });
    },
    'PUT /api/agent-profiles/claude-agents/hidden': (call) => {
      const body = call.body as { names: string[]; rev: number };
      if (body.rev !== stored.rev) return failure(409, 'PROFILE_STALE', 'stale');
      stored.hidden = body.names;
      stored.rev += 1;
      return reply({ hiddenClaudeAgents: stored.hidden, rev: stored.rev });
    },
  });
  render(<Harness />);
  return { api, stored };
};

const managerSwitch = () => screen.getByRole('switch', { name: 'Profile manager for alpha-manager' });

describe('Profile manager switch', () => {
  it('shows the hint, offers the switch on file agents only, and starts off', async () => {
    setup();
    await screen.findByText('alpha-manager');

    expect(managerSwitch().getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByRole('switch', { name: 'Profile manager for Explore' })).toBeNull();
    expect(screen.getByText(/only for the user-level generated agent/)).toBeTruthy();
    expect(screen.getByText(/only in chats on this machine/)).toBeTruthy();
  });

  it('saves the new list with the rev and shows the stored state', async () => {
    const { api, stored } = setup();
    await screen.findByText('alpha-manager');

    fireEvent.click(managerSwitch());

    await waitFor(() => expect(managerSwitch().getAttribute('aria-checked')).toBe('true'));
    expect(api.to('PUT', '/api/agent-profiles/claude-agents/managers').map((call) => call.body)).toEqual([{ names: ['alpha-manager'], rev: 5 }]);
    expect(stored.managers).toEqual(['alpha-manager']);

    // Turning it off again sends the rev the first save returned.
    fireEvent.click(managerSwitch());
    await waitFor(() => expect(managerSwitch().getAttribute('aria-checked')).toBe('false'));
    expect(api.to('PUT', '/api/agent-profiles/claude-agents/managers')[1]!.body).toEqual({ names: [], rev: 6 });
  });

  it('a hide edit after a manager save uses the shared rev, and the manager list survives it', async () => {
    const { api, stored } = setup();
    await screen.findByText('alpha-manager');
    fireEvent.click(managerSwitch());
    await waitFor(() => expect(managerSwitch().getAttribute('aria-checked')).toBe('true'));

    fireEvent.click(screen.getByRole('switch', { name: 'Visible: alpha-manager' }));

    await waitFor(() => expect(api.to('PUT', '/api/agent-profiles/claude-agents/hidden')).toHaveLength(1));
    expect(api.to('PUT', '/api/agent-profiles/claude-agents/hidden')[0]!.body).toEqual({ names: ['alpha-manager'], rev: 6 });
    await waitFor(() => expect(stored.rev).toBe(7));
    expect(managerSwitch().getAttribute('aria-checked')).toBe('true');
  });

  it('a stale save (409) reloads the list and shows what the server holds', async () => {
    const { api, stored } = setup();
    await screen.findByText('alpha-manager');
    // Someone else changed the settings after this list was read.
    stored.rev = 9;
    stored.managers = ['other-manager'];

    fireEvent.click(managerSwitch());

    await waitFor(() => expect(api.to('GET', '/api/agent-profiles/claude-agents').length).toBeGreaterThanOrEqual(2));
    expect(managerSwitch().getAttribute('aria-checked')).toBe('false');
    // The next click builds on the reloaded list and rev.
    fireEvent.click(managerSwitch());
    await waitFor(() => expect(stored.managers).toEqual(['other-manager', 'alpha-manager']));
    expect(api.to('PUT', '/api/agent-profiles/claude-agents/managers').at(-1)!.body).toEqual({ names: ['other-manager', 'alpha-manager'], rev: 9 });
  });
});

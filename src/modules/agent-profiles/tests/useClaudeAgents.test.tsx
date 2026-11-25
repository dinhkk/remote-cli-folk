import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useClaudeAgents } from '@/modules/agent-profiles/hooks/useClaudeAgents';
import { failure, installFakeProfilesApi, listing, makeClaudeAgent, reply } from '@/modules/agent-profiles/tests/fake-profiles-api';

/** The agent list per target folder, and the hide list saves: serialized, built from the raw stored list, always with the revision last returned. */

afterEach(() => {
  vi.unstubAllGlobals();
});

const setup = () => {
  const stored = { names: ['ghost'], rev: 3 };
  const api = installFakeProfilesApi({
    'GET /api/agent-profiles/claude-agents': () => reply({
      items: [makeClaudeAgent({ name: 'Explore' }), makeClaudeAgent({ name: 'Plan' })],
      hiddenNames: stored.names,
      hiddenRev: stored.rev,
      builtinSource: 'sdk',
    }),
    // Like the server: a stale rev is refused, otherwise the list is replaced and the rev moves on.
    'PUT /api/agent-profiles/claude-agents/hidden': async (call) => {
      const body = call.body as { names: string[]; rev: number };
      // Slow enough that a second request issued meanwhile would overlap this one.
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (body.rev !== stored.rev) return failure(409, 'PROFILE_STALE', 'stale');
      stored.names = body.names;
      stored.rev += 1;
      return reply({ hiddenClaudeAgents: stored.names, rev: stored.rev });
    },
  });
  const hook = renderHook(() => useClaudeAgents(null));
  return { api, hook, stored };
};

describe('useClaudeAgents.changeHidden', () => {
  it('sends two changes made at once one after the other, the second with the rev the first returned and on top of its result', async () => {
    const { api, hook, stored } = setup();
    await waitFor(() => expect(hook.result.current.status).toBe('ready'));

    await act(async () => {
      await Promise.all([
        hook.result.current.changeHidden((names) => [...names, 'Explore']),
        hook.result.current.changeHidden((names) => [...names, 'Plan']),
      ]);
    });

    expect(api.to('PUT', '/api/agent-profiles/claude-agents/hidden').map((call) => call.body)).toEqual([
      { names: ['ghost', 'Explore'], rev: 3 },
      { names: ['ghost', 'Explore', 'Plan'], rev: 4 },
    ]);
    expect(stored).toEqual({ names: ['ghost', 'Explore', 'Plan'], rev: 5 });
  });

  it('a failed change does not block the one after it', async () => {
    const { api, hook } = setup();
    await waitFor(() => expect(hook.result.current.status).toBe('ready'));
    api.set('PUT /api/agent-profiles/claude-agents/hidden', failure(409, 'PROFILE_STALE', 'stale'));

    await act(async () => {
      const failed = hook.result.current.changeHidden((names) => [...names, 'Explore']);
      const next = hook.result.current.changeHidden((names) => [...names, 'Plan']);
      await expect(failed).rejects.toBeTruthy();
      await expect(next).rejects.toBeTruthy();
    });

    expect(api.to('PUT', '/api/agent-profiles/claude-agents/hidden')).toHaveLength(2);
  });
});

describe('useClaudeAgents target', () => {
  it('reads the global list without a query and a project list with ?directory=<folder>', async () => {
    const api = installFakeProfilesApi({
      'GET /api/agent-profiles/claude-agents': (call) => reply(listing(call.path.includes('directory=')
        ? [makeClaudeAgent({ name: 'Explore' }), makeClaudeAgent({ source: 'project', name: 'alpha-helper', path: '/work/alpha/.claude/agents/alpha-helper.md' })]
        : [makeClaudeAgent({ name: 'Explore' })])),
    });
    const hook = renderHook(({ directory }: { directory: string | null }) => useClaudeAgents(directory), { initialProps: { directory: null as string | null } });
    await waitFor(() => expect(hook.result.current.status).toBe('ready'));
    expect(api.calls.map((call) => call.path)).toEqual(['/api/agent-profiles/claude-agents']);

    hook.rerender({ directory: '/work/alpha' });
    // Until the answer for the new folder arrives, the old folder's entries are not shown under it.
    expect(hook.result.current.status).toBe('loading');
    expect(hook.result.current.entries).toEqual([]);
    await waitFor(() => expect(hook.result.current.status).toBe('ready'));
    expect(hook.result.current.entries.map((entry) => entry.name)).toEqual(['Explore', 'alpha-helper']);
    expect(api.calls[1].path).toBe('/api/agent-profiles/claude-agents?directory=%2Fwork%2Falpha');
  });

  it('ignores a late answer for a target that is no longer chosen', async () => {
    let releaseFirst: () => void = () => undefined;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    installFakeProfilesApi({
      'GET /api/agent-profiles/claude-agents': async (call) => {
        if (!call.path.includes('directory=')) {
          await first;
          return reply(listing([makeClaudeAgent({ name: 'GlobalOnly' })]));
        }
        return reply(listing([makeClaudeAgent({ source: 'project', name: 'alpha-helper' })]));
      },
    });
    const hook = renderHook(({ directory }: { directory: string | null }) => useClaudeAgents(directory), { initialProps: { directory: null as string | null } });
    hook.rerender({ directory: '/work/alpha' });
    await waitFor(() => expect(hook.result.current.status).toBe('ready'));

    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hook.result.current.entries.map((entry) => entry.name)).toEqual(['alpha-helper']);
  });

  it('says on its first read whether the machine has any agent file, and never changes that answer', async () => {
    const api = installFakeProfilesApi({
      'GET /api/agent-profiles/claude-agents': () => reply(listing([makeClaudeAgent({ name: 'Explore' })])),
    });
    const hook = renderHook(() => useClaudeAgents(null));
    expect(hook.result.current.initiallyEmpty).toBeNull();
    await waitFor(() => expect(hook.result.current.initiallyEmpty).toBe(true));

    api.set('GET /api/agent-profiles/claude-agents', reply(listing([makeClaudeAgent({ name: 'Explore' }), makeClaudeAgent({ source: 'user', name: 'mine' })])));
    act(() => hook.result.current.reload());
    await waitFor(() => expect(hook.result.current.entries).toHaveLength(2));
    expect(hook.result.current.initiallyEmpty).toBe(true);
  });
});

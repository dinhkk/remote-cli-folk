import { act, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import { useNewChatScope } from '@/modules/agent-profiles';
import type { NewChatScopeState } from '@/modules/agent-profiles';
import { failure, installFakeProfilesApi, reply } from '@/modules/agent-profiles/tests/fake-profiles-api';

/**
 * The new-chat main-agent state (`useNewChatScope`, rendered by chat's composer menu): the agents come from `scope-options`
 * of the project open in the sidebar (its database id), no main agent (`Auto`) is the default, the choice becomes
 * `scope: { agentName }` for the session creation, and a project without agents, a failed read or an unused hook leaves a
 * plain chat. Same on the Host and in a Remote tab.
 */

const TARGET = vi.hoisted(() => ({ active: false }));
vi.mock('@/shared/transport/target-context', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isTargetMode: () => TARGET.active,
}));

beforeEach(() => {
  TARGET.active = false;
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

type Props = { projectId: string | null; enabled?: boolean };

/** Mounts the hook the way ChatInterface does and exposes its latest state. */
const mount = (initial: Props) => {
  const seen: { state: NewChatScopeState | null } = { state: null };
  function Harness({ projectId, enabled = true }: Props) {
    const state = useNewChatScope({ projectId, enabled });
    useEffect(() => { seen.state = state; });
    return null;
  }
  const view = render(<Harness {...initial} />);
  return {
    seen,
    request: () => seen.state?.request,
    names: () => seen.state?.agents.map((agent) => agent.name),
    pick: (name: string | null) => act(() => seen.state?.setAgentName(name)),
    rerender: (next: Props) => view.rerender(<Harness {...next} />),
  };
};

const AGENTS = [
  { name: 'review-code', source: 'project', isOrchestrator: false },
  { name: 'orchestrator', source: 'project', isOrchestrator: true },
  { name: 'global-helper', source: 'user', isOrchestrator: false },
];
const ONLY_ORCHESTRATOR = [{ name: 'orchestrator', source: 'project', isOrchestrator: true }];

const installApi = (agents: unknown[] = AGENTS) => installFakeProfilesApi({
  'GET /api/agent-profiles/scope-options': reply({ agents }),
});

describe('new-chat main-agent state', () => {
  it('asks scope-options for the open project\'s database id and lists its agents, orchestrator first', async () => {
    const api = installApi();
    const view = mount({ projectId: 'p-alpha' });

    await waitFor(() => expect(view.seen.state?.status).toBe('ready'));
    expect(api.calls.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /api/agent-profiles/scope-options?projectId=p-alpha']);
    expect(view.names()).toEqual(['orchestrator', 'review-code', 'global-helper']);
  });

  it('defaults to no main agent, and still sends a scope without one so hidden agents stay hidden', async () => {
    installApi();
    const view = mount({ projectId: 'p-alpha' });

    await waitFor(() => expect(view.seen.state?.status).toBe('ready'));
    expect(view.seen.state?.agentName).toBeNull();
    expect(view.request()).toEqual({ scope: { agentName: null } });
  });

  it('turns the choice into scope.agentName and back to none', async () => {
    installApi();
    const view = mount({ projectId: 'p-alpha' });
    await waitFor(() => expect(view.seen.state?.status).toBe('ready'));

    view.pick('orchestrator');
    expect(view.seen.state?.agentName).toBe('orchestrator');
    expect(view.request()).toEqual({ scope: { agentName: 'orchestrator' } });

    view.pick('global-helper');
    expect(view.request()).toEqual({ scope: { agentName: 'global-helper' } });

    view.pick(null);
    expect(view.request()).toEqual({ scope: { agentName: null } });
  });

  it('encodes the project id in the query', async () => {
    const api = installApi();
    const view = mount({ projectId: 'a b&c' });
    await waitFor(() => expect(view.seen.state?.status).toBe('ready'));
    expect(api.calls[0]?.path).toBe('/api/agent-profiles/scope-options?projectId=a+b%26c');
  });

  it('reads the agents of another sidebar project when it is selected, and drops the old choice', async () => {
    const api = installApi();
    const view = mount({ projectId: 'p-alpha' });
    await waitFor(() => expect(view.seen.state?.status).toBe('ready'));
    view.pick('review-code');
    expect(view.request()).toEqual({ scope: { agentName: 'review-code' } });

    api.set('GET /api/agent-profiles/scope-options', reply({ agents: ONLY_ORCHESTRATOR }));
    view.rerender({ projectId: 'p-crm' });

    await waitFor(() => expect(view.names()).toEqual(['orchestrator']));
    expect(view.seen.state?.agentName).toBeNull();
    expect(view.request()).toEqual({ scope: { agentName: null } });
    expect(api.to('GET', '/api/agent-profiles/scope-options?projectId=p-crm')).toHaveLength(1);
  });

  it('starts the next new chat from no main agent again: a choice does not outlive its chat', async () => {
    installApi();
    const view = mount({ projectId: 'p-alpha' });
    await waitFor(() => expect(view.seen.state?.status).toBe('ready'));
    view.pick('orchestrator');
    expect(view.seen.state?.agentName).toBe('orchestrator');

    // The chat got its session (the hook is off), then a new chat opens in the same project.
    view.rerender({ projectId: 'p-alpha', enabled: false });
    view.rerender({ projectId: 'p-alpha', enabled: true });
    await waitFor(() => expect(view.seen.state?.status).toBe('ready'));
    expect(view.seen.state?.agentName).toBeNull();
  });

  it('falls back to no main agent when the chosen agent is no longer offered (hidden or deleted since)', async () => {
    const api = installApi();
    const view = mount({ projectId: 'p-alpha' });
    await waitFor(() => expect(view.seen.state?.status).toBe('ready'));
    view.pick('review-code');

    api.set('GET /api/agent-profiles/scope-options', reply({ agents: ONLY_ORCHESTRATOR }));
    // Same project, new chat: re-read the list.
    view.rerender({ projectId: 'p-alpha', enabled: false });
    view.rerender({ projectId: 'p-alpha', enabled: true });

    await waitFor(() => expect(view.names()).toEqual(['orchestrator']));
    expect(view.seen.state?.agentName).toBeNull();
    expect(view.request()).toEqual({ scope: { agentName: null } });
  });

  it('has no agents to offer for a project without any; the chat still carries its scope', async () => {
    const api = installApi([]);
    const view = mount({ projectId: 'p-empty' });

    await waitFor(() => expect(api.calls).toHaveLength(1));
    await waitFor(() => expect(view.seen.state?.status).toBe('ready'));
    expect(view.seen.state?.agents).toEqual([]);
    expect(view.request()).toEqual({ scope: { agentName: null } });
  });

  it('works the same in a Remote tab: one scope-options read, nothing else', async () => {
    TARGET.active = true;
    const api = installApi();
    const view = mount({ projectId: 'p-alpha' });
    await waitFor(() => expect(view.seen.state?.status).toBe('ready'));

    view.pick('orchestrator');
    expect(view.request()).toEqual({ scope: { agentName: 'orchestrator' } });
    expect(api.calls.map((call) => call.path)).toEqual(['/api/agent-profiles/scope-options?projectId=p-alpha']);
  });

  it('stays a plain chat (no scope key) when the list cannot be read or the project is unknown', async () => {
    const api = installFakeProfilesApi({ 'GET /api/agent-profiles/scope-options': failure(404, 'PROJECT_NOT_FOUND', 'Project not found') });
    const view = mount({ projectId: 'p-gone' });

    await waitFor(() => expect(view.seen.state?.status).toBe('error'));
    expect(api.calls).toHaveLength(1);
    expect(view.request()).toEqual({});
    expect('scope' in (view.request() ?? {})).toBe(false);
  });

  it('does nothing while disabled (other providers, open sessions) or without an open project: no request, no scope', async () => {
    const api = installApi();
    const disabled = mount({ projectId: 'p-alpha', enabled: false });
    await act(async () => { await Promise.resolve(); });
    expect(disabled.request()).toEqual({});
    expect(disabled.seen.state?.status).toBe('idle');

    const noProject = mount({ projectId: null });
    await act(async () => { await Promise.resolve(); });
    expect(noProject.request()).toEqual({});

    expect(api.calls).toEqual([]);
  });
});

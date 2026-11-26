import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import { AgentProfilesPanel } from '@/modules/agent-profiles';
import {
  ORCHESTRATOR_TEMPLATE,
  REVIEW_TEMPLATE,
  SIDEBAR_CRM,
  SIDEBAR_ALPHA,
  failure,
  installFakeProfilesApi,
  makeClaudeAgent,
  makeMemoryBlock,
  memoryBlockRoutes,
  reply,
} from '@/modules/agent-profiles/tests/fake-profiles-api';
import type { ClaudeAgentEntry, GenerateTargetProject } from '@/shared/types';

/**
 * The whole screen against a fake server: exactly four tabs (Agents, Templates, Memory, Pending), the shared template load and the corrupt-file notice, the Agents tab
 * (the list of the chosen target read from `?directory=`, generated/handmade marks, hide/show with the stored `rev`,
 * fallback warning) and the Generate entry.
 */

beforeEach(() => {
  // A returning user: the first-run guide stays out of the way (it has its own tests).
  localStorage.setItem('agentProfiles.setupGuideDismissed', '1');
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const EXPLORE = makeClaudeAgent({ name: 'Explore', description: 'Fast codebase exploration.', model: 'haiku' });
const PLAN = makeClaudeAgent({ name: 'Plan', description: 'Plans the work.', hidden: true });
const PERSONAL = makeClaudeAgent({ source: 'user', name: 'my-reviewer', description: 'My own reviewer.', tools: ['Read', 'Grep'], prompt: 'You review code carefully.' });
const BROKEN = makeClaudeAgent({ source: 'user', name: 'broken-agent', description: '', error: 'front matter has no "name"' });
const ALPHA_GENERATED = makeClaudeAgent({ source: 'project', name: 'orchestrator', description: 'Orchestrates.', generated: true, generatedFrom: 'orchestrator' });
const ALPHA_HANDMADE = makeClaudeAgent({ source: 'project', name: 'alpha-helper', description: 'Helps in Alpha.', prompt: 'Alpha helper prompt.' });
const CRM_HANDMADE = makeClaudeAgent({ source: 'project', name: 'crm-helper', description: 'Helps in CRM.' });

const GLOBAL_LIST: ClaudeAgentEntry[] = [EXPLORE, PLAN, PERSONAL, BROKEN];
const LISTS: Record<string, ClaudeAgentEntry[]> = {
  '/work/alpha': [...GLOBAL_LIST, ALPHA_GENERATED, ALPHA_HANDMADE],
  'C:\\Work\\CRM': [...GLOBAL_LIST, CRM_HANDMADE],
};

const setup = (options: { projects?: GenerateTargetProject[]; corrupt?: boolean; templatesFail?: boolean; builtinSource?: string } = {}) => {
  // The server's stored hide list: it holds "ghost", a name no listed agent has, which no change may drop.
  const stored = { names: ['Plan', 'ghost'], rev: 6 };
  const api = installFakeProfilesApi({
    'GET /api/agent-profiles/templates': reply({
      items: [REVIEW_TEMPLATE, ORCHESTRATOR_TEMPLATE],
      corrupt: options.corrupt ? [{ id: 'broken-template', error: 'invalid JSON' }] : [],
    }),
    'GET /api/agent-profiles/claude-agents': (call) => {
      const directory = new URLSearchParams(call.path.split('?')[1] ?? '').get('directory');
      return reply({
        items: directory ? LISTS[directory] ?? GLOBAL_LIST : GLOBAL_LIST,
        hiddenNames: stored.names,
        hiddenRev: stored.rev,
        builtinSource: options.builtinSource ?? 'sdk',
      });
    },
    // Like the server: a request whose rev is not the stored one is refused, otherwise the list is replaced and the rev moves on.
    'PUT /api/agent-profiles/claude-agents/hidden': (call) => {
      const body = call.body as { names: string[]; rev: number };
      if (body.rev !== stored.rev) return failure(409, 'PROFILE_STALE', 'stale');
      stored.names = body.names;
      stored.rev += 1;
      return reply({ hiddenClaudeAgents: stored.names, rev: stored.rev });
    },
    'GET /api/agent-profiles/generate/values': reply({ directory: '/work/alpha', values: {} }),
    ...memoryBlockRoutes([makeMemoryBlock({ id: 'b-notes', name: 'notes' })]).routes,
  });
  if (options.templatesFail) api.set('GET /api/agent-profiles/templates', failure(500, 'BOOM', 'The store is unreadable'));
  render(<AgentProfilesPanel projects={options.projects ?? [SIDEBAR_ALPHA, SIDEBAR_CRM]} />);
  return api;
};

const openTab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }));
const rowOf = (name: string) => screen.getByText(name).closest('li') as HTMLElement;
const listCalls = (api: ReturnType<typeof setup>) => api.calls.filter((call) => call.method === 'GET' && call.path.startsWith('/api/agent-profiles/claude-agents')).map((call) => call.path);

describe('panel', () => {
  it('offers exactly four tabs: Agents first, then Templates, Memory and Pending', async () => {
    const api = setup();

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Agents', 'Templates', 'Memory', 'Pending']);
    expect(screen.getByRole('tab', { name: 'Agents' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('tab', { name: 'Projects' })).toBeNull();
    expect(screen.queryByRole('tab', { name: /Claude/ })).toBeNull();
    expect(await screen.findByText('Explore')).toBeTruthy();
    // The blocks are read only once the Memory tab is opened.
    expect(api.calls.some((call) => call.path.startsWith('/api/agent-profiles/memory-blocks'))).toBe(false);

    openTab('Templates');
    expect(await screen.findByText('Code reviewer')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Templates' }).getAttribute('aria-selected')).toBe('true');

    openTab('Memory');
    expect(await screen.findByText('notes')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Memory' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByText('Code reviewer')).toBeNull();

    openTab('Agents');
    expect(await screen.findByText('Explore')).toBeTruthy();
    expect(screen.queryByText('notes')).toBeNull();
  });

  it('names every stored template file that was skipped as unreadable and leaves the rest usable', async () => {
    setup({ corrupt: true });

    const notice = await screen.findByText(/1 stored template file could not be read/);
    expect((notice.closest('div') as HTMLElement).textContent).toContain('broken-template: invalid JSON');
    expect(await screen.findByText('Explore')).toBeTruthy();
  });

  it('shows a failed template load with a retry that loads again', async () => {
    const api = setup({ templatesFail: true });

    expect(await screen.findByText('The store is unreadable')).toBeTruthy();
    openTab('Templates');
    // The empty-state text would be a lie here: the templates did not load.
    expect(screen.queryByText(/No templates yet/)).toBeNull();
    api.set('GET /api/agent-profiles/templates', reply({ items: [REVIEW_TEMPLATE], corrupt: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(screen.queryByText('The store is unreadable')).toBeNull());
    expect(await screen.findByText('Code reviewer')).toBeTruthy();
  });

  it('the Setup guide button is still there', async () => {
    setup();
    await screen.findByText('Explore');
    expect(screen.getByRole('button', { name: 'Setup guide' })).toBeTruthy();
  });
});

describe('Agents tab target', () => {
  it('lists the agents of the first sidebar project, read with ?directory=<folder>', async () => {
    const api = setup();

    expect(await screen.findByRole('heading', { name: 'Project: Alpha' })).toBeTruthy();
    expect(listCalls(api)).toEqual(['/api/agent-profiles/claude-agents?directory=%2Fwork%2Falpha']);
    expect((screen.getByLabelText('Show agents for') as HTMLSelectElement).value).toBe(SIDEBAR_ALPHA.projectId);
  });

  it('groups the agents by source and marks generated and handmade files', async () => {
    setup();
    await screen.findByText('Explore');

    expect(screen.getByRole('heading', { name: 'Built into Claude Code' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Personal (~/.claude/agents)' })).toBeTruthy();
    expect(rowOf('orchestrator').textContent).toContain('Generated from orchestrator');
    expect(rowOf('alpha-helper').textContent).toContain('Handmade');
  });

  it('switching the project reloads the list for its folder and never shows the other project\'s agents', async () => {
    const api = setup();
    await screen.findByText('alpha-helper');

    fireEvent.change(screen.getByLabelText('Show agents for'), { target: { value: SIDEBAR_CRM.projectId } });
    expect(screen.queryByText('alpha-helper')).toBeNull();
    expect(await screen.findByText('crm-helper')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Project: CRM' })).toBeTruthy();
    expect(screen.queryByText('alpha-helper')).toBeNull();
    expect(listCalls(api)[1]).toBe('/api/agent-profiles/claude-agents?directory=C%3A%5CWork%5CCRM');
  });

  it('the global target reads the list without a directory and has no project group', async () => {
    const api = setup();
    await screen.findByText('alpha-helper');

    fireEvent.change(screen.getByLabelText('Show agents for'), { target: { value: '' } });
    await waitFor(() => expect(screen.queryByText('alpha-helper')).toBeNull());
    expect(await screen.findByText('my-reviewer')).toBeTruthy();
    expect(listCalls(api)[1]).toBe('/api/agent-profiles/claude-agents');
    expect(screen.queryByRole('heading', { name: /^Project:/ })).toBeNull();
  });

  it('without sidebar projects it starts on the global target', async () => {
    const api = setup({ projects: [] });

    expect(await screen.findByText('my-reviewer')).toBeTruthy();
    expect(listCalls(api)).toEqual(['/api/agent-profiles/claude-agents']);
    expect(screen.getByText(/No project in the sidebar yet/)).toBeTruthy();
  });

  it('falls back to the first project when the chosen one leaves the sidebar', async () => {
    const stored = { names: [] as string[], rev: 1 };
    installFakeProfilesApi({
      'GET /api/agent-profiles/templates': reply({ items: [REVIEW_TEMPLATE], corrupt: [] }),
      'GET /api/agent-profiles/claude-agents': (call) => reply({ items: call.path.includes('directory=') ? [ALPHA_HANDMADE] : GLOBAL_LIST, hiddenNames: stored.names, hiddenRev: stored.rev, builtinSource: 'sdk' }),
    });
    const view = render(<AgentProfilesPanel projects={[SIDEBAR_ALPHA, SIDEBAR_CRM]} />);
    await screen.findByText('alpha-helper');
    fireEvent.change(screen.getByLabelText('Show agents for'), { target: { value: SIDEBAR_CRM.projectId } });

    view.rerender(<AgentProfilesPanel projects={[SIDEBAR_ALPHA]} />);
    expect((screen.getByLabelText('Show agents for') as HTMLSelectElement).value).toBe(SIDEBAR_ALPHA.projectId);
  });
});

describe('hide and show', () => {
  it('is read-only otherwise: details show tools and the prompt, and there is no save, import or edit', async () => {
    setup();
    await screen.findByText('my-reviewer');

    fireEvent.click(within(rowOf('my-reviewer')).getByRole('button', { name: 'Details of my-reviewer' }));
    expect(screen.getByLabelText('Prompt of my-reviewer').textContent).toBe('You review code carefully.');
    expect(screen.queryByRole('button', { name: /Import as template|Create template based on this/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('hides and shows an agent by editing the stored hide list: one name changes, unknown names stay', async () => {
    const api = setup();
    await screen.findByText('Explore');
    const puts = () => api.to('PUT', '/api/agent-profiles/claude-agents/hidden');

    fireEvent.click(within(rowOf('Explore')).getByRole('switch', { name: 'Visible: Explore' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0].body).toEqual({ names: ['Plan', 'ghost', 'Explore'], rev: 6 });

    await waitFor(() => expect(within(rowOf('Plan')).getByRole('switch', { name: 'Visible: Plan' })).toBeTruthy());
    fireEvent.click(within(rowOf('Plan')).getByRole('switch', { name: 'Visible: Plan' }));
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(puts()[1].body).toEqual({ names: ['ghost', 'Explore'], rev: 7 });
  });

  it('hides all and shows all without touching stored names the list does not show, and filters to the hidden ones', async () => {
    const api = setup();
    await screen.findByText('Explore');
    const puts = () => api.to('PUT', '/api/agent-profiles/claude-agents/hidden');

    fireEvent.click(screen.getByRole('button', { name: 'Hide all' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect((puts()[0].body as { names: string[] }).names.sort()).toEqual(['Explore', 'Plan', 'alpha-helper', 'ghost', 'my-reviewer', 'orchestrator']);

    await waitFor(() => expect((screen.getByRole('button', { name: 'Show all' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(puts()[1].body).toEqual({ names: ['ghost'], rev: 7 });

    // The listing still reports Plan as hidden (its items are fixed in this fake), so the filter keeps only it.
    fireEvent.click(screen.getByLabelText('Hidden only'));
    await waitFor(() => expect(screen.queryByText('Explore')).toBeNull());
    expect(screen.getByText('Plan')).toBeTruthy();
  });

  it('refuses a stale hide list and says so instead of overwriting', async () => {
    const api = setup();
    await screen.findByText('Explore');
    api.set('PUT /api/agent-profiles/claude-agents/hidden', failure(409, 'PROFILE_STALE', 'stale'));

    fireEvent.click(within(rowOf('Explore')).getByRole('switch'));
    expect(await screen.findByText(/changed somewhere else/)).toBeTruthy();
  });

  it('warns when the built-in list is the fixed fallback', async () => {
    setup({ builtinSource: 'fallback' });

    expect(await screen.findByText('The built-in list could not be read from Claude Code, so a fixed list is shown.')).toBeTruthy();
  });

  it('shows a broken agent file as an error line while the others stay visible', async () => {
    setup();
    await screen.findByText('Explore');

    expect(screen.getAllByRole('alert').map((node) => node.textContent)).toContain('broken-agent: this agent file could not be read (front matter has no "name"). Fix the file\'s front matter; the other agents are not affected.');
  });
});

describe('Generate entry', () => {
  it('opens the Generate form for the chosen project with the templates to tick', async () => {
    const api = setup();
    await screen.findByText('Explore');
    fireEvent.click(screen.getByRole('button', { name: 'Generate agents' }));

    expect(screen.getByRole('heading', { name: 'Generate agents' })).toBeTruthy();
    expect(screen.getByLabelText(/Code reviewer/)).toBeTruthy();
    expect(screen.getByLabelText(/Orchestrator/)).toBeTruthy();
    await waitFor(() => expect(api.to('GET', '/api/agent-profiles/generate/values?directory=%2Fwork%2Falpha')).toHaveLength(1));
  });

  it('has no lint banner, no agent form and no agent-count text', async () => {
    const api = setup();
    await screen.findByText('Explore');

    expect(screen.queryByText(/lint/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'New agent' })).toBeNull();
    expect(api.calls.some((call) => /\/(lint|agents|projects)(\?|$)/.test(call.path))).toBe(false);
  });
});

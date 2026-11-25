import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import { AgentsTab } from '@/modules/agent-profiles/agents/AgentsTab';
import { GLOBAL_TARGET_ID } from '@/modules/agent-profiles/agents/generate-target';
import {
  REVIEW_TEMPLATE,
  SIDEBAR_CRM,
  SIDEBAR_ALPHA,
  installFakeProfilesApi,
  makeClaudeAgent,
  reply,
} from '@/modules/agent-profiles/tests/fake-profiles-api';
import type { ClaudeAgentEntry } from '@/shared/types';

/** The Agents tab on props: the list grouped by source with generated/handmade marks, hide/show, the target choice and the Generate entry. */

afterEach(() => {
  vi.unstubAllGlobals();
});

const EXPLORE = makeClaudeAgent({ name: 'Explore', description: 'Fast codebase exploration.', model: 'haiku' });
const PLAN = makeClaudeAgent({ name: 'Plan', description: 'Plans the work.', hidden: true });
const PERSONAL = makeClaudeAgent({ source: 'user', name: 'my-reviewer', description: 'My own reviewer.', tools: ['Read', 'Grep'], prompt: 'You review code carefully.', path: '/home/me/.claude/agents/my-reviewer.md' });
const BROKEN = makeClaudeAgent({ source: 'user', name: 'broken-agent', description: '', error: 'front matter has no "name"' });
const GENERATED = makeClaudeAgent({ source: 'project', name: 'review-code', description: 'Reviews code.', generated: true, generatedFrom: 'review-code', path: '/work/alpha/.claude/agents/review-code.md', prompt: 'Review it.' });
const HANDMADE = makeClaudeAgent({ source: 'project', name: 'alpha-helper', description: 'Helps in Alpha.', path: '/work/alpha/.claude/agents/alpha-helper.md', prompt: 'Alpha helper prompt.' });

const ENTRIES: ClaudeAgentEntry[] = [EXPLORE, PLAN, PERSONAL, BROKEN, GENERATED, HANDMADE];

type Props = Partial<React.ComponentProps<typeof AgentsTab>>;

const setup = (props: Props = {}) => {
  const onChangeHidden = vi.fn(() => Promise.resolve());
  const onTargetChange = vi.fn();
  const onReload = vi.fn();
  render(
    <AgentsTab
      projects={[SIDEBAR_ALPHA, SIDEBAR_CRM]}
      targetId={SIDEBAR_ALPHA.projectId}
      onTargetChange={onTargetChange}
      templates={[REVIEW_TEMPLATE]}
      entries={ENTRIES}
      status="ready"
      loadError={null}
      builtinSource="sdk"
      onChangeHidden={onChangeHidden}
      onReload={onReload}
      {...props}
    />,
  );
  return { onChangeHidden, onTargetChange, onReload };
};

const rowOf = (name: string) => screen.getByText(name).closest('li') as HTMLElement;
/** Applies the change a button asked `onChangeHidden` to make to a stored hide list. */
const appliedTo = (mock: ReturnType<typeof vi.fn>, stored: string[]): string[] => {
  const update = mock.mock.calls.at(-1)?.[0] as ((names: string[]) => string[]) | undefined;
  if (!update) throw new Error('onChangeHidden was not called');
  return update(stored);
};

describe('the list', () => {
  it('groups agents by source, with the project group named after the target project', () => {
    setup();

    expect(screen.getByRole('heading', { name: 'Built into Claude Code' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Personal (~/.claude/agents)' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Project: Alpha' })).toBeTruthy();
    expect(screen.getByText('Explore')).toBeTruthy();
    expect(screen.getByText('alpha-helper')).toBeTruthy();
  });

  it('marks a file agent as generated from its template or as handmade, and a built-in as neither', () => {
    setup();

    expect(rowOf('review-code').textContent).toContain('Generated from review-code');
    expect(rowOf('alpha-helper').textContent).toContain('Handmade');
    expect(rowOf('my-reviewer').textContent).toContain('Handmade');
    expect(rowOf('Explore').textContent).not.toMatch(/Generated|Handmade/);
  });

  it('lists two files of one folder that declare the same name as two rows (rows are keyed by file path)', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const first = { ...HANDMADE, name: 'twin', path: '/work/alpha/.claude/agents/twin-a.md' };
      const second = { ...HANDMADE, name: 'twin', path: '/work/alpha/.claude/agents/twin-b.md' };
      setup({ entries: [first, second] });

      expect(screen.getAllByText('twin')).toHaveLength(2);
      expect(errors.mock.calls.some((call) => String(call[0]).includes('same key'))).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });

  it('says only "Generated" when the marker names no template', () => {
    setup({ entries: [{ ...GENERATED, generatedFrom: undefined }] });

    expect(rowOf('review-code').textContent).toContain('Generated');
    expect(rowOf('review-code').textContent).not.toContain('Generated from');
  });

  it('is read-only: details show the file, tools and prompt, built-ins say the prompt is not viewable, and there is no save', () => {
    setup();

    fireEvent.click(within(rowOf('my-reviewer')).getByRole('button', { name: 'Details of my-reviewer' }));
    expect(screen.getByLabelText('Prompt of my-reviewer').textContent).toBe('You review code carefully.');
    expect(rowOf('my-reviewer').textContent).toContain('Tools: Read, Grep');
    expect(rowOf('my-reviewer').textContent).toContain('/home/me/.claude/agents/my-reviewer.md');

    fireEvent.click(within(rowOf('Explore')).getByRole('button', { name: 'Details of Explore' }));
    expect(rowOf('Explore').textContent).toContain('does not let apps read the prompt or tools of its built-in agents');

    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('shows a broken agent file as an error line naming it while the others stay visible', () => {
    setup();

    const errors = screen.getAllByRole('alert').map((node) => node.textContent);
    expect(errors).toContain('broken-agent: this agent file could not be read (front matter has no "name"). Fix the file\'s front matter; the other agents are not affected.');
    expect(screen.getByText('my-reviewer')).toBeTruthy();
  });

  it('counts the visible agents among the readable ones, without description tokens', () => {
    setup();

    // Readable: Explore, Plan (hidden), my-reviewer, review-code, alpha-helper; the unreadable file does not count.
    expect(screen.getByText('4 of 5 visible')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/token/);
  });

  it('warns when the built-in list is the fixed fallback', () => {
    setup({ builtinSource: 'fallback' });
    expect(screen.getByText('The built-in list could not be read from Claude Code, so a fixed list is shown.')).toBeTruthy();
  });

  it('does not warn when the built-in list came from Claude Code', () => {
    setup();
    expect(screen.queryByText(/fixed list is shown/)).toBeNull();
  });

  it('says so when there are no agents', () => {
    setup({ entries: [] });
    expect(screen.getByText('No agents found.')).toBeTruthy();
  });

  it('shows a loading state instead of the list while the agents are read', () => {
    setup({ status: 'loading', entries: [] });

    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(screen.queryByText('No agents found.')).toBeNull();
  });

  it('shows the failure of the list read with a retry button', () => {
    const { onReload } = setup({ status: 'error', loadError: new Error('Agent list unavailable'), entries: [] });

    expect(screen.getByText('Agent list unavailable')).toBeTruthy();
    expect(screen.queryByText(/visible$/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onReload).toHaveBeenCalled();
  });
});

describe('hiding', () => {
  it('hides one agent by adding only its name, and shows it again by removing only its name', async () => {
    const { onChangeHidden } = setup();

    fireEvent.click(within(rowOf('Explore')).getByRole('switch', { name: 'Visible: Explore' }));
    await waitFor(() => expect(onChangeHidden).toHaveBeenCalledTimes(1));
    expect(appliedTo(onChangeHidden, ['Plan', 'ghost'])).toEqual(['Plan', 'ghost', 'Explore']);

    fireEvent.click(within(rowOf('Plan')).getByRole('switch', { name: 'Visible: Plan' }));
    await waitFor(() => expect(onChangeHidden).toHaveBeenCalledTimes(2));
    expect(appliedTo(onChangeHidden, ['Plan', 'ghost', 'Explore'])).toEqual(['ghost', 'Explore']);
  });

  it('hides all and shows all without touching stored names the list does not show', async () => {
    const { onChangeHidden } = setup();

    fireEvent.click(screen.getByRole('button', { name: 'Hide all' }));
    await waitFor(() => expect(onChangeHidden).toHaveBeenCalledTimes(1));
    expect(appliedTo(onChangeHidden, ['ghost']).sort()).toEqual(['Explore', 'Plan', 'alpha-helper', 'ghost', 'my-reviewer', 'review-code']);

    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    await waitFor(() => expect(onChangeHidden).toHaveBeenCalledTimes(2));
    expect(appliedTo(onChangeHidden, ['Plan', 'ghost', 'Explore'])).toEqual(['ghost']);
  });

  it('filters to the hidden agents', () => {
    setup();

    fireEvent.click(screen.getByLabelText('Hidden only'));
    expect(screen.queryByText('Explore')).toBeNull();
    expect(screen.getByText('Plan')).toBeTruthy();
  });

  it('says no agent is hidden when the filter finds none', () => {
    setup({ entries: [EXPLORE] });

    fireEvent.click(screen.getByLabelText('Hidden only'));
    expect(screen.getByText('No agent is hidden.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Show all' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the failure of a refused change and offers a reload on a stale one', async () => {
    const { ApiRequestError } = await import('@/shared/api');
    const stale = new ApiRequestError('stale', { code: 'PROFILE_STALE', status: 409 });
    const { onReload } = setup({ onChangeHidden: () => Promise.reject(stale) });

    fireEvent.click(within(rowOf('Explore')).getByRole('switch'));
    expect(await screen.findByText(/changed somewhere else/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reload the latest version' }));
    expect(onReload).toHaveBeenCalled();
  });
});

describe('target and Generate', () => {
  it('offers every sidebar project and the global scope, with the chosen one selected', () => {
    setup({ targetId: SIDEBAR_CRM.projectId });

    const select = screen.getByLabelText('Show agents for') as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual(['Alpha', 'CRM', 'Global (~/.claude/agents)']);
    expect(select.value).toBe(SIDEBAR_CRM.projectId);
  });

  it('reports the new target when it changes', () => {
    const { onTargetChange } = setup();

    fireEvent.change(screen.getByLabelText('Show agents for'), { target: { value: GLOBAL_TARGET_ID } });
    expect(onTargetChange).toHaveBeenCalledWith(GLOBAL_TARGET_ID);
  });

  it('works with the global scope alone when the sidebar has no project, and says how to add one', () => {
    setup({ projects: [], targetId: GLOBAL_TARGET_ID, entries: [EXPLORE, PERSONAL] });

    const select = screen.getByLabelText('Show agents for') as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual(['Global (~/.claude/agents)']);
    expect(screen.getByText(/No project in the sidebar yet/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /^Project:/ })).toBeNull();
  });

  it('opens the Generate form for the chosen project, reading the values remembered for its folder', async () => {
    const api = installFakeProfilesApi({ 'GET /api/agent-profiles/generate/values': reply({ directory: '/work/alpha', values: { git_url: 'https://git/alpha' } }) });
    setup();

    fireEvent.click(screen.getByRole('button', { name: 'Generate agents' }));
    expect(screen.getByText(/written to the .claude\/agents folder of project "Alpha"/)).toBeTruthy();
    await waitFor(() => expect(api.calls[0]?.path).toBe('/api/agent-profiles/generate/values?directory=%2Fwork%2Falpha'));
  });

  it('cannot open Generate without a template', () => {
    setup({ templates: [] });
    expect((screen.getByRole('button', { name: 'Generate agents' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('closes the Generate form when the target changes, so it never carries values of another project', () => {
    installFakeProfilesApi({ 'GET /api/agent-profiles/generate/values': reply({ directory: '/work/alpha', values: {} }) });
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Generate agents' }));
    expect(screen.getByRole('heading', { name: 'Generate agents' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Show agents for'), { target: { value: SIDEBAR_CRM.projectId } });
    expect(screen.queryByRole('heading', { name: 'Generate agents' })).toBeNull();
  });

  it('reloads the list after Generate wrote files', async () => {
    installFakeProfilesApi({
      'GET /api/agent-profiles/generate/values': reply({ directory: '/work/alpha', values: { git_url: 'https://git/alpha' } }),
      'POST /api/agent-profiles/generate/preview': reply({ scope: 'project', agentsDirectory: '/work/alpha/.claude/agents', plans: [{ templateId: 't-review', name: 'review-code', description: 'd', path: '/work/alpha/.claude/agents/review-code.md', status: 'new' }] }),
      'POST /api/agent-profiles/generate': reply({ scope: 'project', agentsDirectory: '/work/alpha/.claude/agents', created: [{ templateId: 't-review', name: 'review-code', description: 'd', path: 'p', status: 'new' }], regenerated: [], skipped: [], gitExclude: { file: null, added: [] } }, 201),
    });
    const { onReload } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Generate agents' }));
    fireEvent.click(screen.getByLabelText(/Code reviewer/));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Preview' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Generate' }));

    await screen.findByText('Created 1, regenerated 0, skipped 0.');
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});

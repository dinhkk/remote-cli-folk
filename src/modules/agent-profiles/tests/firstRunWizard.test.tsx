import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import { AgentProfilesPanel } from '@/modules/agent-profiles';
import { PaletteOpsProvider, usePaletteOpsRegister } from '@/modules/command-palette';
import { FirstRunWizard } from '@/modules/agent-profiles/wizard/FirstRunWizard';
import {
  ORCHESTRATOR_TEMPLATE,
  REVIEW_TEMPLATE,
  SIDEBAR_CRM,
  SIDEBAR_ALPHA,
  installFakeProfilesApi,
  listing,
  makeClaudeAgent,
  makeTemplate,
  reply,
} from '@/modules/agent-profiles/tests/fake-profiles-api';
import type { AgentProfileTemplate, ClaudeAgentEntry } from '@/shared/types';

/**
 * The first-run guide: three skippable steps (Claude signed in, templates, a sidebar project with its generated agent files),
 * the hand-over of that project to a new chat, and how the panel opens it (by itself when it finds no agent file, from its button otherwise).
 */

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

const TESTING = makeTemplate({ id: 't-test', slug: 'testing', name: 'Tester', description: 'Runs the tests.' });
const SIGNED_IN = { authenticated: true, email: 'me@example.com', loading: false };
const SIGNED_OUT = { authenticated: false, email: null, loading: false };

const VALUES_PATH = '/api/agent-profiles/generate/values';
const PREVIEW_PATH = '/api/agent-profiles/generate/preview';
const APPLY_PATH = '/api/agent-profiles/generate';

/** The generate routes of a fake server: remembered values per folder, a one-agent preview and apply. */
const generateRoutes = (remembered: Record<string, string> = {}) => ({
  [`GET ${VALUES_PATH}`]: reply({ directory: '/work/alpha', values: remembered }),
  [`POST ${PREVIEW_PATH}`]: reply({ scope: 'project', agentsDirectory: '/work/alpha/.claude/agents', plans: [{ templateId: 't-review', name: 'review-code', description: 'Reviews code.', path: '/work/alpha/.claude/agents/review-code.md', status: 'new' }] }),
  [`POST ${APPLY_PATH}`]: reply({ scope: 'project', agentsDirectory: '/work/alpha/.claude/agents', created: [{ templateId: 't-review', name: 'review-code', description: 'Reviews code.', path: '/work/alpha/.claude/agents/review-code.md', status: 'new' }], regenerated: [], skipped: [], gitExclude: { file: '/work/alpha/.git/info/exclude', added: ['.claude/agents/review-code.md'] } }, 201),
});

type WizardOverrides = Partial<Parameters<typeof FirstRunWizard>[0]>;

const renderWizard = (overrides: WizardOverrides = {}, remembered: Record<string, string> = {}) => {
  const handlers = {
    onApplied: vi.fn(),
    onFinish: vi.fn(),
    onSignIn: vi.fn(),
    onOpenTemplates: vi.fn(),
  };
  const api = installFakeProfilesApi(generateRoutes(remembered));
  render(
    <FirstRunWizard
      templates={[ORCHESTRATOR_TEMPLATE, REVIEW_TEMPLATE, TESTING]}
      projects={[SIDEBAR_ALPHA, SIDEBAR_CRM]}
      claudeAuth={SIGNED_IN}
      {...handlers}
      {...overrides}
    />,
  );
  return { api, ...handlers };
};

const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));

describe('first-run wizard', () => {
  it('step 1 confirms that Claude is signed in', () => {
    const first = renderWizard();
    expect(screen.getByText('Claude is signed in as me@example.com.')).toBeTruthy();
    expect(screen.getByText('Step 1 of 3')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in to Claude' })).toBeNull();
    expect(first.onSignIn).not.toHaveBeenCalled();
  });

  it('step 1 signed out: says so, offers the sign-in, and can still be passed', () => {
    const { onSignIn } = renderWizard({ claudeAuth: SIGNED_OUT });
    expect(screen.getByText(/not signed in yet/)).toBeTruthy();

    click('Sign in to Claude');
    expect(onSignIn).toHaveBeenCalledTimes(1);

    click('Next');
    expect(screen.getByText('Step 2 of 3')).toBeTruthy();
  });

  it('step 2 lists every template with its family, all ticked, orchestrator included, and has no Claude-agent count', () => {
    renderWizard();
    click('Next');

    expect((screen.getByLabelText(/Code reviewer/) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/Tester/) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/Orchestrator/) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText(/Claude already offers/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Review Claude/ })).toBeNull();
  });

  it('step 2 cannot go on with nothing ticked', () => {
    renderWizard();
    click('Next');
    for (const name of [/Code reviewer/, /Tester/, /Orchestrator/]) fireEvent.click(screen.getByLabelText(name));

    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('step 2 without any template sends the user to the Templates tab; there is no restore-samples button', () => {
    const { onOpenTemplates } = renderWizard({ templates: [] });
    click('Next');

    expect(screen.getByText(/no templates yet/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add back the original samples' })).toBeNull();
    click('Open templates');
    expect(onOpenTemplates).toHaveBeenCalledTimes(1);
  });

  it('runs all three steps: the ticked templates become agent files of the chosen project, with its remembered values, and the project id is handed back', async () => {
    const { api, onFinish, onApplied } = renderWizard({}, { git_url: 'https://git/alpha' });
    click('Next');
    fireEvent.click(screen.getByLabelText(/Tester/));
    fireEvent.click(screen.getByLabelText(/Orchestrator/));
    click('Next');

    // Step 3: the first sidebar project is chosen; the template choice is locked in, the remembered value pre-fills.
    expect((screen.getByLabelText('Project') as HTMLSelectElement).value).toBe(SIDEBAR_ALPHA.projectId);
    expect(await screen.findByDisplayValue('https://git/alpha')).toBeTruthy();
    expect(api.to('GET', `${VALUES_PATH}?directory=%2Fwork%2Falpha`)).toHaveLength(1);
    expect(screen.queryByLabelText(/Tester/)).toBeNull();

    click('Preview');
    await screen.findByRole('table');
    expect(api.to('POST', PREVIEW_PATH)[0].body).toEqual({
      directory: '/work/alpha',
      projectName: 'Alpha',
      templateIds: ['t-review'],
      values: { git_url: 'https://git/alpha' },
    });
    click('Generate');
    await screen.findByText('Created 1, regenerated 0, skipped 0.');
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(onFinish).not.toHaveBeenCalled();

    click('Open a chat on Alpha');
    expect(onFinish).toHaveBeenCalledWith(SIDEBAR_ALPHA.projectId);
  });

  it('can generate for another sidebar project: the form re-reads that folder\'s values and sends its name', async () => {
    const { api } = renderWizard();
    click('Next');
    click('Next');
    await screen.findByLabelText(/Git URL/);

    fireEvent.change(screen.getByLabelText('Project'), { target: { value: SIDEBAR_CRM.projectId } });
    await waitFor(() => expect(api.to('GET', `${VALUES_PATH}?directory=C%3A%5CWork%5CCRM`)).toHaveLength(1));
    await screen.findByLabelText(/Git URL/);
    fireEvent.change(screen.getByLabelText(/Git URL/), { target: { value: 'https://git/crm' } });
    click('Preview');
    await screen.findByRole('table');

    expect(api.to('POST', PREVIEW_PATH)[0].body).toMatchObject({ directory: 'C:\\Work\\CRM', projectName: 'CRM' });
  });

  it('stops offering a project choice once agents were generated for one', async () => {
    renderWizard();
    click('Next');
    click('Next');
    await screen.findByLabelText(/Git URL/);
    fireEvent.change(screen.getByLabelText(/Git URL/), { target: { value: 'https://git/x' } });
    click('Preview');
    await screen.findByRole('table');
    click('Generate');
    await screen.findByText('Created 1, regenerated 0, skipped 0.');

    expect(screen.queryByLabelText('Project')).toBeNull();
  });

  it('step 3 without a sidebar project says to add one, and goes back', () => {
    renderWizard({ projects: [] });
    click('Next');
    click('Next');

    expect(screen.getByText(/no project in the sidebar yet/i)).toBeTruthy();
    click('Back');
    expect(screen.getByText('Step 2 of 3')).toBeTruthy();
  });

  it('has no "create project" step and no project form', () => {
    renderWizard();
    click('Next');
    click('Next');

    expect(screen.queryByLabelText('Folder')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getByText('Step 3 of 3')).toBeTruthy();
  });

  it('cancelling the form ends the guide without a project', async () => {
    const { onFinish } = renderWizard();
    click('Next');
    click('Next');
    await screen.findByLabelText(/Git URL/);
    click('Cancel');

    expect(onFinish).toHaveBeenCalledWith(null);
  });

  it('the whole guide can be skipped from the first step', () => {
    const first = renderWizard();
    click('Skip setup');
    expect(first.onFinish).toHaveBeenCalledWith(null);
  });

  it('skipping after agents were generated still opens the chat on that project', async () => {
    const { onFinish } = renderWizard();
    click('Next');
    click('Next');
    await screen.findByLabelText(/Git URL/);
    fireEvent.change(screen.getByLabelText(/Git URL/), { target: { value: 'https://git/x' } });
    click('Preview');
    await screen.findByRole('table');
    click('Generate');
    await screen.findByText('Created 1, regenerated 0, skipped 0.');

    click('Skip setup');
    expect(onFinish).toHaveBeenCalledWith(SIDEBAR_ALPHA.projectId);
  });
});

describe('the guide inside the Agent Profiles panel', () => {
  const BUILTIN: ClaudeAgentEntry = makeClaudeAgent({ name: 'Explore' });
  const profiles = (options: { agents?: ClaudeAgentEntry[]; templates?: AgentProfileTemplate[] } = {}) => installFakeProfilesApi({
    'GET /api/agent-profiles/templates': reply({ items: options.templates ?? [ORCHESTRATOR_TEMPLATE, REVIEW_TEMPLATE], corrupt: [] }),
    'GET /api/agent-profiles/claude-agents': reply(listing(options.agents ?? [BUILTIN])),
    ...generateRoutes(),
  });

  /** Stands in for the project-workspace module, which registers the `openNewChat` operation the panel calls when the guide ends. */
  function OpenNewChatStub({ open }: { open: (projectId: string) => void }) {
    usePaletteOpsRegister({ openNewChat: open });
    return null;
  }

  const renderPanel = (open: (projectId: string) => void, onSetupFinished = vi.fn()) => {
    render(
      <PaletteOpsProvider>
        <OpenNewChatStub open={open} />
        <AgentProfilesPanel claudeAuth={SIGNED_IN} projects={[SIDEBAR_ALPHA, SIDEBAR_CRM]} onSetupFinished={onSetupFinished} />
      </PaletteOpsProvider>,
    );
    return onSetupFinished;
  };

  it('opens by itself the first time no agent file exists', async () => {
    profiles();
    render(<AgentProfilesPanel claudeAuth={SIGNED_IN} projects={[SIDEBAR_ALPHA]} />);

    expect(await screen.findByRole('region', { name: 'Setup guide' })).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('does not open by itself once an agent file exists', async () => {
    profiles({ agents: [BUILTIN, makeClaudeAgent({ source: 'project', name: 'review-code', generated: true })] });
    render(<AgentProfilesPanel claudeAuth={SIGNED_IN} projects={[SIDEBAR_ALPHA]} />);

    await screen.findByRole('tablist');
    await screen.findByText('review-code');
    expect(screen.queryByRole('region', { name: 'Setup guide' })).toBeNull();
  });

  it('after a skip it stays out of the way, and the "Setup guide" button runs it again', async () => {
    profiles();
    const view = render(<AgentProfilesPanel claudeAuth={SIGNED_IN} projects={[SIDEBAR_ALPHA]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Skip setup' }));
    await screen.findByRole('tablist');
    view.unmount();

    render(<AgentProfilesPanel claudeAuth={SIGNED_IN} projects={[SIDEBAR_ALPHA]} />);
    await screen.findByRole('tablist');
    await screen.findByText('Explore');
    expect(screen.queryByRole('region', { name: 'Setup guide' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Setup guide' }));
    expect(screen.getByRole('region', { name: 'Setup guide' })).toBeTruthy();
  });

  it('finishing with a project opens a plain new chat on that sidebar project, then tells the dialog to close', async () => {
    profiles();
    const openNewChat = vi.fn();
    const onSetupFinished = renderPanel(openNewChat);
    await screen.findByRole('region', { name: 'Setup guide' });
    click('Next');
    click('Next');
    await screen.findByLabelText(/Git URL/);
    fireEvent.change(screen.getByLabelText(/Git URL/), { target: { value: 'https://git/alpha' } });
    click('Preview');
    await screen.findByRole('table');
    click('Generate');
    await screen.findByText('Created 1, regenerated 0, skipped 0.');
    click('Open a chat on Alpha');

    expect(openNewChat).toHaveBeenCalledWith(SIDEBAR_ALPHA.projectId);
    expect(onSetupFinished).toHaveBeenCalledTimes(1);
    // The panel itself is back on its tabs, targeting that project, and the new-chat hint will no longer nag.
    await screen.findByRole('tablist');
    expect((screen.getByLabelText('Show agents for') as HTMLSelectElement).value).toBe(SIDEBAR_ALPHA.projectId);
    expect(localStorage.getItem('agentProfiles.setupGuideDismissed')).toBe('1');
  });

  it('skipping without a project does not open a chat or close the dialog', async () => {
    profiles();
    const openNewChat = vi.fn();
    const onSetupFinished = renderPanel(openNewChat);
    fireEvent.click(await screen.findByRole('button', { name: 'Skip setup' }));

    expect(openNewChat).not.toHaveBeenCalled();
    expect(onSetupFinished).not.toHaveBeenCalled();
    await screen.findByRole('tablist');
  });

  it('sends the user to the Templates tab when there is no template to choose', async () => {
    profiles({ templates: [] });
    render(<AgentProfilesPanel claudeAuth={SIGNED_IN} projects={[SIDEBAR_ALPHA]} />);
    await screen.findByRole('region', { name: 'Setup guide' });
    click('Next');
    click('Open templates');

    expect(screen.getByRole('tab', { name: 'Templates' }).getAttribute('aria-selected')).toBe('true');
    expect(within(screen.getByRole('tabpanel')).getByRole('button', { name: 'New template' })).toBeTruthy();
  });
});

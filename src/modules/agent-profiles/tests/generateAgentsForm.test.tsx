import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import { GenerateAgentsForm } from '@/modules/agent-profiles/agents/GenerateAgentsForm';
import type { GenerateTarget } from '@/modules/agent-profiles/agents/generate-target';
import {
  ORCHESTRATOR_TEMPLATE,
  REVIEW_TEMPLATE,
  failure,
  installFakeProfilesApi,
  makeTemplate,
  reply,
} from '@/modules/agent-profiles/tests/fake-profiles-api';
import type { GeneratedAgentPlan } from '@/shared/types';

/**
 * The Generate form: remembered values pre-fill the parameter fields of the chosen templates, Preview shows what happens to
 * each agent file, Apply writes them. The full value set goes over the wire on every Preview and Apply (the server does not merge).
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const ALPHA: GenerateTarget = { directory: '/work/alpha', projectName: 'Alpha' };
const GLOBAL: GenerateTarget = { directory: null, projectName: '' };
const VALUES_PATH = '/api/agent-profiles/generate/values';
const PREVIEW_PATH = '/api/agent-profiles/generate/preview';
const APPLY_PATH = '/api/agent-profiles/generate';

// Two templates with overlapping parameters: git_url is shared, guideline has a default, token has neither a default nor is remembered.
const SECOND_TEMPLATE = makeTemplate({
  id: 't-report',
  slug: 'report-writer',
  name: 'Report writer',
  params: [
    { key: 'git_url', type: 'url', title: 'Git URL', description: '', required: true },
    { key: 'report_dir', type: 'dir', title: 'Report folder', description: 'Where reports go.', required: false, default: 'reports' },
  ],
});

const plan = (overrides: Partial<GeneratedAgentPlan> & { templateId: string; name: string }): GeneratedAgentPlan => ({
  description: `${overrides.name} description.`,
  path: `/work/alpha/.claude/agents/${overrides.name}.md`,
  status: 'new',
  ...overrides,
});

type SetupOptions = {
  target?: GenerateTarget;
  remembered?: Record<string, string>;
  previewPlans?: GeneratedAgentPlan[];
  initialTemplateIds?: string[];
  lockTemplates?: boolean;
};

const setup = (options: SetupOptions = {}) => {
  const onApplied = vi.fn();
  const onClose = vi.fn();
  const target = options.target ?? ALPHA;
  const plans = options.previewPlans ?? [plan({ templateId: 't-review', name: 'review-code' })];
  const api = installFakeProfilesApi({
    [`GET ${VALUES_PATH}`]: reply({ directory: target.directory, values: options.remembered ?? {} }),
    [`POST ${PREVIEW_PATH}`]: reply({ scope: target.directory ? 'project' : 'user', agentsDirectory: `${target.directory ?? '~'}/.claude/agents`, plans }),
    [`POST ${APPLY_PATH}`]: reply({
      scope: target.directory ? 'project' : 'user',
      agentsDirectory: `${target.directory ?? '~'}/.claude/agents`,
      created: plans.filter((entry) => entry.status === 'new'),
      regenerated: plans.filter((entry) => entry.status === 'duplicate'),
      skipped: plans.filter((entry) => entry.status !== 'new' && entry.status !== 'duplicate'),
      gitExclude: { file: target.directory ? '/work/alpha/.git/info/exclude' : null, added: ['.claude/agents/review-code.md'] },
    }, 201),
  });
  render(
    <GenerateAgentsForm
      templates={[REVIEW_TEMPLATE, SECOND_TEMPLATE, ORCHESTRATOR_TEMPLATE]}
      target={target}
      initialTemplateIds={options.initialTemplateIds ?? ['t-review']}
      lockTemplates={options.lockTemplates}
      onApplied={onApplied}
      onClose={onClose}
    />,
  );
  return { api, onApplied, onClose };
};

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement;
const previewButton = () => screen.getByRole('button', { name: 'Preview' }) as HTMLButtonElement;
const ready = async () => { await screen.findByLabelText(/Git URL/); };
/** The preview table, once the preview arrived (the template checkboxes also show slugs, so rows are looked up inside it). */
const previewTable = async () => within(await screen.findByRole('table'));

describe('remembered values', () => {
  it('asks the server for the values of the target folder and pre-fills the fields of the chosen templates', async () => {
    const { api } = setup({ remembered: { git_url: 'https://git/alpha', guideline: 'be strict', unrelated: 'x' } });

    await ready();
    expect(api.calls[0].path).toBe(`${VALUES_PATH}?directory=%2Fwork%2Falpha`);
    expect(field('Git URL *').value).toBe('https://git/alpha');
    expect(field('Guidelines').value).toBe('be strict');
  });

  it('shows the template default as the placeholder of an empty field instead of filling it', async () => {
    setup();

    await ready();
    expect(field('Guidelines').value).toBe('');
    expect(field('Guidelines').placeholder).toBe('be kind');
  });

  it('asks for the global scope without a directory', async () => {
    const { api } = setup({ target: GLOBAL });

    await ready();
    expect(api.calls[0].path).toBe(VALUES_PATH);
    expect(screen.getByText(/written to ~\/\.claude\/agents and apply to every project/)).toBeTruthy();
  });

  it('refuses to preview while the remembered values are unread, and when reading them failed', async () => {
    const api = installFakeProfilesApi({ [`GET ${VALUES_PATH}`]: failure(500, 'PROFILE_CORRUPT', 'values.json is unreadable') });
    render(<GenerateAgentsForm templates={[REVIEW_TEMPLATE]} target={ALPHA} initialTemplateIds={['t-review']} onClose={() => undefined} />);

    expect(previewButton().disabled).toBe(true);
    expect(await screen.findByText(/A stored profile file could not be read/)).toBeTruthy();
    expect(screen.getByText(/Preview and Apply stay off until they load/)).toBeTruthy();
    expect(previewButton().disabled).toBe(true);

    api.set(`GET ${VALUES_PATH}`, reply({ directory: '/work/alpha', values: { git_url: 'https://git/alpha' } }));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(previewButton().disabled).toBe(false));
    expect(field('Git URL *').value).toBe('https://git/alpha');
  });
});

describe('preview', () => {
  it('sends the directory, the sidebar project name, the chosen templates and every pre-filled value, typed ones winning', async () => {
    const { api } = setup({ remembered: { git_url: 'https://git/alpha', guideline: 'be strict' } });
    await ready();
    fireEvent.change(field('Guidelines'), { target: { value: 'be brief' } });

    fireEvent.click(previewButton());
    await previewTable();

    expect(api.to('POST', PREVIEW_PATH)[0].body).toEqual({
      directory: '/work/alpha',
      projectName: 'Alpha',
      templateIds: ['t-review'],
      values: { git_url: 'https://git/alpha', guideline: 'be brief' },
    });
  });

  it('leaves out a field nobody filled or remembered, and sends an emptied remembered field as empty so the server forgets it', async () => {
    const { api } = setup({ remembered: { git_url: 'https://git/alpha' } });
    await ready();

    fireEvent.click(previewButton());
    await previewTable();
    expect(api.to('POST', PREVIEW_PATH)[0].body).toMatchObject({ values: { git_url: 'https://git/alpha' } });
    expect((api.to('POST', PREVIEW_PATH)[0].body as { values: Record<string, string> }).values).not.toHaveProperty('guideline');

    fireEvent.change(field('Git URL *'), { target: { value: '' } });
    fireEvent.click(previewButton());
    await waitFor(() => expect(api.to('POST', PREVIEW_PATH)).toHaveLength(2));
    expect(api.to('POST', PREVIEW_PATH)[1].body).toMatchObject({ values: { git_url: '' } });
  });

  it('treats a parameter named like an Object.prototype member as an ordinary key: empty field, no inherited value sent', async () => {
    const template = makeTemplate({
      id: 't-proto',
      slug: 'proto-agent',
      name: 'Proto agent',
      instructions: 'Use {{toString}}.',
      params: [{ key: 'toString', type: 'text', title: 'Tool string', description: '', required: false }],
    });
    const api = installFakeProfilesApi({
      [`GET ${VALUES_PATH}`]: reply({ directory: '/work/alpha', values: {} }),
      [`POST ${PREVIEW_PATH}`]: reply({ scope: 'project', agentsDirectory: '/work/alpha/.claude/agents', plans: [plan({ templateId: 't-proto', name: 'proto-agent' })] }),
    });
    render(<GenerateAgentsForm templates={[template]} target={ALPHA} initialTemplateIds={['t-proto']} onClose={() => undefined} />);
    await screen.findByLabelText('Tool string');

    expect(field('Tool string').value).toBe('');
    fireEvent.click(previewButton());
    await previewTable();
    expect(api.to('POST', PREVIEW_PATH)[0].body).toEqual({ directory: '/work/alpha', projectName: 'Alpha', templateIds: ['t-proto'], values: {} });

    fireEvent.change(field('Tool string'), { target: { value: 'typed' } });
    fireEvent.click(previewButton());
    await waitFor(() => expect(api.to('POST', PREVIEW_PATH)).toHaveLength(2));
    expect(api.to('POST', PREVIEW_PATH)[1].body).toMatchObject({ values: { toString: 'typed' } });
  });

  it('sends no directory and no project name for the global scope', async () => {
    const { api } = setup({ target: GLOBAL });
    await ready();

    fireEvent.click(previewButton());
    await waitFor(() => expect(api.to('POST', PREVIEW_PATH)).toHaveLength(1));
    expect(api.to('POST', PREVIEW_PATH)[0].body).toEqual({ directory: null, templateIds: ['t-review'], values: {} });
  });

  it('shows one field per parameter key across the chosen templates and flags a required one without a value or default', async () => {
    setup({ initialTemplateIds: ['t-review', 't-report'] });
    await ready();

    expect(screen.getAllByLabelText(/Git URL/)).toHaveLength(1);
    expect(field('Report folder').placeholder).toBe('reports');
    expect(screen.getByText('"git_url" is required: type a value.')).toBeTruthy();

    fireEvent.change(field('Git URL *'), { target: { value: 'https://git/x' } });
    expect(screen.queryByText('"git_url" is required: type a value.')).toBeNull();
  });

  it('warns about a repository address that does not look like one, without blocking', async () => {
    setup();
    await ready();

    fireEvent.change(field('Git URL *'), { target: { value: 'not a url' } });
    expect(screen.getByText(/does not look like a web or SSH address/)).toBeTruthy();
    expect(previewButton().disabled).toBe(false);
  });

  it('needs at least one template ticked, and ticking changes the fields', async () => {
    setup({ initialTemplateIds: [] });
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
    expect(previewButton().disabled).toBe(true);
    expect(screen.queryByLabelText(/Git URL/)).toBeNull();

    fireEvent.click(screen.getByLabelText(/Code reviewer/));
    expect(previewButton().disabled).toBe(false);
    expect(screen.getByLabelText(/Git URL/)).toBeTruthy();
  });

  it('hides the template checkboxes when the caller already chose the templates', async () => {
    setup({ lockTemplates: true });
    await ready();

    expect(screen.queryByRole('group', { name: 'Templates' })).toBeNull();
    expect(screen.queryByLabelText(/Code reviewer/)).toBeNull();
  });

  it('shows the file path of an agent, and what would happen to every kind of plan', async () => {
    setup({
      initialTemplateIds: ['t-review', 't-report', 't-orch'],
      previewPlans: [
        plan({ templateId: 't-review', name: 'review-code' }),
        plan({ templateId: 't-report', name: 'report-writer', status: 'duplicate' }),
        plan({ templateId: 't-orch', name: 'orchestrator', status: 'handmade-exists' }),
        plan({ templateId: 't-x', name: 'needs-values', status: 'missing-values', missing: ['git_url', 'jira'] }),
        plan({ templateId: 't-y', name: 'bad name', status: 'invalid-name' }),
        plan({ templateId: 't-z', name: 'locked-file', status: 'write-failed' }),
      ],
    });
    await ready();
    fireEvent.change(field('Git URL *'), { target: { value: 'https://git/x' } });
    fireEvent.click(previewButton());

    const table = await previewTable();
    const rowText = (name: string) => (table.getByText(name).closest('tr') as HTMLElement).textContent;
    expect(rowText('review-code')).toContain('Will be created');
    expect(table.getByText('review-code').getAttribute('title')).toBe('/work/alpha/.claude/agents/review-code.md');
    expect(rowText('report-writer')).toContain('Generated before: will be regenerated');
    expect(rowText('orchestrator')).toContain('A handmade file with this name exists, skipped');
    expect(rowText('needs-values')).toContain('Missing required values (git_url, jira), skipped');
    expect(rowText('bad name')).toContain('not a valid agent name, skipped');
    expect(rowText('locked-file')).toContain('Could not write this file');
    expect(screen.getByText('Writes to /work/alpha/.claude/agents')).toBeTruthy();
  });

  it('forgets the preview as soon as the selection or a value changes, so it never describes another selection', async () => {
    setup();
    await ready();
    fireEvent.click(previewButton());
    await previewTable();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeTruthy();

    fireEvent.change(field('Guidelines'), { target: { value: 'changed' } });
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Generate' })).toBeNull();
  });
});

describe('apply', () => {
  it('is offered only when some plan writes a file', async () => {
    setup({ previewPlans: [plan({ templateId: 't-review', name: 'review-code', status: 'handmade-exists' })] });
    await ready();
    fireEvent.click(previewButton());
    await previewTable();

    expect((screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends the same full request as the preview, then reports created, regenerated and skipped with the git exclude note', async () => {
    const { api, onApplied, onClose } = setup({
      initialTemplateIds: ['t-review', 't-report', 't-orch'],
      remembered: { git_url: 'https://git/alpha', report_dir: 'out' },
      previewPlans: [
        plan({ templateId: 't-review', name: 'review-code' }),
        plan({ templateId: 't-report', name: 'report-writer', status: 'duplicate' }),
        plan({ templateId: 't-orch', name: 'orchestrator', status: 'handmade-exists' }),
      ],
    });
    await ready();
    fireEvent.click(previewButton());
    await previewTable();
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));

    await screen.findByText('Created 1, regenerated 1, skipped 1.');
    expect(api.to('POST', APPLY_PATH)[0].body).toEqual(api.to('POST', PREVIEW_PATH)[0].body);
    expect(api.to('POST', APPLY_PATH)[0].body).toMatchObject({ values: { git_url: 'https://git/alpha', report_dir: 'out' } });
    const result = screen.getByRole('status');
    expect(within(result).getByText('Created review-code')).toBeTruthy();
    expect(within(result).getByText('Regenerated report-writer')).toBeTruthy();
    expect(result.textContent).toContain('orchestrator: A handmade file with this name exists, skipped');
    expect(result.textContent).toContain('Added 1 line to /work/alpha/.git/info/exclude, so the generated files stay out of git.');
    expect(onApplied).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('says nothing was put on a git exclude list when the project is not a repository, and nothing at all for the global scope', async () => {
    const { api } = setup();
    api.set(`POST ${APPLY_PATH}`, reply({ scope: 'project', agentsDirectory: '/work/alpha/.claude/agents', created: [plan({ templateId: 't-review', name: 'review-code' })], regenerated: [], skipped: [], gitExclude: { file: null, added: [] } }, 201));
    await ready();
    fireEvent.click(previewButton());
    await previewTable();
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));

    expect(await screen.findByText(/Not a git repository/)).toBeTruthy();
  });

  it('does not mention git for the global scope', async () => {
    setup({ target: GLOBAL });
    await ready();
    fireEvent.click(previewButton());
    await previewTable();
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));

    await screen.findByText('Created 1, regenerated 0, skipped 0.');
    expect(screen.queryByText(/git/i)).toBeNull();
  });

  it('keeps the form and shows the server\'s reason when applying fails', async () => {
    const { api, onApplied } = setup();
    await ready();
    fireEvent.click(previewButton());
    await previewTable();
    api.set(`POST ${APPLY_PATH}`, failure(400, 'DIRECTORY_NOT_FOUND', 'The project folder does not exist.'));
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));

    expect(await screen.findByText(/The project folder does not exist/)).toBeTruthy();
    expect(onApplied).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeTruthy();
  });

  it('closes on Cancel without calling the server for anything but the remembered values', async () => {
    const { api, onClose } = setup();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalled();
    expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });
});

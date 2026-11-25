import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import { TemplateEditor } from '@/modules/agent-profiles/templates/TemplateEditor';
import {
  REVIEW_TEMPLATE,
  failure,
  installFakeProfilesApi,
  makeTemplate,
  reply,
} from '@/modules/agent-profiles/tests/fake-profiles-api';
import type { AgentProfileTemplate } from '@/shared/types';

/** Template editor: fields, the `{{key}}` checks, edit with `rev`, the optional agent memory scope, capabilities and preview. */

afterEach(() => {
  vi.unstubAllGlobals();
});

const CATALOGS = { mcpServers: ['docs'], skills: [], models: ['claude-sonnet-5-5'] };

type Props = Partial<{
  template: AgentProfileTemplate | null;
  templates: AgentProfileTemplate[];
}>;

const setup = (props: Props = {}) => {
  const onSaved = vi.fn();
  const onCancel = vi.fn();
  const onReload = vi.fn();
  const api = installFakeProfilesApi({
    'POST /api/agent-profiles/templates': reply({ id: 'new' }, 201),
    'PUT /api/agent-profiles/templates/:id': reply({ id: 'x' }),
  });
  render(
    <TemplateEditor
      template={props.template ?? null}
      templates={props.templates ?? []}
      catalogs={CATALOGS}
      onSaved={onSaved}
      onCancel={onCancel}
      onReload={onReload}
    />,
  );
  return { api, onSaved, onCancel, onReload };
};

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const saveButton = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;

describe('creating a template', () => {
  it('follows the name with a generated slug and posts the full body, with no memory unless one is chosen', async () => {
    const { api, onSaved } = setup();
    type('Name', 'Code Reviewer');
    type('When to use it', 'Reviews diffs');
    type('Instructions', 'Review the code.');

    expect((screen.getByLabelText('Slug') as HTMLInputElement).value).toBe('code-reviewer');
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.to('POST', '/api/agent-profiles/templates')[0].body).toEqual({
      slug: 'code-reviewer',
      family: 'worker',
      name: 'Code Reviewer',
      description: 'Reviews diffs',
      instructions: 'Review the code.',
      params: [],
      bindings: { project: true, knowledge: false },
    });
  });

  it('keeps a hand-typed slug and refuses one that another template uses', () => {
    setup({ templates: [REVIEW_TEMPLATE] });
    type('Name', 'Other');
    type('Instructions', 'x');
    type('Slug', 'review-code');

    expect(screen.getByRole('alert').textContent).toContain('already uses this slug');
    expect(saveButton().disabled).toBe(true);
  });

  it('blocks saving a {{key}} with no parameter and fixes it with one click', async () => {
    const { api, onSaved } = setup();
    type('Name', 'Tester');
    type('Instructions', 'Run {{test_command}} please');

    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText(/no parameter has the key "test_command"/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Add parameter "test_command"' }));
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const body = api.to('POST', '/api/agent-profiles/templates')[0].body as { params: Array<{ key: string }> };
    expect(body.params.map((entry) => entry.key)).toEqual(['test_command']);
  });

  it('accepts the reserved project keys without a parameter', () => {
    setup();
    type('Name', 'Scoped');
    type('Instructions', 'Work in {{project_name}} at {{project_directory}}.');

    expect(saveButton().disabled).toBe(false);
  });

  it('warns about an unused parameter without blocking', () => {
    setup({ template: makeTemplate({ id: 's', instructions: 'No placeholders', params: [{ key: 'extra', type: 'text', title: 'extra', description: '', required: false }] }) });

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Parameter "extra" is not used in the instructions.')).toBeTruthy();
    expect(saveButton().disabled).toBe(false);
  });
});

describe('editing a template', () => {
  const template = makeTemplate({
    id: 't1',
    rev: 4,
    slug: 'review-code',
    name: 'Code reviewer',
    instructions: 'Review {{git_url}} with {{guideline}}.',
    params: [
      { key: 'git_url', type: 'url', title: 'Git', description: '', required: false },
      { key: 'guideline', type: 'text', title: 'Guideline', description: '', required: false },
    ],
  });

  it('says a change reaches an agent file only when it is generated again', () => {
    setup({ template });

    expect(screen.getByRole('status').textContent).toContain('only when it is generated again');
  });

  it('sends the rev it loaded so a newer edit is never overwritten', async () => {
    const { api, onSaved } = setup({ template, templates: [template] });
    type('Name', 'Code reviewer v2');
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.to('PUT', '/api/agent-profiles/templates/t1')[0].body).toMatchObject({ rev: 4, name: 'Code reviewer v2', slug: 'review-code' });
  });

  it('removes a parameter without asking for confirmation (no agent record holds values for it any more)', () => {
    setup({ template, templates: [template] });

    fireEvent.click(within(screen.getByRole('group', { name: 'Parameter 2' })).getByRole('button', { name: 'Remove parameter' }));
    fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'Review {{git_url}}.' } });

    expect(screen.queryByText(/will be ignored/)).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it('reports a stale save (409) in place and offers to reload the latest version', async () => {
    const { api, onReload } = setup({ template, templates: [template] });
    api.set('PUT /api/agent-profiles/templates/:id', failure(409, 'PROFILE_STALE', 'stale', { currentRev: 5 }));
    type('Name', 'Changed');
    fireEvent.click(saveButton());

    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toContain('changed somewhere else');
    fireEvent.click(within(notice).getByRole('button', { name: 'Reload the latest version' }));
    expect(onReload).toHaveBeenCalled();
  });

  it('lets an orchestrator template become a worker: there is no default orchestrator to protect', () => {
    setup({ template: makeTemplate({ id: 'o', family: 'orchestrator' }) });
    expect((screen.getByLabelText('Family') as HTMLSelectElement).disabled).toBe(false);
  });
});

describe('agent memory', () => {
  it('offers none, project, user and local, with none selected for a template without memory', () => {
    setup();
    const select = screen.getByLabelText('Agent memory') as HTMLSelectElement;

    expect([...select.options].map((option) => option.value)).toEqual(['', 'project', 'user', 'local']);
    expect(select.value).toBe('');
  });

  it('sends the chosen scope as memory, and drops it again when set back to none', async () => {
    const { api, onSaved } = setup({ template: makeTemplate({ id: 't1', rev: 2, memory: 'user' }) });
    expect((screen.getByLabelText('Agent memory') as HTMLSelectElement).value).toBe('user');

    type('Agent memory', 'project');
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(api.to('PUT', '/api/agent-profiles/templates/t1')[0].body).toMatchObject({ memory: 'project' });

    type('Agent memory', '');
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
    expect(api.to('PUT', '/api/agent-profiles/templates/t1')[1].body).not.toHaveProperty('memory');
  });

  it('creates a template with memory: local', async () => {
    const { api, onSaved } = setup();
    type('Name', 'Remembering');
    type('Instructions', 'Keep notes.');
    type('Agent memory', 'local');
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.to('POST', '/api/agent-profiles/templates')[0].body).toMatchObject({ slug: 'remembering', memory: 'local' });
  });
});

describe('dropdown group', () => {
  it('is empty for a new template, says where it shows, and sends nothing for it', async () => {
    const { api, onSaved } = setup();
    expect((screen.getByLabelText('Group') as HTMLInputElement).value).toBe('');
    expect(screen.getByText(/Empty = System/)).toBeTruthy();

    type('Name', 'Plain');
    type('Instructions', 'Do it.');
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.to('POST', '/api/agent-profiles/templates')[0].body).not.toHaveProperty('group');
  });

  it('sends the trimmed group, and a blank one is left out', async () => {
    const { api, onSaved } = setup();
    type('Name', 'Grouped');
    type('Instructions', 'Do it.');
    type('Group', '  Work ');
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(api.to('POST', '/api/agent-profiles/templates')[0].body).toMatchObject({ slug: 'grouped', group: 'Work' });

    type('Group', '   ');
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
    expect(api.to('POST', '/api/agent-profiles/templates')[1].body).not.toHaveProperty('group');
  });

  it('round trip: loads the stored group, keeps it when saved, and drops it when cleared', async () => {
    const { api, onSaved } = setup({ template: makeTemplate({ id: 't1', rev: 2, group: 'Work' }) });
    expect((screen.getByLabelText('Group') as HTMLInputElement).value).toBe('Work');

    type('Name', 'Renamed');
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(api.to('PUT', '/api/agent-profiles/templates/t1')[0].body).toMatchObject({ rev: 2, group: 'Work' });

    type('Group', '');
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
    expect(api.to('PUT', '/api/agent-profiles/templates/t1')[1].body).not.toHaveProperty('group');
  });
});

describe('memory blocks switch', () => {
  const blocksSwitch = () => screen.getByRole('switch', { name: 'Memory blocks' });

  it('is off for a new template, explains what it adds, and sends nothing for it', async () => {
    const { api, onSaved } = setup();
    expect(blocksSwitch().getAttribute('aria-checked')).toBe('false');
    const help = screen.getByText(/mcp__blocks__block_list/).textContent ?? '';
    expect(help).toContain('block_read and block_write');
    expect(help).toContain('short instruction on Generate');

    type('Name', 'Plain');
    type('Instructions', 'Do it.');
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.to('POST', '/api/agent-profiles/templates')[0].body).not.toHaveProperty('usesBlocks');
  });

  it('creates a template with usesBlocks: true once switched on', async () => {
    const { api, onSaved } = setup();
    type('Name', 'Remembering');
    type('Instructions', 'Keep notes.');
    fireEvent.click(blocksSwitch());
    expect(blocksSwitch().getAttribute('aria-checked')).toBe('true');
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.to('POST', '/api/agent-profiles/templates')[0].body).toMatchObject({ slug: 'remembering', usesBlocks: true });
  });

  it('round trip: loads on for a template that uses blocks, keeps it when saved, and drops it when switched off', async () => {
    const { api, onSaved } = setup({ template: makeTemplate({ id: 't1', rev: 3, usesBlocks: true }) });
    expect(blocksSwitch().getAttribute('aria-checked')).toBe('true');

    type('Name', 'Renamed');
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(api.to('PUT', '/api/agent-profiles/templates/t1')[0].body).toMatchObject({ rev: 3, usesBlocks: true });

    fireEvent.click(blocksSwitch());
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
    expect(api.to('PUT', '/api/agent-profiles/templates/t1')[1].body).not.toHaveProperty('usesBlocks');
  });

  it('a template that does not use blocks loads with the switch off', () => {
    setup({ template: makeTemplate({ id: 't2' }) });
    expect(blocksSwitch().getAttribute('aria-checked')).toBe('false');
  });
});

describe('capabilities and preview', () => {
  it('warns when an orchestrator is left without the delegation tool', () => {
    setup({ template: makeTemplate({ id: 'o', family: 'orchestrator', tools: ['Read'] }) });
    expect(screen.getByText(/cannot call the delegation tool/)).toBeTruthy();
  });

  it('offers the real tool and MCP server lists instead of free text', () => {
    setup();
    const toolSelect = screen.getByLabelText('Add to Allowed tools (empty = all)') as HTMLSelectElement;
    expect([...toolSelect.options].map((option) => option.value)).toContain('Agent');
    expect([...toolSelect.options].map((option) => option.value)).toContain('Bash');

    fireEvent.change(screen.getByLabelText('Add to MCP servers'), { target: { value: 'docs' } });
    expect(screen.getByRole('button', { name: 'Remove docs' })).toBeTruthy();
  });

  it('renders the prompt like an agent would receive it, from sample values', () => {
    setup({ template: REVIEW_TEMPLATE, templates: [REVIEW_TEMPLATE] });
    fireEvent.click(screen.getByRole('button', { name: 'Show preview' }));

    fireEvent.change(screen.getByLabelText('Sample value for git_url'), { target: { value: 'https://git/a<b>' } });
    const rendered = screen.getByLabelText('Rendered instructions').textContent ?? '';

    expect(rendered).toContain('<param name="git_url">https://git/a&lt;b&gt;</param>');
    expect(rendered).toContain('<param name="guideline">be kind</param>');
    expect(rendered).not.toContain('{{');
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import { TemplatesTab } from '@/modules/agent-profiles/templates/TemplatesTab';
import {
  ORCHESTRATOR_TEMPLATE,
  REVIEW_TEMPLATE,
  failure,
  installFakeProfilesApi,
  makeTemplate,
  reply,
} from '@/modules/agent-profiles/tests/fake-profiles-api';

/** Templates tab: the list (name, family, slug, memory) with create, edit and delete; nothing about agents, samples, defaults or imports. */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const CATALOGS = { mcpServers: [], skills: [], models: [] };
const REMEMBERING = makeTemplate({ id: 't-mem', slug: 'notes-taker', name: 'Notes taker', memory: 'project' });

const setup = () => {
  const onReload = vi.fn();
  const api = installFakeProfilesApi({
    'DELETE /api/agent-profiles/templates/:id': reply({ deleted: true }),
  });
  render(<TemplatesTab templates={[REVIEW_TEMPLATE, ORCHESTRATOR_TEMPLATE, REMEMBERING]} catalogs={CATALOGS} loading={false} onReload={onReload} />);
  return { api, onReload };
};

describe('template list', () => {
  it('shows name, family and slug of each template, and the memory scope only where one is set', () => {
    setup();

    const reviewRow = screen.getByText('Code reviewer').closest('li') as HTMLElement;
    expect(reviewRow.textContent).toContain('Worker');
    expect(reviewRow.textContent).toContain('review-code');
    expect(reviewRow.textContent).not.toContain('Memory');

    const orchestratorRow = screen.getByText('default-orchestrator').closest('li') as HTMLElement;
    expect(orchestratorRow.textContent).toContain('Orchestrator');
    expect(orchestratorRow.textContent).toContain('default-orchestrator');

    expect((screen.getByText('Notes taker').closest('li') as HTMLElement).textContent).toContain('Memory: Project (.claude/agent-memory)');
  });

  it('marks a template that uses memory blocks', () => {
    installFakeProfilesApi();
    render(<TemplatesTab templates={[REVIEW_TEMPLATE, makeTemplate({ id: 't-blocks', slug: 'block-user', name: 'Block user', usesBlocks: true })]} catalogs={CATALOGS} loading={false} onReload={() => undefined} />);

    expect((screen.getByText('Block user').closest('li') as HTMLElement).textContent).toContain('Memory blocks');
    expect((screen.getByText('Code reviewer').closest('li') as HTMLElement).textContent).not.toContain('Memory blocks');
  });

  it('has no restore, duplicate, default, origin, import or agent-count control', () => {
    setup();

    expect(screen.queryByRole('button', { name: /original samples/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Duplicate/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Make default/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Import from a Claude agent/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/App sample|Mine|Default orchestrator|agents? use it/);
  });

  it('shows an empty state and a loading state', () => {
    installFakeProfilesApi();
    const { rerender } = render(<TemplatesTab templates={[]} catalogs={CATALOGS} loading onReload={() => undefined} />);
    expect(screen.getByText('Loading…')).toBeTruthy();

    rerender(<TemplatesTab templates={[]} catalogs={CATALOGS} loading={false} onReload={() => undefined} />);
    expect(screen.getByText(/No templates yet/)).toBeTruthy();
  });
});

describe('template actions', () => {
  it('asks before deleting, deletes through the server and reloads', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { api, onReload } = setup();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Notes taker' }));
    expect(api.to('DELETE', '/api/agent-profiles/templates/t-mem')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Notes taker' }));
    await waitFor(() => expect(onReload).toHaveBeenCalled());
    expect(api.to('DELETE', '/api/agent-profiles/templates/t-mem')).toHaveLength(1);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(String(confirm.mock.calls[0][0])).toContain('Agent files already generated from it are not changed');
  });

  it('deletes an orchestrator template like any other', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { api, onReload } = setup();

    const button = screen.getByRole('button', { name: 'Delete Orchestrator' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);

    await waitFor(() => expect(onReload).toHaveBeenCalled());
    expect(api.to('DELETE', '/api/agent-profiles/templates/t-orch')).toHaveLength(1);
  });

  it('keeps the list and says why when the server refuses a delete', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { api, onReload } = setup();
    api.set('DELETE /api/agent-profiles/templates/:id', failure(500, 'BOOM', 'The store is unreadable'));

    fireEvent.click(screen.getByRole('button', { name: 'Delete Code reviewer' }));

    expect((await screen.findByRole('alert')).textContent).toContain('The store is unreadable');
    expect(onReload).not.toHaveBeenCalled();
  });

  it('opens the editor on a new template and on an existing one, and returns to the list on Cancel', () => {
    setup();

    fireEvent.click(screen.getByRole('button', { name: 'New template' }));
    expect(screen.getByRole('heading', { name: 'New template' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('button', { name: 'Edit Code reviewer' }));
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Code reviewer');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'New template' })).toBeTruthy();
  });
});

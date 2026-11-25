import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import { MemoryTab } from '@/modules/agent-profiles/memory/MemoryTab';
import {
  SIDEBAR_CRM,
  SIDEBAR_ALPHA,
  failure,
  installFakeProfilesApi,
  makeClaudeAgent,
  makeMemoryBlock,
  memoryBlockRoutes,
  reply,
} from '@/modules/agent-profiles/tests/fake-profiles-api';
import type { ClaudeAgentEntry, MemoryBlock } from '@/shared/types';

/**
 * Memory tab: the list (name, mode, scope, size, last writer, update time), create / edit / delete against a fake server that
 * behaves like the real one (revision check, name per scope), the stale and field errors, the plain-words limits and the
 * "read-only is not a hard lock" notice.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const NOTES = makeMemoryBlock({ id: 'b-notes', name: 'notes', description: 'Shared scratch notes.', content: 'hello', lastWriter: 'agent:orchestrator', updatedAt: '2026-11-24T08:30:00.000Z' });
const RULES = makeMemoryBlock({ id: 'b-rules', name: 'house-rules', mode: 'read-only', content: 'Be kind.', lastWriter: 'user', maxChars: 500 });
const CRM_BLOCK = makeMemoryBlock({ id: 'b-crm', name: 'crm-facts', scope: { kind: 'project', directory: 'c:/work/crm' } });
const GONE_BLOCK = makeMemoryBlock({ id: 'b-gone', name: 'old-project', scope: { kind: 'project', directory: '/work/removed' } });

const PERSONAL_BASH = makeClaudeAgent({ source: 'user', name: 'shell-helper', tools: ['Read', 'Bash'] });
const PERSONAL_UNRESTRICTED = makeClaudeAgent({ source: 'project', name: 'free-agent' });
const PERSONAL_SAFE = makeClaudeAgent({ source: 'user', name: 'reader', tools: ['Read', 'Grep'] });

type SetupOptions = { blocks?: MemoryBlock[]; agents?: ClaudeAgentEntry[]; agentsReady?: boolean; projects?: typeof SIDEBAR_ALPHA[]; loadFails?: boolean };

const setup = (options: SetupOptions = {}) => {
  const store = memoryBlockRoutes(options.blocks ?? [NOTES, RULES]);
  const api = installFakeProfilesApi(store.routes);
  if (options.loadFails) api.set('GET /api/agent-profiles/memory-blocks', failure(500, 'BOOM', 'The store is unreadable'));
  render(
    <MemoryTab
      projects={options.projects ?? [SIDEBAR_ALPHA, SIDEBAR_CRM]}
      agents={options.agents ?? []}
      agentsReady={options.agentsReady ?? true}
      agentsTarget="Alpha"
    />,
  );
  return { api, store };
};

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const saveButton = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
const rowOf = (name: string) => screen.getByText(name).closest('li') as HTMLElement;
/** Clicks Edit on a block; the form opens once the tab has read the block's current state from the server. */
const openEditor = async (name: string) => {
  fireEvent.click(screen.getByRole('button', { name: `Edit ${name}` }));
  await screen.findByLabelText('Name');
};

describe('block list', () => {
  it('shows name, mode, scope, size, last writer and update time of each block', async () => {
    setup({ blocks: [NOTES, RULES, CRM_BLOCK] });

    await screen.findByText('notes');
    const notes = rowOf('notes');
    expect(notes.textContent).toContain('Writable');
    expect(notes.textContent).toContain('Global (every chat)');
    expect(notes.textContent).toContain('5 / 2000 chars');
    expect(notes.textContent).toContain('agent orchestrator');
    expect(notes.textContent).toContain('Shared scratch notes.');
    expect(notes.textContent).toContain(new Date('2026-11-24T08:30:00.000Z').toLocaleString());

    const rules = rowOf('house-rules');
    expect(rules.textContent).toContain('Read-only');
    expect(rules.textContent).toContain('8 / 500 chars');
    expect(rules.textContent).toContain('you');

    const crm = rowOf('crm-facts');
    expect(crm.textContent).toContain('c:/work/crm');
    expect(crm.textContent).toContain('nobody yet');
  });

  it('says what a block is: global or project scope only, never per agent, only in this app\'s chats', async () => {
    setup();
    await screen.findByText('notes');

    const text = screen.getByRole('note').textContent ?? '';
    expect(text).toContain('global (every chat) or one project');
    expect(text).toContain('cannot be limited to one agent');
    expect(text).toContain('only inside chats of this app');
    expect(text).toContain('claude command on this computer does not see them');
  });

  it('shows an empty state, and a loading state first', async () => {
    setup({ blocks: [] });

    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(await screen.findByText(/No memory blocks yet/)).toBeTruthy();
  });

  it('shows a failed load with a retry instead of claiming the list is empty', async () => {
    const { api } = setup({ loadFails: true });

    expect(await screen.findByText('The store is unreadable')).toBeTruthy();
    expect(screen.queryByText(/No memory blocks yet/)).toBeNull();
    api.set('GET /api/agent-profiles/memory-blocks', reply({ blocks: [RULES] }));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText('The store is unreadable')).toBeNull());
    expect(await screen.findByText('house-rules')).toBeTruthy();
  });
});

describe('creating a block', () => {
  it('posts a writable global block and shows it in the list', async () => {
    const { api } = setup({ blocks: [] });
    await screen.findByText(/No memory blocks yet/);

    fireEvent.click(screen.getByRole('button', { name: 'New block' }));
    type('Name', 'project-notes');
    type('Description', '  What we learned  ');
    type('Content', 'first line');
    fireEvent.click(saveButton());

    await screen.findByText('project-notes');
    expect(api.to('POST', '/api/agent-profiles/memory-blocks')[0].body).toEqual({
      name: 'project-notes',
      description: 'What we learned',
      mode: 'writable',
      scope: { kind: 'global' },
      content: 'first line',
      maxChars: 2000,
    });
    // The form closed and the list was read again.
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(api.to('GET', '/api/agent-profiles/memory-blocks')).toHaveLength(2);
  });

  it('creates a read-only block scoped to a sidebar project picked from the list, with a custom limit', async () => {
    const { api } = setup({ blocks: [] });
    await screen.findByText(/No memory blocks yet/);

    fireEvent.click(screen.getByRole('button', { name: 'New block' }));
    type('Name', 'alpha-rules');
    type('Mode', 'read-only');
    type('Scope', SIDEBAR_ALPHA.projectId);
    type('Size limit (characters)', '500');
    type('Content', 'No force pushes.');
    fireEvent.click(saveButton());

    await screen.findByText('alpha-rules');
    expect(api.to('POST', '/api/agent-profiles/memory-blocks')[0].body).toMatchObject({
      mode: 'read-only',
      scope: { kind: 'project', directory: '/work/alpha' },
      maxChars: 500,
    });
    expect(rowOf('alpha-rules').textContent).toContain('/work/alpha');
  });

  it('offers global and the sidebar projects only: there is no free-text path', async () => {
    setup({ blocks: [] });
    await screen.findByText(/No memory blocks yet/);
    fireEvent.click(screen.getByRole('button', { name: 'New block' }));

    const scope = screen.getByLabelText('Scope') as HTMLSelectElement;
    expect([...scope.options].map((option) => option.textContent)).toEqual(['Global (every chat)', 'Alpha', 'CRM']);
    expect(screen.queryByLabelText(/folder|path|directory/i)).toBeNull();
  });

  it('blocks Save on an invalid name, an invalid limit and content over the limit', async () => {
    setup({ blocks: [] });
    await screen.findByText(/No memory blocks yet/);
    fireEvent.click(screen.getByRole('button', { name: 'New block' }));

    expect(saveButton().disabled).toBe(true);
    type('Name', 'Bad Name');
    expect(screen.getByText(/lower-case letters and digits separated by single hyphens \(at most 40/, { selector: 'p[role="alert"]' })).toBeTruthy();
    expect(saveButton().disabled).toBe(true);

    type('Name', 'good-name');
    expect(saveButton().disabled).toBe(false);
    type('Size limit (characters)', '0');
    expect(screen.getByText('Enter a whole number from 1 to 20000.')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    type('Size limit (characters)', '20001');
    expect(saveButton().disabled).toBe(true);

    type('Size limit (characters)', '5');
    type('Content', 'too long for five');
    expect(screen.getByText('The content is longer than the limit of 5 characters.')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    type('Content', 'ok');
    expect(saveButton().disabled).toBe(false);
  });

  it('shows the server\'s refusal in place: a name already used in that scope, and a field error', async () => {
    const { api } = setup();
    await screen.findByText('notes');
    fireEvent.click(screen.getByRole('button', { name: 'New block' }));
    type('Name', 'notes');
    fireEvent.click(saveButton());

    const taken = (await screen.findByRole('alert')).textContent ?? '';
    expect(taken).toContain('already has this name');
    expect(taken).toContain('unique across all scopes');

    api.set('POST /api/agent-profiles/memory-blocks', failure(400, 'INVALID_PROFILE_INPUT', 'scope.directory must be an absolute folder path'));
    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('scope.directory must be an absolute folder path'));

    api.set('POST /api/agent-profiles/memory-blocks', failure(409, 'BLOCK_LIMIT_REACHED', 'limit'));
    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('limit of 50 memory blocks'));
  });

  it('a name used in another scope is refused too (names are unique across all scopes), and the form says so up front', async () => {
    setup({ blocks: [CRM_BLOCK] });
    await screen.findByText('crm-facts');
    fireEvent.click(screen.getByRole('button', { name: 'New block' }));

    expect(screen.getByText(/Unique across all scopes\./)).toBeTruthy();
    type('Name', 'crm-facts');
    fireEvent.click(saveButton());

    expect((await screen.findByRole('alert')).textContent).toContain('unique across all scopes');
  });

  it('says in the size limit hint that length counts UTF-16 units, so an emoji counts as 2', async () => {
    setup({ blocks: [] });
    await screen.findByText(/No memory blocks yet/);
    fireEvent.click(screen.getByRole('button', { name: 'New block' }));

    expect(screen.getByText(/UTF-16 units, so an emoji counts as 2/)).toBeTruthy();
  });

  it('Cancel returns to the list without a request', async () => {
    const { api } = setup();
    await screen.findByText('notes');
    fireEvent.click(screen.getByRole('button', { name: 'New block' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByRole('button', { name: 'New block' })).toBeTruthy();
    expect(api.to('POST', '/api/agent-profiles/memory-blocks')).toHaveLength(0);
  });
});

describe('editing a block', () => {
  it('opens on the block\'s values, sends the rev it loaded as expectedRev, and shows the change', async () => {
    const { api, store } = setup({ blocks: [{ ...NOTES, rev: 4 }, RULES] });
    await screen.findByText('notes');

    await openEditor('notes');
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('notes');
    expect((screen.getByLabelText('Content') as HTMLTextAreaElement).value).toBe('hello');
    type('Content', 'hello again');
    fireEvent.click(saveButton());

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).toBeNull());
    expect(api.to('PUT', '/api/agent-profiles/memory-blocks/b-notes')[0].body).toMatchObject({
      expectedRev: 4,
      name: 'notes',
      content: 'hello again',
      mode: 'writable',
      scope: { kind: 'global' },
      maxChars: 2000,
    });
    expect(store.blocks.find((block) => block.id === 'b-notes')?.content).toBe('hello again');
    expect(await screen.findByText(/11 \/ 2000 chars/)).toBeTruthy();
  });

  it('lets the user edit a read-only block and switch its mode', async () => {
    const { api } = setup();
    await screen.findByText('house-rules');

    await openEditor('house-rules');
    expect((screen.getByLabelText('Mode') as HTMLSelectElement).value).toBe('read-only');
    type('Mode', 'writable');
    fireEvent.click(saveButton());

    await waitFor(() => expect(api.to('PUT', '/api/agent-profiles/memory-blocks/b-rules')).toHaveLength(1));
    expect(api.to('PUT', '/api/agent-profiles/memory-blocks/b-rules')[0].body).toMatchObject({ mode: 'writable', content: 'Be kind.' });
  });

  it('preselects the sidebar project of a project block, however its folder was typed', async () => {
    setup({ blocks: [CRM_BLOCK] });
    await screen.findByText('crm-facts');

    await openEditor('crm-facts');
    expect((screen.getByLabelText('Scope') as HTMLSelectElement).value).toBe(SIDEBAR_CRM.projectId);
  });

  it('keeps the folder of a block whose project left the sidebar instead of moving it to global', async () => {
    const { api } = setup({ blocks: [GONE_BLOCK] });
    await screen.findByText('old-project');

    await openEditor('old-project');
    const scope = screen.getByLabelText('Scope') as HTMLSelectElement;
    expect([...scope.options].map((option) => option.textContent)).toContain('/work/removed (not in the sidebar)');
    type('Description', 'still here');
    fireEvent.click(saveButton());

    await waitFor(() => expect(api.to('PUT', '/api/agent-profiles/memory-blocks/b-gone')).toHaveLength(1));
    expect(api.to('PUT', '/api/agent-profiles/memory-blocks/b-gone')[0].body).toMatchObject({ scope: { kind: 'project', directory: '/work/removed' } });
  });

  it('reads the list again before opening the editor and edits the block as the server has it now', async () => {
    const { api, store } = setup({ blocks: [{ ...NOTES, rev: 1 }] });
    await screen.findByText('notes');
    // An agent wrote to the block after the tab loaded it.
    store.blocks[0] = { ...store.blocks[0], rev: 3, content: 'agent wrote this', lastWriter: 'agent:worker' };
    const readsBefore = api.to('GET', '/api/agent-profiles/memory-blocks').length;

    await openEditor('notes');

    expect(api.to('GET', '/api/agent-profiles/memory-blocks')).toHaveLength(readsBefore + 1);
    expect((screen.getByLabelText('Content') as HTMLTextAreaElement).value).toBe('agent wrote this');
    type('Content', 'agent wrote this, plus mine');
    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).toBeNull());
    expect(api.to('PUT', '/api/agent-profiles/memory-blocks/b-notes')[0].body).toMatchObject({ expectedRev: 3 });
    expect(api.to('PUT', '/api/agent-profiles/memory-blocks/b-notes')).toHaveLength(1);
  });

  it('does not open the editor of a block deleted meanwhile, and does not open when the reload fails', async () => {
    const { api, store } = setup();
    await screen.findByText('notes');
    store.blocks.splice(0, store.blocks.length, RULES);
    fireEvent.click(screen.getByRole('button', { name: 'Edit notes' }));
    await waitFor(() => expect(screen.queryByText('notes')).toBeNull());
    expect(screen.queryByLabelText('Name')).toBeNull();
    expect(screen.getByRole('button', { name: 'New block' })).toBeTruthy();

    api.set('GET /api/agent-profiles/memory-blocks', failure(500, 'BOOM', 'The store is unreadable'));
    fireEvent.click(screen.getByRole('button', { name: 'Edit house-rules' }));
    expect(await screen.findByText('The store is unreadable')).toBeTruthy();
    expect(screen.queryByLabelText('Name')).toBeNull();
  });

  it('a stale save keeps the draft in the form, names who changed the block, and refreshes only the revision', async () => {
    const { api, store } = setup({ blocks: [{ ...NOTES, rev: 1 }] });
    await screen.findByText('notes');
    await openEditor('notes');
    // The block changes after the editor opened (an agent in a running chat, or another window).
    store.blocks[0] = { ...store.blocks[0], rev: 2, content: 'changed elsewhere', lastWriter: 'agent:orchestrator' };
    type('Description', 'my description');
    type('Content', 'my draft');
    fireEvent.click(saveButton());

    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toContain('changed after you opened it');
    expect(notice.textContent).toContain('last writer: agent orchestrator');
    expect(notice.textContent).toContain('Your edits are still in the form');
    // Nothing closed, nothing lost, and nothing was overwritten on the server.
    expect((screen.getByLabelText('Content') as HTMLTextAreaElement).value).toBe('my draft');
    expect((screen.getByLabelText('Description') as HTMLInputElement).value).toBe('my description');
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(within(notice).queryByRole('button')).toBeNull();
    expect(store.blocks[0].content).toBe('changed elsewhere');
    expect(api.to('PUT', '/api/agent-profiles/memory-blocks/b-notes')[0].body).toMatchObject({ expectedRev: 1, content: 'my draft' });

    // Saving again goes out on the refreshed revision and now succeeds with the user's draft.
    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).toBeNull());
    const puts = api.to('PUT', '/api/agent-profiles/memory-blocks/b-notes');
    expect(puts).toHaveLength(2);
    expect(puts[1].body).toMatchObject({ expectedRev: 2, content: 'my draft', description: 'my description' });
    expect(store.blocks[0]).toMatchObject({ content: 'my draft', description: 'my description', rev: 3, lastWriter: 'user' });
  });

  it('a stale save whose refresh cannot read the list still keeps the draft and says the block changed', async () => {
    const { api, store } = setup({ blocks: [{ ...NOTES, rev: 1 }] });
    await screen.findByText('notes');
    await openEditor('notes');
    store.blocks[0] = { ...store.blocks[0], rev: 2 };
    api.set('GET /api/agent-profiles/memory-blocks', failure(500, 'BOOM', 'unreadable'));
    type('Content', 'my draft');
    fireEvent.click(saveButton());

    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toContain('changed after you opened it');
    expect(notice.textContent).not.toContain('last writer');
    expect((screen.getByLabelText('Content') as HTMLTextAreaElement).value).toBe('my draft');
    // The 409 itself carries the current revision, so a re-save is still based on it.
    fireEvent.click(saveButton());
    await waitFor(() => expect(api.to('PUT', '/api/agent-profiles/memory-blocks/b-notes')).toHaveLength(2));
    expect(api.to('PUT', '/api/agent-profiles/memory-blocks/b-notes')[1].body).toMatchObject({ expectedRev: 2 });
  });

  it('Cancel after a stale save discards the draft and returns to the list', async () => {
    const { store } = setup({ blocks: [{ ...NOTES, rev: 1 }] });
    await screen.findByText('notes');
    await openEditor('notes');
    store.blocks[0] = { ...store.blocks[0], rev: 2, content: 'changed elsewhere' };
    type('Content', 'my draft');
    fireEvent.click(saveButton());
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'New block' })).toBeTruthy();
    expect(store.blocks[0].content).toBe('changed elsewhere');
  });
});

describe('deleting a block', () => {
  it('asks first, deletes through the server and refreshes the list', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { api } = setup();
    await screen.findByText('notes');

    fireEvent.click(screen.getByRole('button', { name: 'Delete notes' }));
    expect(api.to('DELETE', '/api/agent-profiles/memory-blocks/b-notes')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Delete notes' }));
    await waitFor(() => expect(screen.queryByText('notes')).toBeNull());
    expect(api.to('DELETE', '/api/agent-profiles/memory-blocks/b-notes')).toHaveLength(1);
    expect(String(confirm.mock.calls[0][0])).toContain('Delete memory block "notes"?');
    expect(screen.getByText('house-rules')).toBeTruthy();
  });

  it('keeps the list and says why when the server refuses the delete', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { api } = setup();
    await screen.findByText('notes');
    api.set('DELETE /api/agent-profiles/memory-blocks/:id', failure(500, 'BOOM', 'The store is unreadable'));

    fireEvent.click(screen.getByRole('button', { name: 'Delete notes' }));

    expect((await screen.findByRole('alert')).textContent).toContain('The store is unreadable');
    expect(screen.getByText('notes')).toBeTruthy();
  });
});

describe('read-only is not a hard lock notice', () => {
  const lockNotice = (row: HTMLElement) => within(row).queryByText(/not a hard lock/);

  it('shows on a read-only block when a listed agent has Bash or no tool limit, naming them and the list it is based on', async () => {
    setup({ agents: [PERSONAL_BASH, PERSONAL_UNRESTRICTED, PERSONAL_SAFE] });
    await screen.findByText('house-rules');

    const notice = lockNotice(rowOf('house-rules'));
    expect(notice?.textContent).toContain('2 agents in the list (shell-helper, free-agent)');
    expect(notice?.textContent).toContain('target: Alpha');
    expect(notice?.textContent).toContain('not checked per block scope');
  });

  it('never shows on a writable block', async () => {
    setup({ agents: [PERSONAL_BASH] });
    await screen.findByText('notes');

    expect(lockNotice(rowOf('notes'))).toBeNull();
  });

  it('stays away when every listed agent is restricted without Bash, or is built-in (tools unknown), hidden or unreadable', async () => {
    setup({ agents: [PERSONAL_SAFE, makeClaudeAgent({ name: 'Explore' }), makeClaudeAgent({ source: 'user', name: 'quiet', hidden: true }), makeClaudeAgent({ source: 'user', name: 'broken', error: 'bad front matter' })] });
    await screen.findByText('house-rules');

    expect(lockNotice(rowOf('house-rules'))).toBeNull();
  });

  it('is not shown while the agent list is still loading', async () => {
    setup({ agents: [PERSONAL_BASH], agentsReady: false });
    await screen.findByText('house-rules');

    expect(lockNotice(rowOf('house-rules'))).toBeNull();
  });

  it('uses the singular for one agent and treats a Bash permission pattern as Bash', async () => {
    setup({ agents: [makeClaudeAgent({ source: 'user', name: 'git-only', tools: ['Read', 'Bash(git:*)'] })] });
    await screen.findByText('house-rules');

    expect(lockNotice(rowOf('house-rules'))?.textContent).toContain('1 agent in the list (git-only) has Bash or no tool limit');
  });
});

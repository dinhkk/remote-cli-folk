import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import { MemoryBlockContents } from '@/modules/agent-profiles/memory/MemoryBlockContents';
import {
  SIDEBAR_ALPHA,
  SIDEBAR_CRM,
  failure,
  installFakeProfilesApi,
  makeMemoryBlock,
  makeProjectContent,
  memoryBlockRoutes,
} from '@/modules/agent-profiles/tests/fake-profiles-api';
import type { MemoryBlockProjectContent } from '@/shared/types';

/**
 * Folder list of a project block against a fake server that behaves like the real one: add (empty file), edit with the content
 * rev, empty (file stays, rev moves), remove (file gone, a later add continues the rev), stale and cap refusals, unreadable files.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BLOCK = makeMemoryBlock({ id: 'b-crm', name: 'crm-facts', scope: { kind: 'project' }, maxChars: 20 });
const ALPHA_FILE = makeProjectContent({ directory: SIDEBAR_ALPHA.directory, content: 'alpha text', rev: 3, lastWriter: 'agent:worker', updatedAt: '2026-11-24T08:30:00.000Z' });
const GONE_FILE = makeProjectContent({ directory: '/work/removed', content: 'orphan' });

const setup = (files: MemoryBlockProjectContent[] = []) => {
  const store = memoryBlockRoutes([BLOCK], { [BLOCK.id]: files });
  const api = installFakeProfilesApi(store.routes);
  render(<MemoryBlockContents block={BLOCK} projects={[SIDEBAR_ALPHA, SIDEBAR_CRM]} />);
  return { api, store };
};

const CONTENTS = '/api/agent-profiles/memory-blocks/b-crm/contents';
/** Route key of the fake server: `api.set` must use the same pattern to replace a handler. */
const ROUTE = '/api/agent-profiles/memory-blocks/:id/contents';
const stored = (store: ReturnType<typeof setup>['store']) => store.contents[BLOCK.id];
const addFolder = async (project: { projectId: string }) => {
  fireEvent.change(await screen.findByLabelText('Project to add'), { target: { value: project.projectId } });
  fireEvent.click(screen.getByRole('button', { name: 'Add folder' }));
};

describe('folder list', () => {
  it('says the block is visible only in the listed folders, and shows an empty state', async () => {
    setup();

    expect(await screen.findByText(/No folder has content yet/)).toBeTruthy();
    expect(screen.getByText(/Agents see this block only in the folders listed here/)).toBeTruthy();
  });

  it('lists each folder with its project name, size against the limit, last writer and time; orphan folders stay listed', async () => {
    setup([ALPHA_FILE, GONE_FILE]);

    const alpha = (await screen.findByText('Alpha', { selector: 'span' })).closest('li') as HTMLElement;
    expect(alpha.textContent).toContain('/work/alpha');
    expect(alpha.textContent).toContain('10 / 20 chars');
    expect(alpha.textContent).toContain('agent worker');
    expect(alpha.textContent).toContain(new Date('2026-11-24T08:30:00.000Z').toLocaleString());
    expect(screen.getByText('/work/removed')).toBeTruthy();
  });

  it('shows a failed read with a retry', async () => {
    const { api } = setup();
    await screen.findByText(/No folder has content yet/);
    api.set(`GET ${ROUTE}`, failure(500, 'BOOM', 'The store is unreadable'));
    // The list is read again after every change, so a change is how the failing read shows.
    await addFolder(SIDEBAR_ALPHA);
    expect(await screen.findByText('The store is unreadable')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('reports unreadable content files without hiding the folders that are fine', async () => {
    const { api } = setup([ALPHA_FILE]);
    await screen.findByText('Alpha', { selector: 'span' });
    api.set(`GET ${ROUTE}`, { body: { contents: [ALPHA_FILE], corrupt: [{ id: 'b-crm', error: 'bad json' }] } });
    await addFolder(SIDEBAR_CRM);

    expect((await screen.findAllByRole('alert'))[0].textContent).toContain('1 content file could not be read');
    expect(screen.getByText('Alpha', { selector: 'span' })).toBeTruthy();
  });
});

describe('adding a folder', () => {
  it('offers only sidebar projects that are not listed yet and posts the picked project folder', async () => {
    const { api, store } = setup([ALPHA_FILE]);
    await screen.findByText('Alpha', { selector: 'span' });

    const select = screen.getByLabelText('Project to add') as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual(['Pick a project…', 'CRM']);
    expect((screen.getByRole('button', { name: 'Add folder' }) as HTMLButtonElement).disabled).toBe(true);

    await addFolder(SIDEBAR_CRM);

    await screen.findByText('CRM', { selector: 'span' });
    expect(api.to('POST', CONTENTS)[0].body).toEqual({ directory: 'C:\\Work\\CRM' });
    expect(stored(store).map((file) => file.directory)).toEqual(['/work/alpha', 'C:\\Work\\CRM']);
    // The new file is empty: the block is visible there with no text.
    expect(within((screen.getByText('CRM', { selector: 'span' }).closest('li')) as HTMLElement).getByText(/0 \/ 20 chars/)).toBeTruthy();
  });

  it('adds two folders, each its own empty file', async () => {
    const { store } = setup();
    await screen.findByText(/No folder has content yet/);

    await addFolder(SIDEBAR_ALPHA);
    await screen.findByText('Alpha', { selector: 'span' });
    await addFolder(SIDEBAR_CRM);
    await screen.findByText('CRM', { selector: 'span' });

    expect(stored(store).map((file) => file.rev)).toEqual([1, 1]);
    expect((screen.getByLabelText('Project to add') as HTMLSelectElement).options).toHaveLength(1);
  });

  it('shows the cap refusal in words', async () => {
    const { api } = setup();
    await screen.findByText(/No folder has content yet/);
    api.set(`POST ${ROUTE}`, failure(409, 'BLOCK_CONTENT_LIMIT_REACHED', 'limit'));

    await addFolder(SIDEBAR_ALPHA);

    expect((await screen.findByRole('alert')).textContent).toContain('limit of 200 folders');
  });
});

describe('editing a folder', () => {
  it('sends the content rev it loaded and shows the saved text; the other folder is untouched', async () => {
    const other = makeProjectContent({ directory: SIDEBAR_CRM.directory, content: 'crm text', rev: 1 });
    const { api, store } = setup([ALPHA_FILE, other]);
    await screen.findByText('Alpha', { selector: 'span' });

    fireEvent.click(screen.getByRole('button', { name: 'Edit /work/alpha' }));
    const editor = screen.getByLabelText('Content of /work/alpha') as HTMLTextAreaElement;
    expect(editor.value).toBe('alpha text');
    fireEvent.change(editor, { target: { value: 'new alpha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByLabelText('Content of /work/alpha')).toBeNull());
    expect(api.to('PUT', CONTENTS)[0].body).toEqual({ directory: '/work/alpha', content: 'new alpha', expectedRev: 3 });
    expect(stored(store).find((file) => file.directory === '/work/alpha')).toMatchObject({ content: 'new alpha', rev: 4, lastWriter: 'user' });
    expect(stored(store).find((file) => file.directory === SIDEBAR_CRM.directory)?.content).toBe('crm text');
  });

  it('blocks Save over the size limit', async () => {
    setup([ALPHA_FILE]);
    await screen.findByText('Alpha', { selector: 'span' });

    fireEvent.click(screen.getByRole('button', { name: 'Edit /work/alpha' }));
    fireEvent.change(screen.getByLabelText('Content of /work/alpha'), { target: { value: 'x'.repeat(21) } });

    expect(screen.getByText('The content is longer than the limit of 20 characters.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a stale save is refused and offers to reload the latest version', async () => {
    const { store } = setup([ALPHA_FILE]);
    await screen.findByText('Alpha', { selector: 'span' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit /work/alpha' }));
    // An agent wrote to the folder after the editor opened.
    stored(store)[0] = { ...stored(store)[0], rev: 4, content: 'agent wrote' };
    fireEvent.change(screen.getByLabelText('Content of /work/alpha'), { target: { value: 'mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('changed somewhere else');
    expect(stored(store)[0].content).toBe('agent wrote');
    fireEvent.click(within(alert).getByRole('button', { name: 'Reload the latest version' }));
    await waitFor(() => expect(screen.queryByLabelText('Content of /work/alpha')).toBeNull());
    expect(await screen.findByText(/11 \/ 20 chars/)).toBeTruthy();
  });
});

describe('emptying and removing a folder', () => {
  it('empty asks first, keeps the file listed and moves its rev on', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { api, store } = setup([ALPHA_FILE]);
    await screen.findByText('Alpha', { selector: 'span' });

    fireEvent.click(screen.getByRole('button', { name: 'Empty /work/alpha' }));
    expect(api.to('DELETE', `${CONTENTS}?directory=%2Fwork%2Falpha&expectedRev=3`)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Empty /work/alpha' }));

    await waitFor(() => expect(screen.getByText(/0 \/ 20 chars/)).toBeTruthy());
    expect(api.to('DELETE', `${CONTENTS}?directory=%2Fwork%2Falpha&expectedRev=3`)).toHaveLength(1);
    expect(stored(store)[0]).toMatchObject({ content: '', rev: 4 });
    expect(String(confirm.mock.calls[0][0])).toContain('agents there keep the block');
  });

  it('remove asks first, deletes the file, and a later add of the same folder continues the rev', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { api, store } = setup([ALPHA_FILE]);
    await screen.findByText('Alpha', { selector: 'span' });

    fireEvent.click(screen.getByRole('button', { name: 'Remove folder /work/alpha' }));

    await waitFor(() => expect(screen.queryByText('Alpha', { selector: 'span' })).toBeNull());
    expect(api.to('DELETE', `${CONTENTS}?directory=%2Fwork%2Falpha&expectedRev=3&remove=true`)).toHaveLength(1);
    expect(stored(store)).toEqual([]);
    expect(String(confirm.mock.calls[0][0])).toContain('no longer see the block');

    await addFolder(SIDEBAR_ALPHA);
    await screen.findByText('Alpha', { selector: 'span' });
    expect(stored(store)[0].rev).toBe(4);
  });

  it('empty and remove carry the rev of the row; a folder an agent wrote to meanwhile is refused and keeps its text', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { api, store } = setup([ALPHA_FILE]);
    await screen.findByText('Alpha', { selector: 'span' });
    // An agent writes after the list was loaded.
    store.contents[BLOCK.id][0] = { ...ALPHA_FILE, content: 'newer agent text', rev: 4 };

    fireEvent.click(screen.getByRole('button', { name: 'Empty /work/alpha' }));
    await waitFor(() => expect(api.to('DELETE', `${CONTENTS}?directory=%2Fwork%2Falpha&expectedRev=3`)).toHaveLength(1));
    expect((await screen.findByRole('alert')).textContent).toContain('changed somewhere else');
    expect(stored(store)[0]).toMatchObject({ content: 'newer agent text', rev: 4 });

    // The list reloaded after the refusal, so the row now carries rev 4; a second agent write makes that stale too.
    await screen.findByText(/newer agent text|16 \/ 20 chars/);
    store.contents[BLOCK.id][0] = { ...ALPHA_FILE, content: 'newest', rev: 5 };
    fireEvent.click(screen.getByRole('button', { name: 'Remove folder /work/alpha' }));
    await waitFor(() => expect(api.to('DELETE', `${CONTENTS}?directory=%2Fwork%2Falpha&expectedRev=4&remove=true`)).toHaveLength(1));
    expect(stored(store)).toHaveLength(1);
  });

  it('Cancel on the confirmation sends nothing, and a refused remove keeps the folder with the reason', async () => {
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { api } = setup([ALPHA_FILE]);
    await screen.findByText('Alpha', { selector: 'span' });

    fireEvent.click(screen.getByRole('button', { name: 'Remove folder /work/alpha' }));
    expect(api.to('DELETE', `${CONTENTS}?directory=%2Fwork%2Falpha&expectedRev=3&remove=true`)).toHaveLength(0);

    api.set(`DELETE ${ROUTE}`, failure(500, 'BOOM', 'The store is unreadable'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove folder /work/alpha' }));
    expect((await screen.findByRole('alert')).textContent).toContain('The store is unreadable');
    expect(screen.getByText('Alpha', { selector: 'span' })).toBeTruthy();
  });
});

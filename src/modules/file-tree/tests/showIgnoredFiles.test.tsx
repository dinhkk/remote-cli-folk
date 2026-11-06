import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * "Show ignored files" in the Files tree: by default the server hides what .gitignore and its default folder
 * lists cover; ticking the box lists the project again with everything (version-control folders aside). The
 * choice is remembered in this browser and also applies to folders listed on demand.
 */

const ROOT = '/work/app';
const STORAGE_KEY = 'file-tree-show-ignored';

const visibleTree = [
  { type: 'directory', name: 'src', path: `${ROOT}/src`, children: [{ type: 'file', name: 'index.ts', path: `${ROOT}/src/index.ts` }] },
  { type: 'file', name: 'package.json', path: `${ROOT}/package.json` },
];
const fullTree = [
  { type: 'directory', name: 'dist', path: `${ROOT}/dist`, children: [{ type: 'file', name: 'bundle.js', path: `${ROOT}/dist/bundle.js` }] },
  ...visibleTree,
  { type: 'file', name: '.env', path: `${ROOT}/.env` },
];

const getFiles = vi.fn();
vi.mock('@/shared/api', () => ({
  api: { getFiles: (...args: unknown[]) => getFiles(...args) },
}));

const { default: FileTree } = await import('@/modules/file-tree/FileTree');
const project: Project = { projectId: 'p1', displayName: 'app', fullPath: ROOT, path: ROOT };

const answer = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const showIgnoredBox = () => screen.getByRole('checkbox', { name: 'Show ignored files' }) as HTMLInputElement;

/** The whole-project listing the server would give for each choice. */
const listsByChoice = () =>
  getFiles.mockImplementation(async (_projectId: string, _options: unknown, directoryPath?: string, includeIgnored?: boolean) =>
    directoryPath === undefined ? answer(includeIgnored ? fullTree : visibleTree) : answer([]));

beforeEach(() => {
  localStorage.clear();
  getFiles.mockReset();
});

test('the tree lists the project as before until "Show ignored files" is ticked', async () => {
  listsByChoice();
  render(<FileTree selectedProject={project} />);

  await waitFor(() => assert.ok(screen.getByText('package.json')));
  assert.equal(showIgnoredBox().checked, false);
  assert.equal(screen.queryByText('.env'), null);
  assert.equal(getFiles.mock.calls.length, 1);
  assert.equal(getFiles.mock.calls[0]?.[3], false, 'the default listing is what is asked for');
});

test('ticking it lists the project again with everything, and unticking goes back', async () => {
  listsByChoice();
  render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.ok(screen.getByText('package.json')));

  fireEvent.click(showIgnoredBox());

  await waitFor(() => assert.ok(screen.getByText('.env')));
  assert.ok(screen.getByText('dist'));
  assert.equal(showIgnoredBox().checked, true);
  assert.equal(getFiles.mock.calls.length, 2);
  assert.equal(getFiles.mock.calls[1]?.[3], true);
  assert.equal(localStorage.getItem(STORAGE_KEY), 'true');

  fireEvent.click(showIgnoredBox());

  await waitFor(() => assert.equal(screen.queryByText('.env'), null));
  assert.equal(screen.queryByText('dist'), null);
  assert.equal(getFiles.mock.calls[2]?.[3], false);
  assert.equal(localStorage.getItem(STORAGE_KEY), 'false');
});

test('the choice is remembered: a new tree starts with it on', async () => {
  localStorage.setItem(STORAGE_KEY, 'true');
  listsByChoice();
  render(<FileTree selectedProject={project} />);

  await waitFor(() => assert.ok(screen.getByText('.env')));
  assert.equal(getFiles.mock.calls[0]?.[3], true, 'the very first listing already asks for everything');
  assert.equal(showIgnoredBox().checked, true);
});

test('while it is on, a folder listed on demand is asked for with it too', async () => {
  localStorage.setItem(STORAGE_KEY, 'true');
  getFiles.mockImplementation(async (_projectId: string, _options: unknown, directoryPath?: string) =>
    directoryPath === undefined
      ? answer([{ type: 'directory', name: 'big', path: `${ROOT}/big`, partial: true, children: [] }])
      : answer([{ type: 'file', name: 'inner.txt', path: `${ROOT}/big/inner.txt` }]));
  render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.ok(screen.getByText('big')));

  fireEvent.click(screen.getByText('big'));

  await waitFor(() => assert.ok(screen.getByText('inner.txt')));
  assert.deepEqual(getFiles.mock.calls[1], ['p1', {}, `${ROOT}/big`, true]);
});

test('a folder answer that arrives after the choice changed is dropped instead of being put into the new tree', async () => {
  let releaseStale: () => void = () => undefined;
  getFiles.mockImplementation(async (_projectId: string, _options: unknown, directoryPath?: string, includeIgnored?: boolean) => {
    if (directoryPath === undefined) {
      return answer([{ type: 'directory', name: 'big', path: `${ROOT}/big`, partial: true, children: [] }]);
    }
    if (includeIgnored) return answer([{ type: 'file', name: 'fresh.txt', path: `${ROOT}/big/fresh.txt` }]);
    // The answer for the old choice, held back until the test lets it through.
    await new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    return answer([{ type: 'file', name: 'stale.txt', path: `${ROOT}/big/stale.txt` }]);
  });
  render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.ok(screen.getByText('big')));
  fireEvent.click(screen.getByText('big'));
  await waitFor(() => assert.equal(getFiles.mock.calls.length, 2), { timeout: 2000 });

  fireEvent.click(showIgnoredBox());
  await waitFor(() => assert.ok(screen.getByText('fresh.txt')));

  releaseStale();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(screen.queryByText('stale.txt'), null, 'the old listing never overwrites the new one');
  assert.ok(screen.getByText('fresh.txt'));
});

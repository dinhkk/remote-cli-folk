import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * A big project: the server lists what fits in its entry budget and flags the folders it had to leave out
 * (`partial`). Opening such a folder fetches just that folder and shows its contents in place.
 */

const ROOT = '/work/big-project';

const rootTree = [
  { type: 'directory', name: 'src', path: `${ROOT}/src`, children: [{ type: 'file', name: 'index.ts', path: `${ROOT}/src/index.ts` }] },
  { type: 'directory', name: 'generated', path: `${ROOT}/generated`, partial: true, children: [] },
];

const getFiles = vi.fn();
vi.mock('@/shared/api', () => ({
  api: { getFiles: (...args: unknown[]) => getFiles(...args) },
}));

const { default: FileTree } = await import('@/modules/file-tree/FileTree');
const project: Project = { projectId: 'p1', displayName: 'big', fullPath: ROOT, path: ROOT };

const answer = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
  getFiles.mockReset();
});

test('opening a folder the server left out lists it, and only it', async () => {
  getFiles.mockImplementation(async (_projectId: string, _options: unknown, directoryPath?: string) =>
    directoryPath === undefined
      ? answer(rootTree)
      : answer([{ type: 'file', name: 'schema.generated.ts', path: `${ROOT}/generated/schema.generated.ts` }]));
  render(<FileTree selectedProject={project} />);

  await waitFor(() => assert.ok(screen.getByText('generated')));
  assert.equal(getFiles.mock.calls.length, 1, 'nothing but the project tree was asked for');
  assert.ok(screen.getByRole('note'), 'the user is told some folders are listed on demand');

  fireEvent.click(screen.getByText('generated'));

  await waitFor(() => assert.ok(screen.getByText('schema.generated.ts')));
  assert.equal(getFiles.mock.calls.length, 2);
  assert.deepEqual(getFiles.mock.calls[1], ['p1', {}, `${ROOT}/generated`, false]);
  assert.equal(screen.queryByText('Loading…'), null);
  assert.equal(screen.queryByRole('note'), null, 'nothing is left unlisted, so the notice goes away');
});

test('a folder that is already complete is never fetched again when opened', async () => {
  getFiles.mockResolvedValue(answer(rootTree));
  render(<FileTree selectedProject={project} />);

  await waitFor(() => assert.ok(screen.getByText('src')));
  fireEvent.click(screen.getByText('src'));

  await waitFor(() => assert.ok(screen.getByText('index.ts')));
  assert.equal(getFiles.mock.calls.length, 1);
});

test('a folder that cannot be listed says so, and opening it again retries', async () => {
  let attempts = 0;
  getFiles.mockImplementation(async (_projectId: string, _options: unknown, directoryPath?: string) => {
    if (directoryPath === undefined) return answer(rootTree);
    attempts += 1;
    return attempts === 1
      ? { ok: false, status: 500, json: async () => ({}) }
      : answer([{ type: 'file', name: 'recovered.txt', path: `${ROOT}/generated/recovered.txt` }]);
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  render(<FileTree selectedProject={project} />);

  await waitFor(() => assert.ok(screen.getByText('generated')));
  fireEvent.click(screen.getByText('generated'));
  await waitFor(() => assert.ok(screen.getByText(/could not be listed/)));

  // Close, then open again: the second answer succeeds.
  fireEvent.click(screen.getByText('generated'));
  fireEvent.click(screen.getByText('generated'));

  await waitFor(() => assert.ok(screen.getByText('recovered.txt')));
  assert.equal(attempts, 2);
});

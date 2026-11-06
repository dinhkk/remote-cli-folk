// File and git work through Remote does what the same call does Local: read, write, create, rename, delete,
// status, diff, stage, commit, in a throw-away repository on the Host. Escapes out of the project are refused by
// the Host exactly as they are for Local (403 there; through Remote the Controller reports a Host 401/403 as
// 502 REMOTE_UPSTREAM_AUTH so a Host answer can never log the Controller's user out).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createHostProject, hostGit, type HostProject } from './support/e2e-host-project.js';
import { startWorld, type RemoteWorld } from './support/e2e-world.js';

type Json = Record<string, any>;

describe('file and git parity between Remote and Local', () => {
  let world: RemoteWorld;
  let project: HostProject;
  let token = '';

  const remote = (pathAndQuery: string, method = 'GET', body?: unknown) => world.viaRemote(pathAndQuery, { method, body, token });
  const local = (pathAndQuery: string, method = 'GET', body?: unknown) => world.host.api(pathAndQuery, { method, body });
  const tree = (suffix: string): string => `/api/file-tree/projects/${project.id}${suffix}`;

  before(async () => {
    world = await startWorld();
    token = await world.tabToken();
    project = await createHostProject(world.host, 'parity', { repo: true });
  });
  after(async () => {
    await world?.stop();
  });

  it('reads a file: same status and body Remote and Local', async () => {
    const viaRemote = await remote(tree('/file?filePath=README.md'));
    const viaLocal = await local(tree('/file?filePath=README.md'));
    assert.equal(viaRemote.status, 200, viaRemote.text);
    assert.equal(viaRemote.status, viaLocal.status);
    assert.equal(viaRemote.text, viaLocal.text);
    assert.equal(viaRemote.json<Json>().content, '# e2e project\n');
    assert.equal((await remote(tree('/files'))).text, (await local(tree('/files'))).text);
  });

  it('writes, creates, renames and deletes inside the project', async () => {
    const saved = await remote(tree('/file'), 'PUT', { filePath: 'notes.txt', content: 'line one\n' });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(readFileSync(path.join(project.dir, 'notes.txt'), 'utf8'), 'line one\n');

    const folder = await remote(tree('/files/create'), 'POST', { name: 'docs', type: 'directory', path: '' });
    assert.equal(folder.status, 200, folder.text);
    assert.equal(existsSync(path.join(project.dir, 'docs')), true);
    const file = await remote(tree('/files/create'), 'POST', { name: 'guide.md', type: 'file', path: 'docs' });
    assert.equal(file.status, 200, file.text);

    const renamed = await remote(tree('/files/rename'), 'PUT', { oldPath: 'docs/guide.md', newName: 'manual.md' });
    assert.equal(renamed.status, 200, renamed.text);
    assert.equal(existsSync(path.join(project.dir, 'docs', 'manual.md')), true);

    const removed = await remote(tree('/files'), 'DELETE', { path: 'docs/manual.md' });
    assert.equal(removed.status, 200, removed.text);
    assert.equal(existsSync(path.join(project.dir, 'docs', 'manual.md')), false);
  });

  it('git: status, diff, stage and commit change the real repository, and Local sees the same state', async () => {
    const status = await remote(`/api/git/status?project=${project.id}`);
    assert.equal(status.status, 200, status.text);
    assert.ok(status.json<Json>().untracked.includes('notes.txt'), status.text);
    assert.equal(status.text, (await local(`/api/git/status?project=${project.id}`)).text);

    const diff = await remote(`/api/git/diff?project=${project.id}&file=notes.txt`);
    assert.equal(diff.status, 200, diff.text);
    assert.ok(diff.json<Json>().diff.includes('+line one'), diff.text);

    const staged = await remote('/api/git/stage', 'POST', { project: project.id, files: ['notes.txt'] });
    assert.equal(staged.status, 200, staged.text);
    assert.match(hostGit(project.dir, 'status', '--porcelain'), /^A {2}notes\.txt/m);

    const committed = await remote('/api/git/commit', 'POST', { project: project.id, message: 'e2e: add notes', files: ['notes.txt'] });
    assert.equal(committed.status, 200, committed.text);
    assert.match(hostGit(project.dir, 'log', '-1', '--format=%s'), /e2e: add notes/);

    const clean = await remote(`/api/git/status?project=${project.id}`);
    assert.ok(!clean.json<Json>().untracked.includes('notes.txt'));
    const commits = await remote(`/api/git/commits?project=${project.id}&limit=5`);
    assert.equal(commits.status, 200, commits.text);
    assert.ok(commits.text.includes('e2e: add notes'));
  });

  it('a path that leaves the project is refused by the Host as for Local; nothing is written outside', async () => {
    const outside = path.join(path.dirname(project.dir), 'escaped.txt');
    const viaLocal = await local(tree('/file'), 'PUT', { filePath: '../escaped.txt', content: 'x' });
    assert.equal(viaLocal.status, 403, viaLocal.text);
    const viaRemote = await remote(tree('/file'), 'PUT', { filePath: '../escaped.txt', content: 'x' });
    assert.equal(viaRemote.status, 502, viaRemote.text);
    assert.equal(viaRemote.json<{ error: { code: string } }>().error.code, 'REMOTE_UPSTREAM_AUTH');
    assert.equal(existsSync(outside), false);

    const absolute = await remote(tree('/file'), 'PUT', { filePath: path.join(path.dirname(project.dir), 'escaped2.txt'), content: 'x' });
    assert.equal(absolute.status, 502, absolute.text);
    assert.equal(existsSync(path.join(path.dirname(project.dir), 'escaped2.txt')), false);
    // The same Host refuses to read outside as well.
    const read = await remote(tree('/files/content?path=..%2F..%2Fsecret.txt'));
    assert.ok([400, 403, 404, 502].includes(read.status), `${read.status} ${read.text}`);
  });
});

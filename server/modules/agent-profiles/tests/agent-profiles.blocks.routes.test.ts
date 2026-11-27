import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { AppError } from '@/shared/utils.js';

import { createAgentProfilesRouter } from '../agent-profiles.routes.js';

import { makeServiceRig } from './service-rig.js';

type Call = (method: string, url: string, body?: unknown) => Promise<{ status: number; body: any }>;

/** Router on an ephemeral port with the same error middleware the server uses. */
async function withApi(run: (call: Call, rig: ReturnType<typeof makeServiceRig>) => Promise<void>) {
  const rig = makeServiceRig();
  const app = express();
  app.use(express.json());
  app.use('/api/agent-profiles', createAgentProfilesRouter(rig.service, rig.claudeAgents, rig.blocks, rig.bundle, rig.pending));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const call: Call = async (method, url, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/agent-profiles${url}`, {
      method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  try { await run(call, rig); } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rig.cleanup();
  }
}

const ALPHA = path.resolve(path.sep, 'work', 'alpha');
const blockBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'style-guide', description: 'House style', mode: 'read-only', scope: { kind: 'global' }, content: 'Be brief.', maxChars: 2000, ...overrides,
});

test('memory-blocks CRUD over HTTP: exact response shapes and status codes', async () => {
  await withApi(async (call, rig) => {
    assert.deepEqual((await call('GET', '/memory-blocks')), { status: 200, body: { blocks: [] } });

    const created = await call('POST', '/memory-blocks', blockBody());
    assert.equal(created.status, 201);
    assert.deepEqual(Object.keys(created.body), ['block']);
    const { block } = created.body;
    assert.deepEqual(Object.keys(block).sort(), [
      'content', 'description', 'id', 'lastWriter', 'maxChars', 'mode', 'name', 'rev', 'scope', 'updatedAt',
    ]);
    assert.equal(block.rev, 1);
    assert.equal(block.lastWriter, 'user');
    assert.deepEqual(block.scope, { kind: 'global' });
    assert.ok(fs.existsSync(path.join(rig.root, 'agent-profiles', 'memory-blocks', `${block.id}.json`)));

    const listed = await call('GET', '/memory-blocks');
    assert.deepEqual(listed.body, { blocks: [block] });

    const updated = await call('PUT', `/memory-blocks/${block.id}`, { ...blockBody({ content: 'Be very brief.', mode: 'writable' }), expectedRev: 1 });
    assert.equal(updated.status, 200);
    assert.deepEqual(Object.keys(updated.body), ['block']);
    assert.equal(updated.body.block.rev, 2);
    assert.equal(updated.body.block.mode, 'writable');

    assert.deepEqual(await call('DELETE', `/memory-blocks/${block.id}`), { status: 200, body: { ok: true } });
    assert.deepEqual((await call('GET', '/memory-blocks')).body, { blocks: [] });
  });
});

test('memory-blocks: a project scope is one definition without a folder, defaults apply, bad bodies (also a scope.directory) are 400 with a code', async () => {
  await withApi(async (call) => {
    const project = await call('POST', '/memory-blocks', { name: 'alpha-notes', description: '', mode: 'writable', scope: { kind: 'project' }, content: '' });
    assert.equal(project.status, 201);
    assert.equal(project.body.block.maxChars, 2000, 'default limit');
    assert.equal(project.body.block.scope.kind, 'project');
    assert.deepEqual(project.body.block.scope, { kind: 'project' });
    assert.equal(project.body.block.content, '');

    for (const overrides of [{ name: 'Bad Name' }, { mode: 'nope' }, { scope: { kind: 'project', directory: 'relative' } }, { scope: { kind: 'project', directory: ALPHA } }, { maxChars: 20001 }, { content: 'x'.repeat(2001) }]) {
      const bad = await call('POST', '/memory-blocks', blockBody(overrides));
      assert.equal(bad.status, 400, JSON.stringify(overrides));
      assert.equal(bad.body.error.code, 'INVALID_PROFILE_INPUT');
    }
    assert.equal((await call('GET', '/memory-blocks')).body.blocks.length, 1, 'refused bodies stored nothing');
  });
});

test('memory-blocks: duplicate name 409, stale expectedRev 409 PROFILE_STALE, unknown id 404, traversal id 400', async () => {
  await withApi(async (call, rig) => {
    const { block } = (await call('POST', '/memory-blocks', blockBody())).body;
    const duplicate = await call('POST', '/memory-blocks', blockBody());
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'BLOCK_NAME_TAKEN');
    const otherScope = await call('POST', '/memory-blocks', blockBody({ scope: { kind: 'project' } }));
    assert.equal(otherScope.status, 409, 'names are unique across all scopes');
    assert.equal(otherScope.body.error.code, 'BLOCK_NAME_TAKEN');
    const project = (await call('POST', '/memory-blocks', blockBody({ name: 'alpha-notes', scope: { kind: 'project' } }))).body.block;
    const rename = await call('PUT', `/memory-blocks/${project.id}`, { ...blockBody({ name: 'style-guide', scope: { kind: 'project' } }), expectedRev: 1 });
    assert.equal(rename.status, 409, 'a rename into a name of another scope');
    assert.equal(rename.body.error.code, 'BLOCK_NAME_TAKEN');
    assert.equal((await call('PUT', `/memory-blocks/${project.id}`, { ...blockBody({ name: 'alpha-notes', scope: { kind: 'project' }, content: 'kept name' }), expectedRev: 1 })).status, 200, 'a PUT that keeps its own name does not collide with itself');

    assert.equal((await call('PUT', `/memory-blocks/${block.id}`, { ...blockBody({ content: 'v2' }), expectedRev: 1 })).status, 200);
    const stale = await call('PUT', `/memory-blocks/${block.id}`, { ...blockBody({ content: 'older' }), expectedRev: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'PROFILE_STALE');
    assert.equal(stale.body.error.details.currentRev, 2);
    assert.equal((await call('GET', '/memory-blocks')).body.blocks.find((item: { id: string }) => item.id === block.id).content, 'v2');

    assert.equal((await call('PUT', `/memory-blocks/${block.id}`, blockBody())).status, 400, 'expectedRev is required');
    assert.equal((await call('PUT', '/memory-blocks/no-such-id', { ...blockBody(), expectedRev: 1 })).status, 404);
    assert.equal((await call('DELETE', '/memory-blocks/no-such-id')).status, 404);

    fs.writeFileSync(path.join(rig.root, 'outside.json'), '{"id":"x"}');
    for (const id of ['..%2Foutside', '%2e%2e%2f%2e%2e%2foutside', '..%5Coutside']) {
      assert.equal((await call('DELETE', `/memory-blocks/${id}`)).status, 400, `DELETE ${id}`);
      assert.equal((await call('PUT', `/memory-blocks/${id}`, { ...blockBody(), expectedRev: 1 })).status, 400, `PUT ${id}`);
    }
    assert.ok(fs.existsSync(path.join(rig.root, 'outside.json')));
  });
});

test('memory-blocks: the 51st block is refused with 409 BLOCK_LIMIT_REACHED', async () => {
  await withApi(async (call, rig) => {
    for (let index = 0; index < 50; index += 1) rig.blocks.create(blockBody({ name: `block-${index}` }));
    const refused = await call('POST', '/memory-blocks', blockBody({ name: 'one-too-many' }));
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'BLOCK_LIMIT_REACHED');
  });
});

test('memory-blocks: a corrupt file does not break the listing and is not overwritten', async () => {
  await withApi(async (call, rig) => {
    const good = (await call('POST', '/memory-blocks', blockBody({ name: 'good' }))).body.block;
    const bad = (await call('POST', '/memory-blocks', blockBody({ name: 'bad' }))).body.block;
    const badFile = path.join(rig.root, 'agent-profiles', 'memory-blocks', `${bad.id}.json`);
    fs.writeFileSync(badFile, '{ broken');
    const listing = await call('GET', '/memory-blocks');
    assert.equal(listing.status, 200);
    assert.deepEqual(listing.body.blocks.map((item: { id: string }) => item.id), [good.id]);
    assert.equal((await call('PUT', `/memory-blocks/${bad.id}`, { ...blockBody({ name: 'bad' }), expectedRev: 1 })).status, 500);
    assert.equal(fs.readFileSync(badFile, 'utf8'), '{ broken');
  });
});

/** A project block over HTTP; returns its id. */
async function createProjectBlock(call: Call, name = 'alpha-notes'): Promise<string> {
  const created = await call('POST', '/memory-blocks', blockBody({ name, scope: { kind: 'project' }, mode: 'writable', content: '' }));
  assert.equal(created.status, 201);
  return created.body.block.id;
}

const contentsUrl = (id: string, directory?: string, extra = '') =>
  `/memory-blocks/${id}/contents${directory === undefined ? '' : `?directory=${encodeURIComponent(directory)}`}${extra}`;

test('memory-block contents: add, list, edit and empty a folder over HTTP with exact shapes', async () => {
  await withApi(async (call, rig) => {
    const id = await createProjectBlock(call);
    assert.deepEqual((await call('GET', contentsUrl(id))), { status: 200, body: { contents: [], corrupt: [] } });

    const added = await call('POST', contentsUrl(id), { directory: ALPHA });
    assert.equal(added.status, 201);
    assert.deepEqual(Object.keys(added.body), ['content']);
    assert.deepEqual(Object.keys(added.body.content).sort(), ['content', 'directory', 'lastWriter', 'rev', 'updatedAt']);
    assert.equal(added.body.content.rev, 1);
    assert.equal(added.body.content.content, '');
    assert.equal(added.body.content.directory, ALPHA);
    assert.equal(fs.readdirSync(path.join(rig.root, 'agent-profiles', 'memory-block-contents', id)).length, 1);

    const edited = await call('PUT', contentsUrl(id), { directory: ALPHA, content: 'Alpha text', expectedRev: 1 });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.content.rev, 2);
    assert.equal(edited.body.content.lastWriter, 'user');

    const listed = await call('GET', contentsUrl(id));
    assert.deepEqual(listed.body.contents.map((item: { directory: string; content: string }) => [item.directory, item.content]), [[ALPHA, 'Alpha text']]);

    const emptied = await call('DELETE', contentsUrl(id, ALPHA));
    assert.equal(emptied.status, 200);
    assert.equal(emptied.body.content.content, '');
    assert.equal(emptied.body.content.rev, 3, 'the file stays and its rev moves on');
    assert.equal((await call('GET', contentsUrl(id))).body.contents.length, 1);
  });
});

test('memory-block contents: the directory is normalized, so a differently written path is the same folder', async () => {
  await withApi(async (call) => {
    const id = await createProjectBlock(call);
    assert.equal((await call('POST', contentsUrl(id), { directory: ALPHA })).status, 201);
    const messy = `${ALPHA}${path.sep}sub${path.sep}..${path.sep}`;
    const again = await call('POST', contentsUrl(id), { directory: messy });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'BLOCK_CONTENT_EXISTS');
    assert.equal((await call('PUT', contentsUrl(id), { directory: messy, content: 'via messy path', expectedRev: 1 })).status, 200);
    assert.equal((await call('GET', contentsUrl(id))).body.contents.length, 1);
  });
});

test('memory-block contents: creating a folder twice is 409, a stale expectedRev is 409 PROFILE_STALE and writes nothing', async () => {
  await withApi(async (call) => {
    const id = await createProjectBlock(call);
    await call('POST', contentsUrl(id), { directory: ALPHA });
    const twice = await call('POST', contentsUrl(id), { directory: ALPHA });
    assert.equal(twice.status, 409);
    assert.equal(twice.body.error.code, 'BLOCK_CONTENT_EXISTS');

    assert.equal((await call('PUT', contentsUrl(id), { directory: ALPHA, content: 'v2', expectedRev: 1 })).status, 200);
    const stale = await call('PUT', contentsUrl(id), { directory: ALPHA, content: 'older', expectedRev: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'PROFILE_STALE');
    assert.equal(stale.body.error.details.currentRev, 2);
    assert.equal((await call('GET', contentsUrl(id))).body.contents[0].content, 'v2');
  });
});

test('memory-block contents: the definition rev and the content rev are separate counters', async () => {
  await withApi(async (call) => {
    const id = await createProjectBlock(call);
    await call('POST', contentsUrl(id), { directory: ALPHA });
    await call('PUT', contentsUrl(id), { directory: ALPHA, content: 'text', expectedRev: 1 });
    const definition = { ...blockBody({ name: 'alpha-notes', scope: { kind: 'project' }, mode: 'writable', content: '' }) };
    // Content rev is 2 here; the definition is still at rev 1 and is edited with that one.
    const updated = await call('PUT', `/memory-blocks/${id}`, { ...definition, description: 'new', expectedRev: 1 });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.block.rev, 2);
    assert.equal((await call('GET', contentsUrl(id))).body.contents[0].rev, 2, 'editing the definition leaves the content rev alone');
    const staleDefinition = await call('PUT', `/memory-blocks/${id}`, { ...definition, expectedRev: 1 });
    assert.equal(staleDefinition.status, 409);
    const sendingScopeDirectory = await call('PUT', `/memory-blocks/${id}`, { ...definition, scope: { kind: 'project', directory: ALPHA }, expectedRev: 2 });
    assert.equal(sendingScopeDirectory.status, 400);
  });
});

test('memory-block contents: DELETE on a missing folder is 404 for both the empty and the remove form', async () => {
  await withApi(async (call) => {
    const id = await createProjectBlock(call);
    for (const extra of ['', '&remove=true']) {
      const missing = await call('DELETE', contentsUrl(id, ALPHA, extra));
      assert.equal(missing.status, 404, `remove=${extra}`);
      assert.equal(missing.body.error.code, 'PROFILE_NOT_FOUND');
    }
    assert.equal((await call('PUT', contentsUrl(id), { directory: ALPHA, content: 'x', expectedRev: 1 })).status, 404);
  });
});

test('memory-block contents: remove=true deletes the file, and a later create continues above the old rev', async () => {
  await withApi(async (call, rig) => {
    const id = await createProjectBlock(call);
    await call('POST', contentsUrl(id), { directory: ALPHA });
    await call('PUT', contentsUrl(id), { directory: ALPHA, content: 'text', expectedRev: 1 });
    await call('DELETE', contentsUrl(id, ALPHA));
    const removed = await call('DELETE', contentsUrl(id, ALPHA, '&remove=true'));
    assert.deepEqual(removed, { status: 200, body: { ok: true } });
    assert.equal((await call('GET', contentsUrl(id))).body.contents.length, 0);
    const files = fs.readdirSync(path.join(rig.root, 'agent-profiles', 'memory-block-contents', id));
    assert.deepEqual(files.map((file) => path.extname(file)), ['.tomb']);
    const recreated = await call('POST', contentsUrl(id), { directory: ALPHA });
    assert.equal(recreated.body.content.rev, 4, 'above the last rev (3), so an old editor tab cannot overwrite it');
    const staleOldTab = await call('PUT', contentsUrl(id), { directory: ALPHA, content: 'old tab', expectedRev: 3 });
    assert.equal(staleOldTab.status, 409);
  });
});

test('memory-block contents: the 201st folder is refused with 409 BLOCK_CONTENT_LIMIT_REACHED', async () => {
  await withApi(async (call, rig) => {
    const id = await createProjectBlock(call);
    for (let index = 0; index < 200; index += 1) rig.blocks.addContent(id, path.resolve(path.sep, 'work', `folder-${index}`));
    const refused = await call('POST', contentsUrl(id), { directory: ALPHA });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'BLOCK_CONTENT_LIMIT_REACHED');
    assert.equal((await call('DELETE', contentsUrl(id, path.resolve(path.sep, 'work', 'folder-0'), '&remove=true'))).status, 200);
    assert.equal((await call('POST', contentsUrl(id), { directory: ALPHA })).status, 201, 'room again after a folder is removed');
  });
});

test('memory-block contents: bad input is refused (400), a global or unknown block has no contents', async () => {
  await withApi(async (call) => {
    const id = await createProjectBlock(call);
    for (const body of [{}, { directory: '' }, { directory: 'relative/path' }, { directory: 42 }]) {
      assert.equal((await call('POST', contentsUrl(id), body)).status, 400, JSON.stringify(body));
    }
    await call('POST', contentsUrl(id), { directory: ALPHA });
    assert.equal((await call('PUT', contentsUrl(id), { directory: ALPHA, content: 'x' })).status, 400, 'expectedRev is required');
    assert.equal((await call('PUT', contentsUrl(id), { directory: ALPHA, content: 7, expectedRev: 1 })).status, 400);
    assert.equal((await call('PUT', contentsUrl(id), { directory: ALPHA, content: 'x'.repeat(2001), expectedRev: 1 })).status, 400, 'over maxChars');
    assert.equal((await call('DELETE', contentsUrl(id))).status, 400, 'directory query is required');
    assert.equal((await call('GET', contentsUrl(id))).body.contents[0].rev, 1, 'refused requests wrote nothing');

    const global = (await call('POST', '/memory-blocks', blockBody({ name: 'global-one' }))).body.block;
    const notProject = await call('POST', contentsUrl(global.id), { directory: ALPHA });
    assert.equal(notProject.status, 400);
    assert.equal(notProject.body.error.code, 'BLOCK_NOT_PROJECT_SCOPE');
    assert.equal((await call('GET', contentsUrl('no-such-id'))).status, 404);
    assert.equal((await call('POST', contentsUrl('no-such-id'), { directory: ALPHA })).status, 404);
    for (const unsafeId of ['..%2Foutside', '%2e%2e%2f%2e%2e%2foutside']) {
      assert.equal((await call('GET', `/memory-blocks/${unsafeId}/contents`)).status, 400, unsafeId);
    }
  });
});

test('memory-block contents: an unreadable content file is reported by the list and does not hide the others', async () => {
  await withApi(async (call, rig) => {
    const id = await createProjectBlock(call);
    const beta = path.resolve(path.sep, 'work', 'beta');
    await call('POST', contentsUrl(id), { directory: ALPHA });
    await call('POST', contentsUrl(id), { directory: beta });
    const directory = path.join(rig.root, 'agent-profiles', 'memory-block-contents', id);
    const alphaFile = fs.readdirSync(directory).map((file) => path.join(directory, file))
      .find((file) => JSON.parse(fs.readFileSync(file, 'utf8')).directory === ALPHA) as string;
    fs.writeFileSync(alphaFile, '{ broken');
    const listed = await call('GET', contentsUrl(id));
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.contents.map((item: { directory: string }) => item.directory), [beta]);
    assert.equal(listed.body.corrupt.length, 1);
    assert.equal(fs.readFileSync(alphaFile, 'utf8'), '{ broken', 'the unreadable file is not replaced');
  });
});

test('memory-blocks: deleting a block removes its content files', async () => {
  await withApi(async (call, rig) => {
    const id = await createProjectBlock(call);
    await call('POST', contentsUrl(id), { directory: ALPHA });
    assert.equal((await call('DELETE', `/memory-blocks/${id}`)).status, 200);
    assert.equal(fs.existsSync(path.join(rig.root, 'agent-profiles', 'memory-block-contents', id)), false);
  });
});

test('memory-block contents: DELETE with expectedRev refuses a stale rev (409, nothing changed) for both forms, accepts the current one, and rejects a malformed one', async () => {
  await withApi(async (call) => {
    const id = await createProjectBlock(call);
    await call('POST', contentsUrl(id), { directory: ALPHA });
    await call('PUT', contentsUrl(id), { directory: ALPHA, content: 'agent text', expectedRev: 1 }); // rev 2

    for (const extra of ['&expectedRev=1', '&expectedRev=1&remove=true']) {
      const stale = await call('DELETE', contentsUrl(id, ALPHA, extra));
      assert.equal(stale.status, 409, extra);
      assert.equal(stale.body.error.code, 'PROFILE_STALE');
    }
    const kept = (await call('GET', contentsUrl(id))).body.contents[0];
    assert.deepEqual([kept.content, kept.rev], ['agent text', 2], 'a refused delete changes nothing');

    for (const bad of ['&expectedRev=abc', '&expectedRev=-1', '&expectedRev=1.5', '&expectedRev=']) {
      assert.equal((await call('DELETE', contentsUrl(id, ALPHA, bad))).status, 400, bad);
    }

    const emptied = await call('DELETE', contentsUrl(id, ALPHA, '&expectedRev=2'));
    assert.equal(emptied.status, 200);
    assert.equal(emptied.body.content.rev, 3);
    assert.deepEqual(await call('DELETE', contentsUrl(id, ALPHA, '&expectedRev=3&remove=true')), { status: 200, body: { ok: true } });
  });
});

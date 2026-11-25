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
  app.use('/api/agent-profiles', createAgentProfilesRouter(rig.service, rig.claudeAgents, rig.blocks));
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

test('memory-blocks: a project scope is stored with its folder, defaults apply, bad bodies are 400 with a code', async () => {
  await withApi(async (call) => {
    const project = await call('POST', '/memory-blocks', { name: 'alpha-notes', description: '', mode: 'writable', scope: { kind: 'project', directory: ALPHA }, content: '' });
    assert.equal(project.status, 201);
    assert.equal(project.body.block.maxChars, 2000, 'default limit');
    assert.equal(project.body.block.scope.kind, 'project');
    assert.equal(path.resolve(project.body.block.scope.directory), ALPHA);

    for (const overrides of [{ name: 'Bad Name' }, { mode: 'nope' }, { scope: { kind: 'project', directory: 'relative' } }, { maxChars: 20001 }, { content: 'x'.repeat(2001) }]) {
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
    const otherScope = await call('POST', '/memory-blocks', blockBody({ scope: { kind: 'project', directory: ALPHA } }));
    assert.equal(otherScope.status, 409, 'names are unique across all scopes');
    assert.equal(otherScope.body.error.code, 'BLOCK_NAME_TAKEN');
    const project = (await call('POST', '/memory-blocks', blockBody({ name: 'alpha-notes', scope: { kind: 'project', directory: ALPHA } }))).body.block;
    const rename = await call('PUT', `/memory-blocks/${project.id}`, { ...blockBody({ name: 'style-guide', scope: { kind: 'project', directory: ALPHA } }), expectedRev: 1 });
    assert.equal(rename.status, 409, 'a rename into a name of another scope');
    assert.equal(rename.body.error.code, 'BLOCK_NAME_TAKEN');
    assert.equal((await call('PUT', `/memory-blocks/${project.id}`, { ...blockBody({ name: 'alpha-notes', scope: { kind: 'project', directory: ALPHA }, content: 'kept name' }), expectedRev: 1 })).status, 200, 'a PUT that keeps its own name does not collide with itself');

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

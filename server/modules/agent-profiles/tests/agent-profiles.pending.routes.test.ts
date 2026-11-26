import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { AppError } from '@/shared/utils.js';

import { createAgentProfilesRouter } from '../agent-profiles.routes.js';

import { makeServiceRig } from './service-rig.js';

type Call = (method: string, url: string, body?: unknown) => Promise<{ status: number; body: any }>;

async function withApi(run: (call: Call, rig: ReturnType<typeof makeServiceRig>) => Promise<void>) {
  const rig = makeServiceRig();
  const app = express();
  app.use(express.json());
  app.use('/api/agent-profiles', createAgentProfilesRouter(rig.service, rig.claudeAgents, rig.blocks, rig.bundle, rig.pending));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message } });
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

const proposal = (slug: string) => ({
  upsert: { templates: [{ slug, family: 'worker', name: `Template ${slug}`, description: '', instructions: 'Do it.', tools: ['Read'] }] },
});

test('pending list, count, confirm and reject over HTTP', async () => {
  await withApi(async (call, rig) => {
    rig.store.updateSettings({ profileManagerAgents: ['manager'] });
    assert.deepEqual((await call('GET', '/pending')).body, []);
    assert.deepEqual((await call('GET', '/pending/count')).body, { count: 0 });
    const first = rig.pending.propose('manager', proposal('alpha')).proposal;
    const second = rig.pending.propose('manager', proposal('beta')).proposal;
    const listed = await call('GET', '/pending');
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.map((view: { id: string }) => view.id), [first.id, second.id]);
    assert.deepEqual(listed.body[0].basis, { 'template:alpha': 'absent' });
    assert.ok(!('changeset' in listed.body[0]));
    assert.deepEqual((await call('GET', '/pending/count')).body, { count: 2 });

    const confirmed = await call('POST', `/pending/${first.id}/confirm`, { overwrite: [], acceptSensitive: [], basis: listed.body[0].basis });
    assert.equal(confirmed.status, 200);
    assert.deepEqual(confirmed.body.items, [{ key: 'template:alpha', status: 'applied' }]);
    assert.equal(confirmed.body.partial, false);
    assert.equal(rig.service.listTemplates().items.length, 1);

    assert.equal((await call('POST', `/pending/${first.id}/confirm`, {})).status, 404, 'a confirmed proposal is spent');
    const rejected = await call('POST', `/pending/${second.id}/reject`);
    assert.deepEqual([rejected.status, rejected.body], [200, { rejected: true }]);
    assert.deepEqual((await call('GET', '/pending/count')).body, { count: 0 });
    assert.equal(rig.service.listTemplates().items.length, 1, 'reject writes nothing');
  });
});

test('confirm answers 400 for a malformed body or id, 404 for an unknown proposal, and takes an empty body', async () => {
  await withApi(async (call, rig) => {
    rig.store.updateSettings({ profileManagerAgents: ['manager'] });
    const { id } = rig.pending.propose('manager', proposal('alpha')).proposal;
    assert.equal((await call('POST', `/pending/${id}/confirm`, { overwrite: 'template:alpha' })).status, 400);
    assert.equal((await call('POST', `/pending/${id}/confirm`, { basis: { 'template:alpha': -1 } })).status, 400);
    assert.equal((await call('POST', '/pending/no-such-id/confirm', {})).status, 404);
    assert.equal((await call('POST', '/pending/..%2Fsettings/confirm', {})).status, 400, 'a path that is not an id never reaches the store');
    assert.equal((await call('POST', `/pending/${id}/confirm`)).status, 200);
  });
});

test('PUT /claude-agents/managers saves the list, bumps the shared rev, refuses a stale rev and bad names', async () => {
  await withApi(async (call, rig) => {
    const listing = await call('GET', '/claude-agents');
    assert.deepEqual(listing.body.managerNames, []);
    const saved = await call('PUT', '/claude-agents/managers', { names: ['manager', 'manager', ' helper '], rev: listing.body.hiddenRev });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, { profileManagerAgents: ['manager', 'helper'], rev: listing.body.hiddenRev + 1 });
    assert.deepEqual(rig.claudeAgents.managerNames(), ['manager', 'helper']);
    assert.equal((await call('PUT', '/claude-agents/managers', { names: [], rev: listing.body.hiddenRev })).status, 409);
    assert.equal((await call('PUT', '/claude-agents/managers', { names: ['bad name'], rev: saved.body.rev })).status, 400);
    assert.equal((await call('PUT', '/claude-agents/managers', { names: 'manager', rev: saved.body.rev })).status, 400);
    assert.equal((await call('PUT', '/claude-agents/managers', { names: [] })).status, 400, 'rev is required');
    // The hide list shares the rev and is untouched by a manager edit.
    const hidden = await call('PUT', '/claude-agents/hidden', { names: ['Explore'], rev: saved.body.rev });
    assert.equal(hidden.status, 200);
    assert.deepEqual(rig.claudeAgents.managerNames(), ['manager', 'helper']);
  });
});

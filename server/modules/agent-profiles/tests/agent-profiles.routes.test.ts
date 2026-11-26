import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { AppError } from '@/shared/utils.js';

import { createAgentProfilesRouter } from '../agent-profiles.routes.js';

import { makeServiceRig, templateBody } from './service-rig.js';

/** Router on an ephemeral port with the same error middleware the server uses. */
async function withApi(
  run: (call: (method: string, url: string, body?: unknown) => Promise<{ status: number; body: any }>, rig: ReturnType<typeof makeServiceRig>) => Promise<void>,
) {
  const rig = makeServiceRig({ sdkAgents: [{ name: 'Explore', description: 'Fast search' }] });
  const app = express();
  app.use(express.json());
  app.use('/api/agent-profiles', createAgentProfilesRouter(rig.service, rig.claudeAgents, rig.blocks, rig.bundle));
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
  const call = async (method: string, url: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/agent-profiles${url}`, {
      method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    // An unmatched route answers Express's HTML 404 page: its body is not JSON.
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  try { await run(call, rig); } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rig.cleanup();
  }
}

/** A real folder to generate into (inside the rig's temp root, so it is removed with it). */
const makeProjectFolder = (rig: ReturnType<typeof makeServiceRig>, name = 'alpha'): string => {
  const directory = path.join(rig.root, name);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
};

test('CRUD over HTTP: templates with the expected status codes', async () => {
  await withApi(async (call) => {
    const template = await call('POST', '/templates', templateBody());
    assert.equal(template.status, 201);
    assert.equal(Object.hasOwn(template.body, 'origin') || Object.hasOwn(template.body, 'isDefaultOrchestrator'), false);
    assert.equal((await call('GET', `/templates/${template.body.id}`)).body.slug, 'review-code');
    assert.equal((await call('GET', '/templates')).body.items.length, 1);
    assert.equal((await call('PUT', `/templates/${template.body.id}`, templateBody({ name: 'Renamed', rev: 1 }))).status, 200);
    assert.equal((await call('DELETE', `/templates/${template.body.id}`)).status, 200);
    assert.equal((await call('GET', `/templates/${template.body.id}`)).status, 404);
  });
});

test('the agent store, lint, project, import, duplicate, restore-samples and default routes are gone', async () => {
  await withApi(async (call) => {
    const template = await call('POST', '/templates', templateBody());
    const removed = [
      ['GET', '/agents'], ['POST', '/agents'], ['GET', '/agents/x/resolve'], ['GET', '/lint'],
      ['GET', '/projects'], ['POST', '/projects'], ['GET', '/projects/x'], ['PUT', '/projects/x'], ['DELETE', '/projects/x'],
      ['GET', '/projects/x/generate/preview'],
      ['POST', '/templates/from-claude-agent'], ['POST', '/templates/restore-samples'],
      ['POST', `/templates/${template.body.id}/duplicate`], ['POST', `/templates/${template.body.id}/default-orchestrator`],
    ];
    for (const [method, url] of removed) {
      assert.equal((await call(method, url)).status, 404, `${method} ${url}`);
    }
    assert.equal((await call('GET', '/templates')).body.items.length, 1, 'a removed route changed nothing');
  });
});

test('generate: preview writes nothing, apply writes the agent file, a second apply regenerates it', async () => {
  await withApi(async (call, rig) => {
    const directory = makeProjectFolder(rig);
    const template = await call('POST', '/templates', templateBody());
    const body = { directory, templateIds: [template.body.id], values: { git_url: 'https://git.example.com/alpha.git' } };
    const file = path.join(directory, '.claude', 'agents', 'review-code.md');

    const preview = await call('POST', '/generate/preview', body);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.scope, 'project');
    assert.equal(preview.body.agentsDirectory, path.join(directory, '.claude', 'agents'));
    assert.deepEqual(preview.body.plans.map((item: { name: string; status: string }) => [item.name, item.status]), [['review-code', 'new']]);
    assert.equal(fs.existsSync(file), false, 'preview writes nothing');

    const generated = await call('POST', '/generate', body);
    assert.equal(generated.status, 201);
    assert.equal(generated.body.created.length, 1);
    assert.deepEqual(generated.body.regenerated, []);
    assert.ok(fs.readFileSync(file, 'utf8').includes('<param name="git_url">https://git.example.com/alpha.git</param>'));

    const again = await call('POST', '/generate', body);
    assert.equal(again.body.created.length, 0);
    assert.deepEqual(again.body.regenerated.map((item: { status: string }) => item.status), ['duplicate']);
  });
});

test('generate: values are remembered per directory and read back with GET /generate/values', async () => {
  await withApi(async (call, rig) => {
    const directory = makeProjectFolder(rig);
    const other = makeProjectFolder(rig, 'other');
    const template = await call('POST', '/templates', templateBody());
    assert.deepEqual((await call('GET', `/generate/values?directory=${encodeURIComponent(directory)}`)).body.values, {});
    await call('POST', '/generate', { directory, templateIds: [template.body.id], values: { git_url: 'https://a' } });
    const remembered = await call('GET', `/generate/values?directory=${encodeURIComponent(directory)}`);
    assert.equal(remembered.status, 200);
    assert.deepEqual(remembered.body.values, { git_url: 'https://a' });
    assert.deepEqual((await call('GET', `/generate/values?directory=${encodeURIComponent(other)}`)).body.values, {});
    assert.equal((await call('GET', '/generate/values?directory=relative%2Fdir')).status, 400);
  });
});

test('generate: bad input is a 400/404 with a code and never names a folder', async () => {
  await withApi(async (call, rig) => {
    const template = await call('POST', '/templates', templateBody());
    const missing = await call('POST', '/generate', { directory: path.join(rig.root, 'nope'), templateIds: [template.body.id] });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'DIRECTORY_NOT_FOUND');
    assert.ok(!missing.body.error.message.includes(rig.root));
    assert.equal((await call('POST', '/generate', { directory: 'relative', templateIds: [template.body.id] })).status, 400);
    assert.equal((await call('POST', '/generate', { templateIds: [] })).status, 400);
    assert.equal((await call('POST', '/generate', { templateIds: ['missing'] })).status, 404);
    assert.equal((await call('POST', '/generate', { templateIds: [template.body.id], values: { git_url: 5 } })).status, 400);
  });
});

test('a path-traversal id is refused with 400 and touches nothing', async () => {
  await withApi(async (call, rig) => {
    fs.writeFileSync(path.join(rig.root, 'outside.json'), '{"id":"x"}');
    for (const id of ['..%2Foutside', '%2e%2e%2f%2e%2e%2foutside', '..%5Coutside']) {
      assert.equal((await call('GET', `/templates/${id}`)).status, 400, `templates/${id}`);
      assert.equal((await call('DELETE', `/templates/${id}`)).status, 400, `templates/${id}`);
    }
    assert.equal((await call('PUT', '/templates/..%2Foutside', templateBody({ rev: 1 }))).status, 400);
    assert.ok(fs.existsSync(path.join(rig.root, 'outside.json')));
  });
});

test('a stale PUT is rejected with 409 and a JSON error', async () => {
  await withApi(async (call) => {
    const template = await call('POST', '/templates', templateBody());
    assert.equal((await call('PUT', `/templates/${template.body.id}`, templateBody({ name: 'New', rev: 1 }))).status, 200);
    const stale = await call('PUT', `/templates/${template.body.id}`, templateBody({ name: 'Older', rev: 1 }));
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'PROFILE_STALE');
    assert.equal((await call('GET', `/templates/${template.body.id}`)).body.name, 'New');
  });
});

test('a corrupt JSON file does not take the server down or get overwritten', async () => {
  await withApi(async (call, rig) => {
    const template = await call('POST', '/templates', templateBody());
    const brokenFile = path.join(rig.root, 'agent-profiles', 'templates', `${template.body.id}.json`);
    fs.writeFileSync(brokenFile, '{ broken');
    const listing = await call('GET', '/templates');
    assert.equal(listing.status, 200);
    assert.equal(listing.body.corrupt.length, 1);
    const read = await call('GET', `/templates/${template.body.id}`);
    assert.equal(read.status, 500);
    assert.equal(read.body.error.code, 'PROFILE_CORRUPT');
    const write = await call('PUT', `/templates/${template.body.id}`, templateBody({ rev: 1 }));
    assert.equal(write.status, 500);
    assert.equal(fs.readFileSync(brokenFile, 'utf8'), '{ broken');
    assert.equal((await call('GET', '/claude-agents')).status, 200, 'the rest keeps working');
  });
});

test('Claude agents: listing with generated/handmade status and hide with rev', async () => {
  await withApi(async (call, rig) => {
    fs.mkdirSync(path.join(rig.claudeHome, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(rig.claudeHome, 'agents', 'r.md'), '---\nname: reviewer\ndescription: Reviews\n---\nPrompt');
    const listing = await call('GET', '/claude-agents');
    assert.deepEqual(listing.body.items.map((item: { name: string }) => item.name), ['Explore', 'reviewer']);
    assert.equal(listing.body.items[1].generated, false);
    const hidden = await call('PUT', '/claude-agents/hidden', { names: ['Explore'], rev: listing.body.hiddenRev });
    assert.equal(hidden.status, 200);
    assert.deepEqual(listing.body.hiddenNames, []);
    assert.deepEqual((await call('GET', '/claude-agents')).body.hiddenNames, ['Explore'], 'the raw stored list comes back for the client to edit');
    assert.equal((await call('PUT', '/claude-agents/hidden', { names: [], rev: listing.body.hiddenRev })).status, 409);
    for (const unsafe of ['*', 'a)', 'Task(x', 'a\nb']) {
      assert.equal((await call('PUT', '/claude-agents/hidden', { names: [unsafe], rev: hidden.body.rev })).status, 400, JSON.stringify(unsafe));
    }
    assert.equal((await call('GET', '/claude-agents')).body.items[0].hidden, true);
  });
});

test('Claude agents: a project folder adds its .claude/agents, marked generated or handmade', async () => {
  await withApi(async (call, rig) => {
    const directory = makeProjectFolder(rig);
    const template = await call('POST', '/templates', templateBody());
    await call('POST', '/generate', { directory, templateIds: [template.body.id] });
    fs.writeFileSync(path.join(directory, '.claude', 'agents', 'mine.md'), '---\nname: mine\ndescription: Hand written\n---\nBody');
    const listing = await call('GET', `/claude-agents?directory=${encodeURIComponent(directory)}`);
    const byName = Object.fromEntries(listing.body.items.map((item: { name: string }) => [item.name, item]));
    assert.equal(byName['review-code'].source, 'project');
    assert.equal(byName['review-code'].generated, true);
    assert.equal(byName['review-code'].generatedFrom, 'review-code');
    assert.equal(byName.mine.generated, false);
    assert.equal(byName.Explore.generated, false);
  });
});

test('scope-options?projectId= returns the main agents of that sidebar project as names only, without starting the SDK', async () => {
  await withApi(async (call, rig) => {
    const directory = path.join(rig.root, 'private-dir');
    fs.mkdirSync(path.join(directory, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(directory, '.claude', 'agents', 'orch.md'), '---\nname: orchestrator\ndescription: SECRET-PROMPT\n---\nSECRET-PROMPT');
    fs.writeFileSync(path.join(directory, '.claude', 'agents', 'rev.md'), '---\nname: rev\ndescription: SECRET-PROMPT\n---\nSECRET-PROMPT');
    rig.state.projects.set('proj-1', directory);
    const callsBefore = rig.state.sdkCalls;
    const options = await call('GET', '/scope-options?projectId=proj-1');
    assert.equal(options.status, 200);
    assert.deepEqual(options.body, {
      agents: [{ name: 'orchestrator', source: 'project', isOrchestrator: true }, { name: 'rev', source: 'project', isOrchestrator: false }],
    });
    // The route is open to Remote, so it must not have started the Claude CLI/SDK.
    assert.equal(rig.state.sdkCalls, callsBefore);
    const raw = JSON.stringify(options.body);
    for (const leaked of ['private-dir', 'SECRET-PROMPT', 'directory', 'prompt', 'values', 'path']) {
      assert.ok(!raw.includes(leaked), `scope-options must not contain "${leaked}"`);
    }
  });
});

test('scope-options: no projectId is 400, an unknown one is 404, neither names a path', async () => {
  await withApi(async (call, rig) => {
    rig.state.projects.set('proj-1', path.join(rig.root, 'private-dir'));
    const none = await call('GET', '/scope-options');
    assert.equal(none.status, 400);
    assert.equal(none.body.error.code, 'PROJECT_ID_REQUIRED');
    const unknown = await call('GET', '/scope-options?projectId=nope');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'PROJECT_NOT_FOUND');
    for (const answer of [none, unknown]) {
      assert.ok(!JSON.stringify(answer.body).includes('private-dir'));
      assert.ok(!JSON.stringify(answer.body).includes(rig.root));
    }
    // A client still sending a folder path instead of the sidebar id gets nothing: only ids resolve.
    assert.equal((await call('GET', `/scope-options?projectId=${encodeURIComponent(path.join(rig.root, 'private-dir'))}`)).status, 404);
  });
});

test('the server mounts the router behind authenticateToken (requests without a token are rejected)', () => {
  const source = fs.readFileSync(new URL('../../../index.ts', import.meta.url), 'utf8');
  assert.match(source, /app\.use\('\/api\/agent-profiles',\s*authenticateToken,\s*agentProfilesRoutes\)/);
  assert.match(source, /agentProfilesRoutes[^;]*from '\.\/modules\/agent-profiles\/index\.js'/s);
});

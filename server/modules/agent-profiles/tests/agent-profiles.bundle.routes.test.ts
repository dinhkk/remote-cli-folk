import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { AppError } from '@/shared/utils.js';

import { agentProfilesBundleBodyParser, createAgentProfilesRouter } from '../agent-profiles.routes.js';

import { makeServiceRig, templateBody } from './service-rig.js';

type Call = (method: string, url: string, body?: unknown, raw?: string, contentType?: string) => Promise<{ status: number; body: any }>;

/** The bundle parser is mounted before the global 50 MB parser, in the order server/index.ts uses. */
async function withApi(run: (call: Call, rig: ReturnType<typeof makeServiceRig>) => Promise<void>) {
  const rig = makeServiceRig();
  const app = express();
  app.use('/api/agent-profiles/bundle', agentProfilesBundleBodyParser);
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));
  app.use('/api/agent-profiles', createAgentProfilesRouter(rig.service, rig.claudeAgents, rig.blocks, rig.bundle));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    // Same as the app's error middleware: anything that is not an AppError is a plain 500.
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const call: Call = async (method, url, body, raw, contentType) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/agent-profiles${url}`, {
      method, headers: { 'content-type': contentType ?? 'application/json' }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  try { await run(call, rig); } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rig.cleanup();
  }
}

const BUNDLE_TEXT = [
  'format: remotecli.agent-bundle', 'version: 1', 'templates:', '  - slug: alpha', '    family: worker', '    name: Alpha', '    description: First.',
  '    tools: [Read]', '    instructions: |', '      Do alpha.', '      Then stop.', 'memoryBlocks:', '  - name: beta', '    description: Notes', '    mode: writable',
  '    scope: {kind: global}', '    content: hello', '',
].join('\n');

test('export answers {filename, text, problems}: YAML by default, JSON on request', async () => {
  await withApi(async (call, rig) => {
    rig.service.createTemplate(templateBody({ slug: 'alpha', tools: ['Read'] }));
    const yaml = await call('POST', '/bundle/export', {});
    assert.equal(yaml.status, 200);
    assert.match(yaml.body.filename, /^remotecli-agent-bundle-\d{8}\.yaml$/);
    assert.ok(yaml.body.text.startsWith('format: remotecli.agent-bundle'));
    assert.deepEqual(yaml.body.problems, []);
    const json = await call('POST', '/bundle/export', { format: 'json' });
    assert.match(json.body.filename, /\.json$/);
    assert.equal(JSON.parse(json.body.text).templates[0].slug, 'alpha');
    assert.equal((await call('POST', '/bundle/export', { format: 'xml' })).status, 400);
    assert.equal((await call('POST', '/bundle/export', { includeBlockContent: 'yes' })).status, 400);
  });
});

test('preview then import over HTTP: 200 with items, partial flag, and no 201', async () => {
  await withApi(async (call, rig) => {
    const preview = await call('POST', '/bundle/import/preview', { text: BUNDLE_TEXT });
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body.items.map((item: any) => [item.key, item.status, item.basis]), [['template:alpha', 'new', 'absent'], ['block:beta', 'new', 'absent']]);
    assert.equal(rig.service.listTemplates().items.length, 0, 'preview writes nothing');
    const applied = await call('POST', '/bundle/import', { text: BUNDLE_TEXT, basis: { 'template:alpha': 'absent' } });
    assert.equal(applied.status, 200);
    assert.equal(applied.body.partial, false);
    assert.equal(rig.service.listTemplates().items.length, 1);
  });
});

test('a sensitive template needs its tick; a ticked overwrite needs the basis the preview returned', async () => {
  await withApi(async (call, rig) => {
    const text = BUNDLE_TEXT.replace('tools: [Read]', 'tools: [Bash]');
    const first = await call('POST', '/bundle/import', { text });
    assert.equal(first.status, 200);
    const alpha = first.body.items.find((item: any) => item.key === 'template:alpha');
    assert.deepEqual([alpha.status, alpha.code], ['skipped', 'SENSITIVE_NOT_ACCEPTED']);
    assert.equal(first.body.partial, true);
    const second = await call('POST', '/bundle/import', { text, acceptSensitive: ['template:alpha'] });
    assert.equal(second.body.items.find((item: any) => item.key === 'template:alpha').status, 'applied');
    assert.equal(rig.service.listTemplates().items.length, 1);
    const changed = text.replace('Do alpha.', 'Do alpha differently.');
    const preview = await call('POST', '/bundle/import/preview', { text: changed });
    const row = preview.body.items.find((item: any) => item.key === 'template:alpha');
    assert.equal(row.status, 'conflict');
    const refused = await call('POST', '/bundle/import', { text: changed, overwrite: ['template:alpha'], acceptSensitive: ['template:alpha'] });
    assert.equal(refused.body.items.find((item: any) => item.key === 'template:alpha').code, 'BASIS_REQUIRED');
    const done = await call('POST', '/bundle/import', {
      text: changed, overwrite: ['template:alpha'], acceptSensitive: ['template:alpha'], basis: { 'template:alpha': row.basis },
    });
    assert.equal(done.body.items.find((item: any) => item.key === 'template:alpha').status, 'applied');
    assert.ok(done.body.snapshot, 'snapshot named in the result');
    const snapshots = await call('GET', '/bundle/snapshots');
    assert.equal(snapshots.status, 200);
    assert.deepEqual(snapshots.body.map((snapshot: any) => snapshot.name), [done.body.snapshot]);
    const restored = await call('POST', '/bundle/restore', { snapshot: done.body.snapshot });
    assert.equal(restored.status, 200);
    assert.equal(rig.service.listTemplates().items[0].instructions, 'Do alpha.\nThen stop.\n');
  });
});

test('a syntax error is a 400 BUNDLE_INVALID carrying line, column and path', async () => {
  await withApi(async (call) => {
    const syntax = await call('POST', '/bundle/import/preview', { text: 'format: remotecli.agent-bundle\nversion: 1\ntemplates: [oops\n' });
    assert.equal(syntax.status, 400);
    assert.equal(syntax.body.error.code, 'BUNDLE_INVALID');
    assert.ok(typeof syntax.body.error.details.line === 'number' && typeof syntax.body.error.details.column === 'number');
    const type = await call('POST', '/bundle/import/preview', { text: 'format: remotecli.agent-bundle\nversion: 1\ntemplates: nope\n' });
    assert.equal(type.body.error.details.path, 'templates');
    const version = await call('POST', '/bundle/import/preview', { text: 'format: remotecli.agent-bundle\nversion: 2\n' });
    assert.equal(version.body.error.code, 'BUNDLE_VERSION_UNSUPPORTED');
    assert.equal((await call('POST', '/bundle/import/preview', {})).status, 400);
    assert.equal((await call('POST', '/bundle/import/preview', { text: '   ' })).status, 400);
    assert.equal((await call('POST', '/bundle/import', { text: BUNDLE_TEXT, basis: { x: 'old' } })).status, 400);
  });
});

test('restore refuses anything that is not a snapshot file name', async () => {
  await withApi(async (call) => {
    for (const snapshot of ['../outside.json', '..\\x', 'x.json', '/etc/passwd', '20260601T120000000Z-abcd.json']) {
      const response = await call('POST', '/bundle/restore', { snapshot });
      assert.equal(response.status, 404, snapshot);
      assert.equal(response.body.error.code, 'SNAPSHOT_NOT_FOUND');
    }
    assert.equal((await call('POST', '/bundle/restore', {})).status, 400);
    assert.equal((await call('POST', '/bundle/restore', { snapshot: 5 })).status, 400);
  });
});

test('a body over 5 MB gets 413 on the bundle routes without being handled; a 3 MB one is fine', async () => {
  await withApi(async (call) => {
    const huge = JSON.stringify({ text: `#${'x'.repeat(6 * 1024 * 1024)}\n${BUNDLE_TEXT}` });
    for (const url of ['/bundle/import/preview', '/bundle/import', '/bundle/export', '/bundle/restore']) {
      const response = await call('POST', url, undefined, huge);
      assert.equal(response.status, 413, url);
      assert.equal(response.body.error.code, 'BUNDLE_TOO_LARGE');
    }
    // A form post would otherwise reach the 50 MB urlencoded parser.
    const form = await call('POST', '/bundle/import/preview', undefined, `text=${'x'.repeat(8 * 1024 * 1024)}`, 'application/x-www-form-urlencoded');
    assert.equal(form.status, 415);
    const large = await call('POST', '/bundle/import/preview', { text: `#${'x'.repeat(3 * 1024 * 1024)}\n${BUNDLE_TEXT}` });
    assert.equal(large.status, 200);
    // The rest of the API keeps the 50 MB cap (a 6 MB template create is a validation error, not 413).
    const other = await call('POST', '/templates', undefined, JSON.stringify({ ...templateBody(), instructions: 'x'.repeat(6 * 1024 * 1024) }));
    assert.equal(other.status, 400);
  });
});

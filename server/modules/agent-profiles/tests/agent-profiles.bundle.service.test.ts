import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { AppError } from '@/shared/utils.js';
import type {
  AgentBundle, ImportBasis, ImportPlan, ImportPlanItem, ImportResult, MemoryBlockBundleEntry,
} from '@/shared/types.js';

import { serializeBundle } from '../agent-profiles.bundle.format.js';
import { valuesKeyOf } from '../agent-profiles.store.js';

import { makeServiceRig, templateBody } from './service-rig.js';

const rigs: ReturnType<typeof makeServiceRig>[] = [];
const newRig = () => { const rig = makeServiceRig(); rigs.push(rig); return rig; };
afterEach(() => { while (rigs.length) rigs.pop()?.cleanup(); });

type Rig = ReturnType<typeof makeServiceRig>;

const tools = ['Read', 'Grep'];
const template = (slug: string, overrides: Record<string, unknown> = {}) => ({
  slug, family: 'worker', name: `Template ${slug}`, description: 'Does a thing.', instructions: `Work as ${slug}.`,
  params: [], bindings: { project: true, knowledge: false }, tools, ...overrides,
} as unknown as AgentBundle['templates'][number]);
const globalBlock = (name: string, overrides: Partial<MemoryBlockBundleEntry> = {}): MemoryBlockBundleEntry => ({
  name, description: `Block ${name}`, mode: 'writable', scope: { kind: 'global' }, maxChars: 2000, ...overrides,
});
const projectBlock = (name: string, overrides: Partial<MemoryBlockBundleEntry> = {}): MemoryBlockBundleEntry => ({
  name, description: `Block ${name}`, mode: 'writable', scope: { kind: 'project' }, maxChars: 2000, ...overrides,
});
const bundleOf = (templates: AgentBundle['templates'], memoryBlocks: MemoryBlockBundleEntry[] = []): AgentBundle => ({
  format: 'remotecli.agent-bundle', version: 1, exportedAt: '2026-01-01T00:00:00.000Z', templates, memoryBlocks,
});

/** The `basis` map a UI sends: what the preview saw of every item and folder row. */
const basisOf = (plan: ImportPlan): Record<string, ImportBasis> => {
  const basis: Record<string, ImportBasis> = {};
  for (const item of plan.items) {
    basis[item.key] = item.basis;
    for (const folder of item.folders ?? []) basis[folder.key] = folder.basis;
  }
  return basis;
};
const itemOf = (plan: ImportPlan, key: string): ImportPlanItem => {
  const item = plan.items.find((candidate) => candidate.key === key);
  assert.ok(item, `plan has ${key}`);
  return item;
};
const resultOf = (result: ImportResult, key: string) => {
  const item = result.items.find((candidate) => candidate.key === key);
  assert.ok(item, `result has ${key}`);
  return item;
};
const allKeys = (plan: ImportPlan): string[] => plan.items.flatMap((item) => [item.key, ...(item.folders ?? []).map((folder) => folder.key)]);

const addProject = (rig: Rig, id: string, directory: string): void => { rig.state.projects.set(id, directory); };
const blockByName = (rig: Rig, name: string) => {
  const found = rig.blocks.list().blocks.find((block) => block.name === name);
  assert.ok(found, `block ${name} exists`);
  return found;
};
const folderText = (rig: Rig, name: string, directory: string) => {
  const { contents } = rig.blocks.listContents(blockByName(rig, name).id);
  return contents.find((entry) => valuesKeyOf(entry.directory) === valuesKeyOf(directory));
};
const snapshotNames = (rig: Rig): string[] => rig.snapshots.list().map((snapshot) => snapshot.name);

/** A project block with text in `directories` of `rig` (created through the real services). */
function seedProjectBlock(rig: Rig, name: string, texts: Record<string, string>, extra: Record<string, unknown> = {}) {
  const { block } = rig.blocks.create({ name, description: `Block ${name}`, mode: 'writable', scope: { kind: 'project' }, maxChars: 2000, ...extra });
  for (const [directory, text] of Object.entries(texts)) {
    rig.blocks.addContent(block.id, directory);
    const { contents } = rig.blocks.listContents(block.id);
    const added = contents.find((entry) => valuesKeyOf(entry.directory) === valuesKeyOf(directory)) as { rev: number };
    rig.blocks.updateContent(block.id, directory, text, added.rev);
  }
  return block;
}

const failureOf = (operation: () => unknown): AppError => {
  try { operation(); } catch (error) {
    assert.ok(error instanceof AppError, `expected an AppError, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: 'expected an error' });
};

describe('agent bundle export', () => {
  it('leaves block text out unless asked and never exports ids, revisions or timestamps', () => {
    const rig = newRig();
    rig.service.createTemplate(templateBody({ slug: 'alpha' }));
    rig.blocks.create({ name: 'beta', description: 'Beta', mode: 'writable', scope: { kind: 'global' }, content: 'secret text', maxChars: 2000 });
    const without = rig.bundle.exportBundle({ includeBlockContent: false }).bundle;
    assert.equal(without.memoryBlocks[0].content, undefined);
    const withText = rig.bundle.exportBundle({ includeBlockContent: true }).bundle;
    assert.equal(withText.memoryBlocks[0].content, 'secret text');
    assert.equal(withText.memoryBlocks[0].lastWriter, 'user');
    const text = JSON.stringify(withText);
    assert.ok(!/"id"|"rev"|updatedAt|createdAt/.test(text), 'no bookkeeping');
    assert.equal(withText.format, 'remotecli.agent-bundle');
  });

  it('exports only the chosen ids', () => {
    const rig = newRig();
    const first = rig.service.createTemplate(templateBody({ slug: 'alpha' }));
    rig.service.createTemplate(templateBody({ slug: 'beta' }));
    const { bundle } = rig.bundle.exportBundle({ templateIds: [first.id], blockIds: [] });
    assert.deepEqual(bundle.templates.map((entry) => entry.slug), ['alpha']);
    assert.deepEqual(bundle.memoryBlocks, []);
  });

  it('exports every folder text of a project block with its stored directory and no scope.directory', () => {
    const rig = newRig();
    seedProjectBlock(rig, 'notes', { '/work/alpha': 'alpha text', '/work/beta': 'beta text' });
    const { bundle } = rig.bundle.exportBundle({ includeBlockContent: true });
    const [entry] = bundle.memoryBlocks;
    assert.deepEqual(entry.scope, { kind: 'project' });
    assert.deepEqual(entry.contents?.map((folder) => [folder.directory, folder.content]).sort(), [['/work/alpha', 'alpha text'], ['/work/beta', 'beta text']]);
    assert.equal(entry.content, undefined);
    assert.equal(rig.bundle.exportBundle({ includeBlockContent: false }).bundle.memoryBlocks[0].contents, undefined);
  });

  it('lists a problem for a block that needs attention and never exports its legacy text as global content', () => {
    const rig = newRig();
    const legacy = writeLegacyBlock(rig, 'old-notes', '/work/legacy', 'legacy secret', { corruptContentFile: true });
    const { bundle, problems } = rig.bundle.exportBundle({ includeBlockContent: true });
    const entry = bundle.memoryBlocks.find((block) => block.name === 'old-notes');
    assert.ok(entry, 'definition is exported');
    assert.equal(entry.content, undefined);
    assert.equal(entry.contents, undefined);
    assert.ok(problems.some((problem) => problem.key === 'block:old-notes' && problem.code === 'BLOCK_NOT_MIGRATED'), 'problem listed');
    assert.ok(!JSON.stringify(bundle).includes('legacy secret'));
    assert.ok(legacy.id);
  });
});

/**
 * A block saved by an older version (project scope with a folder in the record). With `corruptContentFile` its target
 * content file is unreadable, which stops the migration and leaves the block needing attention.
 */
function writeLegacyBlock(rig: Rig, name: string, directory: string, content: string, options: { corruptContentFile?: boolean } = {}) {
  const id = `00000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`;
  const dir = path.join(rig.root, 'agent-profiles', 'memory-blocks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    id, rev: 3, updatedAt: '2026-01-01T00:00:00.000Z', name, description: 'old', mode: 'writable',
    scope: { kind: 'project', directory }, content, maxChars: 2000, lastWriter: 'user',
  }));
  if (options.corruptContentFile) {
    const hash = createHash('sha1').update(valuesKeyOf(directory)).digest('hex').slice(0, 16);
    const contents = path.join(rig.root, 'agent-profiles', 'memory-block-contents', id);
    fs.mkdirSync(contents, { recursive: true });
    fs.writeFileSync(path.join(contents, `${hash}.json`), '{ not json');
  }
  return { id };
}

describe('agent bundle import: plan', () => {
  it('reports new, identical and conflict per item and writes nothing', () => {
    const rig = newRig();
    rig.service.createTemplate(templateBody({ slug: 'same', tools }));
    rig.service.createTemplate(templateBody({ slug: 'differs', tools, name: 'Old name' }));
    const exported = rig.bundle.exportBundle({ includeBlockContent: false }).bundle;
    const edited = bundleOf([
      exported.templates.find((entry) => entry.slug === 'same') as AgentBundle['templates'][number],
      template('differs', { name: 'New name' }),
      template('fresh'),
    ]);
    const plan = rig.bundle.planImport(edited, {});
    assert.equal(itemOf(plan, 'template:same').status, 'identical');
    assert.equal(itemOf(plan, 'template:differs').status, 'conflict');
    assert.equal(itemOf(plan, 'template:fresh').status, 'new');
    assert.equal(rig.service.listTemplates().items.length, 2, 'nothing written');
    assert.equal(snapshotNames(rig).length, 0);
  });

  it('flags sensitive templates: mcpServers, no tools, Bash, Write, mcp__ tools, skills', () => {
    const rig = newRig();
    const plan = rig.bundle.planImport(bundleOf([
      template('safe'),
      template('with-mcp', { mcpServers: ['db'] }),
      template('no-tools', { tools: undefined }),
      template('with-bash', { tools: ['Read', 'Bash(git status)'] }),
      template('with-write', { tools: ['Write'] }),
      template('with-mcp-tool', { tools: ['mcp__x__y'] }),
      template('with-skills', { skills: ['one'] }),
    ]), {});
    assert.deepEqual(itemOf(plan, 'template:safe').sensitive, []);
    assert.deepEqual(itemOf(plan, 'template:with-mcp').sensitive, ['mcpServers']);
    assert.deepEqual(itemOf(plan, 'template:no-tools').sensitive, ['no-tools']);
    assert.deepEqual(itemOf(plan, 'template:with-bash').sensitive, ['tool:Bash(git status)']);
    assert.deepEqual(itemOf(plan, 'template:with-write').sensitive, ['tool:Write']);
    assert.deepEqual(itemOf(plan, 'template:with-mcp-tool').sensitive, ['tool:mcp__x__y']);
    assert.deepEqual(itemOf(plan, 'template:with-skills').sensitive, ['skills']);
  });

  it('marks wrong types and missing fields invalid with the path, and unknown fields as warnings that still import', () => {
    const rig = newRig();
    const raw = {
      format: 'remotecli.agent-bundle', version: 1, exportedAt: '',
      templates: [template('good', { surprise: 'x' }), { ...template('bad'), tools: 'Bash' }, 'not an object'],
      memoryBlocks: [{ name: 'broken', scope: { kind: 'global' } }],
    } as never;
    const plan = rig.bundle.planImport(raw, {});
    const good = itemOf(plan, 'template:good');
    assert.equal(good.status, 'new');
    assert.ok(good.problems.some((problem) => problem.code === 'unknown-field' && problem.level === 'warning' && problem.path === 'templates[0].surprise'));
    const bad = itemOf(plan, 'template:bad');
    assert.equal(bad.status, 'invalid');
    assert.ok(bad.problems.some((problem) => problem.path === 'templates[1].tools'), JSON.stringify(bad.problems));
    assert.equal(plan.items.find((item) => item.key === 'template:#2')?.status, 'invalid');
    assert.equal(itemOf(plan, 'block:broken').status, 'invalid');
    const applied = rig.bundle.applyImport(raw, {});
    assert.equal(resultOf(applied, 'template:good').status, 'applied');
    assert.equal(resultOf(applied, 'template:bad').status, 'failed');
    assert.equal(applied.partial, true);
  });

  it('makes every copy of a duplicate slug or name invalid', () => {
    const rig = newRig();
    const plan = rig.bundle.planImport(bundleOf([template('dup'), template('dup')], [globalBlock('twice'), globalBlock('twice')]), {});
    const dups = plan.items.filter((item) => item.key === 'template:dup' || item.key === 'block:twice');
    assert.equal(dups.length, 4);
    assert.ok(dups.every((item) => item.status === 'invalid' && item.problems.some((problem) => problem.code === 'DUPLICATE_KEY')));
  });

  it('rejects the 51st block as invalid BLOCK_LIMIT_REACHED', () => {
    const rig = newRig();
    for (let index = 0; index < 49; index += 1) rig.blocks.create({ name: `seed-${index}`, description: '', mode: 'writable', scope: { kind: 'global' }, content: '', maxChars: 100 });
    const plan = rig.bundle.planImport(bundleOf([], [globalBlock('fiftieth'), globalBlock('fifty-first')]), {});
    assert.equal(itemOf(plan, 'block:fiftieth').status, 'new');
    const last = itemOf(plan, 'block:fifty-first');
    assert.equal(last.status, 'invalid');
    assert.equal(last.code, 'BLOCK_LIMIT_REACHED');
  });

  it('gives the same plan for the same bundle as YAML and as JSON, and accepts a hand-written YAML bundle', () => {
    const rig = newRig();
    const value = bundleOf([template('alpha', { instructions: 'First line.\n  second line\n' })], [globalBlock('beta', { content: 'text\nmore' })]);
    const fromYaml = rig.bundle.previewText(serializeBundle(value, 'yaml'), {});
    const fromJson = rig.bundle.previewText(serializeBundle(value, 'json'), {});
    assert.deepEqual(fromYaml, fromJson);
    const handWritten = [
      'format: remotecli.agent-bundle', 'version: 1', 'templates:', '  - slug: gamma', '    family: worker', '    name: Gamma', '    description: By hand.',
      '    tools: [Read]', '    instructions: |', '      Step one.', '      Step two, indented:', '        - nested', 'memoryBlocks:', '  - name: delta',
      '    description: Hand block', '    mode: read-only', '    scope: {kind: global}', '    content: |', '      Line A', '      Line B', '',
    ].join('\n');
    const result = rig.bundle.applyText(handWritten, {});
    assert.equal(result.partial, false);
    const stored = rig.service.listTemplates().items.find((entry) => entry.slug === 'gamma');
    assert.equal(stored?.instructions, 'Step one.\nStep two, indented:\n  - nested\n');
    assert.equal(blockByName(rig, 'delta').content, 'Line A\nLine B\n');
  });

  it('reports the line, column and path of a wrong type found in an item of a text bundle', () => {
    const rig = newRig();
    const text = 'format: remotecli.agent-bundle\nversion: 1\ntemplates:\n  - slug: a\n    family: worker\n    name: A\n    instructions: x\n    tools: wrong\nmemoryBlocks: []\n';
    const plan = rig.bundle.previewText(text, {});
    const problem = itemOf(plan, 'template:a').problems.find((candidate) => candidate.path === 'templates[0].tools');
    assert.ok(problem, 'problem has the path');
    assert.equal(problem.line, 8);
    assert.ok(typeof problem.column === 'number');
  });
});

describe('agent bundle import: apply', () => {
  it('round trips an export into an empty store (text only when included)', () => {
    const source = newRig();
    source.service.createTemplate(templateBody({ slug: 'alpha', tools }));
    source.blocks.create({ name: 'beta', description: 'Beta', mode: 'read-only', scope: { kind: 'global' }, content: 'shared text', maxChars: 500 });
    seedProjectBlock(source, 'notes', { '/work/alpha': 'alpha text' });
    const withText = source.bundle.exportBundle({ includeBlockContent: true }).bundle;

    const target = newRig();
    addProject(target, 'p1', '/target/one');
    const key = valuesKeyOf('/work/alpha');
    const result = target.bundle.applyImport(withText, { projectMap: { [key]: 'p1' } });
    assert.equal(result.partial, false, JSON.stringify(result));
    assert.equal(result.snapshot, null, 'creation-only apply takes no snapshot');
    assert.equal(target.service.listTemplates().items[0].slug, 'alpha');
    const beta = blockByName(target, 'beta');
    assert.deepEqual([beta.content, beta.mode, beta.maxChars, beta.lastWriter], ['shared text', 'read-only', 500, 'user']);
    const folder = folderText(target, 'notes', '/target/one');
    assert.equal(folder?.content, 'alpha text');
    assert.equal(folder?.rev, 1, 'created with its text in one write');
    assert.equal(folder?.lastWriter, 'user');

    const bare = newRig();
    const textless = source.bundle.exportBundle({ includeBlockContent: false }).bundle;
    bare.bundle.applyImport(textless, {});
    assert.equal(blockByName(bare, 'beta').content, '');
    assert.equal(bare.blocks.listContents(blockByName(bare, 'notes').id).contents.length, 0, 'definition without folders');
  });

  it('skips a conflict unless its key is ticked, and takes a snapshot only for an overwrite', () => {
    const rig = newRig();
    rig.service.createTemplate(templateBody({ slug: 'alpha', tools, name: 'Old' }));
    const bundle = bundleOf([template('alpha', { name: 'New' }), template('fresh')]);
    const plan = rig.bundle.planImport(bundle, {});
    const untouched = rig.bundle.applyImport(bundle, { basis: basisOf(plan) });
    assert.equal(resultOf(untouched, 'template:alpha').status, 'skipped');
    assert.equal(resultOf(untouched, 'template:alpha').code, 'CONFLICT');
    assert.equal(resultOf(untouched, 'template:fresh').status, 'applied');
    assert.equal(rig.service.listTemplates().items.find((entry) => entry.slug === 'alpha')?.name, 'Old');
    assert.equal(untouched.snapshot, null);
    assert.equal(snapshotNames(rig).length, 0);

    const overwritten = rig.bundle.applyImport(bundle, { overwrite: ['template:alpha'], basis: basisOf(plan) });
    assert.equal(resultOf(overwritten, 'template:alpha').status, 'applied');
    assert.equal(rig.service.listTemplates().items.find((entry) => entry.slug === 'alpha')?.name, 'New');
    assert.ok(overwritten.snapshot, 'snapshot taken');
    assert.deepEqual(snapshotNames(rig), [overwritten.snapshot]);
  });

  it('refuses an overwrite without a basis entry and one whose item changed since the preview', () => {
    const rig = newRig();
    const created = rig.service.createTemplate(templateBody({ slug: 'alpha', tools, name: 'Old' }));
    const bundle = bundleOf([template('alpha', { name: 'New' })]);
    const plan = rig.bundle.planImport(bundle, {});
    const noBasis = rig.bundle.applyImport(bundle, { overwrite: ['template:alpha'] });
    assert.equal(resultOf(noBasis, 'template:alpha').status, 'failed');
    assert.equal(resultOf(noBasis, 'template:alpha').code, 'BASIS_REQUIRED');
    assert.equal(noBasis.snapshot, null, 'a refused overwrite takes no snapshot');
    rig.service.updateTemplate(created.id, templateBody({ slug: 'alpha', tools, name: 'Edited meanwhile', rev: created.rev }));
    const stale = rig.bundle.applyImport(bundle, { overwrite: ['template:alpha'], basis: basisOf(plan) });
    assert.equal(resultOf(stale, 'template:alpha').code, 'STALE');
    assert.equal(rig.service.listTemplates().items[0].name, 'Edited meanwhile');
  });

  it('refuses a block or folder overwrite without a basis, and a block that changed since the preview (STALE)', () => {
    const rig = newRig();
    addProject(rig, 'p1', '/target/one');
    const stored = rig.blocks.create({ name: 'beta', description: 'Old', mode: 'writable', scope: { kind: 'global' }, content: 'stored', maxChars: 2000 }).block;
    seedProjectBlock(rig, 'notes', { '/target/one': 'folder stored' });
    const bundle = bundleOf([], [
      globalBlock('beta', { description: 'New', content: 'from bundle' }),
      projectBlock('notes', { contents: [{ directory: '/source/a', content: 'folder new' }] }),
    ]);
    const projectMap = { [valuesKeyOf('/source/a')]: 'p1' };
    const plan = rig.bundle.planImport(bundle, { projectMap });
    const folderKey = (itemOf(plan, 'block:notes').folders as { key: string }[])[0].key;
    const keys = ['block:beta', folderKey];
    const bare = rig.bundle.applyImport(bundle, { overwrite: keys, projectMap });
    assert.equal(resultOf(bare, 'block:beta').code, 'BASIS_REQUIRED');
    assert.equal(resultOf(bare, 'block:notes').folders?.[0].code, 'BASIS_REQUIRED');
    assert.equal(bare.snapshot, null);
    assert.equal(blockByName(rig, 'beta').content, 'stored');
    // The definition changed after the preview: only that item is stale.
    rig.blocks.update(stored.id, { name: 'beta', description: 'Edited meanwhile', mode: 'writable', scope: { kind: 'global' }, content: 'stored', maxChars: 2000, expectedRev: stored.rev });
    const stale = rig.bundle.applyImport(bundle, { overwrite: keys, projectMap, basis: basisOf(plan) });
    assert.equal(resultOf(stale, 'block:beta').code, 'STALE');
    assert.equal(blockByName(rig, 'beta').description, 'Edited meanwhile');
    assert.equal(resultOf(stale, 'block:notes').folders?.[0].status, 'applied');
    assert.equal(folderText(rig, 'notes', '/target/one')?.content, 'folder new');
  });

  it('migrates a block saved by an older version before comparing, so the preview revision stays valid', () => {
    const rig = newRig();
    writeLegacyBlock(rig, 'old-notes', '/work/old', 'legacy text');
    const bundle = bundleOf([], [projectBlock('old-notes', { description: 'Updated' })]);
    const plan = rig.bundle.planImport(bundle, {});
    const row = itemOf(plan, 'block:old-notes');
    assert.equal(row.status, 'conflict');
    assert.equal(row.overwritable, true, 'moved to per-folder content by the plan itself');
    const result = rig.bundle.applyImport(bundle, { overwrite: ['block:old-notes'], basis: basisOf(plan) });
    assert.equal(resultOf(result, 'block:old-notes').status, 'applied', JSON.stringify(result));
    assert.equal(blockByName(rig, 'old-notes').description, 'Updated');
    assert.equal(folderText(rig, 'old-notes', '/work/old')?.content, 'legacy text', 'the legacy text became that folder\'s text and was kept');
  });

  it('applies a sensitive item only when its own key is ticked', () => {
    const rig = newRig();
    const bundle = bundleOf([template('risky', { tools: ['Bash'] }), template('calm')]);
    const first = rig.bundle.applyImport(bundle, {});
    assert.equal(resultOf(first, 'template:risky').status, 'skipped');
    assert.equal(resultOf(first, 'template:risky').code, 'SENSITIVE_NOT_ACCEPTED');
    assert.equal(resultOf(first, 'template:calm').status, 'applied');
    const second = rig.bundle.applyImport(bundle, { acceptSensitive: ['template:risky'] });
    assert.equal(resultOf(second, 'template:risky').status, 'applied');
  });

  it('keeps stored text and writer when a text-less bundle overwrites a global block', () => {
    const rig = newRig();
    rig.blocks.create({ name: 'beta', description: 'Old', mode: 'writable', scope: { kind: 'global' }, content: 'keep me', maxChars: 2000 }, 'agent:writer');
    const bundle = bundleOf([], [globalBlock('beta', { description: 'New description', mode: 'read-only', maxChars: 3000 })]);
    const plan = rig.bundle.planImport(bundle, {});
    assert.equal(itemOf(plan, 'block:beta').status, 'conflict');
    rig.bundle.applyImport(bundle, { overwrite: ['block:beta'], basis: basisOf(plan) });
    const stored = blockByName(rig, 'beta');
    assert.deepEqual([stored.content, stored.lastWriter, stored.description, stored.mode, stored.maxChars], ['keep me', 'agent:writer', 'New description', 'read-only', 3000]);
  });

  it('keeps the agent label on imported agent text and labels user and unknown writers as the user', () => {
    const rig = newRig();
    addProject(rig, 'p1', '/t/one');
    const bundle = bundleOf([], [
      globalBlock('agent-text', { content: 'from agent', lastWriter: 'agent:planner' }),
      globalBlock('null-text', { content: 'x', lastWriter: null }),
      projectBlock('folder-text', { contents: [{ directory: '/src/a', content: 'agent folder', lastWriter: 'agent:planner' }] }),
    ]);
    rig.bundle.applyImport(bundle, { projectMap: { [valuesKeyOf('/src/a')]: 'p1' } });
    assert.equal(blockByName(rig, 'agent-text').lastWriter, 'agent:planner');
    assert.equal(blockByName(rig, 'null-text').lastWriter, 'user');
    assert.equal(folderText(rig, 'folder-text', '/t/one')?.lastWriter, 'agent:planner');
  });

  it('never lets a name that exists with the other scope kind be overwritten', () => {
    const rig = newRig();
    rig.blocks.create({ name: 'clash', description: '', mode: 'writable', scope: { kind: 'global' }, content: 'g', maxChars: 100 });
    const bundle = bundleOf([], [projectBlock('clash')]);
    const plan = rig.bundle.planImport(bundle, {});
    const item = itemOf(plan, 'block:clash');
    assert.equal(item.status, 'conflict');
    assert.equal(item.code, 'BLOCK_SCOPE_IMMUTABLE');
    assert.equal(item.overwritable, false);
    const result = rig.bundle.applyImport(bundle, { overwrite: ['block:clash'], basis: basisOf(plan) });
    assert.equal(resultOf(result, 'block:clash').status, 'failed');
    assert.equal(resultOf(result, 'block:clash').code, 'BLOCK_SCOPE_IMMUTABLE');
    assert.equal(blockByName(rig, 'clash').scope.kind, 'global');
  });

  it('marks a store name used twice as ambiguous and not overwritable', () => {
    const rig = newRig();
    writeLegacyBlock(rig, 'twin', '/a', 't1');
    writeLegacyBlock(rig, 'twin', '/b', 't2');
    const plan = rig.bundle.planImport(bundleOf([], [projectBlock('twin')]), {});
    const item = itemOf(plan, 'block:twin');
    assert.equal(item.status, 'conflict');
    assert.equal(item.code, 'BLOCK_NAME_AMBIGUOUS');
    assert.equal(item.overwritable, false);
  });

  it('refuses a read-only target for an agent actor and records agent text under the agent name', () => {
    const rig = newRig();
    rig.blocks.create({ name: 'locked', description: '', mode: 'read-only', scope: { kind: 'global' }, content: 'orig', maxChars: 100 });
    rig.blocks.create({ name: 'open', description: '', mode: 'writable', scope: { kind: 'global' }, content: 'orig', maxChars: 100 });
    const bundle = bundleOf([], [globalBlock('locked', { content: 'changed', maxChars: 100 }), globalBlock('open', { content: 'changed', maxChars: 100 }), globalBlock('made', { content: 'new text' })]);
    const plan = rig.bundle.planImport(bundle, {});
    const result = rig.bundle.applyImport(bundle, {
      overwrite: ['block:locked', 'block:open'], basis: basisOf(plan), actor: { kind: 'agent', name: 'manager' },
    });
    assert.equal(resultOf(result, 'block:locked').code, 'BLOCK_READ_ONLY');
    assert.equal(blockByName(rig, 'locked').content, 'orig');
    assert.equal(blockByName(rig, 'open').lastWriter, 'agent:manager');
    assert.equal(blockByName(rig, 'made').lastWriter, 'agent:manager');
  });

  it('never writes folder text for an agent actor', () => {
    const rig = newRig();
    addProject(rig, 'p1', '/t/one');
    const bundle = bundleOf([], [projectBlock('notes', { contents: [{ directory: '/src/a', content: 'text' }] })]);
    const result = rig.bundle.applyImport(bundle, { projectMap: { [valuesKeyOf('/src/a')]: 'p1' }, actor: { kind: 'agent', name: 'manager' } });
    const folders = resultOf(result, 'block:notes').folders ?? [];
    assert.equal(folders[0].status, 'skipped');
    assert.equal(folders[0].code, 'FOLDER_TEXT_HOST_ONLY');
    assert.equal(rig.blocks.listContents(blockByName(rig, 'notes').id).contents.length, 0);
  });
});

describe('agent bundle import: project blocks and folder text', () => {
  const source = '/source/alpha';
  const sourceKey = valuesKeyOf(source);

  it('creates the definition without a target and skips only the unmapped folder entry', () => {
    const rig = newRig();
    addProject(rig, 'p1', '/target/one');
    const bundle = bundleOf([], [projectBlock('notes', { contents: [{ directory: source, content: 'mapped' }, { directory: '/source/beta', content: 'unmapped' }] })]);
    const plan = rig.bundle.planImport(bundle, { projectMap: { [sourceKey]: 'p1' } });
    const rows = itemOf(plan, 'block:notes').folders ?? [];
    assert.deepEqual(rows.map((row) => [row.sourceDirectory, row.sourceKey, row.status, row.code]).sort(), [
      [source, sourceKey, 'new', undefined],
      ['/source/beta', valuesKeyOf('/source/beta'), 'skipped', 'no-target-folder'],
    ].sort());
    assert.equal(plan.hasFolderText, true);
    const result = rig.bundle.applyImport(bundle, { projectMap: { [sourceKey]: 'p1' } });
    const item = resultOf(result, 'block:notes');
    assert.equal(item.status, 'applied');
    assert.equal(item.partial, true);
    assert.equal(result.partial, true);
    assert.equal(folderText(rig, 'notes', '/target/one')?.content, 'mapped');
    assert.equal(rig.blocks.listContents(blockByName(rig, 'notes').id).contents.length, 1);
  });

  it('treats an unknown project id as an unmapped folder', () => {
    const rig = newRig();
    const bundle = bundleOf([], [projectBlock('notes', { contents: [{ directory: source, content: 'x' }] })]);
    const plan = rig.bundle.planImport(bundle, { projectMap: { [sourceKey]: 'does-not-exist' } });
    assert.equal(itemOf(plan, 'block:notes').folders?.[0].status, 'skipped');
  });

  it('never takes a folder from the bundle: scope.directory is ignored and the real folder comes from the project', () => {
    const rig = newRig();
    addProject(rig, 'p1', '/target/one');
    const raw = {
      format: 'remotecli.agent-bundle', version: 1, exportedAt: '', templates: [],
      memoryBlocks: [{ ...projectBlock('notes'), scope: { kind: 'project', directory: '/etc/evil' }, contents: [{ directory: source, content: 'text' }] }],
    } as never;
    const result = rig.bundle.applyImport(raw, { projectMap: { [sourceKey]: 'p1' } });
    assert.equal(resultOf(result, 'block:notes').status, 'applied');
    const stored = rig.blocks.listContents(blockByName(rig, 'notes').id).contents;
    assert.deepEqual(stored.map((entry) => entry.directory), ['/target/one']);
    assert.ok(!JSON.stringify(rig.blocks.list()).includes('/etc/evil'));
    const plan = rig.bundle.planImport(raw, {});
    assert.ok(itemOf(plan, 'block:notes').problems.some((problem) => problem.code === 'ignored-field'));
  });

  it('marks a relative or NUL directory in a folder entry invalid without blocking the definition', () => {
    const rig = newRig();
    const plan = rig.bundle.planImport(bundleOf([], [projectBlock('rel', { contents: [{ directory: 'relative/dir', content: 'x' }] }), projectBlock('nul', { contents: [{ directory: '/a\0b', content: 'x' }] })]), {});
    for (const name of ['rel', 'nul']) {
      const item = itemOf(plan, `block:${name}`);
      assert.equal(item.status, 'new', 'the definition still imports');
      assert.equal(item.folders?.[0].status, 'invalid');
      assert.equal(item.folders?.[0].code, 'INVALID_DIRECTORY');
    }
  });

  it('overwriting a project definition never touches folder files; a folder entry overwrites only its own folder and only when ticked', () => {
    const rig = newRig();
    addProject(rig, 'p1', '/target/one');
    addProject(rig, 'p2', '/target/two');
    seedProjectBlock(rig, 'notes', { '/target/one': 'one old', '/target/two': 'two old' });
    const bundle = bundleOf([], [projectBlock('notes', { description: 'Changed', contents: [{ directory: '/source/a', content: 'one new' }, { directory: '/source/b', content: 'two new' }] })]);
    const projectMap = { [valuesKeyOf('/source/a')]: 'p1', [valuesKeyOf('/source/b')]: 'p2' };
    const plan = rig.bundle.planImport(bundle, { projectMap });
    const rows = itemOf(plan, 'block:notes').folders ?? [];
    assert.deepEqual(rows.map((row) => row.status), ['conflict', 'conflict']);
    const definitionOnly = rig.bundle.applyImport(bundle, { overwrite: ['block:notes'], projectMap, basis: basisOf(plan) });
    assert.equal(blockByName(rig, 'notes').description, 'Changed');
    assert.equal(folderText(rig, 'notes', '/target/one')?.content, 'one old');
    assert.equal(folderText(rig, 'notes', '/target/two')?.content, 'two old');
    assert.equal(resultOf(definitionOnly, 'block:notes').partial, true);
    const firstFolder = rows.find((row) => row.sourceDirectory === '/source/a') as { key: string };
    const plan2 = rig.bundle.planImport(bundle, { projectMap });
    rig.bundle.applyImport(bundle, { overwrite: [firstFolder.key], projectMap, basis: basisOf(plan2) });
    assert.equal(folderText(rig, 'notes', '/target/one')?.content, 'one new');
    assert.equal(folderText(rig, 'notes', '/target/two')?.content, 'two old');
  });

  it('fails a folder overwrite when an agent wrote the folder after the preview (STALE) and keeps the agent text', () => {
    const rig = newRig();
    addProject(rig, 'p1', '/target/one');
    seedProjectBlock(rig, 'notes', { '/target/one': 'stored' });
    const bundle = bundleOf([], [projectBlock('notes', { contents: [{ directory: '/source/a', content: 'from bundle' }] })]);
    const projectMap = { [valuesKeyOf('/source/a')]: 'p1' };
    const plan = rig.bundle.planImport(bundle, { projectMap });
    const folderKey = (itemOf(plan, 'block:notes').folders as { key: string }[])[0].key;
    rig.blocks.writeForRun({ directory: '/target/one', agentName: 'worker' }, 'notes', 'agent line', 'append');
    const result = rig.bundle.applyImport(bundle, { overwrite: [folderKey], projectMap, basis: basisOf(plan) });
    const folder = resultOf(result, 'block:notes').folders?.[0];
    assert.equal(folder?.status, 'failed');
    assert.equal(folder?.code, 'STALE');
    assert.equal(folderText(rig, 'notes', '/target/one')?.content, 'stored\nagent line');
  });

  it('fails entries over the 200-file cap, over maxChars, and for a block that needs attention, never rolling the definition back', () => {
    const rig = newRig();
    const full = seedProjectBlock(rig, 'full', {});
    for (let index = 0; index < 200; index += 1) rig.blocks.addContent(full.id, `/full/${index}`);
    addProject(rig, 'extra', '/full/extra');
    addProject(rig, 'p1', '/target/one');
    const bundle = bundleOf([], [
      projectBlock('full', { contents: [{ directory: '/source/a', content: 'x' }] }),
      projectBlock('small', { maxChars: 5, contents: [{ directory: '/source/a', content: 'too long text' }] }),
    ]);
    const projectMap = { [valuesKeyOf('/source/a')]: 'extra' };
    const plan = rig.bundle.planImport(bundle, { projectMap });
    assert.equal(itemOf(plan, 'block:full').folders?.[0].status, 'invalid');
    assert.equal(itemOf(plan, 'block:full').folders?.[0].code, 'BLOCK_CONTENT_LIMIT_REACHED');
    assert.equal(itemOf(plan, 'block:small').folders?.[0].code, 'BLOCK_TOO_LARGE');
    const result = rig.bundle.applyImport(bundle, { projectMap });
    assert.equal(resultOf(result, 'block:small').status, 'applied');
    assert.equal(resultOf(result, 'block:small').partial, true);
    assert.equal(resultOf(result, 'block:small').folders?.[0].status, 'failed');
    assert.ok(blockByName(rig, 'small'), 'definition stays applied');
    writeLegacyBlock(rig, 'attention', '/work/legacy', 'old', { corruptContentFile: true });
    const attentionPlan = rig.bundle.planImport(bundleOf([], [projectBlock('attention', { contents: [{ directory: '/source/a', content: 'x' }] })]), { projectMap: { [valuesKeyOf('/source/a')]: 'p1' } });
    assert.equal(itemOf(attentionPlan, 'block:attention').folders?.[0].code, 'BLOCK_NOT_MIGRATED');
  });

  it('marks two entries with the same source folder, and two sources mapped to one folder, as invalid', () => {
    const rig = newRig();
    addProject(rig, 'p1', '/target/one');
    addProject(rig, 'p2', '/target/one');
    const sameSource = bundleOf([], [projectBlock('notes', { contents: [{ directory: 'C:\\Work\\A', content: '1' }, { directory: 'c:/work/a/', content: '2' }] })]);
    const planA = rig.bundle.planImport(sameSource, { projectMap: { [valuesKeyOf('C:\\Work\\A')]: 'p1' } });
    const rowsA = itemOf(planA, 'block:notes').folders ?? [];
    assert.ok(rowsA.every((row) => row.status === 'invalid' && row.code === 'DUPLICATE_KEY'), JSON.stringify(rowsA));
    const sameTarget = bundleOf([], [projectBlock('two', { contents: [{ directory: '/s/a', content: '1' }, { directory: '/s/b', content: '2' }] })]);
    const planB = rig.bundle.planImport(sameTarget, { projectMap: { [valuesKeyOf('/s/a')]: 'p1', [valuesKeyOf('/s/b')]: 'p2' } });
    const rowsB = itemOf(planB, 'block:two').folders ?? [];
    assert.deepEqual(rowsB.map((row) => row.status), ['new', 'invalid']);
    assert.equal(rowsB[1].code, 'DUPLICATE_TARGET_FOLDER');
  });

  it('refuses to overwrite or delete a block that cannot be backed up and applies the rest', () => {
    const rig = newRig();
    writeLegacyBlock(rig, 'attention', '/work/legacy', 'old', { corruptContentFile: true });
    const corrupt = seedProjectBlock(rig, 'with-corrupt', { '/f/one': 'text' });
    const contentsDir = path.join(rig.root, 'agent-profiles', 'memory-block-contents', corrupt.id);
    fs.writeFileSync(path.join(contentsDir, 'ffffffffffffffff.json'), '{ broken');
    const bundle = bundleOf([template('fresh')], [projectBlock('attention', { description: 'x' }), projectBlock('with-corrupt', { description: 'y' })]);
    const plan = rig.bundle.planImport(bundle, {});
    assert.equal(itemOf(plan, 'block:attention').code, 'BLOCK_NOT_MIGRATED');
    assert.equal(itemOf(plan, 'block:with-corrupt').code, 'BLOCK_CONTENT_CORRUPT');
    const result = rig.bundle.applyImport(bundle, { overwrite: ['block:attention', 'block:with-corrupt'], basis: basisOf(plan) });
    assert.equal(resultOf(result, 'block:attention').code, 'BLOCK_NOT_MIGRATED');
    assert.equal(resultOf(result, 'block:with-corrupt').code, 'BLOCK_CONTENT_CORRUPT');
    assert.equal(resultOf(result, 'template:fresh').status, 'applied');
    assert.equal(result.snapshot, null, 'nothing overwritable, no snapshot needed');
  });

  it('checks folder text against the smaller of the stored and the bundle limit, so a limit change cannot leave a half-applied block', () => {
    const rig = newRig();
    addProject(rig, 'p1', '/target/one');
    seedProjectBlock(rig, 'notes', { '/target/one': 'short' });
    const bundle = bundleOf([], [projectBlock('notes', { maxChars: 100, contents: [{ directory: '/source/a', content: 'x'.repeat(150) }] })]);
    const projectMap = { [valuesKeyOf('/source/a')]: 'p1' };
    const plan = rig.bundle.planImport(bundle, { projectMap });
    assert.equal(itemOf(plan, 'block:notes').folders?.[0].status, 'invalid');
    assert.equal(itemOf(plan, 'block:notes').folders?.[0].code, 'BLOCK_TOO_LARGE');
  });

  it('refuses an overwrite when a folder text file of any block is unreadable (the snapshot would be incomplete)', () => {
    const rig = newRig();
    rig.service.createTemplate(templateBody({ slug: 'alpha', tools, name: 'Old' }));
    const corrupt = seedProjectBlock(rig, 'with-corrupt', { '/f/one': 'text' });
    fs.writeFileSync(path.join(rig.root, 'agent-profiles', 'memory-block-contents', corrupt.id, 'ffffffffffffffff.json'), '{ broken');
    const bundle = bundleOf([template('alpha', { name: 'New' })]);
    const plan = rig.bundle.planImport(bundle, {});
    const error = failureOf(() => rig.bundle.applyImport(bundle, { overwrite: ['template:alpha'], basis: basisOf(plan) }));
    assert.equal(error.code, 'SNAPSHOT_UNAVAILABLE');
    assert.equal(rig.service.listTemplates().items[0].name, 'Old');
  });

  it('flags tools that run commands or write whatever their letter case or spacing', () => {
    const rig = newRig();
    const plan = rig.bundle.planImport(bundleOf([
      template('lower', { tools: ['bash'] }), template('upper', { tools: ['WRITE'] }), template('spaced', { tools: ['Bash (rm -rf:*)'] }), template('mcp-upper', { tools: ['MCP__x__y'] }),
    ]), {});
    for (const slug of ['lower', 'upper', 'spaced', 'mcp-upper']) assert.equal(itemOf(plan, `template:${slug}`).sensitive.length, 1, slug);
  });

  it('applies 500 folder entries within a bounded time', () => {
    const rig = newRig();
    const blocks: MemoryBlockBundleEntry[] = [];
    const projectMap: Record<string, string> = {};
    for (let b = 0; b < 3; b += 1) {
      const contents = Array.from({ length: b === 2 ? 100 : 200 }, (_, f) => {
        const directory = `/src/${b}/${f}`;
        rig.state.projects.set(`p-${b}-${f}`, `/dst/${b}/${f}`);
        projectMap[valuesKeyOf(directory)] = `p-${b}-${f}`;
        return { directory, content: `text ${b} ${f}` };
      });
      blocks.push(projectBlock(`bulk-${b}`, { contents }));
    }
    const started = Date.now();
    const result = rig.bundle.applyImport(bundleOf([], blocks), { projectMap });
    const elapsed = Date.now() - started;
    assert.equal(result.partial, false);
    assert.ok(elapsed < 5000, `took ${elapsed} ms`);
    console.log(`[bundle] 500 folder entries applied in ${elapsed} ms`);
  });
});

describe('agent bundle snapshots and restore', () => {
  it('refuses an overwrite when a stored record is unreadable (SNAPSHOT_UNAVAILABLE) and changes nothing', () => {
    const rig = newRig();
    rig.service.createTemplate(templateBody({ slug: 'alpha', tools, name: 'Old' }));
    fs.writeFileSync(path.join(rig.root, 'agent-profiles', 'templates', '11111111-1111-4111-8111-111111111111.json'), '{ broken');
    const bundle = bundleOf([template('alpha', { name: 'New' })]);
    const plan = rig.bundle.planImport(bundle, {});
    const error = failureOf(() => rig.bundle.applyImport(bundle, { overwrite: ['template:alpha'], basis: basisOf(plan) }));
    assert.equal(error.code, 'SNAPSHOT_UNAVAILABLE');
    assert.equal(error.statusCode, 409);
    assert.equal(rig.service.listTemplates().items[0].name, 'Old');
    const creation = rig.bundle.applyImport(bundleOf([template('brand-new')]), {});
    assert.equal(creation.partial, false, 'a creation-only apply does not need a backup');
  });

  it('writes unique, private snapshot files and prunes only those older than 14 days and beyond the newest 50', () => {
    const rig = newRig();
    const bundle = rig.bundle.exportBundle({ includeBlockContent: true }).bundle;
    const names = new Set<string>();
    for (let index = 0; index < 30; index += 1) names.add(rig.snapshots.write(bundle));
    assert.equal(names.size, 30, 'frozen clock, no collision');
    const [first] = names;
    assert.match(first, /^20260601T120000000Z-[0-9a-f]{4}\.json$/);
    const directory = path.join(rig.root, 'agent-profiles', 'backups');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(directory, first)).mode & 0o777, 0o600);
      assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    }
    // Old snapshots: 60 of them, 40 days old, plus the 30 recent ones: the old ones beyond the newest 50 go.
    rig.state.now = new Date('2026-04-20T00:00:00.000Z');
    for (let index = 0; index < 60; index += 1) rig.snapshots.write(bundle);
    rig.state.now = new Date('2026-06-01T12:00:01.000Z');
    rig.snapshots.write(bundle);
    const kept = rig.snapshots.list().map((snapshot) => snapshot.name);
    assert.equal(kept.length, 50, 'newest 50 are kept');
    assert.ok(kept.every((name) => name >= '20260420'), 'only older-than-14-days ones were removed');
    assert.ok(kept.includes(first) || kept.some((name) => name.startsWith('20260601')), 'recent snapshots survive');
    // A fresh store never loses a snapshot younger than 14 days even beyond 50.
    const young = newRig();
    for (let index = 0; index < 55; index += 1) young.snapshots.write(bundle);
    assert.equal(young.snapshots.list().length, 55);
  });

  it('still writes a snapshot, exclusively, on a file system without hard links', (context) => {
    const rig = newRig();
    const bundle = rig.bundle.exportBundle({ includeBlockContent: true }).bundle;
    context.mock.method(fs, 'linkSync', () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); });
    const first = rig.snapshots.write(bundle);
    assert.ok(snapshotNames(rig).includes(first));
    assert.deepEqual(fs.readdirSync(path.join(rig.root, 'agent-profiles', 'backups')).filter((entry) => entry.startsWith('.tmp-')), [], 'no temp file left');
  });

  it('restores an overwritten template and block and a deleted folder text from a snapshot, taking its own snapshot first', () => {
    const rig = newRig();
    addProject(rig, 'p1', '/target/one');
    const created = rig.service.createTemplate(templateBody({ slug: 'alpha', tools, name: 'Original' }));
    rig.blocks.create({ name: 'beta', description: 'Orig', mode: 'writable', scope: { kind: 'global' }, content: 'original text', maxChars: 2000 });
    seedProjectBlock(rig, 'notes', { '/target/one': 'folder original' });
    const projectMap = { [valuesKeyOf('/source/a')]: 'p1' };
    const bundle = bundleOf([template('alpha', { name: 'Changed' })], [
      globalBlock('beta', { description: 'Changed', content: 'changed text' }),
      projectBlock('notes', { contents: [{ directory: '/source/a', content: 'folder changed' }] }),
    ]);
    const plan = rig.bundle.planImport(bundle, { projectMap });
    const applied = rig.bundle.applyImport(bundle, { overwrite: allKeys(plan), projectMap, basis: basisOf(plan) });
    assert.ok(applied.snapshot);
    assert.equal(folderText(rig, 'notes', '/target/one')?.content, 'folder changed');
    // The user later deletes the folder text and a newer template appears.
    rig.blocks.removeFolder(blockByName(rig, 'notes').id, '/target/one');
    rig.service.createTemplate(templateBody({ slug: 'created-later', tools }));
    const before = snapshotNames(rig).length;
    const restored = rig.bundle.restoreSnapshot(applied.snapshot as string);
    assert.equal(restored.partial, false, JSON.stringify(restored));
    assert.equal(rig.service.listTemplates().items.find((entry) => entry.slug === 'alpha')?.name, 'Original');
    assert.equal(blockByName(rig, 'beta').content, 'original text');
    assert.equal(blockByName(rig, 'beta').description, 'Orig');
    assert.equal(folderText(rig, 'notes', '/target/one')?.content, 'folder original', 'deleted folder text is back');
    assert.ok(rig.service.listTemplates().items.some((entry) => entry.slug === 'created-later'), 'items created later are kept');
    assert.ok(restored.snapshot && snapshotNames(rig).length > before, 'restore took its own snapshot');
    assert.ok(created.id);
  });

  it('refuses a restore name that is not a snapshot file name', () => {
    const rig = newRig();
    fs.writeFileSync(path.join(rig.root, 'outside.json'), '{}');
    for (const name of ['../outside.json', '..\\outside.json', 'outside.json', '', '/etc/passwd', '20260601T120000000Z-abcd.json/../../x', '20260601T120000000Z-ABCD.json']) {
      const error = failureOf(() => rig.bundle.restoreSnapshot(name));
      assert.equal(error.code, 'SNAPSHOT_NOT_FOUND', name);
    }
    assert.equal(failureOf(() => rig.bundle.restoreSnapshot('20260601T120000000Z-abcd.json')).code, 'SNAPSHOT_NOT_FOUND');
  });

  it('skips a scope clash and an unmigrated block on restore with their codes', () => {
    const rig = newRig();
    rig.blocks.create({ name: 'clash', description: '', mode: 'writable', scope: { kind: 'project' }, maxChars: 100 });
    const snapshotName = rig.snapshots.write(rig.bundle.exportBundle({ includeBlockContent: true }).bundle);
    const clashId = blockByName(rig, 'clash').id;
    rig.blocks.remove(clashId);
    rig.blocks.create({ name: 'clash', description: '', mode: 'writable', scope: { kind: 'global' }, content: 'now global', maxChars: 100 });
    writeLegacyBlock(rig, 'legacy', '/x', 'old', { corruptContentFile: true });
    const legacySnapshot = rig.snapshots.write({
      ...rig.bundle.exportBundle({ includeBlockContent: true }).bundle,
      memoryBlocks: [projectBlockEntry('legacy')],
    });
    const clash = rig.bundle.restoreSnapshot(snapshotName);
    assert.equal(resultOf(clash, 'block:clash').code, 'BLOCK_SCOPE_IMMUTABLE');
    assert.equal(blockByName(rig, 'clash').scope.kind, 'global');
    const legacy = rig.bundle.restoreSnapshot(legacySnapshot);
    assert.equal(resultOf(legacy, 'block:legacy').code, 'BLOCK_NOT_MIGRATED');
  });

  it('lists snapshots newest first with their counts', () => {
    const rig = newRig();
    rig.service.createTemplate(templateBody({ slug: 'alpha', tools }));
    seedProjectBlock(rig, 'notes', { '/a': 'x', '/b': 'y' });
    rig.snapshots.write(rig.bundle.exportBundle({ includeBlockContent: true }).bundle);
    rig.state.now = new Date('2026-06-02T00:00:00.000Z');
    rig.snapshots.write(rig.bundle.exportBundle({ includeBlockContent: true }).bundle);
    const listed = rig.bundle.listSnapshots();
    assert.equal(listed.length, 2);
    assert.ok(listed[0].createdAt > listed[1].createdAt);
    assert.deepEqual([listed[0].templates, listed[0].blocks, listed[0].folders], [1, 1, 2]);
    assert.ok(listed[0].bytes > 0);
  });
});

function projectBlockEntry(name: string): MemoryBlockBundleEntry {
  return projectBlock(name, { contents: [] });
}

describe('tool lists are read the way the agent file is', () => {
  it('flags a sensitive tool hidden in a comma-joined entry, and keeps a rule with a comma whole', () => {
    const rig = newRig();
    const plan = rig.bundle.planImport(bundleOf([
      template('joined', { tools: ['Read, Bash'] }),
      template('rule', { tools: ['Read', 'Bash(git log, --oneline)'] }),
      template('calm', { tools: ['Read, Grep'] }),
    ]), {});
    assert.deepEqual(itemOf(plan, 'template:joined').sensitive, ['tool:Bash']);
    assert.deepEqual(itemOf(plan, 'template:rule').sensitive, ['tool:Bash(git log, --oneline)']);
    assert.deepEqual(itemOf(plan, 'template:calm').sensitive, []);
  });
});

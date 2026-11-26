import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import type { AgentChangeset, ChangesetReviewItem, ImportResult } from '@/shared/types.js';

import { parseChangeset } from '../agent-profiles.changeset.js';

import { makeServiceRig, templateBody } from './service-rig.js';

const rigs: ReturnType<typeof makeServiceRig>[] = [];
const newRig = () => { const rig = makeServiceRig(); rigs.push(rig); return rig; };
afterEach(() => { while (rigs.length) rigs.pop()?.cleanup(); });
type Rig = ReturnType<typeof makeServiceRig>;

const template = (slug: string, overrides: Record<string, unknown> = {}) => ({
  slug, family: 'worker', name: `Template ${slug}`, description: 'Does a thing.', instructions: `Work as ${slug}.`, tools: ['Read', 'Grep'], ...overrides,
});
const block = (name: string, overrides: Record<string, unknown> = {}) => ({
  name, description: `Block ${name}`, mode: 'writable', scope: { kind: 'global' }, maxChars: 2000, ...overrides,
});
const MAX_CHANGESET_BYTES = 20 * 1024;
const upsert = (templates: unknown[] = [], memoryBlocks: unknown[] = []) => ({ templates, memoryBlocks });
const code = (run: () => unknown): string | undefined => {
  try { run(); } catch (error) { return (error as { code?: string }).code; }
  return undefined;
};
const itemOf = (items: ChangesetReviewItem[], key: string): ChangesetReviewItem => {
  const found = items.find((item) => item.key === key);
  assert.ok(found, `review has ${key}`);
  return found;
};
const resultOf = (result: ImportResult, key: string) => {
  const found = result.items.find((item) => item.key === key);
  assert.ok(found, `result has ${key}`);
  return found;
};
const review = (rig: Rig, changeset: AgentChangeset, managers: string[] = ['manager']) => rig.bundle.reviewChangeset(parseChangeset(changeset), managers).items;
const seedProjectBlock = (rig: Rig, name: string, folders: Record<string, string>) => {
  const { block: created } = rig.blocks.create({ name, description: 'p', mode: 'writable', scope: { kind: 'project' }, maxChars: 2000 });
  for (const [directory, text] of Object.entries(folders)) {
    const { content } = rig.blocks.addContent(created.id, directory);
    rig.blocks.updateContent(created.id, directory, text, content.rev);
  }
  return created.id;
};
const blockNames = (rig: Rig) => rig.blocks.list().blocks.map((entry) => entry.name).sort();

describe('parseChangeset', () => {
  it('accepts an upsert without the bundle envelope and a delete list, and returns fresh objects', () => {
    const raw = { upsert: upsert([template('alpha')]), delete: [{ kind: 'block', key: 'old-notes' }] };
    const parsed = parseChangeset(raw);
    assert.equal(parsed.upsert?.format, 'remotecli.agent-bundle');
    assert.equal(parsed.upsert?.version, 1);
    assert.equal(parsed.upsert?.templates.length, 1);
    assert.deepEqual(parsed.delete, [{ kind: 'block', key: 'old-notes' }]);
    assert.notEqual(parsed.delete, raw.delete);
  });

  it('refuses what is not a changeset: non-objects, unknown fields (settings and managers included), a wrong envelope', () => {
    for (const bad of [null, [], 'x', 5]) assert.equal(code(() => parseChangeset(bad)), 'CHANGESET_INVALID');
    assert.equal(code(() => parseChangeset({ upsert: upsert([template('a')]), settings: { profileManagerAgents: ['x'] } })), 'CHANGESET_INVALID');
    assert.equal(code(() => parseChangeset({ upsert: { ...upsert([template('a')]), profileManagerAgents: ['x'] } })), 'CHANGESET_INVALID');
    assert.equal(code(() => parseChangeset({ upsert: { format: 'other', templates: [template('a')] } })), 'CHANGESET_INVALID');
    assert.equal(code(() => parseChangeset({ upsert: { version: 2, templates: [template('a')] } })), 'CHANGESET_INVALID');
    assert.equal(code(() => parseChangeset({ upsert: { templates: 'a' } })), 'CHANGESET_INVALID');
  });

  it('refuses an empty changeset and more than five items in total', () => {
    assert.equal(code(() => parseChangeset({})), 'CHANGESET_EMPTY');
    assert.equal(code(() => parseChangeset({ upsert: upsert() })), 'CHANGESET_EMPTY');
    const five = { upsert: upsert([template('a'), template('b'), template('c')], [block('d')]), delete: [{ kind: 'block', key: 'e' }] };
    assert.doesNotThrow(() => parseChangeset(five));
    assert.equal(code(() => parseChangeset({ ...five, delete: [{ kind: 'block', key: 'e' }, { kind: 'block', key: 'f' }] })), 'CHANGESET_TOO_MANY_ITEMS');
  });

  it('refuses more than 20 KB', () => {
    const big = { upsert: upsert([template('a', { instructions: 'x'.repeat(MAX_CHANGESET_BYTES) })]) };
    assert.equal(code(() => parseChangeset(big)), 'CHANGESET_TOO_LARGE');
    assert.doesNotThrow(() => parseChangeset({ upsert: upsert([template('a', { instructions: 'x'.repeat(MAX_CHANGESET_BYTES - 500) })]) }));
    // Bytes, not characters.
    assert.equal(code(() => parseChangeset({ upsert: upsert([template('a', { instructions: 'é'.repeat(MAX_CHANGESET_BYTES / 2) })]) })), 'CHANGESET_TOO_LARGE');
  });

  it('refuses the same key upserted and deleted, or deleted twice', () => {
    assert.equal(code(() => parseChangeset({ upsert: upsert([template('a')]), delete: [{ kind: 'template', key: 'a' }] })), 'CHANGESET_CONFLICT');
    assert.equal(code(() => parseChangeset({ upsert: upsert([], [block('n')]), delete: [{ kind: 'block', key: 'n' }] })), 'CHANGESET_CONFLICT');
    assert.equal(code(() => parseChangeset({ delete: [{ kind: 'block', key: 'n' }, { kind: 'block', key: 'n' }] })), 'CHANGESET_CONFLICT');
    // A template and a block may share a name: the keys differ.
    assert.doesNotThrow(() => parseChangeset({ upsert: upsert([template('a')]), delete: [{ kind: 'block', key: 'a' }] }));
  });

  it('refuses a delete that does not name a template slug or a block name', () => {
    for (const bad of [{ kind: 'x', key: 'a' }, { kind: 'template', key: 'Not A Slug' }, { kind: 'block', key: '../etc' }, { kind: 'block' }, 'a', { kind: 'template', key: 'a'.repeat(41) }]) {
      assert.equal(code(() => parseChangeset({ delete: [bad] })), 'CHANGESET_INVALID', JSON.stringify(bad));
    }
  });
});

describe('guardrails (review)', () => {
  it('a plain template create has no refusal, no tick, and a readable summary', () => {
    const rig = newRig();
    const [item] = review(rig, { upsert: upsert([template('alpha')]) });
    assert.equal(item.action, 'create');
    assert.equal(item.needsTick, false);
    assert.equal(item.refusal, undefined);
    assert.equal(item.basis, 'absent');
    assert.match(item.lines.join('\n'), /New template "Template alpha"/);
    assert.match(item.lines.join('\n'), /Tools: Read, Grep/);
  });

  it('refuses mcpServers, a missing or empty tools line, and any mcp__profiles__ tool (any case, or the whole server)', () => {
    const rig = newRig();
    const cases: [string, Record<string, unknown>, string][] = [
      ['mcp', { mcpServers: ['docs'] }, 'TEMPLATE_MCP_SERVERS'],
      ['notools', { tools: undefined }, 'TEMPLATE_NO_TOOLS'],
      ['emptytools', { tools: [] }, 'TEMPLATE_NO_TOOLS'],
      ['own', { tools: ['Read', 'mcp__profiles__profiles_propose'] }, 'TEMPLATE_PROFILES_TOOL'],
      ['upper', { tools: ['MCP__Profiles__profiles_list'] }, 'TEMPLATE_PROFILES_TOOL'],
      ['server', { tools: ['mcp__profiles'] }, 'TEMPLATE_PROFILES_TOOL'],
    ];
    for (const [slug, overrides, expected] of cases) {
      const [item] = review(rig, { upsert: upsert([template(slug, overrides)]) });
      assert.equal(item.action, 'refused', slug);
      assert.equal(item.refusal?.code, expected, slug);
    }
    // Other servers' tools are only sensitive, not refused.
    const [other] = review(rig, { upsert: upsert([template('ok', { tools: ['mcp__docs__search'] })]) });
    assert.equal(other.refusal, undefined);
    assert.deepEqual(other.sensitive, ['tool:mcp__docs__search']);
  });

  it('flags Bash, Write, Edit, NotebookEdit and skills as sensitive (they need the user\'s tick at confirm)', () => {
    const rig = newRig();
    const [item] = review(rig, { upsert: upsert([template('sens', { tools: ['Bash(git *)', 'Write', 'Edit', 'NotebookEdit', 'Read'], skills: ['deploy'] })]) });
    assert.equal(item.refusal, undefined);
    assert.deepEqual(item.sensitive, ['tool:Bash(git *)', 'tool:Write', 'tool:Edit', 'tool:NotebookEdit', 'skills']);
    assert.match(item.lines.join('\n'), /Sensitive, needs its own tick/);
  });

  it('the template of a managing agent cannot be created, overwritten or deleted by an agent', () => {
    const rig = newRig();
    rig.service.createTemplate(templateBody({ slug: 'manager', tools: ['Read'], instructions: 'old' }));
    rig.service.createTemplate(templateBody({ slug: 'deputy', tools: ['Read'] }));
    const items = review(rig, {
      upsert: upsert([template('manager', { instructions: 'new' }), template('boss')]), delete: [{ kind: 'template', key: 'deputy' }],
    }, ['manager', 'boss', 'deputy']);
    assert.deepEqual(items.map((item) => item.refusal?.code), ['TEMPLATE_IS_MANAGER', 'TEMPLATE_IS_MANAGER', 'TEMPLATE_IS_MANAGER']);
  });

  it('an overwrite lists the changed fields with before and after, needs a tick, and carries the live revision', () => {
    const rig = newRig();
    const created = rig.service.createTemplate(templateBody({ slug: 'alpha', tools: ['Read'], instructions: 'old text', description: 'same' }));
    const [item] = review(rig, { upsert: upsert([template('alpha', { instructions: 'new text', description: 'same', tools: ['Read', 'Grep'], name: 'Code reviewer', family: 'worker', params: [], bindings: { project: true, knowledge: false } })]) });
    assert.equal(item.action, 'overwrite');
    assert.equal(item.needsTick, true);
    assert.equal(item.basis, created.rev);
    const fields = item.changes.map((change) => change.field);
    assert.ok(fields.includes('instructions') && fields.includes('tools'), fields.join());
    assert.ok(!fields.includes('description'), 'an unchanged field is not listed');
    const instructions = item.changes.find((change) => change.field === 'instructions');
    assert.deepEqual([instructions?.before, instructions?.after], ['old text', 'new text']);
  });

  it('an identical item is a no-op without a tick', () => {
    const rig = newRig();
    rig.service.createTemplate(template('alpha') as never);
    const [item] = review(rig, { upsert: upsert([template('alpha')]) });
    assert.equal(item.action, 'identical');
    assert.equal(item.needsTick, false);
  });

  it('an invalid item is refused with the validator\'s code', () => {
    const rig = newRig();
    const [item] = review(rig, { upsert: upsert([{ slug: 'Bad Slug', tools: ['Read'] }]) });
    assert.equal(item.action, 'refused');
    assert.equal(item.refusal?.code, 'INVALID_PROFILE_INPUT');
  });

  it('refuses ANY folder text entry or scope.directory on a block, even an identical or new one', () => {
    const rig = newRig();
    const withEntry = block('p1', { scope: { kind: 'project' }, contents: [{ directory: path.resolve('/work/a'), content: 'x' }] });
    const withDirectory = block('p2', { scope: { kind: 'project', directory: path.resolve('/work/a') } });
    const withBadContents = block('p3', { scope: { kind: 'project' }, contents: 'x' });
    for (const entry of [withEntry, withDirectory, withBadContents]) {
      const [item] = review(rig, { upsert: upsert([], [entry]) });
      assert.equal(item.refusal?.code, 'BLOCK_FOLDER_HOST_ONLY', entry.name);
    }
    // An empty list says nothing and is harmless; a project block proposal is a definition alone.
    const [empty] = review(rig, { upsert: upsert([], [block('p4', { scope: { kind: 'project' }, contents: [] })]) });
    assert.equal(empty.action, 'create');
    assert.match(empty.lines.join('\n'), /add the folders/);
  });

  it('refuses a block whose name exists with the other scope, a read-only block, and one with an unreadable folder file', () => {
    const rig = newRig();
    rig.blocks.create({ name: 'notes', description: '', mode: 'writable', scope: { kind: 'global' }, content: 'a', maxChars: 2000 });
    rig.blocks.create({ name: 'rules', description: '', mode: 'read-only', scope: { kind: 'global' }, content: 'b', maxChars: 2000 });
    const damagedId = seedProjectBlock(rig, 'damaged', { [path.resolve('/work/a')]: 'text' });
    const folderDirectory = path.join(rig.root, 'agent-profiles', 'memory-block-contents', damagedId);
    const [file] = fs.readdirSync(folderDirectory);
    fs.writeFileSync(path.join(folderDirectory, file), 'not json');
    const items = review(rig, { upsert: upsert([], [
      block('notes', { scope: { kind: 'project' } }), block('rules', { description: 'changed' }), block('damaged', { scope: { kind: 'project' }, description: 'changed' }),
    ]) });
    assert.deepEqual(items.map((item) => item.refusal?.code), ['BLOCK_SCOPE_IMMUTABLE', 'BLOCK_READ_ONLY', 'BLOCK_CONTENT_CORRUPT']);
  });

  it('a block overwrite shows the text change and needs a tick', () => {
    const rig = newRig();
    const created = rig.blocks.create({ name: 'notes', description: 'a', mode: 'writable', scope: { kind: 'global' }, content: 'one', maxChars: 2000 }).block;
    const [item] = review(rig, { upsert: upsert([], [block('notes', { description: 'a', content: 'one two' })]) });
    assert.equal(item.action, 'overwrite');
    assert.equal(item.needsTick, true);
    assert.equal(item.basis, created.rev);
    assert.deepEqual(item.changes.map((change) => change.field), ['content']);
    assert.match(item.lines.join('\n'), /Text: 7 characters/);
  });

  it('a delete shows what is lost: text size of a global block, folders and total size of a project block, and refuses what cannot be deleted', () => {
    const rig = newRig();
    rig.blocks.create({ name: 'notes', description: '', mode: 'writable', scope: { kind: 'global' }, content: 'twelve chars', maxChars: 2000 });
    rig.blocks.create({ name: 'rules', description: '', mode: 'read-only', scope: { kind: 'global' }, content: 'b', maxChars: 2000 });
    seedProjectBlock(rig, 'proj', { [path.resolve('/work/a')]: 'aaaa', [path.resolve('/work/b')]: 'bbbbbb' });
    rig.service.createTemplate(templateBody({ slug: 'alpha', tools: ['Read'] }));
    const items = review(rig, { delete: [
      { kind: 'block', key: 'notes' }, { kind: 'block', key: 'proj' }, { kind: 'block', key: 'rules' }, { kind: 'block', key: 'missing' }, { kind: 'template', key: 'alpha' },
    ] });
    assert.match(itemOf(items, 'block:notes').lines.join('\n'), /text \(12 characters\)/);
    assert.match(itemOf(items, 'block:proj').lines.join('\n'), /2 folder\(s\) \(10 characters in total\)/);
    assert.equal(itemOf(items, 'block:rules').refusal?.code, 'BLOCK_READ_ONLY');
    assert.equal(itemOf(items, 'block:missing').refusal?.code, 'CHANGESET_TARGET_NOT_FOUND');
    assert.equal(itemOf(items, 'template:alpha').action, 'delete');
    assert.ok(items.filter((item) => item.action === 'delete').every((item) => item.needsTick));
  });

  it('refuses a delete of a block with an unreadable folder file', () => {
    const rig = newRig();
    const id = seedProjectBlock(rig, 'damaged', { [path.resolve('/work/a')]: 'text' });
    const folderDirectory = path.join(rig.root, 'agent-profiles', 'memory-block-contents', id);
    fs.writeFileSync(path.join(folderDirectory, fs.readdirSync(folderDirectory)[0]), '{');
    assert.equal(review(rig, { delete: [{ kind: 'block', key: 'damaged' }] })[0].refusal?.code, 'BLOCK_CONTENT_CORRUPT');
  });
});

describe('applyChangeset', () => {
  const agent = (rig: Rig, changeset: AgentChangeset, choices: Partial<Parameters<Rig['bundle']['applyChangeset']>[1]> = {}) =>
    rig.bundle.applyChangeset(parseChangeset(changeset), { agentName: 'manager', managers: ['manager'], ...choices });

  it('creates need no tick; the writer of a global block text is agent:<name>', () => {
    const rig = newRig();
    const result = agent(rig, { upsert: upsert([template('alpha')], [block('notes', { content: 'hello', lastWriter: 'user' })]) });
    assert.equal(resultOf(result, 'template:alpha').status, 'applied');
    assert.equal(resultOf(result, 'block:notes').status, 'applied');
    assert.equal(result.partial, false);
    assert.equal(rig.blocks.list().blocks[0].lastWriter, 'agent:manager', 'a claimed writer is ignored');
  });

  it('a delete needs its tick and the basis the review showed; a moved target is STALE', () => {
    const rig = newRig();
    rig.blocks.create({ name: 'notes', description: '', mode: 'writable', scope: { kind: 'global' }, content: 'a', maxChars: 2000 });
    const changeset = { delete: [{ kind: 'block' as const, key: 'notes' }] };
    const shown = review(rig, changeset)[0];
    assert.equal(resultOf(agent(rig, changeset), 'block:notes').code, 'DELETE_NOT_TICKED');
    assert.equal(resultOf(agent(rig, changeset, { overwrite: ['block:notes'] }), 'block:notes').code, 'BASIS_REQUIRED');
    const id = rig.blocks.list().blocks[0].id;
    rig.blocks.update(id, { name: 'notes', description: 'moved', mode: 'writable', scope: { kind: 'global' }, content: 'a', maxChars: 2000, expectedRev: 1 });
    const stale = agent(rig, changeset, { overwrite: ['block:notes'], basis: { 'block:notes': shown.basis } });
    assert.equal(resultOf(stale, 'block:notes').code, 'STALE');
    assert.equal(stale.snapshot, null, 'no snapshot when nothing is deleted');
    assert.deepEqual(blockNames(rig), ['notes']);
  });

  it('a confirmed delete of a project block takes a snapshot first, removes its folder files, and restore brings them back', () => {
    const rig = newRig();
    const folder = path.resolve('/work/a');
    const id = seedProjectBlock(rig, 'proj', { [folder]: 'folder text' });
    const changeset = { delete: [{ kind: 'block' as const, key: 'proj' }] };
    const { basis } = review(rig, changeset)[0];
    const result = agent(rig, changeset, { overwrite: ['block:proj'], basis: { 'block:proj': basis } });
    assert.equal(resultOf(result, 'block:proj').status, 'applied');
    assert.ok(result.snapshot, 'a snapshot was written');
    assert.deepEqual(blockNames(rig), []);
    assert.equal(fs.existsSync(path.join(rig.root, 'agent-profiles', 'memory-block-contents', id)), false, 'folder files are gone');
    rig.bundle.restoreSnapshot(result.snapshot as string);
    const restored = rig.blocks.list().blocks.find((entry) => entry.name === 'proj');
    assert.ok(restored, 'the block is back');
    assert.equal(rig.blocks.listContents(restored.id).contents[0]?.content, 'folder text', 'and so is its folder text');
  });

  it('a template delete is snapshotted and restorable', () => {
    const rig = newRig();
    rig.service.createTemplate(templateBody({ slug: 'alpha', tools: ['Read'] }));
    const changeset = { delete: [{ kind: 'template' as const, key: 'alpha' }] };
    const { basis } = review(rig, changeset)[0];
    const result = agent(rig, changeset, { overwrite: ['template:alpha'], basis: { 'template:alpha': basis } });
    assert.equal(resultOf(result, 'template:alpha').status, 'applied');
    assert.equal(rig.service.listTemplates().items.length, 0);
    rig.bundle.restoreSnapshot(result.snapshot as string);
    assert.equal(rig.service.listTemplates().items[0]?.slug, 'alpha');
  });

  it('an overwrite needs its tick and basis, takes a snapshot, and sensitive items need their own tick', () => {
    const rig = newRig();
    rig.service.createTemplate(templateBody({ slug: 'alpha', tools: ['Read'], instructions: 'old' }));
    const changeset = { upsert: upsert([template('alpha', { instructions: 'new', tools: ['Bash'] })]) };
    const [shown] = review(rig, changeset);
    assert.equal(resultOf(agent(rig, changeset), 'template:alpha').code, 'SENSITIVE_NOT_ACCEPTED');
    assert.equal(resultOf(agent(rig, changeset, { acceptSensitive: ['template:alpha'] }), 'template:alpha').code, 'CONFLICT');
    const applied = agent(rig, changeset, { acceptSensitive: ['template:alpha'], overwrite: ['template:alpha'], basis: { 'template:alpha': shown.basis } });
    assert.equal(resultOf(applied, 'template:alpha').status, 'applied');
    assert.ok(applied.snapshot);
    assert.equal(rig.service.listTemplates().items[0].instructions, 'new');
  });

  it('guardrails run again at apply: a block that became read-only, and a template that became a manager, are not written', () => {
    const rig = newRig();
    const created = rig.blocks.create({ name: 'notes', description: 'a', mode: 'writable', scope: { kind: 'global' }, content: 'one', maxChars: 2000 }).block;
    const changeset = { upsert: upsert([template('boss')], [block('notes', { description: 'a', content: 'two' })]) };
    const [, shown] = review(rig, changeset);
    rig.blocks.update(created.id, { name: 'notes', description: 'a', mode: 'read-only', scope: { kind: 'global' }, content: 'one', maxChars: 2000, expectedRev: created.rev });
    const result = agent(rig, changeset, { managers: ['manager', 'boss'], overwrite: ['block:notes'], basis: { 'block:notes': shown.basis } });
    assert.equal(resultOf(result, 'template:boss').code, 'TEMPLATE_IS_MANAGER');
    assert.equal(resultOf(result, 'block:notes').code, 'BLOCK_READ_ONLY');
    assert.equal(rig.service.listTemplates().items.length, 0);
    assert.equal(rig.blocks.list().blocks[0].content, 'one');
    assert.equal(result.partial, true);
  });

  it('a forged changeset with folder text is refused at apply and writes no folder file', () => {
    const rig = newRig();
    const forged = { upsert: { format: 'remotecli.agent-bundle', version: 1, exportedAt: '', templates: [], memoryBlocks: [block('proj', { scope: { kind: 'project' }, contents: [{ directory: path.resolve('/work/a'), content: 'x' }] })] } } as AgentChangeset;
    const result = rig.bundle.applyChangeset(forged, { agentName: 'manager', managers: ['manager'] });
    assert.equal(resultOf(result, 'block:proj').code, 'BLOCK_FOLDER_HOST_ONLY');
    assert.deepEqual(blockNames(rig), []);
  });

  it('deletes run before upserts: a freed slot lets a new block in at the 50-block limit', () => {
    const rig = newRig();
    for (let index = 0; index < 50; index += 1) rig.blocks.create({ name: `b-${index}`, description: '', mode: 'writable', scope: { kind: 'global' }, content: '', maxChars: 2000 });
    const changeset = { upsert: upsert([], [block('fresh')]), delete: [{ kind: 'block' as const, key: 'b-0' }] };
    const { basis } = review(rig, changeset)[1];
    // Without the delete the new block would be over the limit.
    assert.equal(resultOf(rig.bundle.applyChangeset(parseChangeset({ upsert: upsert([], [block('fresh')]) }), { agentName: 'manager', managers: [] }), 'block:fresh').code, 'BLOCK_LIMIT_REACHED');
    const result = agent(rig, changeset, { overwrite: ['block:b-0'], basis: { 'block:b-0': basis } });
    assert.equal(resultOf(result, 'block:b-0').status, 'applied');
    assert.equal(resultOf(result, 'block:fresh').status, 'applied');
  });

  it('one snapshot taken before the deletes holds the deleted and the overwritten item', () => {
    const rig = newRig();
    rig.service.createTemplate(templateBody({ slug: 'gone', tools: ['Read'] }));
    rig.service.createTemplate(templateBody({ slug: 'edited', tools: ['Read'], instructions: 'before' }));
    const changeset = { upsert: upsert([template('edited', { instructions: 'after' })]), delete: [{ kind: 'template' as const, key: 'gone' }] };
    const [edit, gone] = review(rig, changeset);
    const result = agent(rig, changeset, { overwrite: ['template:edited', 'template:gone'], basis: { 'template:edited': edit.basis, 'template:gone': gone.basis } });
    assert.equal(result.partial, false);
    rig.bundle.restoreSnapshot(result.snapshot as string);
    const restored = rig.service.listTemplates().items;
    assert.deepEqual(restored.map((item) => item.slug).sort(), ['edited', 'gone']);
    assert.equal(restored.find((item) => item.slug === 'edited')?.instructions, 'before');
  });

  it('an agent actor without a name is refused', () => {
    const rig = newRig();
    assert.equal(code(() => rig.bundle.applyChangeset(parseChangeset({ upsert: upsert([template('a')]) }), { agentName: ' ', managers: [] })), 'INVALID_PROFILE_INPUT');
  });
});

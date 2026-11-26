import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';
import type { MemoryBlock } from '@/shared/types.js';

import { makeServiceRig } from './service-rig.js';

const ALPHA = path.resolve(path.sep, 'work', 'alpha');
const OTHER = path.resolve(path.sep, 'work', 'other');

const globalBlock = (overrides: Record<string, unknown> = {}) => ({
  name: 'style-guide', description: 'House style', mode: 'read-only', scope: { kind: 'global' }, content: 'Be brief.', ...overrides,
});
const projectBlock = (overrides: Record<string, unknown> = {}) => globalBlock({ scope: { kind: 'project' }, ...overrides });

type Rig = ReturnType<typeof makeServiceRig>;
/** Creates a project block and gives each folder an (empty) content file, like the user does in the UI. */
const projectBlockIn = (rig: Rig, name: string, folders: string[], overrides: Record<string, unknown> = {}) => {
  const { block } = rig.blocks.create(projectBlock({ name, mode: 'writable', ...overrides }));
  for (const folder of folders) rig.blocks.addContent(block.id, folder);
  return block;
};

const codeOf = (run: () => unknown): string | undefined => {
  try { run(); } catch (error) { return error instanceof AppError ? error.code : `not-an-app-error: ${String(error)}`; }
  return undefined;
};

test('create stores a block at rev 1 with defaults, lastWriter user, and a file under memory-blocks/', () => {
  const rig = makeServiceRig();
  try {
    const { block } = rig.blocks.create(globalBlock({ mode: 'writable' }));
    assert.equal(block.rev, 1);
    assert.equal(block.maxChars, 2000);
    assert.equal(block.lastWriter, 'user');
    assert.deepEqual(block.scope, { kind: 'global' });
    assert.ok(fs.existsSync(path.join(rig.root, 'agent-profiles', 'memory-blocks', `${block.id}.json`)));
    assert.deepEqual(rig.blocks.list().blocks.map((item) => item.id), [block.id]);
    assert.equal(rig.blocks.create(globalBlock({ name: 'empty', content: '' })).block.lastWriter, null, 'no content yet, no writer yet');
  } finally { rig.cleanup(); }
});

test('input rules: slug name, mode, scope, maxChars hard cap, content within maxChars', () => {
  const rig = makeServiceRig();
  try {
    const bad: Record<string, unknown>[] = [
      { name: 'Has Space' }, { name: 'UPPER' }, { name: '' }, { name: 'a'.repeat(41) }, { name: 'double--hyphen' },
      { mode: 'rw' }, { mode: undefined },
      { scope: undefined }, { scope: { kind: 'project', directory: ALPHA } }, { scope: { kind: 'project', directory: 'relative/dir' } }, { scope: { kind: 'team' } },
      { maxChars: 0 }, { maxChars: 20001 }, { maxChars: 1.5 }, { maxChars: '10' },
      { content: 'x'.repeat(11), maxChars: 10 }, { content: 5 },
    ];
    for (const overrides of bad) {
      assert.equal(codeOf(() => rig.blocks.create(globalBlock(overrides))), 'INVALID_PROFILE_INPUT', JSON.stringify(overrides));
    }
    assert.equal(rig.blocks.create(globalBlock({ maxChars: 20000 })).block.maxChars, 20000, 'the hard cap itself is allowed');
    assert.equal(rig.blocks.create(globalBlock({ name: 'ten', content: 'x'.repeat(10), maxChars: 10 })).block.content.length, 10);
  } finally { rig.cleanup(); }
});

test('names are unique across all scopes: a name used globally or by a project block cannot be used again', () => {
  const rig = makeServiceRig();
  try {
    rig.blocks.create(globalBlock());
    assert.equal(codeOf(() => rig.blocks.create(globalBlock())), 'BLOCK_NAME_TAKEN');
    assert.equal(codeOf(() => rig.blocks.create(projectBlock())), 'BLOCK_NAME_TAKEN', 'a project block cannot reuse a global name');
    rig.blocks.create(projectBlock({ name: 'alpha-notes' }));
    assert.equal(codeOf(() => rig.blocks.create(projectBlock({ name: 'alpha-notes' }))), 'BLOCK_NAME_TAKEN');
    assert.equal(codeOf(() => rig.blocks.create(globalBlock({ name: 'alpha-notes' }))), 'BLOCK_NAME_TAKEN', 'a global block cannot reuse a project name');
    assert.equal(rig.blocks.list().blocks.length, 2);
    const refusal = (() => { try { rig.blocks.create(globalBlock()); } catch (error) { return error as AppError; } return null; })();
    assert.equal(refusal?.statusCode, 409);
    assert.match(refusal?.message ?? '', /unique across global and all project scopes/);
  } finally { rig.cleanup(); }
});

test('update: renaming into a name used elsewhere is refused; keeping the own name never clashes with itself; the scope cannot change', () => {
  const rig = makeServiceRig();
  try {
    rig.blocks.create(globalBlock());
    const project = rig.blocks.create(projectBlock({ name: 'alpha-notes', mode: 'writable' })).block;
    const edit = (overrides: Record<string, unknown>, expectedRev = project.rev) =>
      rig.blocks.update(project.id, { ...projectBlock({ name: 'alpha-notes', mode: 'writable' }), expectedRev, ...overrides });

    assert.equal(codeOf(() => edit({ name: 'style-guide' })), 'BLOCK_NAME_TAKEN', 'a global name');
    const kept = edit({ description: 'new description' }).block;
    assert.equal(kept.name, 'alpha-notes');
    assert.equal(kept.rev, 2, 'the definition rev');
    assert.equal(codeOf(() => edit({ scope: { kind: 'global' } }, kept.rev)), 'BLOCK_SCOPE_IMMUTABLE', 'project to global');
    const global = rig.blocks.list().blocks.find((block) => block.name === 'style-guide');
    assert.equal(codeOf(() => rig.blocks.update(global!.id, { ...globalBlock(), scope: { kind: 'project' }, expectedRev: global!.rev })), 'BLOCK_SCOPE_IMMUTABLE', 'global to project');
    assert.equal(edit({ name: 'fresh-name' }, kept.rev).block.name, 'fresh-name');
  } finally { rig.cleanup(); }
});

test('a project definition holds no content: create and update ignore content, the definition stays empty', () => {
  const rig = makeServiceRig();
  try {
    const { block } = rig.blocks.create(projectBlock({ content: 'ignored' }));
    assert.equal(block.content, '');
    assert.equal(block.lastWriter, null);
    const updated = rig.blocks.update(block.id, { ...projectBlock({ content: 'ignored too' }), expectedRev: block.rev }).block;
    assert.equal(updated.content, '');
    assert.equal(rig.blocks.update(block.id, { ...projectBlock({ content: undefined, description: 'x' }), expectedRev: updated.rev }).block.description, 'x', 'content is not required for a project block');
  } finally { rig.cleanup(); }
});

test('blocks stored before names became unique across scopes stay (never deleted) and stay editable; no new clash can be made', () => {
  const rig = makeServiceRig();
  try {
    const legacy = (scope: Record<string, unknown>, content: string) => rig.store.insert<MemoryBlock>('memory-blocks', {
      name: 'rules', description: '', mode: 'writable', scope, content, maxChars: 2000, lastWriter: 'user',
    } as never);
    const globalRules = legacy({ kind: 'global' }, 'GLOBAL');
    const projectRules = legacy({ kind: 'project', directory: path.resolve(ALPHA) }, 'PROJECT');
    assert.equal(rig.blocks.list().blocks.length, 2, 'both are still listed');

    // Resolution is unchanged: the project block of the run wins, other runs see the global one.
    assert.equal(rig.blocks.readForRun({ directory: ALPHA }, 'rules').content, 'PROJECT');
    assert.equal(rig.blocks.readForRun({ directory: OTHER }, 'rules').content, 'GLOBAL');

    // Each can still be saved under its own name (no self-collision, no collision with its twin).
    const body = (block: MemoryBlock, content: string) => ({
      name: block.name, description: block.description, mode: block.mode, scope: { kind: block.scope.kind }, content, maxChars: block.maxChars, expectedRev: block.rev,
    });
    assert.equal(rig.blocks.update(globalRules.id, body(globalRules, 'GLOBAL 2')).block.content, 'GLOBAL 2');
    const savedProject = rig.blocks.update(projectRules.id, body(projectRules, 'PROJECT 2')).block;
    assert.equal(savedProject.rev, 2);
    assert.equal(rig.blocks.readForRun({ directory: ALPHA }, 'rules').content, 'PROJECT', 'a project definition ignores content; the old folder keeps its text');
    assert.equal(savedProject.needsAttention !== undefined, true, 'still flagged: not moved because of the clash');
    // But a third one, or a rename onto the shared name, is refused.
    assert.equal(codeOf(() => rig.blocks.create(globalBlock({ name: 'rules' }))), 'BLOCK_NAME_TAKEN');
    const other = rig.blocks.create(globalBlock({ name: 'other' })).block;
    assert.equal(codeOf(() => rig.blocks.update(other.id, { ...body(other, ''), name: 'rules' })), 'BLOCK_NAME_TAKEN');
  } finally { rig.cleanup(); }
});

test('at most 50 blocks exist in total', () => {
  const rig = makeServiceRig();
  try {
    for (let index = 0; index < 50; index += 1) rig.blocks.create(globalBlock({ name: `block-${index}` }));
    assert.equal(codeOf(() => rig.blocks.create(globalBlock({ name: 'one-too-many' }))), 'BLOCK_LIMIT_REACHED');
    assert.equal(codeOf(() => rig.blocks.create(projectBlock({ name: 'other-scope' }))), 'BLOCK_LIMIT_REACHED', 'the limit counts every scope');
    const [first] = rig.blocks.list().blocks;
    rig.blocks.remove(first.id);
    assert.doesNotThrow(() => rig.blocks.create(globalBlock({ name: 'fits-again' })));
  } finally { rig.cleanup(); }
});

test('update: the user may edit a read-only block; a stale expectedRev is the existing 409; content is required; rename keeps names unique', () => {
  const rig = makeServiceRig();
  try {
    const { block } = rig.blocks.create(globalBlock());
    const edit = (overrides: Record<string, unknown>, expectedRev = block.rev) =>
      rig.blocks.update(block.id, { ...globalBlock(), expectedRev, ...overrides });

    const updated = edit({ content: 'Be very brief.' }).block;
    assert.equal(updated.rev, 2);
    assert.equal(updated.content, 'Be very brief.');
    assert.equal(updated.mode, 'read-only', 'the user edited a read-only block');
    assert.equal(updated.lastWriter, 'user');

    assert.equal(codeOf(() => edit({ content: 'older' }, 1)), 'PROFILE_STALE');
    assert.equal(rig.blocks.list().blocks[0].content, 'Be very brief.');
    assert.equal(codeOf(() => rig.blocks.update(block.id, { ...globalBlock(), content: undefined, expectedRev: 2 })), 'INVALID_PROFILE_INPUT');
    assert.equal(codeOf(() => rig.blocks.update(block.id, { ...globalBlock() })), 'INVALID_PROFILE_INPUT', 'expectedRev is required');
    assert.equal(codeOf(() => rig.blocks.update('missing-id', { ...globalBlock(), expectedRev: 1 })), 'PROFILE_NOT_FOUND');

    const other = rig.blocks.create(globalBlock({ name: 'other' })).block;
    assert.equal(codeOf(() => rig.blocks.update(other.id, { ...globalBlock({ name: 'style-guide' }), expectedRev: other.rev })), 'BLOCK_NAME_TAKEN');
    assert.equal(rig.blocks.update(other.id, { ...globalBlock({ name: 'other' }), expectedRev: other.rev }).block.name, 'other', 'keeping its own name is not a clash');
  } finally { rig.cleanup(); }
});

test('an edit that leaves the content alone keeps the last writer (an agent stays the writer)', () => {
  const rig = makeServiceRig();
  try {
    const { block } = rig.blocks.create(globalBlock({ mode: 'writable' }));
    const written = rig.blocks.writeForRun({ directory: ALPHA, agentName: 'orchestrator' }, 'style-guide', 'agent text', 'replace');
    const renamed = rig.blocks.update(block.id, { ...globalBlock({ mode: 'writable', content: 'agent text', description: 'New description' }), expectedRev: written.rev }).block;
    assert.equal(renamed.lastWriter, 'agent:orchestrator');
    assert.equal(renamed.description, 'New description');
  } finally { rig.cleanup(); }
});

test('remove deletes the file; an unknown id is 404', () => {
  const rig = makeServiceRig();
  try {
    const { block } = rig.blocks.create(globalBlock());
    assert.deepEqual(rig.blocks.remove(block.id), { ok: true });
    assert.equal(rig.blocks.list().blocks.length, 0);
    assert.equal(codeOf(() => rig.blocks.remove(block.id)), 'PROFILE_NOT_FOUND');
    assert.equal(codeOf(() => rig.blocks.remove('..%2Fx')), 'INVALID_PROFILE_ID');
  } finally { rig.cleanup(); }
});

test('agent write: read-only is refused and the content does not change', () => {
  const rig = makeServiceRig();
  try {
    rig.blocks.create(globalBlock());
    for (const how of ['replace', 'append'] as const) {
      assert.equal(codeOf(() => rig.blocks.writeForRun({ directory: ALPHA, agentName: 'orchestrator' }, 'style-guide', 'HACKED', how)), 'BLOCK_READ_ONLY');
    }
    const [stored] = rig.blocks.list().blocks;
    assert.equal(stored.content, 'Be brief.');
    assert.equal(stored.rev, 1, 'a refused write never touches the file');
    assert.equal(stored.lastWriter, 'user');
  } finally { rig.cleanup(); }
});

test('agent write: replace and append on a writable block, writer recorded as agent:<name>, rev grows', () => {
  const rig = makeServiceRig();
  try {
    rig.blocks.create(globalBlock({ name: 'notes', mode: 'writable', content: 'first' }));
    const context = { directory: ALPHA, agentName: 'orchestrator' };
    const appended = rig.blocks.writeForRun(context, 'notes', 'second', 'append');
    assert.equal(appended.content, 'first\nsecond');
    assert.equal(appended.lastWriter, 'agent:orchestrator');
    assert.equal(appended.rev, 2);
    const replaced = rig.blocks.writeForRun(context, 'notes', 'only this', 'replace');
    assert.equal(replaced.content, 'only this');
    assert.equal(rig.blocks.readForRun(context, 'notes').content, 'only this');
    // Append to an empty block adds no leading newline.
    rig.blocks.writeForRun(context, 'notes', '', 'replace');
    assert.equal(rig.blocks.writeForRun(context, 'notes', 'start', 'append').content, 'start');
  } finally { rig.cleanup(); }
});

test('agent write: a result over maxChars is refused whole (nothing is cut), also for append', () => {
  const rig = makeServiceRig();
  try {
    rig.blocks.create(globalBlock({ name: 'small', mode: 'writable', content: '12345', maxChars: 10 }));
    const context = { directory: null, agentName: 'orchestrator' };
    assert.equal(codeOf(() => rig.blocks.writeForRun(context, 'small', '1234567890X', 'replace')), 'BLOCK_TOO_LARGE');
    assert.equal(codeOf(() => rig.blocks.writeForRun(context, 'small', '123456', 'append')), 'BLOCK_TOO_LARGE', '5 + newline + 6 > 10');
    assert.equal(rig.blocks.readForRun(context, 'small').content, '12345');
    assert.equal(rig.blocks.writeForRun(context, 'small', '1234567890', 'replace').content, '1234567890', 'exactly maxChars fits');
  } finally { rig.cleanup(); }
});

test('agent write: unknown or invalid names are refused and no block is created', () => {
  const rig = makeServiceRig();
  try {
    const context = { directory: ALPHA, agentName: 'orchestrator' };
    for (const name of ['nope', '../escape', 'Has Space', '']) {
      assert.equal(codeOf(() => rig.blocks.writeForRun(context, name, 'x', 'replace')), 'BLOCK_NOT_FOUND', name);
      assert.equal(codeOf(() => rig.blocks.readForRun(context, name)), 'BLOCK_NOT_FOUND', name);
    }
    assert.equal(rig.blocks.list().blocks.length, 0);
  } finally { rig.cleanup(); }
});

test('scope isolation: a run sees the global blocks and project blocks that have content in its folder, never another folder\'s', () => {
  const rig = makeServiceRig();
  try {
    rig.blocks.create(globalBlock({ name: 'shared' }));
    projectBlockIn(rig, 'alpha-only', [ALPHA]);
    projectBlockIn(rig, 'other-only', [OTHER]);
    projectBlockIn(rig, 'both', [ALPHA, OTHER]);
    projectBlockIn(rig, 'nowhere', []);
    const names = (directory: string | null) => rig.blocks.listForRun({ directory }).map((block: MemoryBlock) => block.name);

    assert.deepEqual(names(ALPHA), ['alpha-only', 'both', 'shared']);
    assert.deepEqual(names(`${ALPHA}${path.sep}`), ['alpha-only', 'both', 'shared'], 'the same folder typed with a trailing separator');
    assert.deepEqual(names(OTHER), ['both', 'other-only', 'shared']);
    assert.deepEqual(names(null), ['shared'], 'no project folder: global blocks only');
    assert.deepEqual(names(path.resolve(path.sep, 'work', 'third')), ['shared'], 'a folder without content files sees no project block');

    const context = { directory: ALPHA, agentName: 'orchestrator' };
    assert.equal(codeOf(() => rig.blocks.readForRun(context, 'other-only')), 'BLOCK_NOT_FOUND');
    assert.equal(codeOf(() => rig.blocks.readForRun(context, 'nowhere')), 'BLOCK_NOT_FOUND', 'a definition without a file is invisible');
    assert.equal(codeOf(() => rig.blocks.writeForRun(context, 'other-only', 'x', 'replace')), 'BLOCK_NOT_FOUND');
    assert.equal(rig.blocks.listContents(rig.blocks.list().blocks.find((block) => block.name === 'other-only')!.id).contents[0].content, '', 'the other folder is untouched');
  } finally { rig.cleanup(); }
});

test('one project block, separate text per folder: writes land in the run\'s own content file only', () => {
  const rig = makeServiceRig();
  try {
    const block = projectBlockIn(rig, 'notes', [ALPHA, OTHER]);
    rig.blocks.writeForRun({ directory: ALPHA, agentName: 'a' }, 'notes', 'alpha text', 'replace');
    rig.blocks.writeForRun({ directory: OTHER, agentName: 'b' }, 'notes', 'other text', 'replace');
    rig.blocks.writeForRun({ directory: OTHER, agentName: 'b' }, 'notes', 'more', 'append');
    assert.equal(rig.blocks.readForRun({ directory: ALPHA }, 'notes').content, 'alpha text');
    const other = rig.blocks.readForRun({ directory: OTHER }, 'notes');
    assert.equal(other.content, 'other text\nmore');
    assert.equal(other.rev, 3, 'create = 1, then two writes');
    assert.equal(other.lastWriter, 'agent:b');
    assert.equal(other.definitionRev, 1);
    const { contents } = rig.blocks.listContents(block.id);
    assert.deepEqual(contents.map((item) => item.content).sort(), ['alpha text', 'other text\nmore']);
    assert.equal(rig.blocks.list().blocks[0].content, '', 'the definition never holds the text');
  } finally { rig.cleanup(); }
});

test('an agent never creates a content file: a folder without one cannot write the block', () => {
  const rig = makeServiceRig();
  try {
    projectBlockIn(rig, 'notes', [ALPHA]);
    assert.equal(codeOf(() => rig.blocks.writeForRun({ directory: OTHER, agentName: 'a' }, 'notes', 'x', 'replace')), 'BLOCK_NOT_FOUND');
    assert.equal(rig.blocks.hasProjectContent(OTHER), false);
  } finally { rig.cleanup(); }
});

test('hasProjectContent is true only for the exact folder of a content file (empty counts); global blocks alone, other folders and no folder are false', () => {
  const rig = makeServiceRig();
  try {
    assert.equal(rig.blocks.hasProjectContent(ALPHA), false, 'empty store');
    rig.blocks.create(globalBlock({ name: 'shared' }));
    assert.equal(rig.blocks.hasProjectContent(ALPHA), false, 'a global block alone does not count');
    projectBlockIn(rig, 'alpha-only', []);
    assert.equal(rig.blocks.hasProjectContent(ALPHA), false, 'a definition without a file does not count');
    projectBlockIn(rig, 'alpha-notes', [ALPHA]);
    assert.equal(rig.blocks.hasProjectContent(ALPHA), true);
    assert.equal(rig.blocks.hasProjectContent(`${ALPHA}${path.sep}`), true, 'the same folder typed with a trailing separator');
    assert.equal(rig.blocks.hasProjectContent(OTHER), false, 'another project\'s folder');
    assert.equal(rig.blocks.hasProjectContent(path.join(ALPHA, 'src')), false, 'exact folder only: a subfolder is not the project');
    assert.equal(rig.blocks.hasProjectContent(null), false);
    assert.equal(rig.blocks.hasProjectContent(undefined), false);
    assert.equal(rig.blocks.hasProjectContent(''), false);
  } finally { rig.cleanup(); }
});

test('legacy same-name blocks: a project block wins over the global one for that project only, and agent writes land on it', () => {
  const rig = makeServiceRig();
  try {
    const legacy = (scope: Record<string, unknown>, content: string) => rig.store.insert<MemoryBlock>('memory-blocks', {
      name: 'rules', description: '', mode: 'writable', scope, content, maxChars: 2000, lastWriter: 'user',
    } as never);
    legacy({ kind: 'global' }, 'GLOBAL');
    legacy({ kind: 'project', directory: path.resolve(ALPHA) }, 'PROJECT');
    assert.equal(rig.blocks.readForRun({ directory: ALPHA }, 'rules').content, 'PROJECT');
    assert.equal(rig.blocks.readForRun({ directory: OTHER }, 'rules').content, 'GLOBAL');
    rig.blocks.writeForRun({ directory: ALPHA, agentName: 'a' }, 'rules', 'PROJECT-2', 'replace');
    assert.equal(rig.blocks.readForRun({ directory: OTHER }, 'rules').content, 'GLOBAL', 'the write landed on the project block');
    assert.equal(rig.blocks.readForRun({ directory: ALPHA }, 'rules').content, 'PROJECT-2');
  } finally { rig.cleanup(); }
});

test('agent write with expectedRev: stale is BLOCK_STALE (409) and writes nothing; current rev or none writes', () => {
  const rig = makeServiceRig();
  try {
    rig.blocks.create(globalBlock({ name: 'notes', mode: 'writable', content: 'first' }));
    const context = { directory: ALPHA, agentName: 'orchestrator' };
    const refused = (() => { try { rig.blocks.writeForRun(context, 'notes', 'late', 'replace', 0); } catch (error) { return error as AppError; } return null; })();
    assert.equal(refused?.code, 'BLOCK_STALE');
    assert.equal(refused?.statusCode, 409);
    assert.equal(rig.blocks.readForRun(context, 'notes').rev, 1, 'nothing was written');
    assert.equal(rig.blocks.writeForRun(context, 'notes', 'second', 'append', 1).content, 'first\nsecond');
    assert.equal(codeOf(() => rig.blocks.writeForRun(context, 'notes', 'x', 'replace', 1)), 'BLOCK_STALE', 'rev 1 is old now');
    assert.equal(rig.blocks.writeForRun(context, 'notes', 'third', 'append').content, 'first\nsecond\nthird', 'no expectedRev: still writes');
    assert.equal(rig.blocks.writeForRun(context, 'notes', 'only', 'replace', 3).content, 'only');
    // A read-only block is refused as read-only first, stale or not.
    rig.blocks.create(globalBlock({ name: 'locked' }));
    assert.equal(codeOf(() => rig.blocks.writeForRun(context, 'locked', 'x', 'replace', 99)), 'BLOCK_READ_ONLY');
  } finally { rig.cleanup(); }
});

test('agent write: append with empty content is refused (no bare newline, rev untouched); replace with empty is allowed', () => {
  const rig = makeServiceRig();
  try {
    rig.blocks.create(globalBlock({ name: 'notes', mode: 'writable', content: 'first' }));
    const context = { directory: ALPHA, agentName: 'orchestrator' };
    assert.equal(codeOf(() => rig.blocks.writeForRun(context, 'notes', '', 'append')), 'BLOCK_EMPTY_APPEND');
    const block = rig.blocks.readForRun(context, 'notes');
    assert.equal(block.content, 'first');
    assert.equal(block.rev, 1);
    assert.equal(rig.blocks.writeForRun(context, 'notes', '', 'replace').content, '');
  } finally { rig.cleanup(); }
});

test('a corrupt block file is skipped by the listing, is not overwritten, and the rest keeps working', () => {
  const rig = makeServiceRig();
  try {
    const { block } = rig.blocks.create(globalBlock({ name: 'good', mode: 'writable' }));
    const bad = rig.blocks.create(globalBlock({ name: 'bad', mode: 'writable' })).block;
    const badFile = path.join(rig.root, 'agent-profiles', 'memory-blocks', `${bad.id}.json`);
    fs.writeFileSync(badFile, '{ broken');
    assert.deepEqual(rig.blocks.list().blocks.map((item) => item.id), [block.id]);
    assert.equal(rig.blocks.writeForRun({ directory: null, agentName: 'a' }, 'good', 'ok', 'replace').content, 'ok');
    assert.equal(fs.readFileSync(badFile, 'utf8'), '{ broken');
    // A file that parses but has the wrong shape is corrupt too, not trusted.
    fs.writeFileSync(badFile, JSON.stringify({ ...bad, mode: 'root' }));
    assert.deepEqual(rig.blocks.list().blocks.map((item) => item.id), [block.id]);
  } finally { rig.cleanup(); }
});

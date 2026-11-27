import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { MemoryBlockDefinition } from '@/shared/types.js';

import { blockContentKey } from '../agent-profiles.store.js';

import { makeServiceRig } from './service-rig.js';

const ALPHA = path.resolve(path.sep, 'work', 'alpha');
const OTHER = path.resolve(path.sep, 'work', 'other');

type Rig = ReturnType<typeof makeServiceRig>;

/** A block as an older version stored it: one fixed folder in `scope.directory`, the text in the record. */
const seedLegacy = (rig: Rig, overrides: Record<string, unknown> = {}) => rig.store.insert<MemoryBlockDefinition>('memory-blocks', {
  name: 'notes', description: 'old', mode: 'writable', scope: { kind: 'project', directory: ALPHA }, content: 'LEGACY TEXT', maxChars: 2000, lastWriter: 'agent:orchestrator',
  ...overrides,
} as never);

const storeDir = (rig: Rig): string => path.join(rig.root, 'agent-profiles');
const definitionFile = (rig: Rig, id: string): string => path.join(storeDir(rig), 'memory-blocks', `${id}.json`);
const readDefinition = (rig: Rig, id: string) => JSON.parse(fs.readFileSync(definitionFile(rig, id), 'utf8')) as Record<string, unknown>;
const contentFilesOf = (rig: Rig, id: string): string[] => {
  try { return fs.readdirSync(path.join(storeDir(rig), 'memory-block-contents', id)).filter((name) => name.endsWith('.json')); } catch { return []; }
};

test('migration: a folder-bound block keeps its text, rev, writer and time in the old folder only; other folders do not see it', () => {
  const rig = makeServiceRig();
  try {
    const legacy = seedLegacy(rig);
    const before = fs.readFileSync(definitionFile(rig, legacy.id), 'utf8');

    const alpha = rig.blocks.readForRun({ directory: ALPHA }, 'notes');
    assert.equal(alpha.content, 'LEGACY TEXT');
    assert.equal(alpha.rev, legacy.rev);
    assert.equal(alpha.lastWriter, 'agent:orchestrator');
    assert.equal(alpha.updatedAt, legacy.updatedAt);
    assert.equal(alpha.needsAttention, undefined);
    assert.equal(rig.blocks.listForRun({ directory: OTHER }).length, 0);
    assert.equal(rig.blocks.hasProjectContent(OTHER), false);
    assert.equal(rig.blocks.hasProjectContent(ALPHA), true);

    const definition = readDefinition(rig, legacy.id);
    assert.deepEqual(definition.scope, { kind: 'project' });
    assert.equal(definition.content, '');
    assert.equal(contentFilesOf(rig, legacy.id).length, 1);
    assert.equal(rig.blocks.listContents(legacy.id).contents[0].directory, ALPHA);
    assert.equal(fs.readFileSync(path.join(storeDir(rig), 'memory-blocks.legacy', `${legacy.id}.json`), 'utf8'), before, 'the backup is the untouched old file');
    assert.deepEqual(rig.blocks.list().blocks.map((block) => block.needsAttention), [undefined]);

    // The migrated block is a normal project block: it can be given to another folder and written there.
    rig.blocks.addContent(legacy.id, OTHER);
    assert.equal(rig.blocks.writeForRun({ directory: OTHER, agentName: 'b' }, 'notes', 'other text', 'replace').content, 'other text');
    assert.equal(rig.blocks.readForRun({ directory: ALPHA }, 'notes').content, 'LEGACY TEXT');
  } finally { rig.cleanup(); }
});

test('migration: a Windows-style legacy folder lands on the content file every spelling of it finds', () => {
  const rig = makeServiceRig();
  try {
    const legacy = seedLegacy(rig, { scope: { kind: 'project', directory: 'C:\\Work\\Old' } });
    assert.equal(rig.blocks.readForRun({ directory: 'c:/work/old/' }, 'notes').content, 'LEGACY TEXT');
    assert.ok(rig.store.getContent(legacy.id, blockContentKey('C:/WORK/OLD')));
  } finally { rig.cleanup(); }
});

test('migration: running again changes nothing (no new files, definition and content untouched)', () => {
  const rig = makeServiceRig();
  try {
    const legacy = seedLegacy(rig);
    rig.blocks.migrateLegacyBlocks();
    const snapshot = () => ({
      definition: fs.readFileSync(definitionFile(rig, legacy.id), 'utf8'),
      content: contentFilesOf(rig, legacy.id).map((name) => fs.readFileSync(path.join(storeDir(rig), 'memory-block-contents', legacy.id, name), 'utf8')),
      backups: fs.readdirSync(path.join(storeDir(rig), 'memory-blocks.legacy')),
    });
    const first = snapshot();
    rig.blocks.migrateLegacyBlocks();
    rig.blocks.migrateLegacyBlocks();
    assert.deepEqual(snapshot(), first);
    assert.equal(rig.blocks.list().blocks[0].rev, legacy.rev + 1, 'the definition was rewritten exactly once');
  } finally { rig.cleanup(); }
});

test('migration: an interrupted run (backup and content written, definition still old) is finished by the next run without touching the text', () => {
  const rig = makeServiceRig();
  try {
    const legacy = seedLegacy(rig);
    rig.store.backupRecord('memory-blocks', legacy.id, 'memory-blocks.legacy');
    rig.store.createContent(legacy.id, blockContentKey(ALPHA), {
      directory: ALPHA, content: legacy.content, lastWriter: legacy.lastWriter, rev: legacy.rev, updatedAt: legacy.updatedAt,
    });
    rig.blocks.migrateLegacyBlocks();
    assert.deepEqual(readDefinition(rig, legacy.id).scope, { kind: 'project' });
    const content = rig.store.getContent(legacy.id, blockContentKey(ALPHA));
    assert.equal(content?.content, 'LEGACY TEXT');
    assert.equal(content?.rev, legacy.rev);
  } finally { rig.cleanup(); }
});

test('migration: an existing but unreadable content file aborts that block only; it stays visible in its old folder, flagged, and the file is not replaced', () => {
  const rig = makeServiceRig();
  try {
    const legacy = seedLegacy(rig);
    const healthy = seedLegacy(rig, { name: 'healthy', scope: { kind: 'project', directory: OTHER }, content: 'OTHER TEXT' });
    // Plant a broken file under the exact name the migration would use.
    rig.store.createContent(legacy.id, blockContentKey(ALPHA), { directory: ALPHA, content: '', lastWriter: null });
    const directory = path.join(storeDir(rig), 'memory-block-contents', legacy.id);
    const planted = path.join(directory, contentFilesOf(rig, legacy.id)[0]);
    fs.writeFileSync(planted, '{ broken');

    assert.doesNotThrow(() => rig.blocks.migrateLegacyBlocks());
    assert.equal(fs.readFileSync(planted, 'utf8'), '{ broken');
    assert.equal(readDefinition(rig, legacy.id).content, 'LEGACY TEXT', 'the old definition is left as it was');
    const listed = rig.blocks.list().blocks;
    assert.match(listed.find((block) => block.id === legacy.id)?.needsAttention ?? '', /Could not be moved/);
    assert.equal(listed.find((block) => block.id === healthy.id)?.needsAttention, undefined);
    assert.deepEqual(readDefinition(rig, healthy.id).scope, { kind: 'project' }, 'the other record was still migrated');
    assert.equal(rig.blocks.readForRun({ directory: OTHER }, 'healthy').content, 'OTHER TEXT');
    // A block that was not moved still answers in its old folder (read from the record).
    assert.equal(rig.blocks.readForRun({ directory: ALPHA }, 'notes').content, 'LEGACY TEXT');
    assert.equal(rig.blocks.hasProjectContent(ALPHA), true);
  } finally { rig.cleanup(); }
});

test('migration: global vs project name clash: nothing is moved, the project block stays in its old folder flagged, global wins elsewhere', () => {
  const rig = makeServiceRig();
  try {
    const globalRules = seedLegacy(rig, { name: 'rules', scope: { kind: 'global' }, content: 'GLOBAL' });
    const projectRules = seedLegacy(rig, { name: 'rules', content: 'PROJECT' });
    rig.blocks.migrateLegacyBlocks();

    assert.equal(contentFilesOf(rig, projectRules.id).length, 0, 'no content file was made');
    assert.equal(fs.existsSync(path.join(storeDir(rig), 'memory-blocks.legacy', `${projectRules.id}.json`)), false, 'nothing was rewritten, so nothing was backed up');
    assert.equal(rig.blocks.readForRun({ directory: ALPHA }, 'rules').content, 'PROJECT');
    assert.equal(rig.blocks.readForRun({ directory: OTHER }, 'rules').content, 'GLOBAL');
    assert.equal(rig.blocks.readForRun({ directory: null }, 'rules').content, 'GLOBAL');
    const listed = rig.blocks.list().blocks;
    assert.match(listed.find((block) => block.id === projectRules.id)?.needsAttention ?? '', /also used by another memory block/);
    assert.equal(listed.find((block) => block.id === globalRules.id)?.needsAttention, undefined);
    assert.equal(listed.find((block) => block.id === projectRules.id)?.scope.kind, 'project');
    assert.equal('directory' in (listed.find((block) => block.id === projectRules.id)?.scope ?? {}), false, 'the listing never carries the stored folder');
  } finally { rig.cleanup(); }
});

test('migration: project vs project name clash: neither is moved, each stays visible in its own folder, both flagged', () => {
  const rig = makeServiceRig();
  try {
    const first = seedLegacy(rig, { content: 'A' });
    const second = seedLegacy(rig, { scope: { kind: 'project', directory: OTHER }, content: 'B' });
    rig.blocks.migrateLegacyBlocks();
    assert.equal(rig.blocks.readForRun({ directory: ALPHA }, 'notes').content, 'A');
    assert.equal(rig.blocks.readForRun({ directory: OTHER }, 'notes').content, 'B');
    const listed = rig.blocks.list().blocks;
    assert.equal(listed.filter((block) => block.needsAttention).length, 2);
    assert.equal(contentFilesOf(rig, first.id).length + contentFilesOf(rig, second.id).length, 0);
    // Writes still land on the old record, in that folder only.
    rig.blocks.writeForRun({ directory: OTHER, agentName: 'a' }, 'notes', 'B2', 'replace');
    assert.equal(rig.blocks.readForRun({ directory: ALPHA }, 'notes').content, 'A');
    assert.equal(rig.blocks.readForRun({ directory: OTHER }, 'notes').content, 'B2');
    // Renaming one of them clears the clash; the next run moves it.
    rig.blocks.update(second.id, {
      name: 'notes-b', description: '', mode: 'writable', scope: { kind: 'project' }, maxChars: 2000, expectedRev: rig.blocks.list().blocks.find((block) => block.id === second.id)!.rev,
    });
    rig.blocks.migrateLegacyBlocks();
    assert.equal(contentFilesOf(rig, second.id).length, 1);
    assert.equal(rig.blocks.readForRun({ directory: OTHER }, 'notes-b').content, 'B2');
    assert.equal(contentFilesOf(rig, first.id).length, 1, 'the other one is no longer in a clash either and moves too');
    assert.equal(rig.blocks.list().blocks.filter((block) => block.needsAttention).length, 0);
  } finally { rig.cleanup(); }
});

test('migration: a store that cannot be listed never throws; new-shape and legacy records coexist in list()', () => {
  const rig = makeServiceRig();
  try {
    rig.blocks.create({ name: 'fresh', description: '', mode: 'writable', scope: { kind: 'project' }, content: '' });
    seedLegacy(rig, { name: 'old' });
    const names = rig.blocks.list().blocks.map((block) => block.name);
    assert.deepEqual(names, ['fresh', 'old']);
    assert.equal(rig.store.list('memory-blocks').items.length, 2, 'both shapes pass the shape check');

    // `memory-blocks` is a file: listing fails with a non-corrupt error. The migration swallows it.
    const broken = makeServiceRig();
    try {
      fs.mkdirSync(storeDir(broken), { recursive: true });
      fs.writeFileSync(path.join(storeDir(broken), 'memory-blocks'), 'not a folder');
      assert.doesNotThrow(() => broken.blocks.migrateLegacyBlocks());
    } finally { broken.cleanup(); }
  } finally { rig.cleanup(); }
});

test('migration: a listing that fails once is retried on the next access and then moves the block', () => {
  const rig = makeServiceRig();
  try {
    const legacy = seedLegacy(rig);
    const realList = rig.store.list.bind(rig.store);
    let failures = 1;
    (rig.store as { list: unknown }).list = (...args: Parameters<typeof realList>) => {
      if (failures > 0) { failures -= 1; throw Object.assign(new Error('too many open files'), { code: 'EMFILE' }); }
      return realList(...args);
    };

    assert.doesNotThrow(() => rig.blocks.migrateLegacyBlocks());
    assert.equal(contentFilesOf(rig, legacy.id).length, 0, 'nothing moved while the store could not be listed');
    assert.equal(readDefinition(rig, legacy.id).content, 'LEGACY TEXT');

    // The next access runs the migration again, with no restart.
    assert.equal(rig.blocks.readForRun({ directory: ALPHA }, 'notes').content, 'LEGACY TEXT');
    assert.deepEqual(readDefinition(rig, legacy.id).scope, { kind: 'project' });
    assert.equal(contentFilesOf(rig, legacy.id).length, 1);
    assert.equal(rig.blocks.list().blocks[0].needsAttention, undefined);
  } finally { rig.cleanup(); }
});

test('migration: a name clash is re-evaluated after a rename or a delete, without calling the migration by hand', () => {
  const rig = makeServiceRig();
  try {
    const globalRules = seedLegacy(rig, { name: 'rules', scope: { kind: 'global' }, content: 'GLOBAL' });
    const first = seedLegacy(rig, { name: 'rules', content: 'PROJECT' });
    const second = seedLegacy(rig, { name: 'rules', scope: { kind: 'project', directory: OTHER }, content: 'OTHER' });
    assert.equal(rig.blocks.list().blocks.filter((block) => block.needsAttention).length, 2);

    // Rename the global one: the other two still clash with each other.
    rig.blocks.update(globalRules.id, { name: 'global-rules', description: '', mode: 'writable', scope: { kind: 'global' }, content: 'GLOBAL', maxChars: 2000, expectedRev: globalRules.rev });
    assert.equal(rig.blocks.list().blocks.filter((block) => block.needsAttention).length, 2);
    assert.equal(contentFilesOf(rig, first.id).length + contentFilesOf(rig, second.id).length, 0);

    // Deleting one of the pair ends the clash for the other: it is moved on the next access.
    rig.blocks.remove(second.id);
    const remaining = rig.blocks.list().blocks.find((block) => block.id === first.id);
    assert.equal(remaining?.needsAttention, undefined);
    assert.equal(contentFilesOf(rig, first.id).length, 1);
    assert.equal(rig.blocks.listContents(first.id).contents[0].content, 'PROJECT');
  } finally { rig.cleanup(); }
});

test('migration: the contents endpoints retry a block that is still unmoved, and refuse it only while the clash lasts', () => {
  const rig = makeServiceRig();
  try {
    seedLegacy(rig, { name: 'rules', scope: { kind: 'global' }, content: 'GLOBAL' });
    const project = seedLegacy(rig, { name: 'rules', content: 'PROJECT' });
    assert.throws(() => rig.blocks.listContents(project.id), (error: { code?: string }) => error.code === 'BLOCK_NOT_MIGRATED');
    const listed = rig.blocks.list().blocks.find((block) => block.id === project.id)!;
    rig.blocks.update(project.id, { name: 'rules-project', description: '', mode: 'writable', scope: { kind: 'project' }, maxChars: 2000, expectedRev: listed.rev });
    assert.equal(rig.blocks.listContents(project.id).contents.length, 1);
  } finally { rig.cleanup(); }
});

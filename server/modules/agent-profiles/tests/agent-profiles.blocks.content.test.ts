import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import { blockContentKey, MAX_CONTENTS_PER_BLOCK } from '../agent-profiles.store.js';

import { makeServiceRig } from './service-rig.js';

const ALPHA = path.resolve(path.sep, 'work', 'alpha');
const OTHER = path.resolve(path.sep, 'work', 'other');

type Rig = ReturnType<typeof makeServiceRig>;

const codeOf = (run: () => unknown): string | undefined => {
  try { run(); } catch (error) { return error instanceof AppError ? error.code : `not-an-app-error: ${String(error)}`; }
  return undefined;
};

const newProjectBlock = (rig: Rig, name = 'notes', overrides: Record<string, unknown> = {}) =>
  rig.blocks.create({ name, description: '', mode: 'writable', scope: { kind: 'project' }, content: '', ...overrides }).block;

const contentsDirOf = (rig: Rig, blockId: string): string => path.join(rig.root, 'agent-profiles', 'memory-block-contents', blockId);
const filesOf = (rig: Rig, blockId: string, extension: string): string[] => {
  try { return fs.readdirSync(contentsDirOf(rig, blockId)).filter((name) => name.endsWith(extension)); } catch { return []; }
};

test('content: create starts at rev 1 with empty text and no writer; a second create for the folder is 409 and keeps the text', () => {
  const rig = makeServiceRig();
  try {
    const block = newProjectBlock(rig);
    const created = rig.blocks.addContent(block.id, ALPHA).content;
    assert.deepEqual({ rev: created.rev, content: created.content, lastWriter: created.lastWriter, directory: created.directory }, { rev: 1, content: '', lastWriter: null, directory: ALPHA });
    rig.blocks.updateContent(block.id, ALPHA, 'kept', 1);
    assert.equal(codeOf(() => rig.blocks.addContent(block.id, `${ALPHA}${path.sep}`)), 'BLOCK_CONTENT_EXISTS', 'same folder typed differently');
    assert.equal(rig.blocks.listContents(block.id).contents[0].content, 'kept');
    assert.equal(codeOf(() => rig.blocks.addContent(block.id, 'relative/dir')), 'INVALID_PROFILE_INPUT');
    assert.equal(codeOf(() => rig.blocks.addContent(block.id, '')), 'INVALID_PROFILE_INPUT');
    const globalBlock = rig.blocks.create({ name: 'shared', description: '', mode: 'writable', scope: { kind: 'global' }, content: '' }).block;
    assert.equal(codeOf(() => rig.blocks.addContent(globalBlock.id, ALPHA)), 'BLOCK_NOT_PROJECT_SCOPE');
    assert.equal(codeOf(() => rig.blocks.addContent('missing-id', ALPHA)), 'PROFILE_NOT_FOUND');
  } finally { rig.cleanup(); }
});

test('content: user edit needs the current content rev, respects maxChars; delete-content keeps the file and bumps rev (no ABA)', () => {
  const rig = makeServiceRig();
  try {
    const block = newProjectBlock(rig, 'notes', { maxChars: 10 });
    rig.blocks.addContent(block.id, ALPHA);
    assert.equal(rig.blocks.updateContent(block.id, ALPHA, 'hello', 1).content.rev, 2);
    assert.equal(codeOf(() => rig.blocks.updateContent(block.id, ALPHA, 'late', 1)), 'PROFILE_STALE');
    assert.equal(codeOf(() => rig.blocks.updateContent(block.id, ALPHA, 'x'.repeat(11), 2)), 'BLOCK_TOO_LARGE');

    const emptied = rig.blocks.emptyContent(block.id, ALPHA, 2).content;
    assert.deepEqual({ rev: emptied.rev, content: emptied.content, lastWriter: emptied.lastWriter }, { rev: 3, content: '', lastWriter: 'user' });
    assert.equal(filesOf(rig, block.id, '.json').length, 1, 'the file stays');
    assert.equal(rig.blocks.hasProjectContent(ALPHA), true, 'an emptied folder still counts');
    assert.equal(codeOf(() => rig.blocks.updateContent(block.id, ALPHA, 'stale', 2)), 'PROFILE_STALE', 'an editor loaded before the delete is refused');
    assert.equal(codeOf(() => rig.blocks.emptyContent(block.id, ALPHA, 2)), 'PROFILE_STALE');
    assert.equal(codeOf(() => rig.blocks.emptyContent(block.id, OTHER)), 'PROFILE_NOT_FOUND', 'no file, nothing to empty');
    assert.equal(rig.blocks.emptyContent(block.id, ALPHA).content.rev, 4, 'without expectedRev the current rev is used');
    assert.equal(codeOf(() => rig.blocks.updateContent(block.id, OTHER, 'x', 1)), 'PROFILE_NOT_FOUND', 'the user does not create a file by writing either');
    assert.equal(filesOf(rig, block.id, '.json').length, 1);
  } finally { rig.cleanup(); }
});

test('content: removing a folder deletes its file; re-creating continues the rev; a tomb is not counted and goes with the block', () => {
  const rig = makeServiceRig();
  try {
    const block = newProjectBlock(rig);
    rig.blocks.addContent(block.id, ALPHA);
    rig.blocks.updateContent(block.id, ALPHA, 'one', 1);
    rig.blocks.updateContent(block.id, ALPHA, 'two', 2);
    assert.deepEqual(rig.blocks.removeFolder(block.id, ALPHA), { ok: true });
    assert.deepEqual(filesOf(rig, block.id, '.json'), []);
    assert.equal(filesOf(rig, block.id, '.tomb').length, 1);
    assert.equal(rig.blocks.hasProjectContent(ALPHA), false);
    assert.equal(codeOf(() => rig.blocks.removeFolder(block.id, ALPHA)), 'PROFILE_NOT_FOUND');

    const again = rig.blocks.addContent(block.id, ALPHA).content;
    assert.equal(again.rev, 4, 'last rev 3 + 1: a stale edit from before the removal cannot match');
    assert.equal(again.content, '');
    assert.deepEqual(filesOf(rig, block.id, '.tomb'), [], 'the tomb is consumed');

    rig.blocks.removeFolder(block.id, ALPHA);
    assert.equal(rig.blocks.listContents(block.id).contents.length, 0, 'a tomb is not a content file');
    rig.blocks.remove(block.id);
    assert.equal(fs.existsSync(contentsDirOf(rig, block.id)), false, 'files and tombs go with the block');
  } finally { rig.cleanup(); }
});

test('content: at most 200 folders per block; tombs and temp files do not count; other blocks have their own count', () => {
  const rig = makeServiceRig();
  try {
    const block = newProjectBlock(rig);
    const other = newProjectBlock(rig, 'other');
    const folder = (index: number) => path.resolve(path.sep, 'work', `f${index}`);
    for (let index = 0; index < MAX_CONTENTS_PER_BLOCK; index += 1) rig.blocks.addContent(block.id, folder(index));
    assert.equal(codeOf(() => rig.blocks.addContent(block.id, folder(MAX_CONTENTS_PER_BLOCK))), 'BLOCK_CONTENT_LIMIT_REACHED');
    assert.equal(rig.blocks.addContent(other.id, folder(0)).content.rev, 1, 'the cap is per block');

    rig.blocks.removeFolder(block.id, folder(0));
    fs.writeFileSync(path.join(contentsDirOf(rig, block.id), 'stray.json.1234.tmp'), '{');
    assert.equal(rig.blocks.addContent(block.id, folder(MAX_CONTENTS_PER_BLOCK)).content.rev, 1, 'a slot is free again; tomb and tmp file are not counted');
    assert.equal(codeOf(() => rig.blocks.addContent(block.id, folder(0))), 'BLOCK_CONTENT_LIMIT_REACHED');
    assert.equal(rig.blocks.listContents(block.id).contents.length, MAX_CONTENTS_PER_BLOCK);
  } finally { rig.cleanup(); }
});

test('content: a folder typed in different Windows spellings is one content file; a stored directory must map back to its file name', () => {
  const rig = makeServiceRig();
  try {
    const block = newProjectBlock(rig);
    assert.equal(blockContentKey('C:\\Work\\Alpha'), blockContentKey('c:/work/alpha/'));
    const key = blockContentKey('C:\\Work\\Alpha');
    rig.store.createContent(block.id, key, { directory: 'C:\\Work\\Alpha', content: 'win', lastWriter: null });
    assert.equal(rig.store.getContent(block.id, blockContentKey('c:/work/ALPHA/'))?.content, 'win');
    assert.equal(rig.blocks.hasProjectContent('c:/work/alpha/'), true);
    assert.equal(rig.blocks.readForRun({ directory: 'C:/Work/Alpha' }, 'notes').content, 'win');
    assert.equal(codeOf(() => rig.store.createContent(block.id, key, { directory: 'C:\\Work\\Alpha', content: '', lastWriter: null })), 'BLOCK_CONTENT_EXISTS');
    assert.equal(codeOf(() => rig.store.createContent(block.id, blockContentKey(OTHER), { directory: ALPHA, content: '', lastWriter: null })), 'INVALID_PROFILE_INPUT', 'directory and key must agree');

    // A file whose directory belongs to another file name is corrupt, never trusted.
    const [file] = filesOf(rig, block.id, '.json');
    const target = path.join(contentsDirOf(rig, block.id), file);
    fs.writeFileSync(target, JSON.stringify({ directory: OTHER, content: 'x', rev: 1, lastWriter: null, updatedAt: 'now' }));
    assert.equal(codeOf(() => rig.store.getContent(block.id, key)), 'PROFILE_CORRUPT');
    assert.equal(rig.store.listContents(block.id).corrupt.length, 1);
  } finally { rig.cleanup(); }
});

test('content: one corrupt content file hides only that block in that folder and is reported; nothing is replaced', () => {
  const rig = makeServiceRig();
  try {
    rig.blocks.create({ name: 'shared', description: '', mode: 'writable', scope: { kind: 'global' }, content: 'g' });
    const broken = newProjectBlock(rig, 'broken');
    const fine = newProjectBlock(rig, 'fine');
    for (const block of [broken, fine]) {
      rig.blocks.addContent(block.id, ALPHA);
      rig.blocks.addContent(block.id, OTHER);
    }
    const brokenFile = path.join(contentsDirOf(rig, broken.id), filesOf(rig, broken.id, '.json')[0]);
    fs.writeFileSync(brokenFile, '{ not json');

    const hiddenIn = [ALPHA, OTHER].filter((folder) => !rig.blocks.listForRun({ directory: folder }).some((block) => block.name === 'broken'));
    assert.equal(hiddenIn.length, 1, 'exactly one folder lost the block');
    const hidden = hiddenIn[0];
    const visibleNames = rig.blocks.listForRun({ directory: hidden }).map((block) => block.name);
    assert.deepEqual(visibleNames, ['fine', 'shared']);
    assert.equal(rig.blocks.corruptForRun({ directory: hidden }).map((entry) => entry.id).join(), broken.id);
    assert.equal(rig.blocks.writeForRun({ directory: hidden, agentName: 'a' }, 'fine', 'ok', 'replace').content, 'ok');
    assert.equal(codeOf(() => rig.blocks.writeForRun({ directory: hidden, agentName: 'a' }, 'broken', 'x', 'replace')), 'BLOCK_NOT_FOUND');
    assert.equal(fs.readFileSync(brokenFile, 'utf8'), '{ not json', 'an unreadable file is never replaced');
    assert.equal(codeOf(() => rig.blocks.addContent(broken.id, hidden)), 'BLOCK_CONTENT_EXISTS', 'and not recreated over');
    assert.equal(rig.blocks.corruptForRun({ directory: path.resolve(path.sep, 'work', 'third') }).length, 0);
  } finally { rig.cleanup(); }
});

test('content: block ids that are not plain ids never reach the file system', () => {
  const rig = makeServiceRig();
  try {
    const sentinel = path.join(rig.root, 'agent-profiles', 'keep.txt');
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    fs.writeFileSync(sentinel, 'keep');
    const key = blockContentKey(ALPHA);
    for (const bad of ['..', '../x', '..%2F', 'a/b', '', '.']) {
      assert.equal(codeOf(() => rig.store.getContent(bad, key)), 'INVALID_PROFILE_ID', `get ${bad}`);
      assert.equal(codeOf(() => rig.store.listContents(bad)), 'INVALID_PROFILE_ID', `list ${bad}`);
      assert.equal(codeOf(() => rig.store.removeAllContents(bad)), 'INVALID_PROFILE_ID', `removeAll ${bad}`);
      assert.equal(codeOf(() => rig.store.removeContent(bad, key)), 'INVALID_PROFILE_ID', `remove ${bad}`);
      assert.equal(codeOf(() => rig.blocks.remove(bad)), 'INVALID_PROFILE_ID', `service remove ${bad}`);
    }
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
    assert.equal(codeOf(() => rig.store.createContent('missing-id', key, { directory: ALPHA, content: '', lastWriter: null })), 'PROFILE_NOT_FOUND', 'a definition must exist');
  } finally { rig.cleanup(); }
});

test('content: deleting a block removes its contents first, so a retry after a crash finishes the delete', () => {
  const rig = makeServiceRig();
  try {
    const block = newProjectBlock(rig);
    rig.blocks.addContent(block.id, ALPHA);
    const other = newProjectBlock(rig, 'other');
    rig.blocks.addContent(other.id, ALPHA);
    // The first attempt got as far as the contents: the definition is still there.
    rig.store.removeAllContents(block.id);
    assert.equal(rig.blocks.list().blocks.length, 2);
    assert.deepEqual(rig.blocks.remove(block.id), { ok: true });
    assert.deepEqual(rig.blocks.list().blocks.map((item) => item.id), [other.id]);
    assert.equal(fs.existsSync(contentsDirOf(rig, block.id)), false);
    assert.equal(rig.blocks.listContents(other.id).contents.length, 1, 'other blocks keep their files');
    assert.equal(codeOf(() => rig.blocks.remove(block.id)), 'PROFILE_NOT_FOUND');
  } finally { rig.cleanup(); }
});

test('content: an agent write respects maxChars, read-only and stale rev inside a folder file, and never touches the definition rev', () => {
  const rig = makeServiceRig();
  try {
    const block = newProjectBlock(rig, 'small', { maxChars: 10 });
    rig.blocks.addContent(block.id, ALPHA);
    const readOnly = newProjectBlock(rig, 'locked', { mode: 'read-only' });
    rig.blocks.addContent(readOnly.id, ALPHA);
    const context = { directory: ALPHA, agentName: 'orchestrator' };
    assert.equal(codeOf(() => rig.blocks.writeForRun(context, 'small', '12345678901', 'replace')), 'BLOCK_TOO_LARGE');
    assert.equal(codeOf(() => rig.blocks.writeForRun(context, 'locked', 'x', 'replace')), 'BLOCK_READ_ONLY');
    assert.equal(codeOf(() => rig.blocks.writeForRun(context, 'small', 'x', 'replace', 7)), 'BLOCK_STALE');
    const written = rig.blocks.writeForRun(context, 'small', '1234567890', 'replace', 1);
    assert.equal(written.rev, 2);
    assert.equal(written.definitionRev, 1);
    assert.equal(rig.blocks.list().blocks.find((item) => item.id === block.id)?.rev, 1, 'the definition is untouched');
  } finally { rig.cleanup(); }
});

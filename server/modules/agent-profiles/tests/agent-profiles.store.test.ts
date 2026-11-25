import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { AgentProfileTemplate } from '@/shared/types.js';

import { createAgentProfileStore } from '../agent-profiles.store.js';
import { storedShapeProblem } from '../agent-profiles.validation.js';

import { makeTempDir, removeDir } from './profile-fixtures.js';

type TemplateContent = Omit<AgentProfileTemplate, 'id' | 'rev' | 'updatedAt'>;
const content = (name = 'Reviewer'): TemplateContent => ({
  slug: name.toLowerCase(), family: 'worker', name, description: '', instructions: 'Do it.', params: [], bindings: { project: true, knowledge: false },
});

function withStore(run: (store: ReturnType<typeof createAgentProfileStore>, root: string) => void): void {
  const root = makeTempDir();
  try { run(createAgentProfileStore({ rootDir: root, checkShape: storedShapeProblem }), root); } finally { removeDir(root); }
}

test('insert writes <kind>/<id>.json at rev 1 and get/list read it back', () => {
  withStore((store, root) => {
    const created = store.insert<AgentProfileTemplate>('templates', content());
    assert.equal(created.rev, 1);
    assert.ok(fs.existsSync(path.join(root, 'templates', `${created.id}.json`)));
    assert.deepEqual(store.get('templates', created.id), created);
    assert.deepEqual(store.list('templates'), { items: [created], corrupt: [] });
  });
});

test('writes leave no temp files behind', () => {
  withStore((store, root) => {
    const created = store.insert<AgentProfileTemplate>('templates', content());
    store.update<AgentProfileTemplate>('templates', created.id, 1, () => content('Renamed'));
    assert.deepEqual(fs.readdirSync(path.join(root, 'templates')), [`${created.id}.json`]);
  });
});

test('update bumps rev and updatedAt; a stale rev is refused with 409 and nothing is written', () => {
  withStore((store) => {
    const created = store.insert<AgentProfileTemplate>('templates', content());
    const second = store.update<AgentProfileTemplate>('templates', created.id, 1, () => content('Second'));
    assert.equal(second.rev, 2);
    assert.throws(
      () => store.update<AgentProfileTemplate>('templates', created.id, 1, () => content('Stale')),
      (error: { statusCode?: number; code?: string }) => error.statusCode === 409 && error.code === 'PROFILE_STALE',
    );
    assert.equal(store.get<AgentProfileTemplate>('templates', created.id)?.name, 'Second');
  });
});

test('ids that could escape the store are refused before any file access', () => {
  withStore((store, root) => {
    fs.writeFileSync(path.join(root, 'secret.json'), '{"id":"x"}');
    for (const id of ['..', '../secret', '..\\secret', 'a/b', '', 'x'.repeat(65), 'a.b']) {
      assert.throws(() => store.get('templates', id), (error: { statusCode?: number }) => error.statusCode === 400, id);
      assert.throws(() => store.remove('templates', id), (error: { statusCode?: number }) => error.statusCode === 400, id);
      assert.throws(() => store.update('templates', id, 1, () => content()), (error: { statusCode?: number }) => error.statusCode === 400, id);
    }
    assert.ok(fs.existsSync(path.join(root, 'secret.json')));
  });
});

test('a corrupt file is reported by list, rejected by get/update, and never overwritten', () => {
  withStore((store, root) => {
    const good = store.insert<AgentProfileTemplate>('templates', content());
    fs.writeFileSync(path.join(root, 'templates', 'broken.json'), '{ not json');
    fs.writeFileSync(path.join(root, 'templates', 'shape.json'), JSON.stringify({ id: 'shape', rev: 1, name: 5 }));
    const listing = store.list<AgentProfileTemplate>('templates');
    assert.deepEqual(listing.items.map((item) => item.id), [good.id]);
    assert.deepEqual(listing.corrupt.map((entry) => entry.id).sort(), ['broken', 'shape']);
    assert.throws(() => store.get('templates', 'broken'), (error: { code?: string }) => error.code === 'PROFILE_CORRUPT');
    assert.throws(() => store.update('templates', 'broken', 1, () => content()), (error: { code?: string }) => error.code === 'PROFILE_CORRUPT');
    assert.equal(fs.readFileSync(path.join(root, 'templates', 'broken.json'), 'utf8'), '{ not json');
  });
});

test('a record whose id does not match its file name is treated as corrupt', () => {
  withStore((store, root) => {
    const created = store.insert<AgentProfileTemplate>('templates', content());
    fs.renameSync(path.join(root, 'templates', `${created.id}.json`), path.join(root, 'templates', 'other.json'));
    assert.deepEqual(store.list('templates').corrupt.map((entry) => entry.id), ['other']);
  });
});

test('a template file of an older version (extra isDefaultOrchestrator / origin) is readable, not corrupt', () => {
  withStore((store, root) => {
    const created = store.insert<AgentProfileTemplate>('templates', content());
    const file = path.join(root, 'templates', `${created.id}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...created, isDefaultOrchestrator: false, origin: 'sample' }));
    assert.deepEqual(store.list('templates').corrupt, []);
    assert.equal(store.get('templates', created.id)?.id, created.id);
  });
});

test('old projects/ files are never read: the collection is gone and its folder is ignored', () => {
  withStore((store, root) => {
    fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(root, 'projects', 'p1.json'), JSON.stringify({ id: 'p1', rev: 1, name: 'Alpha', slug: 'alpha', directory: '/tmp/x', values: {} }));
    assert.deepEqual(store.list('templates'), { items: [], corrupt: [] });
    assert.ok(fs.existsSync(path.join(root, 'projects', 'p1.json')), 'left untouched on disk');
  });
});

test('get returns null and remove returns false for a missing record; a missing directory lists empty', () => {
  withStore((store) => {
    assert.equal(store.get('templates', 'nope'), null);
    assert.equal(store.remove('templates', 'nope'), false);
    assert.deepEqual(store.list('templates'), { items: [], corrupt: [] });
  });
});

test('settings default to empty, update with rev checks, and a corrupt file is not overwritten', () => {
  withStore((store, root) => {
    assert.deepEqual(store.readSettings(), { rev: 0, updatedAt: '', hiddenClaudeAgents: [] });
    const first = store.updateSettings({ hiddenClaudeAgents: ['Explore'] }, 0);
    assert.equal(first.rev, 1);
    assert.throws(() => store.updateSettings({ hiddenClaudeAgents: [] }, 0), (error: { statusCode?: number }) => error.statusCode === 409);
    assert.deepEqual(store.readSettings().hiddenClaudeAgents, ['Explore']);
    fs.writeFileSync(path.join(root, 'settings.json'), 'garbage');
    assert.throws(() => store.updateSettings({ hiddenClaudeAgents: [] }), (error: { code?: string }) => error.code === 'PROFILE_CORRUPT');
    assert.equal(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'), 'garbage');
  });
});

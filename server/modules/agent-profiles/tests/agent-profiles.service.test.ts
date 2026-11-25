import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { AgentProfileTemplate } from '@/shared/types.js';


import { makeServiceRig, templateBody } from './service-rig.js';

type Rig = ReturnType<typeof makeServiceRig>;

async function withRig(run: (rig: Rig) => Promise<void> | void, options?: Parameters<typeof makeServiceRig>[0]): Promise<void> {
  const rig = makeServiceRig(options);
  try { await run(rig); } finally { rig.cleanup(); }
}

const status = (code: number, errorCode?: string) => (error: { statusCode?: number; code?: string }) =>
  error.statusCode === code && (errorCode === undefined || error.code === errorCode);

// ----- templates -----

test('template CRUD: create, read, update with rev, list', async () => {
  await withRig((rig) => {
    const created = rig.service.createTemplate(templateBody());
    assert.equal(created.rev, 1);
    assert.equal(rig.service.getTemplate(created.id).slug, 'review-code');
    const updated = rig.service.updateTemplate(created.id, templateBody({ name: 'Renamed', rev: 1 }));
    assert.equal(updated.rev, 2);
    assert.equal(updated.name, 'Renamed');
    assert.deepEqual(rig.service.listTemplates().items.map((item) => item.id), [created.id]);
  });
});

test('template update with a stale rev is rejected with 409', async () => {
  await withRig((rig) => {
    const created = rig.service.createTemplate(templateBody());
    rig.service.updateTemplate(created.id, templateBody({ name: 'A', rev: 1 }));
    assert.throws(() => rig.service.updateTemplate(created.id, templateBody({ name: 'B', rev: 1 })), status(409, 'PROFILE_STALE'));
    assert.equal(rig.service.getTemplate(created.id).name, 'A');
  });
});

test('template validation: slug, family, unknown placeholder, reserved key, duplicate key, memory scope, bad id', async () => {
  await withRig((rig) => {
    const bad = (overrides: Record<string, unknown>) => () => rig.service.createTemplate(templateBody(overrides));
    assert.throws(bad({ slug: 'Bad Slug' }), status(400));
    assert.throws(bad({ family: 'boss' }), status(400));
    assert.throws(bad({ instructions: 'Use {{undeclared}} here' }), status(400));
    assert.throws(bad({ params: [{ key: 'project_name' }] }), status(400));
    assert.throws(bad({ params: [{ key: 'a' }, { key: 'a' }] }), status(400));
    assert.throws(bad({ params: [{ key: '1x' }] }), status(400));
    assert.throws(bad({ name: '' }), status(400));
    assert.throws(bad({ memory: 'everywhere' }), status(400));
    assert.throws(() => rig.service.getTemplate('../etc'), status(400, 'INVALID_PROFILE_ID'));
    assert.throws(() => rig.service.getTemplate('missing'), status(404));
    rig.service.createTemplate(templateBody({ instructions: 'Reserved {{project_directory}} is allowed' }));
  });
});

test('a template may declare an agent memory scope; empty or absent means off', async () => {
  await withRig((rig) => {
    assert.equal(rig.service.createTemplate(templateBody({ memory: 'project' })).memory, 'project');
    assert.equal(Object.hasOwn(rig.service.createTemplate(templateBody({ slug: 'none', memory: '' })), 'memory'), false);
    assert.equal(Object.hasOwn(rig.service.createTemplate(templateBody({ slug: 'absent' })), 'memory'), false);
  });
});

test('a template may opt into memory blocks with `usesBlocks`: stored only when on, round-trips, must be a boolean', async () => {
  await withRig((rig) => {
    const on = rig.service.createTemplate(templateBody({ usesBlocks: true }));
    assert.equal(on.usesBlocks, true);
    assert.equal(rig.service.getTemplate(on.id).usesBlocks, true, 'read back from the file');
    assert.equal(rig.service.listTemplates().items[0].usesBlocks, true);
    for (const [slug, value] of [['off', false], ['absent', undefined]] as const) {
      assert.equal(Object.hasOwn(rig.service.createTemplate(templateBody({ slug, usesBlocks: value })), 'usesBlocks'), false, `${slug}: default is off`);
    }
    for (const value of ['yes', 1, 'true', null, []]) {
      assert.throws(() => rig.service.createTemplate(templateBody({ slug: 'bad-flag', usesBlocks: value })), status(400), String(value));
    }
    const switchedOff = rig.service.updateTemplate(on.id, templateBody({ usesBlocks: false, rev: 1 }));
    assert.equal(Object.hasOwn(switchedOff, 'usesBlocks'), false);
  });
});

test('a template may carry a dropdown `group`: trimmed, stored only when not empty, at most 40 characters, a string', async () => {
  await withRig((rig) => {
    const grouped = rig.service.createTemplate(templateBody({ group: '  Work  ' }));
    assert.equal(grouped.group, 'Work');
    assert.equal(rig.service.getTemplate(grouped.id).group, 'Work', 'read back from the file');
    for (const [slug, value] of [['blank', '   '], ['empty', ''], ['absent', undefined]] as const) {
      assert.equal(Object.hasOwn(rig.service.createTemplate(templateBody({ slug, group: value })), 'group'), false, `${slug}: no group`);
    }
    assert.equal(rig.service.createTemplate(templateBody({ slug: 'edge', group: 'g'.repeat(40) })).group, 'g'.repeat(40));
    assert.throws(() => rig.service.createTemplate(templateBody({ slug: 'too-long', group: 'g'.repeat(41) })), status(400));
    assert.throws(() => rig.service.createTemplate(templateBody({ slug: 'not-text', group: 5 })), status(400));
    const cleared = rig.service.updateTemplate(grouped.id, templateBody({ group: '', rev: 1 }));
    assert.equal(Object.hasOwn(cleared, 'group'), false);
  });
});

test('template slugs are unique', async () => {
  await withRig((rig) => {
    rig.service.createTemplate(templateBody());
    assert.throws(() => rig.service.createTemplate(templateBody()), status(409, 'SLUG_TAKEN'));
  });
});

test('an orchestrator template is an ordinary template: it can be deleted and turned into a worker', async () => {
  await withRig((rig) => {
    const orchestrator = rig.service.createTemplate(templateBody({ slug: 'orch', family: 'orchestrator', name: 'O', instructions: 'Route.' }));
    const turned = rig.service.updateTemplate(orchestrator.id, templateBody({ slug: 'orch', family: 'worker', rev: orchestrator.rev }));
    assert.equal(turned.family, 'worker');
    assert.deepEqual(rig.service.deleteTemplate(orchestrator.id), { deleted: true });
    assert.deepEqual(rig.service.listTemplates().items, []);
  });
});

test('fields of older template files (isDefaultOrchestrator, origin) are ignored: never returned, dropped by the next save', async () => {
  await withRig((rig) => {
    const created = rig.service.createTemplate(templateBody());
    const file = path.join(rig.root, 'agent-profiles', 'templates', `${created.id}.json`);
    const legacy = { ...JSON.parse(fs.readFileSync(file, 'utf8')), isDefaultOrchestrator: true, origin: 'sample' };
    fs.writeFileSync(file, JSON.stringify(legacy));
    for (const template of [rig.service.getTemplate(created.id), rig.service.listTemplates().items[0]]) {
      assert.equal(Object.hasOwn(template, 'isDefaultOrchestrator'), false);
      assert.equal(Object.hasOwn(template, 'origin'), false);
    }
    // A template that used to be the default can now be deleted like any other.
    rig.service.updateTemplate(created.id, templateBody({ rev: 1 }));
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(Object.hasOwn(saved, 'isDefaultOrchestrator') || Object.hasOwn(saved, 'origin'), false);
    fs.writeFileSync(file, JSON.stringify({ ...saved, isDefaultOrchestrator: true }));
    assert.deepEqual(rig.service.deleteTemplate(created.id), { deleted: true });
  });
});

test('deleting a template leaves the agent files generated from it untouched', async () => {
  await withRig(async (rig) => {
    const project = fs.mkdtempSync(path.join(rig.root, 'proj-'));
    const template = rig.service.createTemplate(templateBody());
    await rig.service.generate({ directory: project, templateIds: [template.id] });
    const file = path.join(project, '.claude', 'agents', 'review-code.md');
    assert.deepEqual(rig.service.deleteTemplate(template.id), { deleted: true });
    assert.ok(fs.existsSync(file));
  });
});

// ----- scope options -----

/** Writes an agent file with the given name into the agents folder `folder`. */
function writeAgentFile(folder: string, name: string, extraFrontMatter = ''): void {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `${name}.md`), `---\nname: ${name}\ndescription: ${name} secret description\n${extraFrontMatter}---\nSecret prompt body\n`);
}

/** Registers a sidebar project (id -> folder) in the rig and returns its folder. */
function addSidebarProject(rig: Rig, id: string, name = id): string {
  const directory = path.join(rig.root, name);
  fs.mkdirSync(directory, { recursive: true });
  rig.state.projects.set(id, directory);
  return directory;
}

test('scope options list the main agents of the project and of the user folder as names only, project first', async () => {
  await withRig(async (rig) => {
    const directory = addSidebarProject(rig, 'p-beta');
    writeAgentFile(path.join(directory, '.claude', 'agents'), 'reviewer');
    writeAgentFile(path.join(directory, '.claude', 'agents'), 'orchestrator');
    writeAgentFile(path.join(rig.claudeHome, 'agents'), 'helper');
    const options = await rig.service.scopeOptions('p-beta');
    assert.deepEqual(options, {
      agents: [
        { name: 'orchestrator', source: 'project', isOrchestrator: true },
        { name: 'reviewer', source: 'project', isOrchestrator: false },
        { name: 'helper', source: 'user', isOrchestrator: false },
      ],
    });
    // Remote may call this: nothing but names and flags, no folder, prompt or description.
    const text = JSON.stringify(options);
    assert.ok(!text.includes('secret'), 'no description or prompt');
    assert.ok(!text.includes(rig.root.replace(/\\/g, '\\\\')) && !text.includes(rig.claudeHome.replace(/\\/g, '\\\\')), 'no path');
  });
});

test('scope options skip hidden agents, unreadable files and built-ins, and show a name shadowed by the project once', async () => {
  await withRig(async (rig) => {
    const directory = addSidebarProject(rig, 'p1');
    const projectAgents = path.join(directory, '.claude', 'agents');
    writeAgentFile(projectAgents, 'shared-name');
    writeAgentFile(projectAgents, 'hide-me');
    fs.writeFileSync(path.join(projectAgents, 'broken.md'), '---\ndescription: no name\n---\nBody');
    writeAgentFile(path.join(rig.claudeHome, 'agents'), 'shared-name');
    writeAgentFile(path.join(rig.claudeHome, 'agents'), 'hide-user');
    rig.claudeAgents.setHidden({ names: ['hide-me', 'hide-user'], rev: 0 });
    assert.deepEqual((await rig.service.scopeOptions('p1')).agents, [{ name: 'shared-name', source: 'project', isOrchestrator: false }]);
  }, { sdkAgents: [{ name: 'Explore', description: 'x' }] });
});

test('scope options only read agent files: never the Claude SDK, with or without agents', async () => {
  await withRig(async (rig) => {
    addSidebarProject(rig, 'empty');
    assert.deepEqual(await rig.service.scopeOptions('empty'), { agents: [] });
    writeAgentFile(path.join(rig.claudeHome, 'agents'), 'helper');
    assert.equal((await rig.service.scopeOptions('empty')).agents.length, 1);
    assert.equal(rig.state.sdkCalls, 0);
  }, { sdkAgents: [{ name: 'Explore', description: 'x' }] });
});

test('scope options need a known sidebar project id: 400 without one, 404 for an unknown one, no path in either answer', async () => {
  await withRig(async (rig) => {
    addSidebarProject(rig, 'known');
    for (const missing of [undefined, '', '   ', 42, 'x'.repeat(201)]) {
      await assert.rejects(rig.service.scopeOptions(missing), status(400, 'PROJECT_ID_REQUIRED'), String(missing));
    }
    await assert.rejects(rig.service.scopeOptions('C:\\work\\beta'), (error: Error & { statusCode?: number; code?: string }) => {
      assert.equal(error.statusCode, 404);
      assert.equal(error.code, 'PROJECT_NOT_FOUND');
      assert.ok(!error.message.includes('beta'), 'the answer does not echo the id back');
      return true;
    });
  });
});

test('Windows reserved device names are refused as a template slug, on create and on update', async () => {
  await withRig((rig) => {
    for (const slug of ['con', 'prn', 'aux', 'nul', 'com1', 'com9', 'lpt1', 'lpt9']) {
      assert.throws(() => rig.service.createTemplate(templateBody({ slug })), status(400, 'INVALID_PROFILE_INPUT'), slug);
    }
    const created = rig.service.createTemplate(templateBody());
    assert.throws(() => rig.service.updateTemplate(created.id, templateBody({ slug: 'nul', rev: created.rev })), status(400, 'INVALID_PROFILE_INPUT'));
    assert.equal(rig.service.getTemplate(created.id).slug, 'review-code');
    for (const slug of ['console', 'com10', 'lpt', 'nul-agent']) assert.ok(rig.service.createTemplate(templateBody({ slug })), slug);
  });
});

test('a template file whose hand-edited slug breaks the slug rule is reported corrupt, not used', async () => {
  await withRig((rig) => {
    const good = rig.service.createTemplate(templateBody());
    const folder = path.join(rig.root, 'agent-profiles', 'templates');
    const stored = JSON.parse(fs.readFileSync(path.join(folder, `${good.id}.json`), 'utf8')) as Record<string, unknown>;
    for (const [id, slug] of [['upper', 'Review_Code'], ['device', 'con'], ['empty', ''], ['dotted', 'a.b']]) {
      fs.writeFileSync(path.join(folder, `${id}.json`), JSON.stringify({ ...stored, id, slug }));
    }
    const listing = rig.service.listTemplates();
    assert.deepEqual(listing.items.map((item) => item.id), [good.id]);
    assert.deepEqual(listing.corrupt.map((entry) => entry.id).sort(), ['device', 'dotted', 'empty', 'upper']);
    assert.throws(() => rig.service.getTemplate('upper'), status(500, 'PROFILE_CORRUPT'));
  });
});

test('a corrupt template file does not break listing or other operations', async () => {
  await withRig((rig) => {
    const template = rig.service.createTemplate(templateBody());
    fs.writeFileSync(path.join(rig.root, 'agent-profiles', 'templates', 'broken.json'), '{oops');
    const listing = rig.service.listTemplates();
    assert.deepEqual(listing.items.map((item) => item.id), [template.id]);
    assert.equal(listing.corrupt[0].id, 'broken');
    assert.throws(() => rig.service.getTemplate('broken'), status(500, 'PROFILE_CORRUPT'));
    assert.ok(rig.service.createTemplate(templateBody({ slug: 'another' })));
  });
});

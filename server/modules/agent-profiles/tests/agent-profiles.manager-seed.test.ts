import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { MANAGER_SKILLS, MANAGER_TEMPLATE, seedProfileManagerOnce } from '../agent-profiles.manager-seed.js';

import { makeServiceRig, templateBody } from './service-rig.js';
import { makeTempDir, removeDir } from './profile-fixtures.js';

const EXAMPLE_DIR = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'docs', 'examples', 'remotecli-manager');
const rigs: ReturnType<typeof makeServiceRig>[] = [];
const dirs: string[] = [];
afterEach(() => { while (rigs.length) rigs.pop()?.cleanup(); while (dirs.length) removeDir(dirs.pop() as string); });

function setup() {
  const rig = makeServiceRig();
  rigs.push(rig);
  const skillsDirectory = makeTempDir('skills-');
  dirs.push(skillsDirectory);
  const rootDir = path.join(rig.root, 'agent-profiles');
  const seed = () => seedProfileManagerOnce({ rootDir, skillsDirectory, profiles: rig.service });
  return { rig, skillsDirectory, rootDir, seed };
}

describe('profile manager seed', () => {
  it('creates the template and the three skills on a fresh store', () => {
    const { rig, skillsDirectory, seed } = setup();
    seed();
    const [template] = rig.service.listTemplates().items;
    assert.equal(template.slug, 'remotecli-manager');
    assert.equal(template.family, 'orchestrator');
    assert.equal(template.mcpServers, undefined);
    for (const skill of MANAGER_SKILLS) {
      assert.equal(fs.readFileSync(path.join(skillsDirectory, skill.name, 'SKILL.md'), 'utf8'), skill.content);
    }
  });

  it('runs once: a deleted template does not come back and an edited one is not overwritten', () => {
    const { rig, seed } = setup();
    seed();
    const [template] = rig.service.listTemplates().items;
    rig.service.updateTemplate(template.id, { ...MANAGER_TEMPLATE, name: 'My manager', rev: template.rev });
    seed();
    assert.equal(rig.service.listTemplates().items[0].name, 'My manager');
    rig.service.deleteTemplate(template.id);
    seed();
    assert.deepEqual(rig.service.listTemplates().items, []);
  });

  it('keeps a template with the same slug and a skill folder that already exist', () => {
    const { rig, skillsDirectory, seed } = setup();
    rig.service.createTemplate(templateBody({ slug: 'remotecli-manager', name: 'Mine', tools: ['Read'] }));
    const folder = path.join(skillsDirectory, MANAGER_SKILLS[0].name);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'SKILL.md'), 'my own skill');
    seed();
    assert.equal(rig.service.listTemplates().items.length, 1);
    assert.equal(rig.service.listTemplates().items[0].name, 'Mine');
    assert.equal(fs.readFileSync(path.join(folder, 'SKILL.md'), 'utf8'), 'my own skill');
    assert.ok(fs.existsSync(path.join(skillsDirectory, MANAGER_SKILLS[1].name, 'SKILL.md')));
  });

  it('never throws, and tries again at the next start when it failed', () => {
    const { rig, skillsDirectory, seed } = setup();
    const blocked = path.join(skillsDirectory, 'blocked');
    fs.writeFileSync(blocked, 'a file where a folder is expected');
    const failing = () => seedProfileManagerOnce({ rootDir: path.join(rig.root, 'agent-profiles'), skillsDirectory: path.join(blocked, 'inside'), profiles: rig.service });
    assert.doesNotThrow(failing);
    assert.ok(!fs.existsSync(path.join(rig.root, 'agent-profiles', 'seeded-manager.json')), 'no marker after a failure');
    seed();
    assert.ok(fs.existsSync(path.join(rig.root, 'agent-profiles', 'seeded-manager.json')));
  });

  it('stays identical to the documented example (template and skills)', () => {
    const bundle = JSON.parse(fs.readFileSync(path.join(EXAMPLE_DIR, 'remotecli-manager.bundle.json'), 'utf8'));
    assert.deepEqual(bundle.templates[0], MANAGER_TEMPLATE);
    for (const skill of MANAGER_SKILLS) {
      assert.equal(fs.readFileSync(path.join(EXAMPLE_DIR, 'skills', skill.name, 'SKILL.md'), 'utf8'), skill.content, skill.name);
    }
  });
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { parseBundleText } from '../agent-profiles.bundle.format.js';
import { PROFILES_TOOL_NAMES } from '../agent-profiles.profiles.tool-names.js';

import { makeServiceRig } from './service-rig.js';

const EXAMPLE_DIR = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'docs', 'examples', 'remotecli-manager');
const SKILLS = ['remotecli-create-template', 'remotecli-create-memory', 'remotecli-edit-or-delete'];

const rigs: ReturnType<typeof makeServiceRig>[] = [];
afterEach(() => { while (rigs.length) rigs.pop()?.cleanup(); });

describe('remotecli-manager example', () => {
  const text = fs.readFileSync(path.join(EXAMPLE_DIR, 'remotecli-manager.bundle.json'), 'utf8');

  it('plans as new on an empty store with no invalid item, and the manager template is sensitive', () => {
    const rig = makeServiceRig();
    rigs.push(rig);
    const plan = rig.bundle.previewText(text, {});
    assert.deepEqual(plan.items.map((item) => [item.key, item.status]), [['template:remotecli-manager', 'new']]);
    const [manager] = plan.items;
    assert.ok(manager.sensitive.includes('tool:mcp__profiles__profiles_propose'), JSON.stringify(manager.sensitive));
    assert.ok(manager.sensitive.includes('skills'));
    assert.ok(!manager.sensitive.includes('no-tools') && !manager.sensitive.includes('mcpServers'));
    assert.deepEqual(manager.problems.filter((problem) => problem.level === 'error'), []);
  });

  it('imports once ticked, and lists exactly the four profiles tools plus read-only helpers', () => {
    const rig = makeServiceRig();
    rigs.push(rig);
    const result = rig.bundle.applyText(text, { acceptSensitive: ['template:remotecli-manager'] });
    assert.equal(result.partial, false);
    const [stored] = rig.service.listTemplates().items;
    assert.equal(stored.family, 'orchestrator');
    assert.equal(stored.mcpServers, undefined);
    for (const tool of PROFILES_TOOL_NAMES) assert.ok(stored.tools?.includes(tool), `${tool} listed`);
    assert.deepEqual(stored.skills, SKILLS);
  });

  it('the skills name every profiles tool, stay short, and carry front matter naming themselves', () => {
    for (const skill of SKILLS) {
      const body = fs.readFileSync(path.join(EXAMPLE_DIR, 'skills', skill, 'SKILL.md'), 'utf8');
      assert.match(body, new RegExp(`^---\\nname: ${skill}\\n`));
      assert.ok(body.split('\n').length < 100, `${skill} is under 100 lines`);
      assert.match(body, /profiles_preview/);
      assert.match(body, /profiles_propose/);
      assert.match(body, /Settings -> Agent Profiles -> Pending/);
    }
    const names = PROFILES_TOOL_NAMES.map((name) => name.replace('mcp__profiles__', ''));
    const all = SKILLS.map((skill) => fs.readFileSync(path.join(EXAMPLE_DIR, 'skills', skill, 'SKILL.md'), 'utf8')).join('\n');
    for (const name of names) assert.ok(all.includes(name), `${name} is referenced by a skill`);
  });

  it('is a valid bundle text and carries no project or organization names', () => {
    assert.equal(parseBundleText(text).bundle.templates.length, 1);
    const everything = [text, ...SKILLS.map((skill) => fs.readFileSync(path.join(EXAMPLE_DIR, 'skills', skill, 'SKILL.md'), 'utf8')), fs.readFileSync(path.join(EXAMPLE_DIR, 'README.md'), 'utf8')].join('\n');
    assert.ok(!/\b(ota|uav)\b/i.test(everything));
  });
});

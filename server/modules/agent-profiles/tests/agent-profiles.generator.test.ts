import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { mock } from 'node:test';

import { parseFrontMatter } from '@/shared/frontmatter.js';

import {
  generatedMarker, planGeneration, readGeneratedMarker, renderAgentFile, writeGeneration,
} from '../agent-profiles.generator.js';

import { makeTempDir, makeTemplate, removeDir } from './profile-fixtures.js';

/** Runs `run` with an empty agents folder (not yet created on disk) inside a temp directory. */
async function withAgentsDirectory(run: (agentsDirectory: string) => Promise<void> | void): Promise<void> {
  const root = makeTempDir('generator-');
  try { await run(path.join(root, '.claude', 'agents')); } finally { removeDir(root); }
}

const ALPHA = { name: 'Alpha', directory: '/work/alpha' };

// ----- rendering -----

test('renders native front matter (name = slug, description, tools, model), the marker, then the instructions', () => {
  const text = renderAgentFile(
    makeTemplate({ tools: ['Read', 'Grep'], disallowedTools: ['Bash'], model: 'sonnet', skills: ['review'], mcpServers: ['docs'] }),
    { git_url: 'https://git/x.git' },
  );
  const parsed = parseFrontMatter(text);
  assert.equal(parsed.data.name, 'review-code');
  assert.equal(parsed.data.description, 'Code reviewer: Reviews merge requests.');
  assert.equal(parsed.data.tools, 'Read, Grep');
  assert.equal(parsed.data.disallowedTools, 'Bash');
  assert.equal(parsed.data.model, 'sonnet');
  assert.deepEqual(parsed.data.skills, ['review']);
  assert.deepEqual(parsed.data.mcpServers, ['docs']);
  assert.equal(Object.hasOwn(parsed.data, 'memory'), false, 'memory is written only when the template declares it');
  const body = parsed.content.trimStart();
  assert.ok(body.startsWith(generatedMarker('review-code')));
  assert.ok(body.endsWith('Review code in <param name="git_url">https://git/x.git</param>.\n'));
  assert.equal(readGeneratedMarker(text, 'review-code'), 'review-code');
});

test('a template without tools, model or memory renders only name and description (the agent inherits everything)', () => {
  const text = renderAgentFile(makeTemplate({ params: [], instructions: 'Plain.' }), {});
  assert.deepEqual(parseFrontMatter(text).data, { name: 'review-code', description: 'Code reviewer: Reviews merge requests.' });
});

test('descriptions and values with YAML-special characters survive a parse round trip', () => {
  const description = 'Reviews "quoted" things: a # b, c: d\nsecond line [x] {y} - z';
  const text = renderAgentFile(makeTemplate({ description, model: 'inherit', tools: ['Bash(git diff:*)', 'Read'] }), {});
  const parsed = parseFrontMatter(text);
  assert.equal(parsed.data.description, `Code reviewer: ${description}.`);
  assert.equal(parsed.data.tools, 'Bash(git diff:*), Read');
  assert.equal(parsed.data.model, 'inherit');
});

test('a template memory scope is written as `memory:`; a restricted tool list then gains Read, Write and Edit', () => {
  const restricted = parseFrontMatter(renderAgentFile(makeTemplate({ memory: 'project', tools: ['Grep', 'Read'], params: [], instructions: 'x' }), {}));
  assert.equal(restricted.data.memory, 'project');
  assert.equal(restricted.data.tools, 'Grep, Read, Write, Edit');
  const unrestricted = parseFrontMatter(renderAgentFile(makeTemplate({ memory: 'user', params: [], instructions: 'x' }), {}));
  assert.equal(unrestricted.data.memory, 'user');
  assert.equal(Object.hasOwn(unrestricted.data, 'tools'), false, 'no tools line = every tool, nothing to add');
  const complete = parseFrontMatter(renderAgentFile(makeTemplate({ memory: 'local', tools: ['Read', 'Edit(src/**)', 'Write'], params: [], instructions: 'x' }), {}));
  assert.equal(complete.data.tools, 'Read, Edit(src/**), Write');
});

test('usesBlocks: a restricted tool list gains the three mcp__blocks__ tools once; an unrestricted agent is left alone', () => {
  const blockTools = ['mcp__blocks__block_list', 'mcp__blocks__block_read', 'mcp__blocks__block_write'];
  const restricted = parseFrontMatter(renderAgentFile(makeTemplate({ usesBlocks: true, tools: ['Read', 'Grep'], params: [], instructions: 'x' }), {}));
  assert.equal(restricted.data.tools, ['Read', 'Grep', ...blockTools].join(', '));
  // A tool the template already names is not added twice.
  const partial = parseFrontMatter(renderAgentFile(makeTemplate({ usesBlocks: true, tools: ['Read', 'mcp__blocks__block_read'], params: [], instructions: 'x' }), {}));
  assert.equal(partial.data.tools, ['Read', 'mcp__blocks__block_read', 'mcp__blocks__block_list', 'mcp__blocks__block_write'].join(', '));
  // No `tools:` line means every tool is available: nothing to add, and no line is invented.
  const unrestricted = parseFrontMatter(renderAgentFile(makeTemplate({ usesBlocks: true, params: [], instructions: 'x' }), {}));
  assert.equal(Object.hasOwn(unrestricted.data, 'tools'), false);
  // Off (or absent): no tools, no paragraph.
  const off = renderAgentFile(makeTemplate({ usesBlocks: false, tools: ['Read'], params: [], instructions: 'x' }), {});
  assert.equal(parseFrontMatter(off).data.tools, 'Read');
  assert.ok(!off.includes('block_list'));
});

test('usesBlocks appends one short instruction paragraph after the instructions; independent of the native memory field', () => {
  const text = renderAgentFile(makeTemplate({ usesBlocks: true, params: [], instructions: 'Review code.' }), {});
  const body = parseFrontMatter(text).content;
  assert.ok(body.indexOf('Review code.') < body.indexOf('## Memory blocks'), 'after the template instructions');
  assert.equal(body.match(/## Memory blocks/g)?.length, 1);
  assert.match(body, /`block_list`.*start of a session/);
  assert.match(body, /only to blocks whose mode is `writable`/);
  assert.match(body, /Never write secrets/);
  assert.match(body, /`block_read` it first and pass the `rev` you saw as `expectedRev`/, 'replace guidance: read first, pass expectedRev');
  assert.match(body, /prefer `how=append`/, 'append for logs');
  assert.equal(Object.hasOwn(parseFrontMatter(text).data, 'memory'), false, 'usesBlocks does not switch the native memory on');
  // With the native memory on as well, both stay: neither replaces the other.
  const both = parseFrontMatter(renderAgentFile(makeTemplate({ usesBlocks: true, memory: 'project', tools: ['Grep'], params: [], instructions: 'x' }), {}));
  assert.equal(both.data.memory, 'project');
  assert.equal(both.data.tools, 'Grep, Read, Write, Edit, mcp__blocks__block_list, mcp__blocks__block_read, mcp__blocks__block_write');
  // Rendering is pure: the same template twice is the same text (regenerate never stacks paragraphs).
  assert.equal(renderAgentFile(makeTemplate({ usesBlocks: true }), {}), renderAgentFile(makeTemplate({ usesBlocks: true }), {}));
});

test('usesBlocks: Generate twice rewrites the file to the same text with one paragraph', async () => {
  await withAgentsDirectory(async (agentsDirectory) => {
    const template = makeTemplate({ usesBlocks: true, tools: ['Read'], params: [], instructions: 'Review.' });
    const run = async () => {
      const planned = await planGeneration({ agentsDirectory, project: ALPHA, templates: [template], values: {} });
      await writeGeneration(planned);
      return { status: planned[0].plan.status, text: fs.readFileSync(path.join(agentsDirectory, 'review-code.md'), 'utf8') };
    };
    const first = await run();
    const second = await run();
    assert.equal(first.status, 'new');
    assert.equal(second.status, 'duplicate');
    assert.equal(second.text, first.text);
    assert.equal(second.text.match(/## Memory blocks/g)?.length, 1);
    assert.equal(readGeneratedMarker(second.text, 'review-code'), 'review-code');
  });
});

test('a restricted orchestrator keeps the delegation tool; one that already has it is left alone', () => {
  const restricted = renderAgentFile(makeTemplate({ slug: 'lead', family: 'orchestrator', tools: ['Read', 'Grep'], params: [], instructions: 'x' }), {});
  assert.equal(parseFrontMatter(restricted).data.tools, 'Read, Grep, Agent');
  const withTask = renderAgentFile(makeTemplate({ slug: 'lead', family: 'orchestrator', tools: ['Read', 'Task'], params: [], instructions: 'x' }), {});
  assert.equal(parseFrontMatter(withTask).data.tools, 'Read, Task');
  const worker = renderAgentFile(makeTemplate({ tools: ['Read'], params: [], instructions: 'x' }), {});
  assert.equal(parseFrontMatter(worker).data.tools, 'Read');
});

test('the marker is recognised only as the first line after the front matter, naming the file\'s own slug', () => {
  const marker = generatedMarker('review-code');
  assert.equal(readGeneratedMarker(`---\nname: a\n---\n${marker}\nBody`, 'review-code'), 'review-code');
  assert.equal(readGeneratedMarker(`---\r\nname: a\r\n---\r\n\r\n${marker}\r\nBody`, 'review-code'), 'review-code', 'CRLF and blank lines before the marker are fine');
  assert.equal(readGeneratedMarker(`---\nname: a\n---\n${marker}  \nBody`, 'review-code'), 'review-code', 'trailing blanks are fine');
  assert.equal(readGeneratedMarker('---\nname: a\n---\nBody', 'review-code'), null);
  assert.equal(readGeneratedMarker(`Quoted: ${marker} inline`, 'review-code'), null);
  assert.equal(readGeneratedMarker('<!-- generated by someone else -->', 'review-code'), null);
  // Not directly after the front matter: other text first, or quoted inside a sentence.
  assert.equal(readGeneratedMarker(`---\nname: a\n---\nIntro.\n${marker}\nBody`, 'review-code'), null);
  assert.equal(readGeneratedMarker(`---\nname: a\n---\nSee "${marker}" in the docs`, 'review-code'), null);
  // No front matter at all: a bare marker is not an agent file of ours.
  assert.equal(readGeneratedMarker(`${marker}\nBody`, 'review-code'), null);
  // The marker names another template (a renamed copy).
  assert.equal(readGeneratedMarker(`---\nname: a\n---\n${marker}\nBody`, 'my-copy'), null);
});

// ----- planning: values, reserved variables, statuses -----

test('values come in two layers (typed, then template default) and reserved variables fill from the project', async () => {
  await withAgentsDirectory(async (agentsDirectory) => {
    const template = makeTemplate({
      instructions: 'In {{project_name}} ({{project_directory}}) use {{git_url}} and {{style}}.',
      params: [
        { key: 'git_url', type: 'url', title: 'u', description: '', required: false },
        { key: 'style', type: 'text', title: 's', description: '', required: false, default: 'default-style' },
      ],
    });
    const [item] = await planGeneration({ agentsDirectory, project: ALPHA, templates: [template], values: { git_url: 'https://typed' } });
    assert.equal(item.plan.status, 'new');
    assert.ok(item.content?.includes('<param name="project_name">Alpha</param>'));
    assert.ok(item.content?.includes('<param name="project_directory">/work/alpha</param>'));
    assert.ok(item.content?.includes('<param name="git_url">https://typed</param>'));
    assert.ok(item.content?.includes('<param name="style">default-style</param>'));
    assert.equal(item.plan.path, path.join(agentsDirectory, 'review-code.md'));
    assert.equal(item.plan.name, 'review-code');
  });
});

test('a required parameter without a typed value or default is missing-values and writes nothing', async () => {
  await withAgentsDirectory(async (agentsDirectory) => {
    const needs = makeTemplate({
      slug: 'needs', instructions: 'Follow {{guide}}',
      params: [{ key: 'guide', type: 'text', title: 'g', description: '', required: true }],
    });
    const [missing] = await planGeneration({ agentsDirectory, project: ALPHA, templates: [needs], values: {} });
    assert.equal(missing.plan.status, 'missing-values');
    assert.deepEqual(missing.plan.missing, ['guide']);
    assert.equal(missing.content, null);
    const [filled] = await planGeneration({ agentsDirectory, project: ALPHA, templates: [needs], values: { guide: 'g' } });
    assert.equal(filled.plan.status, 'new');
    const result = await writeGeneration([missing]);
    assert.equal(result.skipped.length, 1);
    assert.equal(fs.existsSync(agentsDirectory), false, 'nothing was created');
  });
});

test('a slug that is not a valid agent name is invalid-name and never becomes a path', async () => {
  await withAgentsDirectory(async (agentsDirectory) => {
    const evil = makeTemplate({ slug: '../evil' });
    const [item] = await planGeneration({ agentsDirectory, project: ALPHA, templates: [evil], values: {} });
    assert.equal(item.plan.status, 'invalid-name');
    assert.equal(item.content, null);
    assert.equal((await writeGeneration([item])).skipped.length, 1);
    assert.equal(fs.existsSync(path.join(agentsDirectory, '..', 'evil.md')), false);
  });
});

test('statuses: new for a free name, duplicate when the existing file carries the marker, handmade-exists otherwise', async () => {
  await withAgentsDirectory(async (agentsDirectory) => {
    fs.mkdirSync(agentsDirectory, { recursive: true });
    const generatedBefore = renderAgentFile(makeTemplate({ slug: 'old-one' }), {});
    fs.writeFileSync(path.join(agentsDirectory, 'old-one.md'), generatedBefore);
    fs.writeFileSync(path.join(agentsDirectory, 'mine.md'), '---\nname: mine\ndescription: hand written\n---\nMy own prompt.\n');
    const templates = [makeTemplate({ slug: 'fresh' }), makeTemplate({ slug: 'old-one' }), makeTemplate({ slug: 'mine' })];
    const plans = await planGeneration({ agentsDirectory, project: ALPHA, templates, values: {} });
    assert.deepEqual(plans.map((item) => [item.plan.name, item.plan.status]), [['fresh', 'new'], ['old-one', 'duplicate'], ['mine', 'handmade-exists']]);
    assert.equal(plans[2].content, null);
  });
});

test('handmade-exists wins over missing-values: a file that is not ours is reported first', async () => {
  await withAgentsDirectory(async (agentsDirectory) => {
    fs.mkdirSync(agentsDirectory, { recursive: true });
    fs.writeFileSync(path.join(agentsDirectory, 'needs.md'), 'handmade');
    const needs = makeTemplate({ slug: 'needs', instructions: '{{guide}}', params: [{ key: 'guide', type: 'text', title: 'g', description: '', required: true }] });
    const [item] = await planGeneration({ agentsDirectory, project: ALPHA, templates: [needs], values: {} });
    assert.equal(item.plan.status, 'handmade-exists');
  });
});

test('a directory or an oversized file under the agent name counts as handmade and is never read or replaced', async () => {
  await withAgentsDirectory(async (agentsDirectory) => {
    fs.mkdirSync(path.join(agentsDirectory, 'a-dir.md'), { recursive: true });
    fs.writeFileSync(path.join(agentsDirectory, 'big.md'), `${renderAgentFile(makeTemplate({ slug: 'big' }), {})}${'x'.repeat(300 * 1024)}`);
    const plans = await planGeneration({ agentsDirectory, project: ALPHA, templates: [makeTemplate({ slug: 'a-dir' }), makeTemplate({ slug: 'big' })], values: {} });
    assert.deepEqual(plans.map((item) => item.plan.status), ['handmade-exists', 'handmade-exists']);
  });
});

test('a renamed copy that keeps the marker, or a handmade file quoting the marker mid-file, is handmade-exists; the right file is duplicate', async () => {
  await withAgentsDirectory(async (agentsDirectory) => {
    fs.mkdirSync(agentsDirectory, { recursive: true });
    // `orchestrator.md` copied to `my-orch.md` and edited by hand: the marker still names `orchestrator`.
    fs.writeFileSync(path.join(agentsDirectory, 'my-orch.md'), renderAgentFile(makeTemplate({ slug: 'orchestrator' }), {}).replace('name: orchestrator', 'name: my-orch'));
    // A handmade agent whose body quotes the marker line on a line of its own.
    fs.writeFileSync(path.join(agentsDirectory, 'docs-agent.md'), `---\nname: docs-agent\ndescription: d\n---\nHow RemoteCLI marks files:\n\n${generatedMarker('docs-agent')}\n`);
    fs.writeFileSync(path.join(agentsDirectory, 'real.md'), renderAgentFile(makeTemplate({ slug: 'real' }), {}));
    const templates = ['my-orch', 'docs-agent', 'real'].map((slug) => makeTemplate({ slug }));
    const plans = await planGeneration({ agentsDirectory, project: ALPHA, templates, values: {} });
    assert.deepEqual(plans.map((item) => [item.plan.name, item.plan.status]), [['my-orch', 'handmade-exists'], ['docs-agent', 'handmade-exists'], ['real', 'duplicate']]);
    const result = await writeGeneration(plans);
    assert.deepEqual(result.regenerated.map((item) => item.plan.name), ['real']);
    assert.match(fs.readFileSync(path.join(agentsDirectory, 'my-orch.md'), 'utf8'), /name: my-orch/, 'the renamed copy is untouched');
  });
});

test('Windows reserved device names are invalid-name and never become a path', async () => {
  await withAgentsDirectory(async (agentsDirectory) => {
    const slugs = ['con', 'prn', 'aux', 'nul', 'com1', 'com9', 'lpt1', 'lpt9', 'CON', 'Nul'];
    const plans = await planGeneration({ agentsDirectory, project: ALPHA, templates: slugs.map((slug) => makeTemplate({ slug })), values: {} });
    assert.deepEqual(plans.map((item) => item.plan.status), slugs.map(() => 'invalid-name'));
    assert.ok(plans.every((item) => item.content === null));
    assert.equal((await writeGeneration(plans)).skipped.length, slugs.length);
    assert.equal(fs.existsSync(agentsDirectory), false, 'nothing was created');
    // Names that only look similar are fine.
    const fine = await planGeneration({ agentsDirectory, project: ALPHA, templates: ['console', 'com10', 'com0', 'lpt', 'nul-agent'].map((slug) => makeTemplate({ slug })), values: {} });
    assert.deepEqual(fine.map((item) => item.plan.status), ['new', 'new', 'new', 'new', 'new']);
  });
});

// ----- writing -----

test('writeGeneration creates the folder, writes new files and leaves nothing temporary behind', async () => {
  await withAgentsDirectory(async (agentsDirectory) => {
    const plans = await planGeneration({ agentsDirectory, project: ALPHA, templates: [makeTemplate({ slug: 'one' }), makeTemplate({ slug: 'two' })], values: { git_url: 'https://g' } });
    const result = await writeGeneration(plans);
    assert.deepEqual(result.created.map((item) => item.plan.name), ['one', 'two']);
    assert.deepEqual(fs.readdirSync(agentsDirectory).sort(), ['one.md', 'two.md']);
    const written = fs.readFileSync(path.join(agentsDirectory, 'one.md'), 'utf8');
    assert.ok(written.includes('<param name="git_url">https://g</param>'));
    assert.equal(parseFrontMatter(written).data.name, 'one');
  });
});

test('a second run regenerates files that carry the marker, picking up the new values', async () => {
  await withAgentsDirectory(async (agentsDirectory) => {
    const template = makeTemplate();
    await writeGeneration(await planGeneration({ agentsDirectory, project: ALPHA, templates: [template], values: { git_url: 'https://old' } }));
    const again = await writeGeneration(await planGeneration({ agentsDirectory, project: ALPHA, templates: [template], values: { git_url: 'https://new' } }));
    assert.equal(again.created.length, 0);
    assert.deepEqual(again.regenerated.map((item) => item.plan.status), ['duplicate']);
    const text = fs.readFileSync(path.join(agentsDirectory, 'review-code.md'), 'utf8');
    assert.ok(text.includes('https://new') && !text.includes('https://old'));
    assert.deepEqual(fs.readdirSync(agentsDirectory), ['review-code.md'], 'no temp file is left');
  });
});

test('a handmade file is never overwritten, not even when it appears between planning and writing', async () => {
  await withAgentsDirectory(async (agentsDirectory) => {
    const plans = await planGeneration({ agentsDirectory, project: ALPHA, templates: [makeTemplate({ slug: 'race-new' }), makeTemplate({ slug: 'race-regen' })], values: {} });
    // `race-regen` was generated earlier, then the user replaced it by hand; `race-new` appears by hand after planning.
    fs.mkdirSync(agentsDirectory, { recursive: true });
    fs.writeFileSync(path.join(agentsDirectory, 'race-regen.md'), renderAgentFile(makeTemplate({ slug: 'race-regen' }), {}));
    const regenPlans = await planGeneration({ agentsDirectory, project: ALPHA, templates: [makeTemplate({ slug: 'race-regen' })], values: {} });
    assert.equal(regenPlans[0].plan.status, 'duplicate');
    fs.writeFileSync(path.join(agentsDirectory, 'race-regen.md'), 'now handmade');
    fs.writeFileSync(path.join(agentsDirectory, 'race-new.md'), 'handmade too');

    const result = await writeGeneration([plans[0], regenPlans[0]]);

    assert.deepEqual(result.created.concat(result.regenerated), []);
    assert.deepEqual(result.skipped.map((item) => item.plan.status), ['handmade-exists', 'handmade-exists']);
    assert.equal(fs.readFileSync(path.join(agentsDirectory, 'race-regen.md'), 'utf8'), 'now handmade');
    assert.equal(fs.readFileSync(path.join(agentsDirectory, 'race-new.md'), 'utf8'), 'handmade too');
  });
});

test('a file the file system refuses is write-failed, the rest of the run is still written', async () => {
  await withAgentsDirectory(async (agentsDirectory) => {
    const root = path.dirname(path.dirname(agentsDirectory));
    const blockedDirectory = path.join(root, 'blocked');
    const good = await planGeneration({ agentsDirectory, project: ALPHA, templates: [makeTemplate({ slug: 'before' }), makeTemplate({ slug: 'after' })], values: {} });
    // Planned while free, then the agents folder of the middle file turns into a regular file: creating the folder fails.
    const blocked = await planGeneration({ agentsDirectory: path.join(blockedDirectory, 'agents'), project: ALPHA, templates: [makeTemplate({ slug: 'middle' })], values: {} });
    assert.equal(blocked[0].plan.status, 'new');
    fs.writeFileSync(blockedDirectory, 'not a folder');

    const result = await writeGeneration([good[0], blocked[0], good[1]]);

    assert.deepEqual(result.created.map((item) => item.plan.name), ['before', 'after']);
    assert.deepEqual(result.skipped.map((item) => [item.plan.name, item.plan.status]), [['middle', 'write-failed']]);
    assert.deepEqual(fs.readdirSync(agentsDirectory).sort(), ['after.md', 'before.md']);
  });
});

test('a regenerate that fails at the rename is write-failed, leaves the old file and no temp file behind', async () => {
  await withAgentsDirectory(async (agentsDirectory) => {
    fs.mkdirSync(agentsDirectory, { recursive: true });
    const oldText = renderAgentFile(makeTemplate({ slug: 'stuck' }), { git_url: 'https://old' });
    fs.writeFileSync(path.join(agentsDirectory, 'stuck.md'), oldText);
    const plans = await planGeneration({
      agentsDirectory, project: ALPHA, templates: [makeTemplate({ slug: 'stuck' }), makeTemplate({ slug: 'fine' })], values: { git_url: 'https://new' },
    });
    assert.deepEqual(plans.map((item) => item.plan.status), ['duplicate', 'new']);
    // Windows refuses a rename over a file another process holds open (EPERM); simulate that on any OS.
    const rename = mock.method(fs.promises, 'rename', async () => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); });
    let result;
    try { result = await writeGeneration(plans); } finally { rename.mock.restore(); }

    assert.deepEqual(result.skipped.map((item) => [item.plan.name, item.plan.status]), [['stuck', 'write-failed']]);
    assert.deepEqual(result.created.map((item) => item.plan.name), ['fine']);
    assert.equal(fs.readFileSync(path.join(agentsDirectory, 'stuck.md'), 'utf8'), oldText);
    assert.deepEqual(fs.readdirSync(agentsDirectory).sort(), ['fine.md', 'stuck.md'], 'the temp file was removed');
  });
});

test('generating twice with the same input is stable: the second plan equals the first except for the status', async () => {
  await withAgentsDirectory(async (agentsDirectory) => {
    const input = { agentsDirectory, project: ALPHA, templates: [makeTemplate()], values: { git_url: 'https://g' } };
    const first = await planGeneration(input);
    await writeGeneration(first);
    const second = await planGeneration(input);
    assert.equal(second[0].content, first[0].content);
    assert.deepEqual([first[0].plan.status, second[0].plan.status], ['new', 'duplicate']);
  });
});

// ----- worker templates -----

/** Two self-contained workers: one read-only (no file edits), one unrestricted. Both use the memory blocks. */
const WORKERS = () => [
  makeTemplate({
    id: 'worker-0', slug: 'reviewer', name: 'Reviewer', description: 'Reviews changes.', params: [],
    instructions: 'Review the change and report findings.', usesBlocks: true, disallowedTools: ['Edit', 'MultiEdit', 'NotebookEdit'],
  }),
  makeTemplate({
    id: 'worker-1', slug: 'coder', name: 'Coder', description: 'Implements changes.', params: [],
    instructions: 'Implement the change.', usesBlocks: true,
  }),
];

test('every worker template renders into a valid native agent file and none of them enables agent memory', async () => {
  await withAgentsDirectory(async (agentsDirectory) => {
    const workers = WORKERS();
    const plans = await planGeneration({ agentsDirectory, project: ALPHA, templates: workers, values: {} });
    assert.deepEqual(plans.map((item) => item.plan.status), workers.map(() => 'new'));
    for (const item of plans) {
      const parsed = parseFrontMatter(item.content ?? '');
      assert.equal(parsed.data.name, item.template.slug);
      assert.ok(typeof parsed.data.description === 'string' && parsed.data.description.length > 0);
      assert.equal(Object.hasOwn(parsed.data, 'memory'), false, `${item.template.slug} does not enable memory`);
      assert.ok(parsed.content.includes(generatedMarker(item.template.slug)));
      assert.ok(!/\{\{\s*\w+\s*\}\}/.test(parsed.content), `${item.template.slug} has no unfilled placeholder`);
    }
  });
});

test('workers render with the blocks paragraph once, their file-edit limits and no tools allow-list', async () => {
  await withAgentsDirectory(async (agentsDirectory) => {
    const plans = await planGeneration({ agentsDirectory, project: null, templates: WORKERS(), values: {} });
    assert.deepEqual(plans.map((item) => item.plan.status), ['new', 'new'], 'a global Generate needs no typed value');
    for (const item of plans) {
      const text = item.content ?? '';
      const parsed = parseFrontMatter(text);
      const restricted = item.template.slug === 'reviewer';
      assert.equal(Object.hasOwn(parsed.data, 'tools'), false, `${item.template.slug} has no tools: line`);
      assert.equal(Object.hasOwn(parsed.data, 'disallowedTools'), restricted, item.template.slug);
      if (restricted) assert.equal(parsed.data.disallowedTools, 'Edit, MultiEdit, NotebookEdit');
      assert.ok(text.includes('## Memory blocks'), `${item.template.slug} gets the blocks paragraph once`);
      assert.equal(text.split('## Memory blocks').length, 2, `${item.template.slug} blocks paragraph is not repeated`);
    }
  });
});

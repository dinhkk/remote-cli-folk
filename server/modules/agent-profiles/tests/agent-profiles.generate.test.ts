import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test, { mock } from 'node:test';

import { parseFrontMatter } from '@/shared/frontmatter.js';

import { makeServiceRig, templateBody } from './service-rig.js';

type Rig = ReturnType<typeof makeServiceRig>;

async function withRig(run: (rig: Rig) => Promise<void>): Promise<void> {
  const rig = makeServiceRig();
  try { await run(rig); } finally { rig.cleanup(); }
}

const gitAvailable = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

/** A real project folder inside the rig's temp root. */
function makeProject(rig: Rig, name = 'alpha'): string {
  const directory = path.join(rig.root, name);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

const status = (code: number, errorCode?: string) => (error: { statusCode?: number; code?: string }) =>
  error.statusCode === code && (errorCode === undefined || error.code === errorCode);

const agentFile = (directory: string, name: string): string => path.join(directory, '.claude', 'agents', `${name}.md`);

// ----- target folder -----

test('a project folder gets <directory>/.claude/agents/<slug>.md named by the template slug, with the project name and folder filled in', async () => {
  await withRig(async (rig) => {
    const directory = makeProject(rig, 'beta');
    const template = rig.service.createTemplate(templateBody({
      slug: 'orchestrator', family: 'orchestrator', name: 'Orchestrator', description: 'Main agent.',
      instructions: 'Project {{project_name}} in {{project_directory}}.', params: [],
    }));

    const result = await rig.service.generate({ directory, templateIds: [template.id] });

    assert.equal(result.scope, 'project');
    assert.equal(result.agentsDirectory, path.join(directory, '.claude', 'agents'));
    assert.deepEqual(result.created.map((plan) => plan.name), ['orchestrator'], 'no --<project> suffix any more');
    const parsed = parseFrontMatter(fs.readFileSync(agentFile(directory, 'orchestrator'), 'utf8'));
    assert.equal(parsed.data.name, 'orchestrator');
    assert.ok(parsed.content.includes('<param name="project_name">beta</param>'), 'project name defaults to the folder name');
    assert.ok(parsed.content.includes(`<param name="project_directory">${directory.replace(/&/g, '&amp;')}</param>`));
  });
});

test('projectName overrides the folder name for {{project_name}}', async () => {
  await withRig(async (rig) => {
    const directory = makeProject(rig);
    const template = rig.service.createTemplate(templateBody({ instructions: 'For {{project_name}}.', params: [] }));
    await rig.service.generate({ directory, projectName: 'Online Travel App', templateIds: [template.id] });
    assert.ok(fs.readFileSync(agentFile(directory, 'review-code'), 'utf8').includes('<param name="project_name">Online Travel App</param>'));
  });
});

test('without a directory the agent is global: it goes to <claude home>/agents', async () => {
  await withRig(async (rig) => {
    const template = rig.service.createTemplate(templateBody({ instructions: 'Global.', params: [] }));
    const preview = await rig.service.previewGenerate({ templateIds: [template.id] });
    assert.deepEqual([preview.scope, preview.agentsDirectory], ['user', path.join(rig.claudeHome, 'agents')]);

    for (const body of [{ templateIds: [template.id] }, { directory: null, templateIds: [template.id] }, { directory: '  ', templateIds: [template.id] }]) {
      fs.rmSync(path.join(rig.claudeHome, 'agents'), { recursive: true, force: true });
      const result = await rig.service.generate(body);
      assert.equal(result.scope, 'user');
      assert.equal(result.gitExclude.file, null, 'a global agent is never put in a repository exclude file');
      assert.ok(fs.existsSync(path.join(rig.claudeHome, 'agents', 'review-code.md')));
    }
  });
});

test('a directory that is missing, a file or not absolute is refused with a code and without the folder path', async () => {
  await withRig(async (rig) => {
    const template = rig.service.createTemplate(templateBody());
    const aFile = path.join(rig.root, 'secret-file.txt');
    fs.writeFileSync(aFile, 'x');
    await assert.rejects(rig.service.generate({ directory: path.join(rig.root, 'secret-missing'), templateIds: [template.id] }), (error: { message: string; code?: string; statusCode?: number }) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, 'DIRECTORY_NOT_FOUND');
      assert.equal(error.message.includes('secret'), false);
      return true;
    });
    await assert.rejects(rig.service.generate({ directory: aFile, templateIds: [template.id] }), status(400, 'DIRECTORY_NOT_A_DIRECTORY'));
    await assert.rejects(rig.service.generate({ directory: 'relative/dir', templateIds: [template.id] }), status(400));
    assert.equal(fs.existsSync(path.join(rig.root, 'secret-missing')), false, 'a missing folder is never created');
  });
});

// ----- never overwrite handmade, regenerate generated -----

test('generate writes new files, regenerates marked ones with the new values, and reports a handmade file as skipped', async () => {
  await withRig(async (rig) => {
    const directory = makeProject(rig);
    const [reviewer, tester] = [
      rig.service.createTemplate(templateBody()),
      rig.service.createTemplate(templateBody({ slug: 'testing', name: 'Tester', description: 'Runs tests.' })),
    ];
    const handmade = agentFile(directory, 'testing');
    fs.mkdirSync(path.dirname(handmade), { recursive: true });
    fs.writeFileSync(handmade, '---\nname: testing\ndescription: mine\n---\nMy own prompt.\n');

    const first = await rig.service.generate({ directory, templateIds: [reviewer.id, tester.id], values: { git_url: 'https://old' } });
    assert.deepEqual(first.created.map((plan) => plan.name), ['review-code']);
    assert.deepEqual(first.skipped.map((plan) => [plan.name, plan.status]), [['testing', 'handmade-exists']]);
    assert.equal(fs.readFileSync(handmade, 'utf8'), '---\nname: testing\ndescription: mine\n---\nMy own prompt.\n');

    const second = await rig.service.generate({ directory, templateIds: [reviewer.id, tester.id], values: { git_url: 'https://new' } });
    assert.deepEqual(second.created, []);
    assert.deepEqual(second.regenerated.map((plan) => [plan.name, plan.status]), [['review-code', 'duplicate']]);
    assert.ok(fs.readFileSync(agentFile(directory, 'review-code'), 'utf8').includes('https://new'));
  });
});

test('preview writes neither files nor remembered values and matches what apply then does', async () => {
  await withRig(async (rig) => {
    const directory = makeProject(rig);
    const template = rig.service.createTemplate(templateBody());
    const body = { directory, templateIds: [template.id], values: { git_url: 'https://g' } };
    const preview = await rig.service.previewGenerate(body);
    assert.deepEqual(preview.plans.map((plan) => [plan.name, plan.status]), [['review-code', 'new']]);
    assert.equal(fs.existsSync(agentFile(directory, 'review-code')), false);
    assert.deepEqual(rig.service.getRememberedValues(directory).values, {});
    const applied = await rig.service.generate(body);
    assert.deepEqual(applied.created.map((plan) => plan.path), [preview.plans[0].path]);
  });
});

test('a missing required value is reported as missing-values and no file is written', async () => {
  await withRig(async (rig) => {
    const directory = makeProject(rig);
    const needs = rig.service.createTemplate(templateBody({ slug: 'needs', instructions: 'Follow {{guide}}', params: [{ key: 'guide', required: true }] }));
    const result = await rig.service.generate({ directory, templateIds: [needs.id] });
    assert.deepEqual(result.created, []);
    assert.deepEqual(result.skipped.map((plan) => [plan.status, plan.missing]), [['missing-values', ['guide']]]);
    assert.equal(fs.existsSync(path.join(directory, '.claude')), false);
  });
});

test('request validation: template ids 1-50 valid, values must be strings, unknown template is 404', async () => {
  await withRig(async (rig) => {
    const template = rig.service.createTemplate(templateBody());
    await assert.rejects(rig.service.generate({ templateIds: [] }), status(400));
    await assert.rejects(rig.service.generate({ templateIds: ['../x'] }), status(400, 'INVALID_PROFILE_ID'));
    await assert.rejects(rig.service.generate({ templateIds: ['missing'] }), status(404));
    await assert.rejects(rig.service.generate({ templateIds: [template.id], values: { git_url: 1 } }), status(400));
    await assert.rejects(rig.service.generate({ templateIds: [template.id], values: { 'bad key': 'x' } }), status(400));
    await assert.rejects(rig.service.generate('nope'), status(400));
  });
});

// ----- values remembered per directory -----

test('values typed at Generate are remembered per directory and filled in again next time', async () => {
  await withRig(async (rig) => {
    const [beta, alpha] = [makeProject(rig, 'beta'), makeProject(rig, 'alpha')];
    const template = rig.service.createTemplate(templateBody({
      instructions: '{{git_url}} {{style}}', params: [{ key: 'git_url' }, { key: 'style' }],
    }));
    await rig.service.generate({ directory: beta, templateIds: [template.id], values: { git_url: 'https://beta', style: 'strict' } });
    await rig.service.generate({ directory: alpha, templateIds: [template.id], values: { git_url: 'https://alpha' } });

    assert.deepEqual(rig.service.getRememberedValues(beta), { directory: path.resolve(beta), values: { git_url: 'https://beta', style: 'strict' } });
    assert.deepEqual(rig.service.getRememberedValues(alpha).values, { git_url: 'https://alpha' });
    assert.deepEqual(rig.service.getRememberedValues(path.join(rig.root, 'never-used')).values, {});
    const file = path.join(rig.root, 'agent-profiles', 'values-by-directory.json');
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).length, 2, 'one entry per directory in <store>/values-by-directory.json');
  });
});

test('the same folder written differently (trailing slash, other separators) finds the same values', async () => {
  await withRig(async (rig) => {
    const directory = makeProject(rig);
    const template = rig.service.createTemplate(templateBody());
    await rig.service.generate({ directory, templateIds: [template.id], values: { git_url: 'https://g' } });
    assert.deepEqual(rig.service.getRememberedValues(`${directory}${path.sep}`).values, { git_url: 'https://g' });
    if (process.platform === 'win32') {
      assert.deepEqual(rig.service.getRememberedValues(directory.toUpperCase()).values, { git_url: 'https://g' }, 'Windows paths ignore case');
      assert.deepEqual(rig.service.getRememberedValues(directory.replace(/\\/g, '/')).values, { git_url: 'https://g' });
    }
  });
});

test('remembering merges: a key sent empty is forgotten, keys not sent and keys of other templates stay, undeclared keys are dropped', async () => {
  await withRig(async (rig) => {
    const directory = makeProject(rig);
    const a = rig.service.createTemplate(templateBody({ slug: 'a', instructions: '{{one}} {{two}}', params: [{ key: 'one' }, { key: 'two' }] }));
    const b = rig.service.createTemplate(templateBody({ slug: 'b', instructions: '{{three}}', params: [{ key: 'three' }] }));
    await rig.service.generate({ directory, templateIds: [a.id, b.id], values: { one: '1', two: '2', three: '3' } });
    await rig.service.generate({ directory, templateIds: [a.id], values: { one: '', stray: 'x' } });
    assert.deepEqual(rig.service.getRememberedValues(directory).values, { two: '2', three: '3' });
  });
});

test('global values live under their own key and never mix with a folder', async () => {
  await withRig(async (rig) => {
    const directory = makeProject(rig);
    const template = rig.service.createTemplate(templateBody());
    await rig.service.generate({ templateIds: [template.id], values: { git_url: 'https://global' } });
    assert.deepEqual(rig.service.getRememberedValues(undefined), { directory: null, values: { git_url: 'https://global' } });
    assert.deepEqual(rig.service.getRememberedValues('').values, { git_url: 'https://global' });
    assert.deepEqual(rig.service.getRememberedValues(directory).values, {});
  });
});

test('old agents/projects store folders are ignored: values-by-directory.json starts empty', async () => {
  await withRig(async (rig) => {
    fs.mkdirSync(path.join(rig.root, 'agent-profiles', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(rig.root, 'agent-profiles', 'agents', 'old.json'), '{"not":"a record"}');
    assert.deepEqual(rig.service.getRememberedValues(makeProject(rig)).values, {});
    assert.equal(fs.existsSync(path.join(rig.root, 'agent-profiles', 'values-by-directory.json')), false, 'reading creates nothing');
  });
});

test('a corrupt values file is reported, left untouched and never replaced by a generate', async () => {
  await withRig(async (rig) => {
    const directory = makeProject(rig);
    const template = rig.service.createTemplate(templateBody());
    const file = path.join(rig.root, 'agent-profiles', 'values-by-directory.json');
    fs.writeFileSync(file, '{ broken');
    await assert.rejects(rig.service.generate({ directory, templateIds: [template.id], values: { git_url: 'x' } }), status(500, 'PROFILE_CORRUPT'));
    assert.equal(fs.readFileSync(file, 'utf8'), '{ broken');
    assert.equal(fs.existsSync(agentFile(directory, 'review-code')), false, 'the request failed before any agent file was written');
  });
});

// ----- git exclude -----

test('inside a git repository the generated files are added to .git/info/exclude, once', { skip: !gitAvailable }, async () => {
  await withRig(async (rig) => {
    const directory = makeProject(rig);
    execFileSync('git', ['init', '-q'], { cwd: directory });
    const [plain, remembering] = [
      rig.service.createTemplate(templateBody()),
      rig.service.createTemplate(templateBody({ slug: 'lead', name: 'Lead', memory: 'project', params: [], instructions: 'Lead.' })),
    ];

    const first = await rig.service.generate({ directory, templateIds: [plain.id, remembering.id] });
    assert.deepEqual(first.gitExclude.added, ['.claude/agents/review-code.md', '.claude/agents/lead.md', '.claude/agent-memory/']);
    const exclude = fs.readFileSync(path.join(directory, '.git', 'info', 'exclude'), 'utf8');
    for (const line of first.gitExclude.added) assert.ok(exclude.split(/\r?\n/).includes(line), line);

    const second = await rig.service.generate({ directory, templateIds: [plain.id, remembering.id] });
    assert.deepEqual(second.gitExclude.added, [], 'regenerating adds nothing');
    assert.equal(fs.readFileSync(path.join(directory, '.git', 'info', 'exclude'), 'utf8'), exclude);
  });
});

test('only files Generate wrote are excluded: a skipped handmade file is not', { skip: !gitAvailable }, async () => {
  await withRig(async (rig) => {
    const directory = makeProject(rig);
    execFileSync('git', ['init', '-q'], { cwd: directory });
    const template = rig.service.createTemplate(templateBody());
    fs.mkdirSync(path.dirname(agentFile(directory, 'review-code')), { recursive: true });
    fs.writeFileSync(agentFile(directory, 'review-code'), 'handmade');
    const result = await rig.service.generate({ directory, templateIds: [template.id] });
    assert.deepEqual(result.gitExclude, { file: null, added: [] });
    assert.equal(fs.existsSync(path.join(directory, '.git', 'info', 'exclude')) && fs.readFileSync(path.join(directory, '.git', 'info', 'exclude'), 'utf8').includes('review-code'), false);
  });
});

/** Makes writing the file `<name>.md` fail with EACCES while every other write works (a stand-in for a read-only or locked file on any OS). */
function refuseWritesTo(name: string) {
  const original = fs.promises.writeFile;
  return mock.method(fs.promises, 'writeFile', async (...args: Parameters<typeof original>) => {
    if (String(args[0]).endsWith(`${path.sep}${name}.md`)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    return original(...args);
  });
}

test('one file the file system refuses is reported as write-failed, the others are written and the values are remembered; no 500', async () => {
  await withRig(async (rig) => {
    const directory = makeProject(rig);
    const [fine, locked, last] = [
      rig.service.createTemplate(templateBody()),
      rig.service.createTemplate(templateBody({ slug: 'locked', name: 'Locked' })),
      rig.service.createTemplate(templateBody({ slug: 'zeta', name: 'Zeta' })),
    ];
    const writeFile = refuseWritesTo('locked');
    let result;
    try {
      result = await rig.service.generate({ directory, templateIds: [fine.id, locked.id, last.id], values: { git_url: 'https://g' } });
    } finally {
      writeFile.mock.restore();
    }

    assert.deepEqual(result.created.map((plan) => plan.name), ['review-code', 'zeta']);
    assert.deepEqual(result.skipped.map((plan) => [plan.name, plan.status]), [['locked', 'write-failed']]);
    assert.ok(fs.existsSync(agentFile(directory, 'review-code')) && fs.existsSync(agentFile(directory, 'zeta')));
    assert.equal(fs.existsSync(agentFile(directory, 'locked')), false);
    assert.deepEqual(rig.service.getRememberedValues(directory).values, { git_url: 'https://g' });
    // Nothing leaks the folder path into the outcome except the plan's own file path (host-only route).
    assert.equal(JSON.stringify(result).includes('EACCES'), false);
  });
});

test('a failed file does not stop the git exclude: the files that were written are still excluded, the failed one is not', { skip: !gitAvailable }, async () => {
  await withRig(async (rig) => {
    const directory = makeProject(rig);
    execFileSync('git', ['init', '-q'], { cwd: directory });
    const [fine, locked] = [
      rig.service.createTemplate(templateBody()),
      rig.service.createTemplate(templateBody({ slug: 'locked', name: 'Locked' })),
    ];
    const writeFile = refuseWritesTo('locked');
    let result;
    try {
      result = await rig.service.generate({ directory, templateIds: [locked.id, fine.id], values: { git_url: 'https://g' } });
    } finally {
      writeFile.mock.restore();
    }

    assert.deepEqual(result.skipped.map((plan) => [plan.name, plan.status]), [['locked', 'write-failed']]);
    assert.deepEqual(result.gitExclude.added, ['.claude/agents/review-code.md']);
    const exclude = fs.readFileSync(path.join(directory, '.git', 'info', 'exclude'), 'utf8');
    assert.ok(exclude.split(/\r?\n/).includes('.claude/agents/review-code.md'));
    assert.equal(exclude.includes('locked'), false);
  });
});

test('a project that is not a git repository generates normally and reports no exclude file', async () => {
  await withRig(async (rig) => {
    const directory = makeProject(rig);
    const template = rig.service.createTemplate(templateBody());
    const result = await rig.service.generate({ directory, templateIds: [template.id] });
    assert.deepEqual(result.gitExclude, { file: null, added: [] });
    assert.ok(fs.existsSync(agentFile(directory, 'review-code')));
  });
});

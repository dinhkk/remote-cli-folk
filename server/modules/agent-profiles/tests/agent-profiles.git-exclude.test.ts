import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { addGitExcludeEntries } from '../agent-profiles.git-exclude.js';

import { makeTempDir, removeDir } from './profile-fixtures.js';

const gitAvailable = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/** A fresh temp directory with `git init` run in it (not inside any other repository). */
function makeRepo(): string {
  const root = makeTempDir('git-exclude-');
  git(root, 'init', '-q');
  return root;
}

const readExclude = (repo: string): string => fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');

test('appends the entries to .git/info/exclude and git then ignores those files', { skip: !gitAvailable }, async () => {
  const repo = makeRepo();
  try {
    const result = await addGitExcludeEntries(repo, ['.claude/agents/review-code.md', '.claude/agent-memory/']);
    assert.deepEqual(result.added, ['.claude/agents/review-code.md', '.claude/agent-memory/']);
    assert.equal(path.resolve(result.file ?? ''), path.join(repo, '.git', 'info', 'exclude'));
    assert.match(readExclude(repo), /^\.claude\/agents\/review-code\.md$/m);
    fs.mkdirSync(path.join(repo, '.claude', 'agents'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.claude', 'agent-memory', 'lead'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'agents', 'review-code.md'), 'x');
    fs.writeFileSync(path.join(repo, '.claude', 'agents', 'handmade.md'), 'x');
    fs.writeFileSync(path.join(repo, '.claude', 'agent-memory', 'lead', 'MEMORY.md'), 'x');
    assert.equal(git(repo, 'check-ignore', '.claude/agents/review-code.md').trim(), '.claude/agents/review-code.md');
    assert.equal(git(repo, 'check-ignore', '.claude/agent-memory/lead/MEMORY.md').trim(), '.claude/agent-memory/lead/MEMORY.md');
    assert.throws(() => git(repo, 'check-ignore', '-q', '.claude/agents/handmade.md'), 'a handmade agent file is not excluded');
  } finally { removeDir(repo); }
});

test('is idempotent: a second call adds nothing and the file keeps one line per entry', { skip: !gitAvailable }, async () => {
  const repo = makeRepo();
  try {
    await addGitExcludeEntries(repo, ['.claude/agents/a.md']);
    const again = await addGitExcludeEntries(repo, ['.claude/agents/a.md', '.claude/agents/b.md']);
    assert.deepEqual(again.added, ['.claude/agents/b.md']);
    const lines = readExclude(repo).split(/\r?\n/).filter((line) => line === '.claude/agents/a.md');
    assert.equal(lines.length, 1);
    assert.deepEqual((await addGitExcludeEntries(repo, ['.claude/agents/a.md', '.claude/agents/b.md'])).added, []);
  } finally { removeDir(repo); }
});

test('keeps the existing exclude content (also without a final line break) and creates the file or folder when missing', { skip: !gitAvailable }, async () => {
  const repo = makeRepo();
  try {
    const excludeFile = path.join(repo, '.git', 'info', 'exclude');
    fs.writeFileSync(excludeFile, '# mine\n*.tmp');
    await addGitExcludeEntries(repo, ['.claude/agents/a.md']);
    assert.equal(readExclude(repo), '# mine\n*.tmp\n.claude/agents/a.md\n');
    fs.rmSync(path.join(repo, '.git', 'info'), { recursive: true, force: true });
    const recreated = await addGitExcludeEntries(repo, ['.claude/agents/a.md']);
    assert.deepEqual(recreated.added, ['.claude/agents/a.md']);
    assert.equal(readExclude(repo), '.claude/agents/a.md\n');
  } finally { removeDir(repo); }
});

test('an entry already written with a leading slash counts as present', { skip: !gitAvailable }, async () => {
  const repo = makeRepo();
  try {
    fs.mkdirSync(path.join(repo, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'info', 'exclude'), '/.claude/agents/a.md\n');
    assert.deepEqual((await addGitExcludeEntries(repo, ['.claude/agents/a.md'])).added, []);
  } finally { removeDir(repo); }
});

test('a project that is a sub-folder of the repository gets entries anchored with its path from the root', { skip: !gitAvailable }, async () => {
  const repo = makeRepo();
  try {
    const sub = path.join(repo, 'apps', 'alpha');
    fs.mkdirSync(sub, { recursive: true });
    const result = await addGitExcludeEntries(sub, ['.claude/agents/a.md']);
    assert.deepEqual(result.added, ['apps/alpha/.claude/agents/a.md']);
    fs.mkdirSync(path.join(sub, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(sub, '.claude', 'agents', 'a.md'), 'x');
    assert.ok(git(sub, 'check-ignore', '.claude/agents/a.md').trim());
  } finally { removeDir(repo); }
});

test('works for a linked worktree: the exclude file git names is the one written', { skip: !gitAvailable }, async () => {
  const repo = makeRepo();
  try {
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
    const worktree = path.join(repo, '..', `${path.basename(repo)}-wt`);
    git(repo, 'worktree', 'add', '-q', '-b', 'wt', worktree);
    try {
      const result = await addGitExcludeEntries(worktree, ['.claude/agents/a.md']);
      assert.deepEqual(result.added, ['.claude/agents/a.md']);
      const expected = path.resolve(worktree, git(worktree, 'rev-parse', '--git-path', 'info/exclude').trim());
      assert.equal(path.resolve(result.file ?? ''), expected);
      fs.mkdirSync(path.join(worktree, '.claude', 'agents'), { recursive: true });
      fs.writeFileSync(path.join(worktree, '.claude', 'agents', 'a.md'), 'x');
      assert.ok(git(worktree, 'check-ignore', '.claude/agents/a.md').trim());
    } finally { removeDir(worktree); }
  } finally { removeDir(repo); }
});

test('a folder that is not in a git repository is skipped silently', async () => {
  const folder = makeTempDir('not-a-repo-');
  try {
    assert.deepEqual(await addGitExcludeEntries(folder, ['.claude/agents/a.md']), { file: null, added: [] });
    assert.deepEqual(fs.readdirSync(folder), [], 'nothing was created');
  } finally { removeDir(folder); }
});

test('a folder that does not exist, and an empty entry list, are skipped silently', async () => {
  const folder = makeTempDir('gone-');
  try {
    assert.deepEqual(await addGitExcludeEntries(path.join(folder, 'missing'), ['.claude/agents/a.md']), { file: null, added: [] });
    assert.deepEqual(await addGitExcludeEntries(folder, []), { file: null, added: [] });
  } finally { removeDir(folder); }
});

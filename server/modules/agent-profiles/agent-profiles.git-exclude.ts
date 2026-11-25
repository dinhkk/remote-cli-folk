import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

/** A git lookup that takes longer than this is treated as "git unavailable". */
const GIT_TIMEOUT_MS = 5000;

/** Stdout (trimmed of the final line break only) of `git <args>` run in `cwd`, or null on any failure. */
function runGit(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : stdout.replace(/\r?\n$/, ''));
    });
  });
}

/**
 * Appends `entries` (paths relative to `directory`, e.g. `.claude/agents/review-code.md` or
 * `.claude/agent-memory/`) to the git repository's local exclude file, so generated agent files
 * (which hold rendered, possibly personal values) are never committed by accident and the team's
 * `.gitignore` is not touched.
 *
 * The exclude file is whatever `git rev-parse --git-path info/exclude` names when run in `directory`
 * (correct for worktrees and submodules). When `directory` is a sub-folder of the repository the
 * entries are prefixed with its path from the repository root, because exclude patterns that contain
 * a slash are anchored there. Idempotent: a line already present (also in its `/`-anchored form) is
 * not added again; the file and its folder are created when missing. Not a git repository, git
 * missing or any failure: nothing is changed and `file` is null (never throws).
 * Consumed by: agent-profiles.service.ts (after Generate wrote into a project folder).
 */
export async function addGitExcludeEntries(
  directory: string, entries: readonly string[],
): Promise<{ file: string | null; added: string[] }> {
  if (entries.length === 0) return { file: null, added: [] };
  try {
    const excludePath = await runGit(directory, ['rev-parse', '--git-path', 'info/exclude']);
    const prefix = await runGit(directory, ['rev-parse', '--show-prefix']);
    if (!excludePath || prefix === null) return { file: null, added: [] };
    const file = path.resolve(directory, excludePath);

    let current = '';
    try {
      current = await fs.readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const present = new Set(current.split(/\r?\n/).map((line) => line.trim()));
    const wanted = entries.map((entry) => `${prefix}${entry}`);
    const added = wanted.filter((line) => !present.has(line) && !present.has(`/${line}`));
    if (added.length === 0) return { file, added: [] };

    await fs.mkdir(path.dirname(file), { recursive: true });
    const separator = current === '' || current.endsWith('\n') ? '' : '\n';
    await fs.appendFile(file, `${separator}${added.join('\n')}\n`, 'utf8');
    return { file, added };
  } catch {
    // Excluding is a convenience: a failure here must never fail the Generate that already wrote the agents.
    return { file: null, added: [] };
  }
}

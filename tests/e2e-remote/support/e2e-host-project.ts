// A project on the Host's (temporary) home: a directory registered through the Host's own API, optionally a git
// repository with one commit. Everything lives under the redirected HOME of the child, never the developer's.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { E2eServer } from './e2e-server.js';

export type HostProject = { id: string; dir: string };

const git = (dir: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Creates `<host home>/<name>` (with a README, and a first commit when `repo`) and registers it as a project. */
export async function createHostProject(host: E2eServer, name: string, options: { repo?: boolean } = {}): Promise<HostProject> {
  const dir = path.join(host.home, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'README.md'), '# e2e project\n');
  if (options.repo) {
    git(dir, 'init', '-q');
    // Local identity only: the redirected HOME has no global git configuration.
    git(dir, 'config', 'user.email', 'e2e@example.invalid');
    git(dir, 'config', 'user.name', 'e2e');
    git(dir, 'config', 'core.autocrlf', 'false');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'initial');
  }
  const created = await host.api('/api/projects/create-project', { method: 'POST', body: { path: dir } });
  if (created.status !== 200) throw new Error(`create-project failed: ${created.status} ${created.text}`);
  return { id: created.json<{ project: { projectId: string } }>().project.projectId, dir };
}

/** Runs git in a project directory (assertions on what the Host really did to the repository). */
export const hostGit = git;

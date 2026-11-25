import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AgentProfileTemplate } from '@/shared/types.js';

/** Fresh temporary directory; tests never touch the real home directory. */
export function makeTempDir(prefix = 'agent-profiles-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeDir(directory: string): void {
  fs.rmSync(directory, { recursive: true, force: true });
}

const META = { id: 'x', rev: 1, updatedAt: '2026-01-01T00:00:00.000Z' };

export function makeTemplate(overrides: Partial<AgentProfileTemplate> = {}): AgentProfileTemplate {
  return {
    ...META, slug: 'review-code', family: 'worker', name: 'Code reviewer',
    description: 'Reviews merge requests.', instructions: 'Review code in {{git_url}}.',
    params: [{ key: 'git_url', type: 'url', title: 'Git URL', description: '', required: false }],
    bindings: { project: true, knowledge: false }, ...overrides,
  };
}

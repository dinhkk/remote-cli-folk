import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

type CheckResult = { ok: boolean; problems: string[] };

const forkRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const repoRoot = path.resolve(forkRoot, '..', '..', '..');
const scriptPath = path.join(forkRoot, 'scripts', 'check-remote-docs.mjs');

const FORK_RELATIVE = path.join('project', 'cloud-cli-remote', 'claudecodeui');
const DOC_FILES = [
  'docs/deployment-guide.md',
  'docs/system-architecture.md',
  'docs/project-roadmap.md',
  `${FORK_RELATIVE}/relay/README.md`,
];

// These integration fixtures belong to the parent workspace, not the public checkout.
// A partially present workspace must still fail its checks rather than hide missing docs.
const missingDocs = DOC_FILES.filter((relative) => !fs.existsSync(path.join(repoRoot, relative)));
const docsOptions = {
  skip: missingDocs.length === DOC_FILES.length
    ? `Parent workspace docs are unavailable: ${missingDocs.map((relative) => path.join(repoRoot, relative)).join(', ')}`
    : false,
};

const runChecker = (root?: string): CheckResult => {
  const args = [scriptPath, ...(root ? [root] : []), '--json'];
  const run = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.ok(run.stdout, `checker printed nothing: ${run.stderr}`);
  return JSON.parse(run.stdout) as CheckResult;
};

/** A repo-shaped temp directory holding copies of the real docs, so each case can break one thing. */
const makeTempRepo = (): { root: string; file(relative: string): string; cleanup(): void } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-docs-check-'));
  for (const relative of DOC_FILES) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, relative), target);
  }
  return { root, file: (relative) => path.join(root, relative), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
};

const withTempRepo = (body: (repo: ReturnType<typeof makeTempRepo>) => void): void => {
  const repo = makeTempRepo();
  try {
    body(repo);
  } finally {
    repo.cleanup();
  }
};

const edit = (file: string, change: (text: string) => string): void => {
  fs.writeFileSync(file, change(fs.readFileSync(file, 'utf8')));
};

test('the real Remote docs pass every check', docsOptions, () => {
  const result = runChecker();
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
});

test('a copy of the real docs passes, so the cases below fail only because of their own change', docsOptions, () => {
  withTempRepo((repo) => assert.deepEqual(runChecker(repo.root).problems, []));
});

test('a missing required file is reported', docsOptions, () => {
  withTempRepo((repo) => {
    fs.rmSync(repo.file('docs/project-roadmap.md'));
    const result = runChecker(repo.root);
    assert.equal(result.ok, false);
    assert.ok(result.problems.includes('missing required file: docs/project-roadmap.md'), result.problems.join('\n'));
  });
});

test('a missing required section and a missing keyword are reported', docsOptions, () => {
  withTempRepo((repo) => {
    edit(repo.file('docs/deployment-guide.md'), (text) =>
      text.replace('## Security headers', '## Headers').replaceAll('TRUST_PROXY', 'TRUSTED_HOPS'),
    );
    const result = runChecker(repo.root);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.includes('missing heading "Security headers"')), result.problems.join('\n'));
    assert.ok(result.problems.some((problem) => problem.includes('missing TRUST_PROXY')), result.problems.join('\n'));
  });
});

test('a broken file link and a broken anchor are reported, a good anchor is not', docsOptions, () => {
  withTempRepo((repo) => {
    edit(repo.file('docs/system-architecture.md'), (text) =>
      `${text}\n[gone](./does-not-exist.md)\n[bad anchor](deployment-guide.md#no-such-heading)\n[good anchor](deployment-guide.md#security-headers)\n`,
    );
    const { problems } = runChecker(repo.root);
    assert.ok(problems.some((problem) => problem.includes('broken link "./does-not-exist.md"')), problems.join('\n'));
    assert.ok(problems.some((problem) => problem.includes('broken anchor "deployment-guide.md#no-such-heading"')), problems.join('\n'));
    assert.ok(!problems.some((problem) => problem.includes('#security-headers')), problems.join('\n'));
  });
});

test('links inside code blocks and inline code are ignored', docsOptions, () => {
  withTempRepo((repo) => {
    edit(repo.file('docs/system-architecture.md'), (text) => `${text}\n\`[x](./nope.md)\`\n\n\`\`\`\n[y](./nope.md)\n\`\`\`\n`);
    assert.deepEqual(runChecker(repo.root).problems, []);
  });
});

test('an environment variable used in server or relay code but absent from the guide is reported', docsOptions, () => {
  withTempRepo((repo) => {
    const serverFile = repo.file(`${FORK_RELATIVE}/server/modules/remote/example-setting.ts`);
    fs.mkdirSync(path.dirname(serverFile), { recursive: true });
    fs.writeFileSync(serverFile, "export const SETTING = process.env.CLOUDCLI_REMOTE_BRAND_NEW_SETTING;\n// CLOUDCLI_REMOTE_PREFIX_ONLY_*\n");
    const relayFile = repo.file(`${FORK_RELATIVE}/relay/src/example.ts`);
    fs.mkdirSync(path.dirname(relayFile), { recursive: true });
    fs.writeFileSync(relayFile, "export const RELAY = 'CLOUDCLI_REMOTE_RELAY_ONLY_SETTING';\n");
    const testFile = repo.file(`${FORK_RELATIVE}/server/modules/remote/tests/ignored.test.ts`);
    fs.mkdirSync(path.dirname(testFile), { recursive: true });
    fs.writeFileSync(testFile, "export const IGNORED = 'CLOUDCLI_REMOTE_ONLY_IN_A_TEST';\n");

    const { problems } = runChecker(repo.root);
    assert.ok(problems.some((problem) => problem.includes('undocumented environment variable CLOUDCLI_REMOTE_BRAND_NEW_SETTING')), problems.join('\n'));
    assert.ok(problems.some((problem) => problem.includes('undocumented environment variable CLOUDCLI_REMOTE_RELAY_ONLY_SETTING')), problems.join('\n'));
    assert.ok(!problems.some((problem) => problem.includes('PREFIX_ONLY') || problem.includes('ONLY_IN_A_TEST')), problems.join('\n'));

    // Documenting it (as a whole word) clears the problem.
    edit(repo.file('docs/deployment-guide.md'), (text) => `${text}\n\`CLOUDCLI_REMOTE_BRAND_NEW_SETTING\`\n`);
    const after = runChecker(repo.root).problems;
    assert.ok(!after.some((problem) => problem.includes('BRAND_NEW_SETTING')), after.join('\n'));
  });
});

test('a default in the guide that differs from the constant in the code is reported; the real defaults agree', docsOptions, () => {
  assert.deepEqual(runChecker().problems, [], 'the real guide and the real code agree on every checked default');
  withTempRepo((repo) => {
    const source = repo.file(`${FORK_RELATIVE}/server/modules/remote/quota/pairing-quota.service.ts`);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'export const DEFAULT_QUOTA_LIMITS = { maxStreams: 99, maxPty: 8, maxWs: 8, newStreamsPerSecond: 50, violationsPerMinute: 20 };\n');
    const { problems } = runChecker(repo.root);
    assert.ok(
      problems.some((problem) => problem.includes('CLOUDCLI_REMOTE_QUOTA_STREAMS is documented with default "64" but the code default is 99')),
      problems.join('\n'),
    );
    assert.equal(problems.length, 1, 'only the changed constant is reported');

    edit(repo.file('docs/deployment-guide.md'), (text) => text.replace(/(\| `CLOUDCLI_REMOTE_QUOTA_STREAMS` \| )64( \|)/, (_match, before: string, after: string) => `${before}99${after}`));
    assert.deepEqual(runChecker(repo.root).problems, []);
  });
});

test('a default whose pattern no longer matches the code is reported instead of silently skipped', docsOptions, () => {
  withTempRepo((repo) => {
    const source = repo.file(`${FORK_RELATIVE}/server/modules/remote/pairing/pairing-expiry.service.ts`);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'export const IDLE = 30;\n');
    const { problems } = runChecker(repo.root);
    assert.ok(problems.some((problem) => problem.includes('cannot read the default of CLOUDCLI_REMOTE_PAIRING_IDLE_DAYS')), problems.join('\n'));
  });
});

test('a longer variable name does not count as documenting a shorter one', docsOptions, () => {
  withTempRepo((repo) => {
    const serverFile = repo.file(`${FORK_RELATIVE}/server/modules/remote/short-name.ts`);
    fs.mkdirSync(path.dirname(serverFile), { recursive: true });
    fs.writeFileSync(serverFile, "export const NAME = 'CLOUDCLI_REMOTE_QUOTA';\n");
    const { problems } = runChecker(repo.root);
    assert.ok(problems.some((problem) => problem.includes('undocumented environment variable CLOUDCLI_REMOTE_QUOTA ')), problems.join('\n'));
  });
});

test('a document of 800 lines or more is reported', docsOptions, () => {
  withTempRepo((repo) => {
    edit(repo.file('docs/project-roadmap.md'), (text) => `${text}${'filler\n'.repeat(800)}`);
    const { problems } = runChecker(repo.root);
    assert.ok(problems.some((problem) => /docs\/project-roadmap\.md: \d+ lines, must be under 800/.test(problem)), problems.join('\n'));
  });
});

test('the command line exits 1 and lists the problems when something is wrong, 0 when all is well', docsOptions, () => {
  withTempRepo((repo) => {
    fs.rmSync(repo.file('docs/system-architecture.md'));
    const failing = spawnSync(process.execPath, [scriptPath, repo.root], { encoding: 'utf8' });
    assert.equal(failing.status, 1);
    assert.match(failing.stderr, /missing required file: docs\/system-architecture\.md/);
  });
  const passing = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.equal(passing.status, 0, passing.stderr);
  assert.match(passing.stdout, /Remote docs OK/);
});

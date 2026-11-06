import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  loadTestClaudeCreateQuery,
  TEST_CLAUDE_QUERY_MODULE_ENV,
} from '@/modules/providers/services/test-claude-query-seam.js';

/**
 * The scripted Claude SDK seam must exist only under NODE_ENV=test: a production process that happens to
 * carry the variable must never load a module from it.
 */

async function withModule(source: string, run: (modulePath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-query-seam-'));
  try {
    const modulePath = path.join(dir, 'scripted-query.mjs');
    await writeFile(modulePath, source, 'utf8');
    await run(modulePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('the seam module is loaded when NODE_ENV is test', async () => {
  await withModule('export const createQuery = () => "scripted";', async (modulePath) => {
    const createQuery = await loadTestClaudeCreateQuery({ NODE_ENV: 'test', [TEST_CLAUDE_QUERY_MODULE_ENV]: modulePath });
    assert.equal(typeof createQuery, 'function');
    assert.equal((createQuery as unknown as () => string)(), 'scripted');
  });
});

test('the variable is ignored when NODE_ENV is not test, and the module is never imported', async () => {
  await withModule('globalThis.__seamImported = true; export const createQuery = () => "scripted";', async (modulePath) => {
    for (const nodeEnv of [undefined, 'production', 'development', 'TEST', 'test ']) {
      const env: NodeJS.ProcessEnv = { [TEST_CLAUDE_QUERY_MODULE_ENV]: modulePath };
      if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
      assert.equal(await loadTestClaudeCreateQuery(env), undefined, `NODE_ENV=${String(nodeEnv)}`);
    }
    assert.equal((globalThis as { __seamImported?: boolean }).__seamImported, undefined);
  });
});

test('an empty or missing variable under NODE_ENV=test leaves the real SDK in place', async () => {
  assert.equal(await loadTestClaudeCreateQuery({ NODE_ENV: 'test' }), undefined);
  assert.equal(await loadTestClaudeCreateQuery({ NODE_ENV: 'test', [TEST_CLAUDE_QUERY_MODULE_ENV]: '  ' }), undefined);
});

test('a module without createQuery is refused loudly', async () => {
  await withModule('export const other = 1;', async (modulePath) => {
    await assert.rejects(
      loadTestClaudeCreateQuery({ NODE_ENV: 'test', [TEST_CLAUDE_QUERY_MODULE_ENV]: modulePath }),
      /must point at a module that exports createQuery/,
    );
  });
});

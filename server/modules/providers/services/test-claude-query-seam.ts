import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ProviderRuntimeContext } from '@/shared/types.js';

/**
 * Name of the environment variable that points at a module replacing the Claude SDK `query` function.
 * It exists only so end-to-end tests can run the REAL server (Claude runtime, permission cards, chat run
 * registry, WebSocket) against a scripted model: the variable is ignored unless `NODE_ENV` is exactly
 * `test`, so a production process never loads anything from it.
 */
export const TEST_CLAUDE_QUERY_MODULE_ENV = 'CLOUDCLI_TEST_CLAUDE_QUERY_MODULE';

type CreateQuery = NonNullable<ProviderRuntimeContext['createQuery']>;

/**
 * Loads the scripted `createQuery` named by `CLOUDCLI_TEST_CLAUDE_QUERY_MODULE` (an ES module exporting
 * `createQuery`), or returns undefined when `NODE_ENV` is not `test` or the variable is empty.
 * Consumed by: the provider runtime service (once, at import time).
 */
export async function loadTestClaudeCreateQuery(env: NodeJS.ProcessEnv = process.env): Promise<CreateQuery | undefined> {
  if (env.NODE_ENV !== 'test') {
    return undefined;
  }

  const modulePath = env[TEST_CLAUDE_QUERY_MODULE_ENV]?.trim();
  if (!modulePath) {
    return undefined;
  }

  const loaded = (await import(pathToFileURL(path.resolve(modulePath)).href)) as { createQuery?: unknown };
  if (typeof loaded.createQuery !== 'function') {
    throw new Error(`${TEST_CLAUDE_QUERY_MODULE_ENV} must point at a module that exports createQuery().`);
  }
  return loaded.createQuery as CreateQuery;
}

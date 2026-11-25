import os from 'node:os';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import { buildClaudeSdkEnv } from '@/modules/providers/index.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import type { ClaudeSdkAgentInfo } from '@/shared/types.js';

// Below the listing service's own 10 s backstop, so the CLI process is aborted before the service gives up.
const QUERY_TIMEOUT_MS = 8_000;

/**
 * Asks Claude Code which agents it knows (`supportedAgents()`) through a temporary
 * SDK query that is closed right after. No prompt is sent, so no model call is made.
 * It starts the CLI exactly like a chat run does (same executable resolution and
 * environment), from a neutral directory with no settings sources, so what comes
 * back is the built-in set and never another project's `.claude/agents`.
 * Throws on any failure; the listing service then falls back to a static list.
 * Consumed by: agent-profiles.module.ts (given to the Claude agents service).
 */
export async function querySupportedClaudeAgents(): Promise<ClaudeSdkAgentInfo[]> {
  const abort = new AbortController();
  // Rejects when the query is aborted, so a stuck CLI cannot leave the await below pending.
  const aborted = new Promise<never>((_resolve, reject) => {
    abort.signal.addEventListener('abort', () => reject(new Error('built-in agent lookup aborted')), { once: true });
  });
  aborted.catch(() => undefined);
  const timer = setTimeout(() => abort.abort(), QUERY_TIMEOUT_MS);
  let temporaryQuery: ReturnType<typeof query> | undefined;
  try {
    // Streaming input that never yields: keeps the CLI waiting for a prompt we do not send.
    const idleInput: AsyncIterable<SDKUserMessage> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          abort.signal.addEventListener('abort', () => resolve({ done: true, value: undefined }), { once: true });
        }),
      }),
    };
    const executablePath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
    temporaryQuery = query({
      prompt: idleInput,
      options: {
        cwd: os.tmpdir(),
        env: buildClaudeSdkEnv(),
        settingSources: [],
        abortController: abort,
        ...(executablePath ? { pathToClaudeCodeExecutable: executablePath } : {}),
      },
    });
    const agents = await Promise.race([temporaryQuery.supportedAgents(), aborted]);
    return agents.map(({ name, description, model }) => ({ name, description, ...(model ? { model } : {}) }));
  } finally {
    clearTimeout(timer);
    temporaryQuery?.close();
    abort.abort();
  }
}

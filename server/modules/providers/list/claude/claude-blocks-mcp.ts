import type { AnyRecord, SessionAgentSnapshot } from '@/shared/types.js';
// Deep import on purpose: the agent-profiles barrel depends on this module, so importing it statically would close a cycle.
// The target file imports nothing, so this edge cannot cycle; it is the only way to share the tool names without a copy.
// oxlint-disable-next-line boundaries/dependencies
import { BLOCKS_READ_TOOL_NAMES } from '@/modules/agent-profiles/agent-profiles.blocks.tool-names.js';

/** Writer name recorded for a block write made in a chat that has no main agent (the sub-agent's work is the chat's). */
export const PLAIN_CHAT_BLOCKS_WRITER = 'claude-code';

/**
 * Who the `blocks` server works for in this run: the session's main agent when it has one; otherwise
 * `claude-code` when the run's folder owns at least one project-scoped block (plain chat or a scoped chat with
 * `agentName: null`, where Claude Code hands work to the generated sub-agents itself); otherwise `undefined`
 * (no server). Global blocks alone never attach the server, so a plain chat in a folder with no project memory
 * carries no MCP server and no extra tools. A store error is logged and counts as "no blocks": the run goes on.
 * The agent-profiles module is loaded on first use (see `withBlocksMcpServer`).
 * Consumed by: claude-runtime.provider.ts.
 */
export async function resolveBlocksAgentName(
  agentProfile: SessionAgentSnapshot | undefined,
  cwd: string | undefined,
): Promise<string | undefined> {
  if (agentProfile?.agentName) return agentProfile.agentName;
  if (!cwd) return undefined;
  try {
    const { directoryHasProjectBlocks } = await import('@/modules/agent-profiles/index.js');
    return directoryHasProjectBlocks(cwd) ? PLAIN_CHAT_BLOCKS_WRITER : undefined;
  } catch (error) {
    console.warn('[Claude SDK] Unable to read memory blocks; running without the blocks server:', error);
    return undefined;
  }
}

/**
 * Pre-approves the two read tools of the `blocks` server (`block_list`, `block_read`) when the run has the server
 * (`blocksAgentName` set): they change nothing. `block_write` is deliberately NOT here: it goes through the normal
 * approval flow (and so the permission mode, plan mode included), because an agent could otherwise persist text into
 * any visible writable block, a global one included, without a prompt. The handler still enforces read-only, size and
 * name rules. Returns the list unchanged when the server is not attached; never mutates `allowedTools`.
 */
export function withBlocksToolsAllowed(
  allowedTools: string[],
  blocksAgentName: string | undefined,
): string[] {
  if (!blocksAgentName) return allowedTools;
  return [...allowedTools, ...BLOCKS_READ_TOOL_NAMES.filter((name) => !allowedTools.includes(name))];
}

/**
 * Adds the app-owned `blocks` MCP server to the run's `mcpServers` when the run has a `blocksAgentName` (see
 * `resolveBlocksAgentName`). The existing servers (the Claude config's and the project's) are kept: the result is a
 * new map holding all of them plus `blocks`, never a replacement. A configured server that is itself called `blocks`
 * is replaced, because the `mcp__blocks__*` tool names are the app's contract with generated agents.
 *
 * Must run on EVERY run, resumed ones included: a resumed session does not remember the in-process server, so
 * without it the agent loses the tools. `cwd` is the project folder of the run, which decides the project blocks the
 * agent sees next to the global ones. `blocksAgentName` is recorded as the writer (`agent:<name>`) of its writes.
 * Returns `servers` unchanged (possibly null) when no server is attached.
 *
 * The agent-profiles module is loaded on first use, not at import: it already depends on the providers module
 * (built-in agent list), and a static import here would close that cycle while the Claude runtime is still
 * being defined.
 * Consumed by: claude-runtime.provider.ts.
 */
export async function withBlocksMcpServer(
  servers: AnyRecord | null,
  blocksAgentName: string | undefined,
  cwd: string | undefined,
): Promise<AnyRecord | null> {
  if (!blocksAgentName) return servers;
  const { createBlocksMcpServerForRun } = await import('@/modules/agent-profiles/index.js');
  return { ...(servers ?? {}), blocks: createBlocksMcpServerForRun({ directory: cwd ?? null, agentName: blocksAgentName }) };
}

/**
 * Names of the tools of the in-process `blocks` MCP server, as a Claude agent sees and lists them
 * (`mcp__<server>__<tool>`). The one place both sides read: the generator puts them into an agent's `tools:` line
 * and the Claude runtime pre-approves the read ones, so they cannot drift apart.
 * Imports nothing on purpose: the agent-profiles barrel depends on the providers module, so the providers module
 * must load these names without going through that barrel (a static import of it would close an import cycle).
 * Consumed by: agent-profiles.generator.ts, claude-blocks-mcp.ts (providers).
 */
export const BLOCK_LIST_TOOL = 'mcp__blocks__block_list';
export const BLOCK_READ_TOOL = 'mcp__blocks__block_read';
export const BLOCK_WRITE_TOOL = 'mcp__blocks__block_write';

/** All three tools: what a `usesBlocks` agent with a restricted `tools:` list needs. */
export const BLOCKS_TOOL_NAMES = [BLOCK_LIST_TOOL, BLOCK_READ_TOOL, BLOCK_WRITE_TOOL] as const;

/** The tools that only look: pre-approved for a session with a main agent. `block_write` is left to the normal approval flow. */
export const BLOCKS_READ_TOOL_NAMES = [BLOCK_LIST_TOOL, BLOCK_READ_TOOL] as const;

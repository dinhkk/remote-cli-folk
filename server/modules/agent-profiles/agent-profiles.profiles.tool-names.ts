/**
 * Names of the tools of the in-process `profiles` MCP server, as a Claude agent sees and lists them
 * (`mcp__<server>__<tool>`). The one place both sides read: the changeset guardrail refuses a template that names them,
 * and the Claude runtime pre-approves them (none changes the store: a proposal is only staged for the Host user).
 * Imports nothing on purpose: the agent-profiles barrel depends on the providers module, so the providers module
 * must load these names without going through that barrel (a static import of it would close an import cycle).
 * Consumed by: agent-profiles.changeset.ts, agent-profiles.profiles.mcp.ts, claude-profiles-mcp.ts (providers).
 */
export const PROFILES_LIST_TOOL = 'mcp__profiles__profiles_list';
export const PROFILES_GET_TOOL = 'mcp__profiles__profiles_get';
export const PROFILES_PREVIEW_TOOL = 'mcp__profiles__profiles_preview';
export const PROFILES_PROPOSE_TOOL = 'mcp__profiles__profiles_propose';

/** All four tools; every one of them is pre-approved because none of them writes the live store. */
export const PROFILES_TOOL_NAMES = [PROFILES_LIST_TOOL, PROFILES_GET_TOOL, PROFILES_PREVIEW_TOOL, PROFILES_PROPOSE_TOOL] as const;

/** Tool-list entry that names the whole server (`mcp__profiles`) or any of its tools (`mcp__profiles__*`); matched case-insensitively. */
export const PROFILES_TOOL_REFERENCE = /^mcp__profiles/i;

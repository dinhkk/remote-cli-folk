import type { AnyRecord, SessionAgentSnapshot } from '@/shared/types.js';
import { readRunOrigin } from '@/shared/utils.js';
// Deep import on purpose: the agent-profiles barrel depends on this module, so importing it statically would close a cycle.
// The target file imports nothing, so this edge cannot cycle; it is the only way to share the tool names without a copy.
// oxlint-disable-next-line boundaries/dependencies
import { PROFILES_TOOL_NAMES } from '@/modules/agent-profiles/agent-profiles.profiles.tool-names.js';

/**
 * Which main agent the `profiles` server works for in this run, or `undefined` (no server). ALL of these must hold:
 * the run is local (`readRunOrigin(origin) === 'local'`: a Remote, scheduled, queued, API-key or unknown-origin run never
 * qualifies), the session has a main agent, that agent is on the Host's allowlist (`profileManagerAgents`), and its name
 * resolves to the user-level generated agent file (a project file of the same name does not count). Any error (unreadable
 * or malformed settings, unreadable folder) is logged by the agent-profiles module and counts as "no": the run goes on
 * without the tools. The agent-profiles module is loaded on first use, and only for a local run with a main agent.
 * Consumed by: claude-runtime.provider.ts.
 */
export async function resolveProfilesAgentName(
  agentProfile: SessionAgentSnapshot | undefined,
  origin: unknown,
  cwd: string | undefined,
): Promise<string | undefined> {
  const agentName = agentProfile?.agentName;
  if (!agentName || readRunOrigin(origin) !== 'local') return undefined;
  try {
    const { isProfilesManagerRun } = await import('@/modules/agent-profiles/index.js');
    return await isProfilesManagerRun(agentName, cwd) ? agentName : undefined;
  } catch (error) {
    console.warn('[Claude SDK] Unable to check the profiles allowlist; running without the profiles server:', error);
    return undefined;
  }
}

/**
 * Pre-approves the four `profiles` tools when the run has the server (`profilesAgentName` set): none of them changes the
 * store (a proposal is only staged; the Host user confirms it in the app), so the SDK permission prompt, which a permission
 * mode or a remembered tool can bypass anyway, is not what protects the store. Returns the list unchanged when the server is
 * not attached; never mutates `allowedTools`.
 * Consumed by: claude-runtime.provider.ts.
 */
export function withProfilesToolsAllowed(allowedTools: string[], profilesAgentName: string | undefined): string[] {
  if (!profilesAgentName) return allowedTools;
  return [...allowedTools, ...PROFILES_TOOL_NAMES.filter((name) => !allowedTools.includes(name))];
}

/**
 * Adds the app-owned `profiles` MCP server to the run's `mcpServers` when the run has a `profilesAgentName` (see
 * `resolveProfilesAgentName`). Like `withBlocksMcpServer`: the existing servers are kept (a configured server that is itself
 * called `profiles` is replaced, because the `mcp__profiles__*` names are the app's contract), it must run on EVERY run
 * (a resumed session does not remember the in-process server), and `servers` comes back unchanged when nothing is attached.
 * Consumed by: claude-runtime.provider.ts.
 */
export async function withProfilesMcpServer(servers: AnyRecord | null, profilesAgentName: string | undefined): Promise<AnyRecord | null> {
  if (!profilesAgentName) return servers;
  const { createProfilesMcpServerForRun } = await import('@/modules/agent-profiles/index.js');
  return { ...(servers ?? {}), profiles: createProfilesMcpServerForRun({ agentName: profilesAgentName }) };
}

// agentProfilesRoutes: used by the server entrypoint to mount the protected agent-profile endpoints.
// resolveSessionAgentScope: used by the providers module's session creation route to check the chosen main agent and build the session's agent record.
// createBlocksMcpServerForRun: used by the providers module's Claude runtime to attach the app-owned memory blocks MCP server to a run.
// directoryHasProjectBlocks: used by the same runtime to decide if a chat without a main agent still gets that server.
export {
  agentProfilesRoutes, createBlocksMcpServerForRun, directoryHasProjectBlocks, resolveSessionAgentScope,
} from './agent-profiles.module.js';

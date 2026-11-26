// agentProfilesBundleBodyParser: used by the server entrypoint to cap the bundle import routes at 5 MB before the global body parser.
// agentProfilesRoutes: used by the server entrypoint to mount the protected agent-profile endpoints.
// resolveSessionAgentScope: used by the providers module's session creation route to check the chosen main agent and build the session's agent record.
// createBlocksMcpServerForRun: used by the providers module's Claude runtime to attach the app-owned memory blocks MCP server to a run.
// directoryHasProjectContent: used by the same runtime to decide if a chat without a main agent still gets that server.
export { agentProfilesBundleBodyParser } from './agent-profiles.routes.js';
export {
  agentProfilesRoutes, createBlocksMcpServerForRun, directoryHasProjectContent, resolveSessionAgentScope,
} from './agent-profiles.module.js';

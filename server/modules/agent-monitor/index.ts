// agentMonitorRoutes: used by the server entrypoint to mount the protected agent-monitor endpoint.
// stopAgentMonitor: used by the server entrypoint at shutdown to end the CPU/RAM sampler.
export { agentMonitorRoutes, stopAgentMonitor } from './agent-monitor.module.js';

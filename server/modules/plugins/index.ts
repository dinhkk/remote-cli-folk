// pluginsRoutes: used by the server entrypoint to mount protected plugin-management endpoints.
export { pluginsRoutes } from './plugins.module.js';

// startEnabledPluginServers: used by the server entrypoint to start enabled plugin subprocesses.
export { startEnabledPluginServers } from './plugin-process.service.js';
// stopAllPlugins: used by the server entrypoint to stop plugin subprocesses during shutdown.
export { stopAllPlugins } from './plugin-process.service.js';
// getPluginPort: used by WebSocket setup in the server entrypoint to proxy plugin connections.
export { getPluginPort } from './plugin-process.service.js';
// PLUGINS_DISABLED: used by the server entrypoint to refuse plugin WebSocket connections while plugins are off.
export { PLUGINS_DISABLED } from './plugins-switch.js';
// pluginsSwitch: mounted by the server entrypoint between authentication and the plugin router.
export { pluginsSwitch } from './plugins-switch.js';

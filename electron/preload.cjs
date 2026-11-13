const { contextBridge, ipcRenderer } = require('electron');

function isRemoteCliAppOrigin(location) {
  if (location.protocol === 'file:') return true;

  if (location.protocol === 'http:') {
    return location.hostname === '127.0.0.1' || location.hostname === 'localhost';
  }

  return location.protocol === 'https:' && (
    location.hostname === 'remotecli.ai' || location.hostname.endsWith('.remotecli.ai') ||
    location.hostname === 'cloudcli.ai' || location.hostname.endsWith('.cloudcli.ai')
  );
}

function onDesktopStateUpdated(callback) {
  const listener = (_event, state) => callback(state);
  ipcRenderer.on('remotecli-desktop:state-updated', listener);
  ipcRenderer.on('cloudcli-desktop:state-updated', listener);
  return () => {
    ipcRenderer.removeListener('remotecli-desktop:state-updated', listener);
    ipcRenderer.removeListener('cloudcli-desktop:state-updated', listener);
  };
}

const desktopNotificationApi = {
  getState: () => ipcRenderer.invoke('remotecli-desktop:get-state').catch(() => ipcRenderer.invoke('cloudcli-desktop:get-state')),
  update: (settings) => ipcRenderer.invoke('remotecli-desktop:update-desktop-notifications', settings).catch(() => ipcRenderer.invoke('cloudcli-desktop:update-desktop-notifications', settings)),
  onStateUpdated: onDesktopStateUpdated,
};

if (isRemoteCliAppOrigin(window.location)) {
  contextBridge.exposeInMainWorld('remotecliDesktopNotifications', desktopNotificationApi);
  contextBridge.exposeInMainWorld('cloudcliDesktopNotifications', desktopNotificationApi);
}

if (window.location.protocol === 'file:') {
  const invokeDesktop = (channel, ...args) => {
    return ipcRenderer.invoke(`remotecli-desktop:${channel}`, ...args)
      .catch((error) => {
        if (error && error.message && error.message.includes('No handler registered')) {
          return ipcRenderer.invoke(`cloudcli-desktop:${channel}`, ...args);
        }
        throw error;
      });
  };

  const desktopApi = {
    connectCloud: () => invokeDesktop('connect-cloud'),
    disconnectCloud: () => invokeDesktop('disconnect-cloud'),
    copyDiagnostics: () => invokeDesktop('copy-diagnostics'),
    copyLocalWebUrl: () => invokeDesktop('copy-local-web-url'),
    getState: () => invokeDesktop('get-state'),
    openCloudDashboard: () => invokeDesktop('open-cloud-dashboard'),
    openEnvironment: (environmentId) => invokeDesktop('open-environment', environmentId),
    runActiveEnvironmentAction: (action) => invokeDesktop('run-active-environment-action', action),
    openLocal: () => invokeDesktop('open-local'),
    openLocalWebUi: () => invokeDesktop('open-local-web-ui'),
    refreshEnvironments: () => invokeDesktop('refresh-environments'),
    refreshActiveTab: () => invokeDesktop('reload-active-tab'),
    showEnvironmentPicker: () => invokeDesktop('show-environment-picker'),
    showLauncher: () => invokeDesktop('show-launcher'),
    showLocalSettings: () => invokeDesktop('show-local-settings'),
    showDesktopSettings: () => invokeDesktop('show-desktop-settings'),
    closeSettingsWindow: () => invokeDesktop('close-settings-window'),
    showActiveEnvironmentActionsMenu: () => invokeDesktop('show-active-environment-actions-menu'),
    showEnvironmentActionsMenu: (environmentId) => invokeDesktop('show-environment-actions-menu', environmentId),
    switchTab: (tabId) => invokeDesktop('switch-tab', tabId),
    closeTab: (tabId) => invokeDesktop('close-tab', tabId),
    updateSetting: (key, value) => invokeDesktop('update-setting', key, value),
    onStateUpdated: onDesktopStateUpdated,
    onLauncherCommand: (callback) => {
      const listener = (_event, command) => callback(command);
      ipcRenderer.on('remotecli-desktop:launcher-command', listener);
      ipcRenderer.on('cloudcli-desktop:launcher-command', listener);
    },
  };

  contextBridge.exposeInMainWorld('remotecliDesktop', desktopApi);
  contextBridge.exposeInMainWorld('cloudcliDesktop', desktopApi);
}

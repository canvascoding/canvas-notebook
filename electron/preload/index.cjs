const { contextBridge, ipcRenderer } = require('electron');

function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args);
}

contextBridge.exposeInMainWorld('canvasDesktop', {
  getAppInfo: () => invoke('desktop:get-app-info'),
  getServerUrl: () => invoke('desktop:get-server-url'),
  validateServerUrl: url => invoke('desktop:validate-server-url', url),
  setServerUrl: url => invoke('desktop:set-server-url', url),
  clearServerUrl: () => invoke('desktop:clear-server-url'),
  openExternal: url => invoke('desktop:open-external', url),
});


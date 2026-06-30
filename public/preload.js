const { contextBridge, ipcRenderer } = require('electron');

// Expose safe APIs to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // Get app information
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getAppPath: () => ipcRenderer.invoke('get-app-path'),

  // Data export/import
  exportData: (data, filename) => {
    ipcRenderer.invoke('export-data', { data, filename });
  },

  importData: () => ipcRenderer.invoke('import-data'),

  // File operations
  openFile: (options) => ipcRenderer.invoke('open-file', options),
  saveFile: (options) => ipcRenderer.invoke('save-file', options),

  // Listen for events
  onDataLoaded: (callback) => {
    ipcRenderer.on('data-loaded', callback);
  },

  // App control
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  maximizeWindow: () => ipcRenderer.invoke('maximize-window'),
  closeWindow: () => ipcRenderer.invoke('close-window'),
});

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('behaviorSettings', {
  get: () => ipcRenderer.invoke('behavior-settings:get'),
  save: (settings) => ipcRenderer.invoke('behavior-settings:save', settings)
});

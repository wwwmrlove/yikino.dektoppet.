'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petMenu', {
  getState: () => ipcRenderer.invoke('pet-menu:get-state'),
  runAction: (action, value) => ipcRenderer.invoke('pet-menu:action', { action, value }),
  onRefresh: (callback) => ipcRenderer.on('pet-menu:refresh', (_event, state) => callback(state))
});

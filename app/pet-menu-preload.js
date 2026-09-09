'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petMenu', {
  getState: () => ipcRenderer.invoke('pet-menu:get-state'),
  runAction: (action, value) => ipcRenderer.invoke('pet-menu:action', { action, value }),
  moveWindow: (x, y, final = false) => ipcRenderer.send('pet-menu:move', { x, y, final }),
  onRefresh: (callback) => ipcRenderer.on('pet-menu:refresh', (_event, state) => callback(state))
});

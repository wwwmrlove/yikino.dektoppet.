'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('subtitleCloud', {
  onShow: (callback) => ipcRenderer.on('subtitle:show', (_event, payload) => callback(payload)),
  onHide: (callback) => ipcRenderer.on('subtitle:hide', (_event, token) => callback(token)),
  onPosition: (callback) => ipcRenderer.on('subtitle:position', (_event, payload) => callback(payload))
});

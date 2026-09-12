'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopPet', {
  getState: () => ipcRenderer.invoke('pet:state'),
  moveTo: (x, y) => ipcRenderer.send('pet:move', { x, y }),
  showMenu: () => ipcRenderer.send('pet:menu'),
  saveScale: (scale) => ipcRenderer.send('pet:scale', scale),
  reportLayout: (layout) => ipcRenderer.send('pet:layout', layout),
  setPointerOver: (isOverPet) => ipcRenderer.send('pet:pointer-over', Boolean(isOverPet)),
  reportInteraction: (type) => ipcRenderer.send('pet:interaction', type),
  speechStarted: (payload) => ipcRenderer.send('pet:speech-started', payload),
  speechEnded: (token) => ipcRenderer.send('pet:speech-ended', token),
  rendererReady: () => ipcRenderer.send('pet:renderer-ready'),
  rendererFailed: (message) => ipcRenderer.send('pet:renderer-failed', message),
  onExpression: (callback) => ipcRenderer.on('pet:expression', (_event, name) => callback(name)),
  onSpeak: (callback) => ipcRenderer.on('pet:speak', (_event, dialogue) => callback(dialogue)),
  onSpeechCancelled: (callback) => ipcRenderer.on('pet:speech-cancelled', (_event, payload) => callback(payload)),
  onScaleStep: (callback) => ipcRenderer.on('pet:scale-step', (_event, amount) => callback(amount)),
  onScaleReset: (callback) => ipcRenderer.on('pet:scale-reset', callback),
  onPointerPosition: (callback) => ipcRenderer.on('pet:pointer-position', (_event, point) => callback(point)),
  onClickThrough: (callback) => ipcRenderer.on('pet:click-through', (_event, enabled) => callback(enabled))
});

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('weatherSettings', {
  getStatus: () => ipcRenderer.invoke('weather-settings:get'),
  saveCity: (city) => ipcRenderer.invoke('weather-settings:save', city),
  refresh: () => ipcRenderer.invoke('weather-settings:refresh'),
  disable: () => ipcRenderer.invoke('weather-settings:disable')
});

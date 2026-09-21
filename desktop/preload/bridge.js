'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const api = {
  toggleCompact: () => ipcRenderer.invoke('cockpit:toggleCompact'),
  toggleVisible: () => ipcRenderer.invoke('cockpit:toggleVisible'),
  captureExam: (options) => ipcRenderer.invoke('liuwa:capture', options),
  sendChat: () => ipcRenderer.invoke('liuwa:send'),
  getConfig: () => ipcRenderer.invoke('cockpit:getConfig'),
  onCapture: (callback) => ipcRenderer.on('liuwa:capture', (_event, payload) => callback(payload)),
  onCaptureError: (callback) =>
    ipcRenderer.on('liuwa:capture-error', (_event, payload) => callback(payload)),
  onSend: (callback) => ipcRenderer.on('liuwa:send', () => callback()),
  onCompact: (callback) => ipcRenderer.on('cockpit:compact', (_event, value) => callback(value)),
  onArmed: (callback) => ipcRenderer.on('cockpit:armed', (_event, value) => callback(value)),
};

contextBridge.exposeInMainWorld('cockpit', api);

const bootConfig = ipcRenderer.sendSync('cockpit:getConfigSync');
contextBridge.exposeInMainWorld('__GATEWAY_URL__', bootConfig.gatewayUrl || '');
contextBridge.exposeInMainWorld('__GATEWAY_KEY__', bootConfig.gatewayApiKey || '');

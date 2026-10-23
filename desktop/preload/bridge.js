'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const api = {
  toggleCompact: () => ipcRenderer.invoke('cockpit:toggleCompact'),
  toggleVisible: () => ipcRenderer.invoke('cockpit:toggleVisible'),
  captureExam: (options) => ipcRenderer.invoke('liuwa:capture', options),
  sendChat: () => ipcRenderer.invoke('liuwa:send'),
  getConfig: () => ipcRenderer.invoke('cockpit:getConfig'),
  setDisplay: (patch) => ipcRenderer.invoke('cockpit:setDisplay', patch),
  onDisplay: (callback) => ipcRenderer.on('cockpit:display', (_event, value) => callback(value)),
  onCapture: (callback) => ipcRenderer.on('liuwa:capture', (_event, payload) => callback(payload)),
  onCaptureError: (callback) =>
    ipcRenderer.on('liuwa:capture-error', (_event, payload) => callback(payload)),
  onNewQuestion: (callback) => ipcRenderer.on('liuwa:new-question', () => callback()),
  onClearShots: (callback) => ipcRenderer.on('liuwa:clear-shots', () => callback()),
  onDeleteLastShot: (callback) => ipcRenderer.on('liuwa:delete-last-shot', () => callback()),
  onSend: (callback) => ipcRenderer.on('liuwa:send', () => callback()),
  onRead: (callback) => ipcRenderer.on('liuwa:read', (_event, direction) => callback(direction)),
  onScroll: (callback) => ipcRenderer.on('liuwa:scroll', (_event, direction) => callback(direction)),
  onCompact: (callback) => ipcRenderer.on('cockpit:compact', (_event, value) => callback(value)),
  onHotkeys: (callback) => ipcRenderer.on('cockpit:hotkeys', (_event, value) => callback(value)),
  onArmed: (callback) => ipcRenderer.on('cockpit:armed', (_event, value) => callback(value)),
};

contextBridge.exposeInMainWorld('cockpit', api);

const bootConfig = ipcRenderer.sendSync('cockpit:getConfigSync');
contextBridge.exposeInMainWorld('__GATEWAY_URL__', bootConfig.gatewayUrl || '');
contextBridge.exposeInMainWorld('__GATEWAY_KEY__', bootConfig.gatewayApiKey || '');

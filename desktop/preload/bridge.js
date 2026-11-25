'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const api = {
  toggleCompact: () => ipcRenderer.invoke('cockpit:toggleCompact'),
  toggleVisible: () => ipcRenderer.invoke('cockpit:toggleVisible'),
  captureExam: (options) => ipcRenderer.invoke('liuwa:capture', options),
  sendChat: () => ipcRenderer.invoke('liuwa:send'),
  getConfig: () => ipcRenderer.invoke('cockpit:getConfig'),
  setDisplay: (patch) => ipcRenderer.invoke('cockpit:setDisplay', patch),
  setSurface: (patch) => ipcRenderer.invoke('cockpit:setSurface', patch),
  setTextEditing: (value) => ipcRenderer.invoke('cockpit:setTextEditing', value),
  onTextEditing: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('cockpit:textEditing', listener);
    return () => ipcRenderer.removeListener('cockpit:textEditing', listener);
  },
  setCaptureOptions: (patch) => ipcRenderer.invoke('cockpit:setCaptureOptions', patch),
  openSettings: (section) => ipcRenderer.invoke('cockpit:openSettings', section),
  getInterviewState: () => ipcRenderer.invoke('interview:getState'),
  publishInterview: data => ipcRenderer.send('interview:publish', data),
  onInterviewCommand: callback => ipcRenderer.on('interview:command', (_event, command) => callback(command)),
  openInterviewSocket: id => ipcRenderer.invoke('interview:socket-open', id),
  sendInterviewSocket: (id, data) => ipcRenderer.send('interview:socket-send', id, data),
  closeInterviewSocket: id => ipcRenderer.send('interview:socket-close', id),
  onInterviewSocketEvent: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('interview:socket-event', listener);
    return () => ipcRenderer.removeListener('interview:socket-event', listener);
  },
  interviewCommand: command => ipcRenderer.invoke('interview:command', command),
  onInterviewState: callback => ipcRenderer.on('interview:state', (_event, value) => callback(value)),
  onInterviewControl: callback => ipcRenderer.on('liuwa:interview-control', (_event, action) => callback(action)),
  resetView: () => ipcRenderer.invoke('liuwa:reset-view'),
  onReset: (callback) => ipcRenderer.on('liuwa:reset-view', () => callback()),
  onDisplay: (callback) => ipcRenderer.on('cockpit:display', (_event, value) => callback(value)),
  onCaptureStart: callback => ipcRenderer.on('liuwa:capture-start', (_event, payload) => callback(payload)),
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
ipcRenderer.on('app:privacy-hidden', () => window.dispatchEvent(new Event('app:privacy-hidden')));

const bootConfig = ipcRenderer.sendSync('cockpit:getConfigSync');
contextBridge.exposeInMainWorld('__GATEWAY_URL__', bootConfig.gatewayUrl || '');
contextBridge.exposeInMainWorld('__GATEWAY_KEY__', bootConfig.gatewayApiKey || '');

contextBridge.exposeInMainWorld('__AUDIO_CAPTURE__', bootConfig.audioCapture || {systemAudioSupported:false});

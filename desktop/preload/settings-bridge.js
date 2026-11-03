'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const config = ipcRenderer.sendSync('cockpit:getConfigSync');
contextBridge.exposeInMainWorld('__GATEWAY_URL__', config.gatewayUrl || '');
contextBridge.exposeInMainWorld('__GATEWAY_KEY__', config.gatewayApiKey || '');
contextBridge.exposeInMainWorld('__APP_SETTINGS__', true);
contextBridge.exposeInMainWorld('__AUDIO_CAPTURE__', config.audioCapture || { systemAudioSupported: false });
contextBridge.exposeInMainWorld('interviewBridge', {
  publish: event => ipcRenderer.send('interview:publish', event),
  closeSettings: () => ipcRenderer.invoke('settings:close'),
  openAudioPermissions: kind => ipcRenderer.invoke('settings:audioPermissions', kind),
  onCommand: callback => ipcRenderer.on('interview:command', (_event, command) => callback(command)),
});
ipcRenderer.on('app:privacy-hidden', () => window.dispatchEvent(new Event('app:privacy-hidden')));
ipcRenderer.on('settings:navigate', (_event, section) => {
  if (['models', 'asr', 'interview', 'study', 'briefing', 'shortcuts', 'assets'].includes(section)) window.location.hash = section;
});

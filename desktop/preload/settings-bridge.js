'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const config = ipcRenderer.sendSync('cockpit:getConfigSync');
contextBridge.exposeInMainWorld('__GATEWAY_URL__', config.gatewayUrl || '');
contextBridge.exposeInMainWorld('__GATEWAY_KEY__', config.gatewayApiKey || '');
contextBridge.exposeInMainWorld('__APP_SETTINGS__', true);
contextBridge.exposeInMainWorld('__AUDIO_CAPTURE__', config.audioCapture || { systemAudioSupported: false });
contextBridge.exposeInMainWorld('interviewBridge', {
  closeSettings: () => ipcRenderer.invoke('settings:close'),
  openAudioPermissions: kind => ipcRenderer.invoke('settings:audioPermissions', kind),
});
contextBridge.exposeInMainWorld('appearanceBridge', {
  getDisplay: () => ipcRenderer.invoke('settings:getDisplay'),
  setDisplay: patch => ipcRenderer.invoke('settings:setDisplay', patch),
  onDisplay: callback => ipcRenderer.on('cockpit:display', (_event, display) => callback(display)),
});
contextBridge.exposeInMainWorld('knowledgeBridge', {
  choose: input => ipcRenderer.invoke('knowledge-import:choose', input),
  read: input => ipcRenderer.invoke('knowledge-import:read', input),
  bind: input => ipcRenderer.invoke('knowledge-import:bind', input),
  release: input => ipcRenderer.invoke('knowledge-import:release', input),
  forget: input => ipcRenderer.invoke('knowledge-import:forget', input),
  hasSource: input => ipcRenderer.invoke('knowledge-import:hasSource', input),
});
ipcRenderer.on('app:privacy-hidden', () => window.dispatchEvent(new Event('app:privacy-hidden')));
ipcRenderer.on('settings:navigate', (_event, section) => {
  const anchor = section === 'interview' ? 'briefing' : section;
  if (['models', 'asr', 'study', 'briefing', 'knowledge', 'display', 'shortcuts', 'assets'].includes(anchor)) window.location.hash = anchor;
});

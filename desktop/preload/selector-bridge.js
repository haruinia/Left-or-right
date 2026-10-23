'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 框选覆盖层只做两件事：交矩形、取消。不给它别的能力。
contextBridge.exposeInMainWorld('__liuwaSelect', {
  commit: (rect) => ipcRenderer.send('selector:commit', rect),
  cancel: () => ipcRenderer.send('selector:cancel'),
});

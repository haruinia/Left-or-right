'use strict';

const { globalShortcut } = require('electron');

const BINDINGS = [
  { accelerator: 'CommandOrControl+Shift+Space', action: 'toggleVisible', label: '按住操作面板' },
  { accelerator: 'CommandOrControl+Shift+D', action: 'showWindow', label: '展示' },
  { accelerator: 'CommandOrControl+Shift+H', action: 'hideWindow', label: '隐藏' },
  { accelerator: 'CommandOrControl+Shift+Q', action: 'quitApp', label: '退出' },
  { accelerator: 'CommandOrControl+Shift+J', action: 'toggleCompact', label: '紧凑/展开' },
  { accelerator: 'CommandOrControl+Shift+U', action: 'captureRegion', label: '框选截图' },
  { accelerator: 'CommandOrControl+Shift+Y', action: 'captureScreen', label: '全屏截图' },
  { accelerator: 'CommandOrControl+Shift+Enter', action: 'sendChat', label: '发送给模型' },
];

function formatAccelerator(accelerator, platform = process.platform) {
  const mac = platform === 'darwin';
  const names = {
    CommandOrControl: mac ? '⌘' : 'Ctrl',
    Command: '⌘',
    Control: mac ? '⌃' : 'Ctrl',
    Shift: mac ? '⇧' : 'Shift',
    Alt: mac ? '⌥' : 'Alt',
    Option: '⌥',
    Space: 'Space',
    Enter: 'Enter',
    Return: 'Enter',
  };
  const parts = String(accelerator)
    .split('+')
    .map((token) => names[token] || token);
  return mac ? parts.join('') : parts.join('+');
}

function registerHotkeys(handlers, bindings = BINDINGS) {
  unregisterHotkeys();
  const failed = [];
  for (const binding of bindings) {
    const handler = handlers[binding.action];
    if (!handler) continue;
    const ok = globalShortcut.register(binding.accelerator, handler);
    if (!ok) failed.push(binding);
  }
  return failed;
}

function bindingsWith(overrides = {}) {
  return BINDINGS.map((binding) => ({
    ...binding,
    accelerator: String(overrides[binding.action] || binding.accelerator),
  }));
}

function unregisterHotkeys() {
  globalShortcut.unregisterAll();
}

module.exports = { registerHotkeys, unregisterHotkeys, BINDINGS, bindingsWith, formatAccelerator };

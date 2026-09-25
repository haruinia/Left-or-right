'use strict';

const { globalShortcut } = require('electron');

const BINDINGS = [
  { accelerator: 'CommandOrControl+Shift+U', action: 'captureRegion', label: '截图' },
  { accelerator: 'CommandOrControl+Shift+Enter', action: 'sendChat', label: '发送' },
  { accelerator: 'CommandOrControl+Shift+H', action: 'toggleWindow', label: '隐藏/显示' },
  { accelerator: 'CommandOrControl+Shift+Q', action: 'quitApp', label: '退出' },
  { accelerator: 'CommandOrControl+Shift+N', action: 'newQuestion', label: '新对话' },
  { accelerator: 'CommandOrControl+Shift+Backspace', action: 'clearShots', label: '清空截图' },

  { accelerator: 'CommandOrControl+Shift+Space', action: 'toggleVisible', label: '按住操作面板' },
  { accelerator: 'CommandOrControl+Shift+Y', action: 'captureScreen', label: '全屏截图' },
  { accelerator: 'CommandOrControl+Shift+J', action: 'toggleCompact', label: '紧凑/展开' },
  { accelerator: 'CommandOrControl+Shift+Up', action: 'moveUp', label: '窗口上移' },
  { accelerator: 'CommandOrControl+Shift+Down', action: 'moveDown', label: '窗口下移' },
  { accelerator: 'CommandOrControl+Shift+Left', action: 'moveLeft', label: '窗口左移' },
  { accelerator: 'CommandOrControl+Shift+Right', action: 'moveRight', label: '窗口右移' },
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
    Backspace: '⌫',
    Delete: '⌦',
    Up: '↑', Down: '↓', Left: '←', Right: '→',
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
    try {
      if (!globalShortcut.register(binding.accelerator, handler)) failed.push(binding);
    } catch {
      failed.push(binding);
    }
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

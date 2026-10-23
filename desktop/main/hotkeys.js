'use strict';

const { globalShortcut } = require('electron');

// 键位对齐 Gank Interview 的实际默认值（从它的渲染层里提取的）：
//   ⌘B 显示/隐藏   ⌘H 截图       ⌘Enter 处理截图
//   ⌘←→↑↓ 移动窗口   ⌘, / ⌘. 翻页   ⌘; / ⌘' 滚动
//   ⌘[ / ⌘] 透明度   ⌘- ⌘0 ⌘= 缩放     ⌘L 删除最后一张截图
//   ⌘Q 退出
// Gank 全套都是「⌘ + 单键」，没有 ⌘⇧ 组合；我们之前那套 ⌘⇧ 是自创的，
// 既和系统/浏览器冲突，也不符合用户从 Gank 带过来的手感。
const BINDINGS = [
  { accelerator: 'CommandOrControl+H', action: 'captureRegion', label: '截图' },
  { accelerator: 'CommandOrControl+Enter', action: 'sendChat', label: '处理截图' },
  { accelerator: 'CommandOrControl+B', action: 'toggleWindow', label: '显示/隐藏' },
  { accelerator: 'CommandOrControl+Q', action: 'quitApp', label: '退出' },
  { accelerator: 'CommandOrControl+N', action: 'newQuestion', label: '新对话' },
  { accelerator: 'CommandOrControl+R', action: 'resetView', label: '重置视图' },
  { accelerator: 'CommandOrControl+L', action: 'deleteLastShot', label: '删除最后一张截图' },
  { accelerator: 'CommandOrControl+Shift+Backspace', action: 'clearShots', label: '清空截图' },

  { accelerator: 'CommandOrControl+Shift+Space', action: 'toggleVisible', label: '按住操作面板' },
  { accelerator: 'CommandOrControl+Shift+Y', action: 'captureScreen', label: '全屏截图' },
  { accelerator: 'CommandOrControl+Shift+J', action: 'toggleCompact', label: '紧凑/展开' },

  // 翻页/滚动沿用 Gank 的标点键：逗号句号翻页，分号引号滚动。
  { accelerator: 'CommandOrControl+,', action: 'readPrev', label: '上一页' },
  { accelerator: 'CommandOrControl+.', action: 'readNext', label: '下一页' },
  { accelerator: 'CommandOrControl+;', action: 'scrollUp', label: '内容上滚' },
  { accelerator: "CommandOrControl+'", action: 'scrollDown', label: '内容下滚' },

  // 窗口移动：Gank 用 ⌘+方向键。macOS 上 ⌘←/→ 是行首行尾，但在
  // globalShortcut 注册后由我们接管，和 Gank 的行为一致。
  { accelerator: 'CommandOrControl+Up', action: 'moveUp', label: '窗口上移' },
  { accelerator: 'CommandOrControl+Down', action: 'moveDown', label: '窗口下移' },
  { accelerator: 'CommandOrControl+Left', action: 'moveLeft', label: '窗口左移' },
  { accelerator: 'CommandOrControl+Right', action: 'moveRight', label: '窗口右移' },

  // 透明度和缩放，Gank 也有。
  { accelerator: 'CommandOrControl+[', action: 'opacityDown', label: '降低不透明度' },
  { accelerator: 'CommandOrControl+]', action: 'opacityUp', label: '提高不透明度' },
  { accelerator: 'CommandOrControl+-', action: 'zoomOut', label: '缩小字号' },
  { accelerator: 'CommandOrControl+0', action: 'zoomReset', label: '还原字号' },
  { accelerator: 'CommandOrControl+=', action: 'zoomIn', label: '放大字号' },
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

const registered = new Set();
function registerHotkeys(handlers, bindings = BINDINGS) {
  unregisterHotkeys();
  const failed = [];
  for (const binding of bindings) {
    const handler = handlers[binding.action];
    if (!handler) continue;
    try {
      if (!globalShortcut.register(binding.accelerator, handler)) failed.push(binding);
      else registered.add(binding.accelerator);
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

// 只注销自己注册的那些。之前用 unregisterAll()，会把框选覆盖层临时注册的
// Escape 一起清掉——框选进行到一半时设置页保存快捷键，Esc 就当场失效了。
function unregisterHotkeys() {
  for (const accelerator of registered) {
    try {
      globalShortcut.unregister(accelerator);
    } catch {
      // 未注册或已被系统收回时忽略。
    }
  }
  registered.clear();
}

module.exports = { registerHotkeys, unregisterHotkeys, BINDINGS, bindingsWith, formatAccelerator };

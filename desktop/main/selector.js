'use strict';

const path = require('node:path');
const { BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');

// 两点式框选覆盖层（对齐 Gank 的 area-screenshot）。
//
// Gank 用的是全局鼠标钩子，本来就不弹窗；我们没有原生钩子，改用一层全透明的
// 无边框窗口来收两次点击。要做到和它一样的体感，关键有三点：
//   1. 不抢焦点——showInactive() + acceptFirstMouse，用户正在看的窗口保持前台，
//      第一下点击也照样算数；
//   2. 不画东西、不动光标——select.html 里没有任何提示或十字线；
//   3. 覆盖整块屏幕（bounds 而不是 workArea），菜单栏和 Dock 也能选到。
let overlay = null;
let pendingResolve = null;
let selectedDisplay = null;
let escShortcut = false;

function selectorPage() {
  const { app } = require('electron');
  return app.isPackaged
    ? path.join(process.resourcesPath, 'web', 'select.html')
    : path.resolve(__dirname, '..', '..', 'web', 'select.html');
}

function releaseEsc() {
  if (!escShortcut) return;
  escShortcut = false;
  try {
    globalShortcut.unregister('Escape');
  } catch {
    // 已被别处注销时忽略。
  }
}

function closeOverlay() {
  releaseEsc();
  if (!overlay) return;
  const win = overlay;
  overlay = null;
  if (!win.isDestroyed()) win.destroy();
}

function settle(result) {
  const resolve = pendingResolve;
  pendingResolve = null;
  closeOverlay();
  if (resolve) resolve(result);
}

let wired = false;
function wireOnce() {
  if (wired) return;
  wired = true;
  ipcMain.on('selector:commit', (_event, rect) => {
    // 渲染层用的是 CSS 像素坐标；screencapture 要的是物理像素，
    // Retina 屏上差 2 倍，不换算会截到左上角四分之一的区域。
    // clientX/clientY 是覆盖层内坐标；裁剪的是选中屏幕的截图，不叠加桌面原点。
    const display = selectedDisplay || screen.getPrimaryDisplay();
    const scale = display?.scaleFactor || 1;
    if (!rect || !['left', 'top', 'width', 'height'].every((key) => Number.isFinite(rect[key]))
        || rect.left < 0 || rect.top < 0 || rect.width < 4 || rect.height < 4
        || rect.left + rect.width > display.bounds.width || rect.top + rect.height > display.bounds.height) {
      settle(null);
      return;
    }
    const x = Math.round(rect.left * scale);
    const y = Math.round(rect.top * scale);
    settle({
      x,
      y,
      width: Math.round((rect.left + rect.width) * scale) - x,
      height: Math.round((rect.top + rect.height) * scale) - y,
    });
  });
  ipcMain.on('selector:cancel', () => settle(null));
}

function selectRegion(display = screen.getPrimaryDisplay()) {
  wireOnce();
  if (overlay) {
    // 上一次还没选完又按了一次：当作取消，重新开始。
    settle(null);
  }
  return new Promise((resolve) => {
    pendingResolve = resolve;
    selectedDisplay = display;
    const bounds = display.bounds;
    const win = new BrowserWindow({
      show: false,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      neverShowInTaskbar: true,
      alwaysOnTop: true,
      // 第一下点击直接透到页面里，不用先点一下"激活"再点第二下。
      acceptFirstMouse: true,
      enableLargerThanScreen: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'selector-bridge.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    overlay = win;
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // 覆盖层本身不能被截进去。
    win.setContentProtection(true);
    win.loadFile(selectorPage());
    win.once('ready-to-show', () => {
      // showInactive：前台还是用户的做题窗口，这里只是"浮"在上面等两次点击。
      win.showInactive();
      // 不抢焦点就收不到键盘，Esc 改由全局快捷键兜底。
      // register() 失败时只返回 false、不抛异常；注册不上就靠超时兜底，
      // 否则一个看不见的覆盖层会一直吞点击。
      try {
        escShortcut = globalShortcut.register('Escape', () => settle(null)) === true;
      } catch {
        escShortcut = false;
      }
    });
    // 兜底：框选超过 2 分钟没完成就自动取消，避免覆盖层永久占住屏幕。
    const timeout = setTimeout(() => settle(null), 120000);
    win.once('closed', () => clearTimeout(timeout));
    win.on('closed', () => {
      if (overlay === win) overlay = null;
      releaseEsc();
      if (pendingResolve) {
        const p = pendingResolve;
        pendingResolve = null;
        p(null);
      }
    });
  });
}

module.exports = { selectRegion, cancelSelection: () => settle(null) };

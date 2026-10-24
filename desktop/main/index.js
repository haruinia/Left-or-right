'use strict';

const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { app, ipcMain, Menu, shell, nativeTheme, systemPreferences, screen } = require('electron');
const { loadConfig, saveConfig } = require('./config');
const {
  createWindow,
  moveWindow,
  toggleCompact,
  toggleVisible,
  beginHoldInteract,
  setClickThrough,
  changeOpacity,
  changeZoom,
  resetZoom,
  setOpacity,
  setLayout,
  getDisplayState,
  setSurface,
  setTheme,
  setInteractive,
} = require('./window');
const { registerHotkeys, unregisterHotkeys, BINDINGS, bindingsWith, formatAccelerator } = require('./hotkeys');
const { captureScreenshot } = require('./capture');
const { selectRegion } = require('./selector');
const { startBackend, stopBackend, waitForHealth } = require('./backend');
const { startCommandKeyMonitor } = require('./command-key');

app.setName('左右');
const config = loadConfig();
let win = null;
let failedHotkeys = [];
let currentBindings = BINDINGS;
let permissionPaneOpened = false;
let lastScreenshotTime = 0;
let stopCommandKeyMonitor = null;
// 一次截图流程（框选 → 抓 → 恢复窗口）进行中时，再按截图键直接忽略。
// 之前第二次 ⌘⇧U 会先取消旧框选再立刻开新的，而旧流程的收尾
// 会把主面板重新 show 到新覆盖层上面，下一次点击就被面板吃掉了。
let screenBusy = false;

const SCREEN_RECORDING_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

function openScreenRecordingSettings() {
  shell.openExternal(SCREEN_RECORDING_PANE).catch(() => {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_PrivacyAccessibility');
  });
}

function screenAccessStatus() {
  try {
    return systemPreferences.getMediaAccessStatus('screen');
  } catch {
    return 'unknown';
  }
}

// 每次按键挪 24px：比 32 更容易微调到贴边，按住方向键连发也不会冲过头。
const STEP = 24;

function hotkeyHandlers() {
  return {
    toggleVisible: () => beginHoldInteract(win),
    toggleWindow: () => toggleVisible(win),
    quitApp: () => app.quit(),
    clearShots: () => {
      if (win && !win.isDestroyed()) win.webContents.send('liuwa:clear-shots');
    },
    // Gank 的 ⌘L 只删最后一张，不是清空全部。
    deleteLastShot: () => {
      if (win && !win.isDestroyed()) win.webContents.send('liuwa:delete-last-shot');
    },
    toggleCompact: () => toggleCompact(win),
    opacityDown: () => changeOpacity(win, -0.1),
    opacityUp: () => changeOpacity(win, 0.1),
    zoomOut: () => changeZoom(win, -0.1),
    zoomIn: () => changeZoom(win, 0.1),
    zoomReset: () => resetZoom(win),
    moveUp: () => moveWindow(win, 0, -STEP),
    moveDown: () => moveWindow(win, 0, STEP),
    moveLeft: () => moveWindow(win, -STEP, 0),
    moveRight: () => moveWindow(win, STEP, 0),

    captureRegion: () => attachScreenshot({ interactive: config.screenshotMode !== 'full' }),
    // 全屏截图不该弹框选十字：screencapture 不带 -i 直接抓当前显示器的完整画面。
    captureScreen: () => attachScreenshot({ interactive: false }),
    sendChat: () => sendChat(),
    newQuestion: () => {
      if (win && !win.isDestroyed()) win.webContents.send('liuwa:new-question');
    },
    resetView: () => { if(win && !win.isDestroyed()) win.webContents.send('liuwa:reset-view'); },
    readPrev: () => sendRead('prev'),
    readNext: () => sendRead('next'),
    scrollUp: () => sendScroll(-1),
    scrollDown: () => sendScroll(1),
  };
}

async function refreshUiHotkeys() {
  try {
    const headers = {};
    if (config.gatewayApiKey) headers['x-api-key'] = config.gatewayApiKey;
    const response = await fetch(`${config.gatewayUrl}/api/ui/settings`, { headers, signal: AbortSignal.timeout(3000) });
    if (!response.ok) return;
    const data = await response.json();
    const next = bindingsWith(data.hotkeys || {});
    const fingerprint = next.map((binding) => `${binding.action}:${binding.accelerator}`).join('|');
    const previous = currentBindings.map((binding) => `${binding.action}:${binding.accelerator}`).join('|');
    if (fingerprint === previous) return;
    currentBindings = next;
    failedHotkeys = registerHotkeys(hotkeyHandlers(), currentBindings);
    if (win && !win.isDestroyed()) win.webContents.send('cockpit:hotkeys', hotkeySnapshot());
  } catch {
    // Overlay keeps the last working chords if the settings API is down.
  }
}

function sendCapture(payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('liuwa:capture', payload);
  }
}

function sendCaptureError(detail) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('liuwa:capture-error', { detail });
  }
}

function sendChat() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('liuwa:send');
  }
}

// 翻节与滚动交给渲染层：滚动容器和分段表都在那边，主进程只转达方向，
// 不猜当前读到哪。
function sendRead(direction) {
  if (win && !win.isDestroyed()) win.webContents.send('liuwa:read', direction);
}

function sendScroll(direction) {
  if (win && !win.isDestroyed()) win.webContents.send('liuwa:scroll', direction);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function hideWindowForCapture() {
  if (!win || win.isDestroyed() || !win.isVisible()) return false;
  win.hide();
  // Give the compositor a beat so the frosted panel is gone before the crosshair.
  await sleep(160);
  return true;
}

function restoreWindow(wasVisible) {
  if (wasVisible && win && !win.isDestroyed()) {
    win.showInactive();
    win.setFocusable(false);
    setClickThrough(win, true);
  }
}

async function attachScreenshot({ interactive }) {
  if (screenBusy) return;
  const now = Date.now();
  if (now - lastScreenshotTime < 800) {
    sendCaptureError("截图间隔太短，请稍后再试");
    return;
  }

  screenBusy = true;
  const wasVisible = await hideWindowForCapture();
  try {
    const displays = screen.getAllDisplays();
    const display = displays.find(d => String(d.id) === String(config.captureDisplayId)) || screen.getPrimaryDisplay();
    const displayIndex = displays.findIndex(d => d.id === display.id) + 1;
    let rect = null;
    if (interactive) {
      // 两点式框选：先让用户点两个角，再按矩形截。
      // 取消（Esc / 右键）返回 null，此时不该截图也不该报错。
      rect = await selectRegion(display);
      if (!rect) {
        restoreWindow(wasVisible);
        return;
      }
    }
    // 节流只统计真正发生了的截图：取消/重选不该被 800ms 挡回去。
    lastScreenshotTime = Date.now();
    const shot = await captureScreenshot({ interactive: false, rect, displayIndex });
    restoreWindow(wasVisible);
    sendCapture({
      mime: shot.mime,
      data: shot.data.toString('base64'),
    });
  } catch (error) {
    restoreWindow(wasVisible);
    const raw = String(error.message || error);
    // Unpackaged builds often report 'not-determined' even when the host app is
    // authorized, so only 'denied' is trusted on its own; the screencapture stderr
    // message is the reliable missing-permission signal.
    const permissionDenied =
      raw.includes('could not create image') || screenAccessStatus() === 'denied';
    if (permissionDenied) {
      if (!permissionPaneOpened) {
        permissionPaneOpened = true;
        openScreenRecordingSettings();
      }
      sendCaptureError(
        '缺少屏幕录制权限：已打开「系统设置 > 隐私与安全性 > 屏幕录制」，'
        + '请给启动左右的应用（终端 / Qoder 等；打包安装后是「左右」本身）打开开关，再按一次截图。'
      );
      return;
    }
    sendCaptureError(raw);
  } finally {
    screenBusy = false;
  }
}

function hotkeySnapshot() {
  return {
    hotkeys: currentBindings.map((binding) => ({
      ...binding,
      display: formatAccelerator(binding.accelerator),
    })),
    failedHotkeys: failedHotkeys.map((binding) => binding.accelerator),
  };
}

function captureOptions() {
  const displays = screen.getAllDisplays();
  const selected = displays.find(d => String(d.id) === String(config.captureDisplayId)) || screen.getPrimaryDisplay();
  return {mode:config.screenshotMode || 'area',displayId:String(selected.id),displays:displays.map((d,i)=>({id:String(d.id),label:d.label || `显示器 ${i+1}`,width:d.bounds.width,height:d.bounds.height,scaleFactor:d.scaleFactor}))};
}

function registerIpc() {
  ipcMain.handle('cockpit:getConfig', () => ({
    gatewayUrl: config.gatewayUrl,
    gatewayApiKey: config.gatewayApiKey,
    ...hotkeySnapshot(),
    display: getDisplayState(win),
    captureOptions: captureOptions(),
  }));
  ipcMain.on('cockpit:getConfigSync', (event) => {
    event.returnValue = { gatewayUrl: config.gatewayUrl, gatewayApiKey: config.gatewayApiKey };
  });
  ipcMain.handle('cockpit:toggleCompact', () => toggleCompact(win));
  ipcMain.handle('cockpit:setDisplay', (_event, patch) => {
    if (!patch || typeof patch !== 'object') throw new Error('Invalid display settings');
    if (Number.isFinite(patch.opacity)) setOpacity(win, patch.opacity);
    if (typeof patch.theme === 'string') setTheme(win, patch.theme);
    if (typeof patch.layout === 'string') setLayout(win, patch.layout);
    if (typeof patch.compact === 'boolean' && patch.compact !== getDisplayState(win).compact) toggleCompact(win);
    const display = getDisplayState(win);
    const {x, y, width, height} = display;
    const saved = saveConfig({panelOpacity: display.opacity, windowLayout: display.layout, panelTheme:display.theme, surfaceVersion:1,
      ...(!display.compact && Number.isFinite(x) ? {windowBounds: {x, y, width, height}} : {})});
    return {...display, saved};
  });
  ipcMain.handle('cockpit:setSurface', (_event, patch) => {
    if(!patch || typeof patch !== 'object') throw new Error('Invalid surface state');
    return setSurface(win, patch);
  });
  ipcMain.handle('cockpit:setCaptureOptions', (_event, patch) => {
    if(!patch || typeof patch !== 'object') throw new Error('Invalid capture settings');
    if(['area','full'].includes(patch.mode)) config.screenshotMode = patch.mode;
    if(patch.displayId !== undefined) {
      if(!screen.getAllDisplays().some(d => String(d.id) === String(patch.displayId))) throw new Error('显示器已断开，请重新选择');
      config.captureDisplayId = String(patch.displayId);
    }
    const saved = saveConfig({screenshotMode:config.screenshotMode || 'area',captureDisplayId:config.captureDisplayId || ''});
    return {...captureOptions(),saved};
  });
  ipcMain.handle('cockpit:openSettings', (_event, section) => {
    // 只接受固定分区的深链接，避免渲染层可导航到任意地址。
    const anchor = ['study', 'models', 'assets'].includes(section) ? `#${section}` : '';
    return shell.openExternal(`${config.gatewayUrl}/settings${anchor}`);
  });
  ipcMain.handle('liuwa:reset-view', () => { if(win && !win.isDestroyed()) win.webContents.send('liuwa:reset-view'); });
  ipcMain.handle('cockpit:toggleVisible', () => {
    toggleVisible(win);
  });
  ipcMain.handle('liuwa:capture', (_event, options) =>
    attachScreenshot({ interactive: typeof options?.interactive === 'boolean' ? options.interactive : config.screenshotMode !== 'full' }),
  );
  ipcMain.handle('liuwa:send', () => sendChat());
}

// 单实例：两个实例会抢同一批全局快捷键，后一个还会因为 8001 被占用而
// 起不来网关；退出其中一个时又可能把另一个正在用的网关杀掉。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      win.showInactive();
      win.setFocusable(false);
      setClickThrough(win, true);
    }
  });
  app.whenReady().then(boot);
}

async function boot() {
  // Gank 式纯快捷键驱动：无条件隐藏 Dock 图标，不创建菜单栏托盘。
  // accessory 策略让应用不出现在 Dock、Cmd+Tab 和应用菜单中。
  if (process.platform === 'darwin') {
    app.dock?.hide();
    app.setActivationPolicy('accessory');
  }
  nativeTheme.themeSource = 'light';
  if (config.spawnBackend) {
    startBackend(config);
  }
  await waitForHealth(config.gatewayUrl, {
    timeoutMs: config.spawnBackend ? 30000 : 3000,
  });
  registerIpc();
  failedHotkeys = registerHotkeys(hotkeyHandlers(), currentBindings);
  win = createWindow(config, {
    onMove: (bounds) => saveConfig({ windowBounds: bounds }),
    onDisplay: (patch) => saveConfig(patch),
  });
  stopCommandKeyMonitor = startCommandKeyMonitor((held) => {
    setInteractive(win, held, { restore: !held });
  });
  refreshUiHotkeys();
  setInterval(refreshUiHotkeys, 4000);

  const { session } = require('electron');
  const { RENDERER_INDEX } = require('./window');
  const rendererUrl = pathToFileURL(RENDERER_INDEX).href;
  const allowMedia = (wc, permission) =>
    permission === 'media' && wc.getURL().split('?')[0] === rendererUrl;
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(allowMedia(wc, permission));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) =>
    Boolean(wc) && allowMedia(wc, permission),
  );
}

app.on('will-quit', () => {
  stopCommandKeyMonitor?.();
  unregisterHotkeys();
  stopBackend();
});

app.on('window-all-closed', () => app.quit());

'use strict';

const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { app, ipcMain, Menu, shell, nativeTheme, systemPreferences, screen, BrowserWindow } = require('electron');
const { loadConfig, saveConfig } = require('./config');
const {
  createWindow,
  moveWindow,
  moveToDisplay,
  toggleCompact,
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
  isInteractive,
} = require('./window');
const { registerHotkeys, unregisterHotkeys, BINDINGS, bindingsWith, formatAccelerator } = require('./hotkeys');
const { captureScreenshot } = require('./capture');
const { validateCaptureOptions, captureWindowDisplay } = require('./capture-options');
const { selectRegion, cancelSelection } = require('./selector');
const { ensureBackend, stopBackend } = require('./backend');
const { startCommandKeyMonitor } = require('./command-key');
const { openSettingsWindow } = require('./settings-window');
const { createWindowVisibility } = require('./window-visibility');
const { showAppError: displayAppError } = require('./error-window');

app.setName('左右');
const config = loadConfig();
let win = null;
let failedHotkeys = [];
let currentBindings = BINDINGS;
let permissionPaneOpened = false;
let lastScreenshotTime = 0;
let stopCommandKeyMonitor = null;
const visibility = createWindowVisibility({
  getMainWindow: () => win,
  getWindows: () => BrowserWindow.getAllWindows(),
  setInteractive: held => setInteractive(win, held, {restore: !held}),
});

function showAppError(title, content) {
  const version = visibility.version();
  void displayAppError(title, content, () => visibility.canShow(version));
}
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

function toggleAppVisibility() {
  if (screenBusy) cancelSelection();
  visibility.toggle();
}

function hotkeyHandlers() {
  return {
    toggleVisible: () => visibility.modifierChanged(true),
    toggleWindow: () => toggleAppVisibility(),
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

    captureRegion: () => attachScreenshot({ interactive: config.screenshotMode === 'area' }),
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
  const snapshot = visibility.beginCapture();
  if (snapshot.windows.length) await sleep(160);
  return snapshot;
}

function restoreWindow(snapshot) {
  visibility.endCapture(snapshot);
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
    const image = await captureWindowDisplay({
      displays,
      display: runningDisplay(),
      interactive,
      selectRegion,
      captureScreenshot,
    });
    if (!image) return;
    lastScreenshotTime = Date.now();
    sendCapture(image);
  } catch (error) {
    const raw = String(error.message || error);
    // Unpackaged builds often report 'not-determined' even when the host app is
    // authorized, so only 'denied' is trusted on its own; the screencapture stderr
    // message is the reliable missing-permission signal.
    const permissionDenied = process.platform === 'darwin' &&
      (raw.includes('could not create image') || screenAccessStatus() === 'denied');
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
    restoreWindow(wasVisible);
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

function runningDisplay() {
  return win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
}

function captureOptions() {
  const displays = screen.getAllDisplays();
  return {mode:config.screenshotMode || 'full',displayId:String(runningDisplay().id),displays:displays.map((d,i)=>({id:String(d.id),label:d.label || `显示器 ${i+1}`,width:d.bounds.width,height:d.bounds.height,scaleFactor:d.scaleFactor}))};
}

function registerIpc() {
  ipcMain.handle('cockpit:getConfig', () => ({
    gatewayUrl: config.gatewayUrl,
    gatewayApiKey: config.gatewayApiKey,
    ...hotkeySnapshot(),
    display: getDisplayState(win),
    captureOptions: captureOptions(),
    armed: isInteractive(),
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
    const displays = screen.getAllDisplays();
    validateCaptureOptions(patch, displays);
    if (patch.displayId !== undefined) moveToDisplay(win, displays.find((display) => String(display.id) === String(patch.displayId)));
    if (patch.mode !== undefined) config.screenshotMode = patch.mode;
    const options = captureOptions();
    config.windowDisplayId = options.displayId;
    const saved = saveConfig({screenshotMode:options.mode,windowDisplayId:options.displayId});
    return {...captureOptions(),saved};
  });
  ipcMain.handle('cockpit:openSettings', async (_event, section) => {
    const version = visibility.version();
    if (!await ensureBackend(config)) {
      showAppError('设置服务未能启动', '请重启应用后重试。服务日志位于应用的 gateway.log 日志文件中。');
      return false;
    }
    const opened = await openSettingsWindow(config, section, win, () => visibility.canShow(version));
    if (!opened) showAppError('设置页未能打开', '本地服务未能加载设置页面，请重试。');
    return opened;
  });
  ipcMain.handle('liuwa:reset-view', () => { if(win && !win.isDestroyed()) win.webContents.send('liuwa:reset-view'); });
  ipcMain.handle('cockpit:toggleVisible', () => toggleAppVisibility());
  ipcMain.handle('liuwa:capture', (_event, options) =>
    attachScreenshot({ interactive: typeof options?.interactive === 'boolean' ? options.interactive : config.screenshotMode === 'area' }),
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
  // Validate the native policy before creating any window or starting services.
  try {
    require('./taskbar-runtime').assertTaskbarRuntime();
  } catch (error) {
    console.error(error.message);
    app.quit();
    return;
  }
  // Gank 式纯快捷键驱动：无条件隐藏 Dock 图标，不创建菜单栏托盘。
  // accessory 策略让应用不出现在 Dock、Cmd+Tab 和应用菜单中。
  if (process.platform === 'darwin') {
    app.dock?.hide();
    app.setActivationPolicy('accessory');
  }
  nativeTheme.themeSource = 'light';
  if (!await ensureBackend(config)) {
    showAppError('本地服务未能启动', '请重新打开应用。如果问题持续，请检查应用日志目录中的 gateway.log。');
  }
  registerIpc();
  failedHotkeys = registerHotkeys(hotkeyHandlers(), currentBindings);
  win = createWindow(config, {
    onMove: (bounds) => {
      config.windowDisplayId = String(runningDisplay().id);
      saveConfig({ windowBounds: bounds, windowDisplayId: config.windowDisplayId });
    },
    onDisplay: (patch) => saveConfig(patch),
  });
  const handleRemovedDisplay = (_event, removed) => {
    if (!win || win.isDestroyed()) return;
    if (String(removed.id) === config.windowDisplayId) {
      moveToDisplay(win, screen.getPrimaryDisplay());
      config.windowDisplayId = String(runningDisplay().id);
      saveConfig({windowDisplayId:config.windowDisplayId});
    }
  };
  screen.on('display-removed', handleRemovedDisplay);
  win.on('closed', () => screen.removeListener('display-removed', handleRemovedDisplay));
  stopCommandKeyMonitor = startCommandKeyMonitor(held => visibility.modifierChanged(held));
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

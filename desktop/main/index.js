'use strict';

const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { app, ipcMain, Menu, Tray, nativeImage, shell, nativeTheme, systemPreferences } = require('electron');
const { loadConfig } = require('./config');
const { createWindow, moveWindow, toggleCompact, toggleVisible, beginHoldInteract, setClickThrough, isInteractive } = require('./window');
const { registerHotkeys, unregisterHotkeys, BINDINGS, bindingsWith, formatAccelerator } = require('./hotkeys');
const { captureScreenshot } = require('./capture');
const { startBackend, stopBackend, waitForHealth } = require('./backend');

app.setName('左右');
const config = loadConfig();
let win = null;
let tray = null;
let failedHotkeys = [];
let currentBindings = BINDINGS;
let lastHealthy = false;
let permissionPaneOpened = false;
let lastScreenshotTime = 0;

let screenshotDebounce = null;

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

function hotkeyHandlers() {
  return {
    toggleVisible: () => beginHoldInteract(win),
    toggleWindow: () => toggleVisible(win),
    quitApp: () => app.quit(),
    clearShots: () => {
      if (win && !win.isDestroyed()) win.webContents.send('liuwa:clear-shots');
    },
    toggleCompact: () => toggleCompact(win),
    moveUp: () => moveWindow(win, 0, -32),
    moveDown: () => moveWindow(win, 0, 32),
    moveLeft: () => moveWindow(win, -32, 0),
    moveRight: () => moveWindow(win, 32, 0),

    captureRegion: () => attachScreenshot({ interactive: true }),
    captureScreen: () => attachScreenshot({ interactive: true }),
    sendChat: () => sendChat(),
    newQuestion: () => {
      if (win && !win.isDestroyed()) win.webContents.send('liuwa:new-question');
    },
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
    buildTray();
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
    setClickThrough(win, !isInteractive());
  }
}

async function attachScreenshot({ interactive }) {
  const now = Date.now();
  if (now - lastScreenshotTime < 800) {
    sendCaptureError("截图间隔太短，请稍后再试");
    return;
  }
  lastScreenshotTime = now;

  const wasVisible = await hideWindowForCapture();
  try {
    const shot = await captureScreenshot({ interactive });
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
  }
}

function buildTray(gatewayHealthy = lastHealthy) {
  lastHealthy = Boolean(gatewayHealthy);
  if (!tray) {
    const trayIcon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png')).resize({ width: 18, height: 18 });
    trayIcon.setTemplateImage(true);
    tray = new Tray(trayIcon);
    tray.setToolTip('左右');
  }
  const hotkeyItems = currentBindings.map((binding) => {
    const taken = failedHotkeys.some((failed) => failed.accelerator === binding.accelerator);
    return {
      label: `${binding.label}  ${formatAccelerator(binding.accelerator)}${taken ? '（被其他应用占用）' : ''}`,
      enabled: false,
    };
  });
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: lastHealthy ? `后端已连接：${config.gatewayUrl}` : '后端未连接：请先启动 gateway',
        enabled: false,
      },
      { type: 'separator' },
      { label: '隐藏/显示', click: () => toggleVisible(win) },
      { label: '紧凑/展开', click: () => toggleCompact(win) },
      { type: 'separator' },
      { label: '共享保护：已开启（仅 macOS 生效）', enabled: false },
      ...buildPermissionsMenu(),
      ...hotkeyItems,
      { type: 'separator' },
      { label: '打开设置', click: () => shell.openExternal(`${config.gatewayUrl}/settings`) },
      { label: '打开屏幕录制权限设置', click: () => openScreenRecordingSettings() },
      { label: '退出', click: () => app.quit() },
    ]),
  );
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

function registerIpc() {
  ipcMain.handle('cockpit:getConfig', () => ({
    gatewayUrl: config.gatewayUrl,
    gatewayApiKey: config.gatewayApiKey,
    ...hotkeySnapshot(),
  }));
  ipcMain.on('cockpit:getConfigSync', (event) => {
    event.returnValue = { gatewayUrl: config.gatewayUrl, gatewayApiKey: config.gatewayApiKey };
  });
  ipcMain.handle('cockpit:toggleCompact', () => toggleCompact(win));
  ipcMain.handle('cockpit:toggleVisible', () => {
    toggleVisible(win);
  });
  ipcMain.handle('liuwa:capture', (_event, options) =>
    attachScreenshot({ interactive: options?.interactive !== false }),
  );
  ipcMain.handle('liuwa:send', () => sendChat());
}

app.whenReady().then(async () => {
  app.dock?.setIcon(path.join(__dirname, '..', 'assets', 'icon.png'));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu', label: '左右' },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));
  nativeTheme.themeSource = 'light';
  if (config.spawnBackend) {
    startBackend(config);
  }
  const healthy = await waitForHealth(config.gatewayUrl, {
    timeoutMs: config.spawnBackend ? 30000 : 3000,
  });
  registerIpc();
  failedHotkeys = registerHotkeys(hotkeyHandlers(), currentBindings);
  win = createWindow(config);
  buildTray(healthy);
  refreshUiHotkeys();
  setInterval(refreshUiHotkeys, 4000);

  win.on('focus', () => {
    buildTray();
  });
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
});

app.on('will-quit', () => {
  unregisterHotkeys();
  stopBackend();
});

app.on('window-all-closed', () => app.quit());

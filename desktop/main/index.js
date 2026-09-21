'use strict';

const { pathToFileURL } = require('node:url');
const { app, ipcMain, Menu, Tray, nativeImage, shell, nativeTheme } = require('electron');
const { loadConfig } = require('./config');
const { createWindow, toggleCompact, toggleVisible, showWindow, hideWindow, beginHoldInteract, setClickThrough, isInteractive } = require('./window');
const { registerHotkeys, unregisterHotkeys, BINDINGS, bindingsWith, formatAccelerator } = require('./hotkeys');
const { captureScreenshot } = require('./capture');
const { startBackend, stopBackend, waitForHealth } = require('./backend');

const config = loadConfig();
let win = null;
let tray = null;
let failedHotkeys = [];
let currentBindings = BINDINGS;
let lastHealthy = false;

function hotkeyHandlers() {
  return {
    toggleVisible: () => beginHoldInteract(win),
    showWindow: () => showWindow(win),
    hideWindow: () => hideWindow(win),
    quitApp: () => app.quit(),
    toggleCompact: () => toggleCompact(win),
    captureRegion: () => attachScreenshot({ interactive: true }),
    captureScreen: () => attachScreenshot({ interactive: false }),
    sendChat: () => sendChat(),
  };
}

async function refreshUiHotkeys() {
  try {
    const headers = {};
    if (config.gatewayApiKey) headers['x-api-key'] = config.gatewayApiKey;
    const response = await fetch(`${config.gatewayUrl}/api/ui/settings`, { headers });
    if (!response.ok) return;
    const data = await response.json();
    const next = bindingsWith(data.hotkeys || {});
    const fingerprint = next.map((binding) => `${binding.action}:${binding.accelerator}`).join('|');
    const previous = currentBindings.map((binding) => `${binding.action}:${binding.accelerator}`).join('|');
    if (fingerprint === previous) return;
    currentBindings = next;
    failedHotkeys = registerHotkeys(hotkeyHandlers(), currentBindings);
    buildTray();
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
    sendCaptureError(String(error.message || error));
  }
}

function buildTray(gatewayHealthy = lastHealthy) {
  lastHealthy = Boolean(gatewayHealthy);
  if (!tray) {
    tray = new Tray(nativeImage.createEmpty());
    tray.setToolTip('六娃');
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
      { label: '展示', click: () => showWindow(win) },
      { label: '隐藏', click: () => hideWindow(win) },
      { label: '紧凑/展开', click: () => toggleCompact(win) },
      { type: 'separator' },
      { label: '共享保护：已开启（仅 macOS 生效）', enabled: false },
      { label: `截图：${process.platform === 'darwin' ? '可用' : '仅 macOS'}`, enabled: false },
      ...hotkeyItems,
      { type: 'separator' },
      { label: '打开设置', click: () => shell.openExternal(`${config.gatewayUrl}/settings`) },
      { label: '退出', click: () => app.quit() },
    ]),
  );
}

function registerIpc() {
  ipcMain.handle('cockpit:getConfig', () => ({
    gatewayUrl: config.gatewayUrl,
    gatewayApiKey: config.gatewayApiKey,
    hotkeys: currentBindings.map((binding) => ({
      ...binding,
      display: formatAccelerator(binding.accelerator),
    })),
    failedHotkeys: failedHotkeys.map((binding) => binding.accelerator),
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

  // The embedded cockpit captures the interviewer's mic for live transcription.
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

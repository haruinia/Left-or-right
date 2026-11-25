'use strict';

const path = require('node:path');
const { BrowserWindow, screen } = require('electron');

let settingsWindow = null;
let loading = null;
const SECTIONS = new Set(['models', 'asr', 'study', 'briefing', 'knowledge', 'display', 'shortcuts', 'assets']);

function getSettingsWindow() {
  return settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : null;
}

async function openSettingsWindow(config, section, mainWindow, canShow = () => true, getDisplay = () => ({readingFontSize:config.readingFontSize || 18, zoomFactor:config.zoomFactor || 1})) {
  const syncAppearance = win => {
    if (win.isDestroyed()) return;
    const display = getDisplay();
    const zoom = Number.isFinite(display.zoomFactor) ? Math.max(.7, Math.min(1.6, Math.round(display.zoomFactor * 10) / 10)) : 1;
    win.webContents.setZoomFactor(zoom);
    win.webContents.send('cockpit:display', {...display, zoomFactor:zoom});
  };
  const anchor = section === 'interview' ? 'briefing' : SECTIONS.has(section) ? section : 'models';
  const existing = getSettingsWindow();
  if (existing) {
    if (loading) await loading;
    if (existing.isDestroyed()) return false;
    syncAppearance(existing);
    existing.webContents.send('settings:navigate', anchor);
    if (canShow()) { existing.show(); existing.focus(); }
    return true;
  }
  const area = (mainWindow && !mainWindow.isDestroyed()
    ? screen.getDisplayMatching(mainWindow.getBounds())
    : screen.getPrimaryDisplay()).workArea;
  const width = Math.min(1120, area.width);
  const height = Math.min(850, area.height);
  const win = new BrowserWindow({
    title: '左右 · 设置',
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width, height,
    minWidth: Math.min(520, area.width),
    minHeight: Math.min(420, area.height),
    show: false,
    skipTaskbar: true,
    backgroundColor: '#fcfcfd',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'settings-bridge.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  settingsWindow = win;
  win.setContentProtection(true);
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const base = new URL(config.gatewayUrl);
  const guard = (event, rawUrl) => {
    let allowed = false;
    try {
      const url = new URL(rawUrl);
      allowed = url.origin === base.origin && ['/settings', '/settings.html'].includes(url.pathname);
    } catch {}
    if (!allowed) event.preventDefault();
  };
  win.webContents.on('will-navigate', guard);
  win.webContents.on('will-redirect', guard);
  win.on('closed', () => { if (settingsWindow === win) { settingsWindow = null; loading = null; } });
  win.webContents.on('did-finish-load', () => syncAppearance(win));
  loading = win.loadURL(`${base.origin}/settings#${anchor}`);
  try {
    await loading;
    if (win.isDestroyed()) return false;
    syncAppearance(win);
    if (canShow()) { win.show(); win.focus(); }
    return true;
  } catch {
    if (!win.isDestroyed()) win.destroy();
    return false;
  } finally { loading = null; }
}

module.exports = { openSettingsWindow, getSettingsWindow };

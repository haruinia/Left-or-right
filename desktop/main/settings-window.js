'use strict';

const path = require('node:path');
const { BrowserWindow, screen } = require('electron');

let settingsWindow = null;
let loading = null;
const SECTIONS = new Set(['models', 'asr', 'interview', 'study', 'briefing', 'shortcuts', 'assets']);

function getSettingsWindow() {
  return settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : null;
}

async function openSettingsWindow(config, section, mainWindow, canShow = () => true) {
  const anchor = SECTIONS.has(section) ? section : 'models';
  const existing = getSettingsWindow();
  if (existing) {
    if (loading) await loading;
    if (existing.isDestroyed()) return false;
    existing.webContents.send('settings:navigate', anchor);
    if (canShow()) { existing.show(); existing.focus(); }
    return true;
  }
  const area = (mainWindow && !mainWindow.isDestroyed()
    ? screen.getDisplayMatching(mainWindow.getBounds())
    : screen.getPrimaryDisplay()).workArea;
  const audioStart = anchor === 'interview';
  const width = Math.min(audioStart ? 520 : 1120, area.width);
  const height = Math.min(audioStart ? 340 : 850, area.height);
  const win = new BrowserWindow({
    title: '左右 · 设置',
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width, height,
    minWidth: Math.min(audioStart ? 320 : 520, area.width),
    minHeight: Math.min(audioStart ? 260 : 420, area.height),
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
  let compactAudio = audioStart;
  let fullBounds = null;
  win.webContents.on('did-navigate-in-page', (_event, rawUrl, isMainFrame) => {
    if (isMainFrame === false || win.isDestroyed()) return;
    let nextAudio;
    try { const url = new URL(rawUrl); if (url.origin !== base.origin || !['/settings', '/settings.html'].includes(url.pathname)) return; nextAudio = url.hash === '#interview'; } catch { return; }
    if (nextAudio === compactAudio) return;
    const current = win.getBounds();
    const work = screen.getDisplayMatching(current).workArea;
    if (nextAudio) fullBounds = current;
    const target = nextAudio ? { width: Math.min(520, work.width), height: Math.min(340, work.height) }
      : { width: Math.min(fullBounds?.width || 1120, work.width), height: Math.min(fullBounds?.height || 850, work.height) };
    win.setMinimumSize(Math.min(nextAudio ? 320 : 520, work.width), Math.min(nextAudio ? 260 : 420, work.height));
    win.setBounds({ ...target, x: Math.round(work.x + (work.width - target.width) / 2), y: Math.round(work.y + (work.height - target.height) / 2) });
    compactAudio = nextAudio;
  });
  win.on('closed', () => { if (settingsWindow === win) { settingsWindow = null; loading = null; } });
  loading = win.loadURL(`${base.origin}/settings#${anchor}`);
  try {
    await loading;
    if (win.isDestroyed()) return false;
    if (canShow()) { win.show(); win.focus(); }
    return true;
  } catch {
    if (!win.isDestroyed()) win.destroy();
    return false;
  } finally { loading = null; }
}

module.exports = { openSettingsWindow, getSettingsWindow };

'use strict';

const { execFile, execFileSync } = require('node:child_process');
const path = require('node:path');
const { app, BrowserWindow, shell } = require('electron');

const COMPACT = { width: 320, height: 240 };
const EXPANDED = { width: 440, height: 720 };

let compact = false;

// The UI ships with the app and loads from disk, so the window still renders when
// the gateway is down. The gateway URL and key reach the renderer through the
// preload bridge, never through the page URL.
// In development the UI is read straight out of the repo; a packaged build ships
// the same directory as an extra resource (see package.json > build.extraResources).
const RENDERER_INDEX = app.isPackaged
  ? path.join(process.resourcesPath, 'web', 'index.html')
  : path.resolve(__dirname, '..', '..', 'web', 'index.html');

function createWindow(config) {
  const isMac = process.platform === 'darwin';
  const win = new BrowserWindow({
    width: EXPANDED.width,
    height: EXPANDED.height,
    minWidth: COMPACT.width,
    minHeight: COMPACT.height,
    frame: false,
    show: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    // Vibrancy paints a material over the whole window, so the meeting behind
    // it disappears. True HUD glass is a transparent window with only the
    // cards filled in CSS.
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'bridge.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // Keep the interviewer's private panel out of screen share and screen recording,
  // the same way presenter notes stay off the shared feed. macOS maps this to
  // NSWindowSharingNone; must be set before the window is shown.
  win.setContentProtection(true);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setBackgroundColor('#00000000');
  if (isMac) {
    if (typeof win.setWindowButtonVisibility === 'function') {
      win.setWindowButtonVisibility(false);
    }
    if (typeof win.setVibrancy === 'function') {
      win.setVibrancy(null);
    }
  }

  // A window that is invisible to screen capture must never navigate away from the
  // bundled UI: anything else (role join links included) opens in a real browser.
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile(RENDERER_INDEX);
  win.once('ready-to-show', () => {
    win.setBackgroundColor('#00000000');
    win.setFocusable(false);
    setClickThrough(win, true);
    win.showInactive();
  });
  win.on('blur', () => {
    if (!interact || Date.now() - armedAt < 250) return;
    setInteractive(win, false, { restore: false });
  });
  win.webContents.on('before-input-event', (_event, input) => {
    if (!interact || input.type !== 'keyUp' || Date.now() - armedAt < 250) return;
    if (
      input.key === 'Meta' ||
      input.key === 'Control' ||
      input.key === 'Shift' ||
      input.key === ' ' ||
      input.key === 'Space'
    ) {
      setInteractive(win, false);
    }
  });
  // ponytail: 1s poll of the front app, CGEvent tap if restore must be instant
  const rememberFrontApp = setInterval(() => {
    if (interact) return;
    const pid = frontmostPid();
    if (pid && pid !== String(process.pid)) previousPid = pid;
  }, 1000);
  win.on('closed', () => clearInterval(rememberFrontApp));
  return win;
}

function toggleCompact(win) {
  if (!win) return compact;
  compact = !compact;
  const size = compact ? COMPACT : EXPANDED;
  win.setSize(size.width, size.height, true);
  win.webContents.send('cockpit:compact', compact);
  return compact;
}

function showWindow(win) {
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) win.showInactive();
  win.setFocusable(false);
  setClickThrough(win, !isInteractive());
}

function hideWindow(win) {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  setInteractive(win, false);
  win.hide();
}

function toggleVisible(win) {
  if (!win) return;
  if (win.isVisible()) hideWindow(win);
  else showWindow(win);
}

let interact = false;
let armedAt = 0;
let previousPid = '';

function setClickThrough(win, ignore) {
  if (!win || win.isDestroyed()) return;
  win.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
}

function frontmostPid() {
  if (process.platform !== 'darwin') return '';
  try {
    return execFileSync(
      'osascript',
      ['-e', 'tell application "System Events" to get unix id of first application process whose frontmost is true'],
      { encoding: 'utf8', timeout: 800 },
    ).trim();
  } catch {
    return '';
  }
}

function activatePid(pid) {
  const n = Number(pid);
  if (!n || process.platform !== 'darwin') return;
  execFile(
    'osascript',
    ['-e', `tell application "System Events" to set frontmost of (first application process whose unix id is ${n}) to true`],
    () => {},
  );
}

function isInteractive() {
  return interact;
}

function setInteractive(win, on, { restore = true } = {}) {
  if (!win || win.isDestroyed()) return interact;
  const next = Boolean(on);
  if (interact === next) return interact;
  interact = next;
  if (interact) {
    armedAt = Date.now();
    if (!win.isVisible()) win.show();
    win.setFocusable(true);
    setClickThrough(win, false);
    win.focus();
  } else {
    setClickThrough(win, true);
    win.setFocusable(false);
    const pid = previousPid;
    previousPid = '';
    if (restore && pid && pid !== String(process.pid)) activatePid(pid);
  }
  win.webContents.send('cockpit:armed', interact);
  return interact;
}

function beginHoldInteract(win) {
  if (!win || win.isDestroyed()) return;
  if (interact && Date.now() - armedAt > 250) {
    setInteractive(win, false);
    return;
  }
  const pid = frontmostPid();
  if (pid && pid !== String(process.pid)) previousPid = pid;
  setInteractive(win, true);
}

module.exports = {
  createWindow,
  toggleCompact,
  toggleVisible,
  showWindow,
  hideWindow,
  setClickThrough,
  setInteractive,
  beginHoldInteract,
  isInteractive,
  RENDERER_INDEX,
  COMPACT,
  EXPANDED,
};

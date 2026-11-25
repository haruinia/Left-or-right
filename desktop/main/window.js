'use strict';

const { execFile, execFileSync } = require('node:child_process');
const path = require('node:path');
const { app, BrowserWindow, shell, screen } = require('electron');
const { startupDisplay } = require('./capture-options');

const COMPACT = { width: 560, height: 76 };
// 780 = Gank 解答区的 740px 上限 + 窗口与卡片两层内边距（约 40px）。
// 560 时卡片内宽只有 460，长代码行仍然折；对齐 Gank 的实际阅读宽度。
const EXPANDED = { width: 780, height: 760 };
const LAYOUTS = { narrow: {width: 560, height: 720}, standard: EXPANDED, wide: {width: 1000, height: 680} };
// 转录 + 回答两栏的最小可用宽度；用户手动调整后按调整值记住。
const INTERVIEW = { width: 900, height: 700 };

let compact = false;
let layout = 'standard';
let expandedSize = {...EXPANDED};
let interviewSize = {...INTERVIEW};
let onDisplayChange = null;
let displayRevision = 0;
let displaySaved = true;
let readingFontSize = 18;
let theme = 'light';
let surface = {answer:false, shotCount:0, settingsOpen:false, notice:false, interview:false, transcriptOpen:false};

// The UI ships with the app and loads from disk, so the window still renders when
// the gateway is down. The gateway URL and key reach the renderer through the
// preload bridge, never through the page URL.
// In development the UI is read straight out of the repo; a packaged build ships
// the same directory as an extra resource (see package.json > build.extraResources).
const RENDERER_INDEX = app.isPackaged
  ? path.join(process.resourcesPath, 'web', 'index.html')
  : path.resolve(__dirname, '..', '..', 'web', 'index.html');

function createWindow(config, { onMove, onDisplay, canShow = () => true } = {}) {
  const isMac = process.platform === 'darwin';
  // 记住上次的位置：透明无边框窗口没有标题栏可以拖，每次启动都回默认位置
  // 时用户得重新按快捷键挪一遍。
  const saved = config && config.windowBounds;
  compact = true;
  surface = {answer:false, shotCount:0, settingsOpen:false, notice:false, interview:false, transcriptOpen:false};
  layout = config?.surfaceVersion === 1 && Object.hasOwn(LAYOUTS, config?.windowLayout) ? config.windowLayout : 'narrow';
  theme = ['light','dark','transparent-black','transparent-white'].includes(config?.panelTheme) ? config.panelTheme : 'light';
  opacity = Number.isFinite(config?.panelOpacity) ? config.panelOpacity : .9;
  readingFontSize = [16,18,20,22,24].includes(config?.readingFontSize) ? config.readingFontSize : 18;
  zoomFactor = Number.isFinite(config?.zoomFactor) ? Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(config.zoomFactor * 10) / 10)) : 1;
  expandedSize = {
    width: config?.surfaceVersion === 1 && Number.isFinite(saved?.width) ? Math.max(320, saved.width) : LAYOUTS[layout].width,
    height: config?.surfaceVersion === 1 && Number.isFinite(saved?.height) ? Math.max(300, saved.height) : LAYOUTS[layout].height,
  };
  interviewSize = {
    width: Number.isFinite(saved?.interviewWidth) ? Math.max(720, saved.interviewWidth) : INTERVIEW.width,
    height: Number.isFinite(saved?.interviewHeight) ? Math.max(480, saved.interviewHeight) : INTERVIEW.height,
  };
  onDisplayChange = onDisplay;
  const win = new BrowserWindow({
    title: '左右',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    ...(saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)
      ? { x: Math.round(saved.x), y: Math.round(saved.y) }
      : {}),
    width: COMPACT.width,
    height: COMPACT.height,
    minWidth: 320,
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
  const endTextEditing = () => setTextEditing(win, false, {restore: false});
  win.on('blur', endTextEditing);
  win.on('hide', endTextEditing);
  win.on('closed', endTextEditing);
  win.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) endTextEditing(); });
  win.webContents.on('did-navigate', endTextEditing);
  win.webContents.on('render-process-gone', endTextEditing);
  const target = startupDisplay(config, screen.getAllDisplays(), screen.getPrimaryDisplay());
  if (screen.getDisplayMatching(win.getBounds()).id !== target.id) moveToDisplay(win, target);
  fitSurface(win);
  clampToArea(win);
  setOpacity(win, opacity);

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
    endTextEditing();
    if (url !== win.webContents.getURL()) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('did-finish-load', () => {
    if (!win.isDestroyed()) win.webContents.setZoomFactor(zoomFactor);
  });
  win.loadFile(RENDERER_INDEX);
  win.once('ready-to-show', () => {
    if (win.isDestroyed() || !canShow()) return;
    win.setBackgroundColor('#00000000');
    setOverlayFocusable(win, false);
    // Gank 式悬浮层：默认让鼠标完全穿过，只有系统级 Command 监听报告
    // Command 按下时才临时接收点击。不能在这里设成可点击，否则面板会
    // 一直挡住下面的题目。
    setClickThrough(win, true);
    win.showInactive();
  });
  // 两种工作面松开修饰键都立即恢复穿透。
  win.webContents.on('before-input-event', (_event, input) => {
    if (!interact || input.type !== 'keyUp') return;
    if (
      input.key === 'Meta' ||
      input.key === 'Control' ||
      input.key === 'Shift' ||
      input.key === 'Alt' ||
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
    const own = process.platform === 'win32' ? nativeWindowId(win) : String(process.pid);
    if (pid && pid !== own) previousPid = pid;
  }, 1000);
  win.on('closed', () => clearInterval(rememberFrontApp));

  // 位置变化后落盘，下次启动接着用。防抖是因为拖动/连按方向键会连续触发。
  let saveTimer = null;
  const persistBounds = () => {
    if (!onMove) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (win.isDestroyed()) return;
      const { x, y, width, height } = win.getBounds();
      // 收起尺寸不覆盖阅读尺寸；重启仍恢复最后的阅读窗口。
      if (!compact && !surface.settingsOpen && surface.interview) interviewSize = {width,height};
      else if (!compact && !surface.settingsOpen) expandedSize = {width,height};
      onMove({ x, y, ...expandedSize, interviewWidth: interviewSize.width, interviewHeight: interviewSize.height });
    }, 400);
  };
  win.on('move', persistBounds);
  win.on('resize', persistBounds);
  win.on('closed', () => clearTimeout(saveTimer));
  return win;
}

// 背景不透明度：滑块按 1% 调整，⌘[ / ⌘] 每次调 10%。
// 悬浮窗挡在题目上时，调低一点能看清底下的原文。
const OPACITY_MIN = 0;
const OPACITY_MAX = 1;
const OPACITY_STEP = 0.1;
let opacity = .9;

function getDisplayState(win) {
  return {revision:displayRevision, saved:displaySaved, opacity, layout, compact, theme, readingFontSize, zoomFactor, ...surface, ...(win && !win.isDestroyed() ? win.getBounds() : {})};
}

function notifyDisplay(win) {
  displayRevision += 1;
  const display = getDisplayState(win);
  displaySaved = onDisplayChange?.({panelOpacity: opacity, windowLayout: layout, panelTheme:theme, readingFontSize, zoomFactor, surfaceVersion:1}, display) !== false;
  display.saved = displaySaved;
  if (win && !win.isDestroyed()) win.webContents.send('cockpit:display', display);
  return display;
}

function setOpacity(win, value) {
  if (!Number.isFinite(value)) return opacity;
  opacity = Math.max(OPACITY_MIN, Math.min(OPACITY_MAX, Math.round(value * 100) / 100));
  // 保持字与代码清晰，只调整 CSS 背景；不让整个窗口一起褪色。
  if (win && !win.isDestroyed()) win.setOpacity(1);
  notifyDisplay(win);
  return opacity;
}

function changeOpacity(win, delta) {
  return setOpacity(win, opacity + delta);
}

// 字号缩放：Gank 用 ⌘- / ⌘0 / ⌘=。用 webContents 的 zoomFactor，
// 正文、代码块、标签栏一起缩放，比改 CSS 变量稳。
const ZOOM_MIN = 0.7;
const ZOOM_MAX = 1.6;
const ZOOM_STEP = 0.1;
let zoomFactor = 1;

function setZoom(win, value) {
  if (!Number.isFinite(value)) return zoomFactor;
  zoomFactor = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(value * 10) / 10));
  if (win && !win.isDestroyed()) {
    win.webContents.setZoomFactor(zoomFactor);
    fitSurface(win);
  }
  notifyDisplay(win);
  return zoomFactor;
}

function setReadingFontSize(win, value) {
  if (![16,18,20,22,24].includes(value)) return readingFontSize;
  readingFontSize = value;
  notifyDisplay(win);
  return readingFontSize;
}

function changeZoom(win, delta) {
  return setZoom(win, zoomFactor + delta);
}

function resetZoom(win) {
  return setZoom(win, 1);
}

function clampToArea(win) {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const x = Math.max(area.x, Math.min(bounds.x, area.x + Math.max(0, area.width - bounds.width)));
  const y = Math.max(area.y, Math.min(bounds.y, area.y + Math.max(0, area.height - bounds.height)));
  if (x !== bounds.x || y !== bounds.y) win.setPosition(x, y, false);
}

function moveToDisplay(win, display) {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  const area = display.workArea;
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  const x = Math.round(area.x + (area.width - width) / 2);
  const y = Math.round(area.y + (area.height - height) / 2);
  win.setBounds({ x, y, width, height }, false);
  notifyDisplay(win);
}

function moveWindow(win, dx, dy) {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const x = Math.max(area.x, Math.min(bounds.x + dx, area.x + Math.max(0, area.width - bounds.width)));
  const y = Math.max(area.y, Math.min(bounds.y + dy, area.y + Math.max(0, area.height - bounds.height)));
  win.setPosition(x, y, false);
}

function toggleCompact(win) {
  if (!win || win.isDestroyed()) return compact;
  if (!compact && !surface.settingsOpen && surface.interview) {
    const {width, height} = win.getBounds();
    interviewSize = {width, height};
  } else if (!compact && !surface.settingsOpen) {
    const {width, height} = win.getBounds();
    expandedSize = {width, height};
  }
  compact = !compact;
  fitSurface(win);
  // 贴在屏幕右下角时展开，大半截会跑到屏幕外——重设尺寸后重新夹一次。
  clampToArea(win);
  win.webContents.send('cockpit:compact', compact);
  notifyDisplay(win);
  return compact;
}

function fitWindow(win, size) {
  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  win.setSize(Math.round(Math.min(size.width, area.width)), Math.round(Math.min(size.height, area.height)));
}

function setLayout(win, value) {
  if (!win || win.isDestroyed() || !Object.hasOwn(LAYOUTS, value)) return getDisplayState(win);
  layout = value;
  compact = !(surface.answer || surface.interview);
  expandedSize = {...LAYOUTS[value]};
  fitSurface(win);
  clampToArea(win);
  win.webContents.send('cockpit:compact', false);
  return notifyDisplay(win);
}

function fitSurface(win) {
  const additions = (surface.shotCount ? 84 : 0) + (surface.notice ? 26 : 0);
  // 面试是独立工作面：左转录右回答，需要真正的横向空间，而不是把一个窄窗拉高。
  const compactScale = Math.max(1, zoomFactor);
  const size = compact ? {width:COMPACT.width * compactScale, height:(COMPACT.height + additions) * compactScale}
    : surface.interview ? {...interviewSize}
    : {...expandedSize};
  if(surface.settingsOpen) size.height = Math.max(size.height, 650);
  fitWindow(win, size);
  clampToArea(win);
}

function setSurface(win, patch = {}) {
  if(!win || win.isDestroyed()) return getDisplayState(win);
  const interview = typeof patch.interview === 'boolean' ? patch.interview : surface.interview;
  if (surface.interview && !interview) setTextEditing(win, false, {restore: false});
  if(patch.answer === false && !interview) compact = true;
  else if((patch.answer === true && !surface.answer) || (interview && !surface.interview)) compact = false;
  if(typeof patch.answer === 'boolean') surface.answer = patch.answer;
  surface.interview = interview;
  if(typeof patch.transcriptOpen === 'boolean') surface.transcriptOpen = patch.transcriptOpen;
  if(Number.isInteger(patch.shotCount)) surface.shotCount = Math.max(0, Math.min(8, patch.shotCount));
  if(typeof patch.settingsOpen === 'boolean') surface.settingsOpen = patch.settingsOpen;
  if(typeof patch.notice === 'boolean') surface.notice = patch.notice;
  fitSurface(win);
  return notifyDisplay(win);
}

function setTheme(win, value) {
  if(['light','dark','transparent-black','transparent-white'].includes(value)) theme = value;
  return notifyDisplay(win);
}

function showWindow(win) {
  if (!win || win.isDestroyed()) return;
  setTextEditing(win, false, {restore: false});
  if (!win.isVisible()) win.showInactive();
  setOverlayFocusable(win, false);
  setClickThrough(win, true);
}

function hideWindow(win) {
  if (!win || win.isDestroyed()) return;
  setTextEditing(win, false, {restore: false});
  if (!win.isVisible()) return;
  setInteractive(win, false);
  win.hide();
}

function toggleVisible(win) {
  if (!win) return;
  if (win.isVisible()) hideWindow(win);
  else showWindow(win);
}

let interact = false;
let textEditing = false;
let armedAt = 0;
let previousPid = '';

function setClickThrough(win, ignore) {
  if (!win || win.isDestroyed()) return;
  win.setIgnoreMouseEvents(Boolean(ignore), { forward: false });
}

function setOverlayFocusable(win, focusable) {
  win.setFocusable(focusable);
  // Electron 33 on Windows changes taskbar membership when focusability changes.
  if (process.platform === 'win32') win.setSkipTaskbar(true);
}

function nativeWindowId(win) {
  if (!win || typeof win.getNativeWindowHandle !== 'function') return '';
  const handle = win.getNativeWindowHandle();
  return handle.length >= 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
}

function frontmostPid() {
  if (process.platform === 'win32') return require('./command-key').getWindowsForegroundWindow();
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

function activatePid(pid, win) {
  if (process.platform === 'win32') {
    require('./command-key').restoreWindowsForegroundWindow(pid, nativeWindowId(win));
    return;
  }
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

function isTextEditing() {
  return textEditing;
}

function releaseKeyboardFocus(win, restore) {
  const hadFocus = typeof win.isFocused === 'function' && win.isFocused();
  setOverlayFocusable(win, false);
  const pid = previousPid;
  previousPid = '';
  const own = process.platform === 'win32' ? nativeWindowId(win) : String(process.pid);
  if (restore && hadFocus && pid && pid !== own) activatePid(pid, win);
}

function setTextEditing(win, on, { restore = true } = {}) {
  if (typeof on !== 'boolean') return false;
  if (!win || win.isDestroyed()) {
    if (!on) textEditing = false;
    return false;
  }
  if (on && (!interact || !win.isVisible() || !win.isFocused())) return false;
  if (textEditing === on) return textEditing;
  textEditing = on;
  if (!interact) {
    setClickThrough(win, true);
    if (textEditing) setOverlayFocusable(win, true);
    else releaseKeyboardFocus(win, restore);
  }
  win.webContents.send('cockpit:textEditing', textEditing);
  return textEditing;
}

function setInteractive(win, on, { restore = true } = {}) {
  if (!win || win.isDestroyed()) return interact;
  const next = Boolean(on);
  if (interact === next) {
    if (!next) {
      setClickThrough(win, true);
      setOverlayFocusable(win, textEditing);
      win.webContents.send('cockpit:armed', false);
    }
    return interact;
  }
  interact = next;
  if (interact) {
    if (process.platform === 'win32') {
      const foreground = frontmostPid();
      if (foreground && foreground !== nativeWindowId(win)) previousPid = foreground;
    }
    armedAt = Date.now();
    if (!win.isVisible()) win.showInactive();
    setOverlayFocusable(win, true);
    setClickThrough(win, false);
  } else {
    setClickThrough(win, true);
    // A focused editor can receive keyboard input while every mouse event passes through.
    if (textEditing) setOverlayFocusable(win, true);
    else releaseKeyboardFocus(win, restore);
  }
  win.webContents.send('cockpit:armed', interact);
  return interact;
}

function beginHoldInteract(win) {
  if (!win || win.isDestroyed()) return;
  // 兼容旧的“按住操作面板”全局快捷键：它只负责进入临时交互，
  // 松开 Command 后仍由系统级监听统一恢复穿透。
  const pid = frontmostPid();
  const own = process.platform === 'win32' ? nativeWindowId(win) : String(process.pid);
  if (pid && pid !== own) previousPid = pid;
  setInteractive(win, true);
}

module.exports = {
  createWindow,
  moveToDisplay,
  moveWindow,
  setOpacity,
  changeOpacity,
  setZoom,
  setReadingFontSize,
  changeZoom,
  resetZoom,
  toggleCompact,
  toggleVisible,
  showWindow,
  hideWindow,
  setClickThrough,
  setInteractive,
  setTextEditing,
  beginHoldInteract,
  isInteractive,
  isTextEditing,
  RENDERER_INDEX,
  COMPACT,
  EXPANDED,
  LAYOUTS,
  setLayout,
  getDisplayState,
  setSurface,
  setTheme,
};

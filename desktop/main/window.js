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

let compact = false;
let layout = 'standard';
let expandedSize = {...EXPANDED};
let onDisplayChange = null;
let displayRevision = 0;
let theme = 'light';
let surface = {answer:false, shotCount:0, settingsOpen:false, notice:false};

// The UI ships with the app and loads from disk, so the window still renders when
// the gateway is down. The gateway URL and key reach the renderer through the
// preload bridge, never through the page URL.
// In development the UI is read straight out of the repo; a packaged build ships
// the same directory as an extra resource (see package.json > build.extraResources).
const RENDERER_INDEX = app.isPackaged
  ? path.join(process.resourcesPath, 'web', 'index.html')
  : path.resolve(__dirname, '..', '..', 'web', 'index.html');

function createWindow(config, { onMove, onDisplay } = {}) {
  const isMac = process.platform === 'darwin';
  // 记住上次的位置：透明无边框窗口没有标题栏可以拖，每次启动都回默认位置
  // 时用户得重新按快捷键挪一遍。
  const saved = config && config.windowBounds;
  compact = true;
  surface = {answer:false, shotCount:0, settingsOpen:false, notice:false};
  layout = config?.surfaceVersion === 1 && Object.hasOwn(LAYOUTS, config?.windowLayout) ? config.windowLayout : 'narrow';
  theme = ['light','dark','transparent-black','transparent-white'].includes(config?.panelTheme) ? config.panelTheme : 'light';
  opacity = Number.isFinite(config?.panelOpacity) ? config.panelOpacity : .9;
  expandedSize = {
    width: config?.surfaceVersion === 1 && Number.isFinite(saved?.width) ? Math.max(320, saved.width) : LAYOUTS[layout].width,
    height: config?.surfaceVersion === 1 && Number.isFinite(saved?.height) ? Math.max(300, saved.height) : LAYOUTS[layout].height,
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
    neverShowInTaskbar: true,
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
  const target = startupDisplay(config, screen.getAllDisplays(), screen.getPrimaryDisplay());
  if (screen.getDisplayMatching(win.getBounds()).id !== target.id) moveToDisplay(win, target);
  fitWindow(win, COMPACT);
  clampToArea(win);
  setOpacity(win, opacity);

  // Keep the interviewer's private panel out of screen share and screen recording,
  // the same way presenter notes stay off the shared feed. macOS maps this to
  // NSWindowSharingNone; must be set before the window is shown.
  win.setContentProtection(true);
  // Electron 33 on Windows can clear display affinity on hide. Restore it for
  // screenshot recovery, visibility shortcuts and all other show paths.
  win.on('show', () => win.setContentProtection(true));
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
    // Gank 式悬浮层：默认让鼠标完全穿过，只有系统级 Command 监听报告
    // Command 按下时才临时接收点击。不能在这里设成可点击，否则面板会
    // 一直挡住下面的题目。
    setClickThrough(win, true);
    win.showInactive();
  });
  // 松开 Command 由 command-key.js 的系统级监听负责。这里保留一个
  // 窗口已获得焦点时的兜底：即使原生监听暂不可用，Command 的 keyUp
  // 仍能恢复穿透。
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
      if (!compact && !surface.settingsOpen) expandedSize = {width,height};
      onMove({ x, y, ...expandedSize });
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
  return {revision:displayRevision, opacity, layout, compact, theme, ...surface, ...(win && !win.isDestroyed() ? win.getBounds() : {})};
}

function notifyDisplay(win) {
  displayRevision += 1;
  const display = getDisplayState(win);
  if (win && !win.isDestroyed()) win.webContents.send('cockpit:display', display);
  onDisplayChange?.({panelOpacity: opacity, windowLayout: layout, panelTheme:theme, surfaceVersion:1});
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
  zoomFactor = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(value * 10) / 10));
  if (win && !win.isDestroyed()) win.webContents.setZoomFactor(zoomFactor);
  return zoomFactor;
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
  if (!compact && !surface.settingsOpen) {
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
  compact = !surface.answer;
  expandedSize = {...LAYOUTS[value]};
  fitSurface(win);
  clampToArea(win);
  win.webContents.send('cockpit:compact', false);
  return notifyDisplay(win);
}

function fitSurface(win) {
  const size = compact ? {...COMPACT, height:COMPACT.height + (surface.shotCount ? 84 : 0) + (surface.notice ? 26 : 0)} : {...expandedSize};
  if(surface.settingsOpen) size.height = Math.max(size.height, 650);
  fitWindow(win, size);
  clampToArea(win);
}

function setSurface(win, patch = {}) {
  if(!win || win.isDestroyed()) return getDisplayState(win);
  if(patch.answer === false) compact = true;
  else if(patch.answer === true && !surface.answer) compact = false;
  if(typeof patch.answer === 'boolean') surface.answer = patch.answer;
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
  if (!win.isVisible()) win.showInactive();
  win.setFocusable(false);
  setClickThrough(win, true);
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
  win.setIgnoreMouseEvents(Boolean(ignore), { forward: false });
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

function setInteractive(win, on, { restore = true } = {}) {
  if (!win || win.isDestroyed()) return interact;
  const next = Boolean(on);
  if (interact === next) {
    if (!next) {
      setClickThrough(win, true);
      win.setFocusable(false);
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
    // 不主动 focus：按下 Command 只解除鼠标穿透，用户仍可继续在题目
    // 窗口里操作；真正点击悬浮层时才由 macOS 把焦点交给它。
    win.setFocusable(true);
    setClickThrough(win, false);
  } else {
    const hadFocus = typeof win.isFocused === 'function' && win.isFocused();
    setClickThrough(win, true);
    win.setFocusable(false);
    const pid = previousPid;
    previousPid = '';
    // 只有悬浮层真的取得过焦点时才把焦点还给原来的应用。单纯按住
    // Command 不会打断用户正在输入的题目。
    const own = process.platform === 'win32' ? nativeWindowId(win) : String(process.pid);
    if (restore && hadFocus && pid && pid !== own) activatePid(pid, win);
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
  changeZoom,
  resetZoom,
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
  LAYOUTS,
  setLayout,
  getDisplayState,
  setSurface,
  setTheme,
};

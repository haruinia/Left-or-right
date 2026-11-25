import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const source = name => fs.readFileSync(new URL(`../desktop/main/${name}.js`, import.meta.url), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const display = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 1 };

function indexFixture() {
  const events = [], timers = [], handlers = new Map(), appEvents = new Map();
  const window = { visible: true, isDestroyed: () => false, isVisible() { return this.visible; }, hide() { this.visible = false; }, showInactive() { this.visible = true; }, getBounds: () => display.bounds, webContents: { mainFrame:{},getURL:()=> 'file:///app/web/index.html',send: (...args) => events.push(args) } };
  const state = { armed:false,textEditing:false,surface: {interview:false}, screenAccess:'denied', backend: async () => true, settings: async () => true, selection: async () => ({ x: 0, y: 0, width: 20, height: 20 }), capture: async () => ({ mime: 'image/png', data: Buffer.from('image') }) };
  const electron = {
    app: { userAgentFallback:'TestAgent/1.0', setName() {}, getPath: () => '/test-user-data', requestSingleInstanceLock: () => true, on: (name, fn) => appEvents.set(name, fn), whenReady: () => ({ then() {} }) },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} },
    BrowserWindow: { getAllWindows: () => [window] }, screen: { getAllDisplays: () => [display], getDisplayMatching: () => display, getPrimaryDisplay: () => display },
    dialog: { showErrorBox: (...args) => events.push(['dialog', ...args]) },
    shell: { openExternal: async (...args) => events.push(['external', ...args]) }, systemPreferences: { getMediaAccessStatus: () => state.screenAccess },
  };
  const modules = {
    './config': { loadConfig: () => ({}), saveConfig() {} },
    './window': {
      RENDERER_INDEX:'/app/web/index.html',
      setInteractive: (...args) => {state.armed=Boolean(args[1]);events.push(['interactive', ...args]);},
      isInteractive:()=>state.armed,
      setTextEditing: (_window,value) => {state.textEditing=value;events.push(['editing',value]);return value;},
      isTextEditing:()=>state.textEditing,
      getDisplayState: () => ({...state.surface}),
      setSurface: (_window,patch) => Object.assign(state.surface,patch),
    },
    './hotkeys': { BINDINGS: [] },
    './capture': { captureScreenshot: options => { events.push(['capture']); return state.capture(options); } },
    './capture-options': require('../desktop/main/capture-options.js'),
    './selector': { selectRegion: (...args) => { events.push(['select']); return state.selection(...args); }, cancelSelection: () => events.push(['cancel']) },
    './backend': { ensureBackend: () => state.backend() },
    './interview-relay': { registerInterviewRelay() {} },
    './interview-socket': { registerInterviewSocket() {} },
    './knowledge-import': { registerKnowledgeImport() {} },
    './audio-capture': { audioCapabilities: () => ({}), configureAudioCapture() {} },
    './command-key': {}, './settings-window': { getSettingsWindow: () => state.settingsWindow || null, openSettingsWindow: (...args) => { events.push(['settings']); return state.settings(...args); } },
    './window-visibility': require('../desktop/main/window-visibility.js'),
  };
  const context = vm.createContext({ process: { ...process, platform: 'darwin' }, Buffer, testWindow: window, setTimeout: (fn, ms) => { timers.push({ fn, ms }); }, require: name => name === 'electron' ? electron : modules[name] || require(name) });
  vm.runInContext(source('index'), context);
  vm.runInContext('win = testWindow; registerIpc()', context);
  return { events, timers, state, window, appEvents, handlers, run: code => vm.runInContext(code, context) };
}

test('speech shortcuts dispatch distinct commands without revealing or focusing windows', () => {
  const f=indexFixture();
  f.run('visibility.hideAll(); hotkeyHandlers().toggleInterview(); hotkeyHandlers().muteInterviewMic(); hotkeyHandlers().muteInterviewSystem()');
  assert.deepEqual(f.events.filter(([name])=>name==='liuwa:interview-control').map(([,action])=>action),['toggle','mic','system']);
  assert.equal(f.window.visible,false);
});

test('text editing IPC accepts only a boolean from the bundled main frame',()=>{
  const f=indexFixture(),request=f.handlers.get('cockpit:setTextEditing');
  const event={sender:f.window.webContents,senderFrame:f.window.webContents.mainFrame};
  assert.equal(request({sender:{},senderFrame:event.senderFrame},true),false);
  assert.equal(request({sender:event.sender,senderFrame:{}},true),false);
  for(const value of [undefined,null,1,'true',{}])assert.equal(request(event,value),false);
  for(const url of ['https://example.test/','file:///app/web/index.html.evil','http://127.0.0.1:9958/settings']){
    f.window.webContents.getURL=()=>url;assert.equal(request(event,true),false);
  }
  assert.equal(f.events.filter(([name])=>name==='editing').length,0);
  f.window.webContents.getURL=()=> 'file:///app/web/index.html#interview';
  assert.equal(request(event,true),true);assert.equal(f.state.textEditing,true);
  assert.equal(f.handlers.get('cockpit:getConfig')().textEditing,true);
  assert.equal(request(event,false),false);assert.equal(f.state.textEditing,false);
  f.window.isDestroyed=()=>true;assert.equal(request(event,true),false);
});

test('capture and explicit visibility changes end text editing before hiding',async()=>{
  const capture=indexFixture();capture.state.textEditing=true;
  const pending=capture.run('attachScreenshot({interactive:false})');
  assert.equal(capture.state.textEditing,false);
  assert.ok(capture.events.findIndex(([name])=>name==='editing')<capture.events.findIndex(([name])=>name==='app:privacy-hidden'));
  capture.timers[0].fn();await pending;
  const hidden=indexFixture();hidden.state.textEditing=true;
  hidden.run('toggleAppVisibility()');
  assert.equal(hidden.state.textEditing,false);assert.equal(hidden.window.visible,false);
  assert.ok(hidden.events.findIndex(([name])=>name==='editing')<hidden.events.findIndex(([name])=>name==='app:privacy-hidden'));
});

test('surface mode changes preserve the modifier gate and hidden-window guards',()=>{
  const f=indexFixture(),surface=f.handlers.get('cockpit:setSurface');
  const armed=()=>f.events.filter(([name])=>name==='interactive').at(-1)[2];
  for(const interview of [true,false]){
    surface({}, {interview});assert.equal(armed(),false);
    f.run('visibility.modifierChanged(true)');assert.equal(armed(),true);
    surface({}, {interview:!interview});assert.equal(armed(),true);
    f.run('visibility.modifierChanged(false)');assert.equal(armed(),false);
    surface({}, {interview});assert.equal(armed(),false);
  }
  f.run('visibility.hideAll()');surface({}, {interview:true});f.appEvents.get('second-instance')();
  assert.equal(f.window.visible,false);assert.equal(armed(),false);
  f.run('visibility.modifierChanged(true)');assert.equal(armed(),false);assert.equal(f.window.visible,false);
  f.run('visibility.modifierChanged(false);visibility.toggle()');assert.equal(f.window.visible,true);assert.equal(armed(),false);
});

for(const status of ['granted','unknown','not-determined'])test(`generic capture failure with ${status} screen access is not misreported as denied permission`,async()=>{
  const f=indexFixture();f.state.screenAccess=status;f.state.capture=async()=>{throw Error('could not create image from display');};
  const pending=f.run('attachScreenshot({interactive:false})');f.timers[0].fn();await pending;
  const failures=f.events.filter(([name])=>name==='liuwa:capture-error');
  assert.equal(failures.length,1);assert.equal(failures[0][1].detail,'截图未能生成，请确认应用所在显示器后重试。');
  assert.doesNotMatch(failures[0][1].detail,/缺少|权限|授权/);
  assert.ok(!f.events.some(([name])=>name==='external'||name==='dialog'));
  assert.equal(f.window.visible,true);assert.equal(f.run('screenBusy'),false);
});

test('an explicit denied screen status keeps precise recovery instructions and opens settings only once',async()=>{
  const f=indexFixture();f.state.screenAccess='denied';f.state.capture=async()=>{throw Error('could not create image from display');};
  for(let attempt=0;attempt<2;attempt++){
    const pending=f.run('attachScreenshot({interactive:false})');f.timers[attempt].fn();await pending;
  }
  const failures=f.events.filter(([name])=>name==='liuwa:capture-error');assert.equal(failures.length,2);
  assert.ok(failures.every(([,payload])=>payload.detail.includes('屏幕录制权限未生效')));
  const external=f.events.filter(([name])=>name==='external');assert.equal(external.length,1);
  assert.match(external[0][1],/Privacy_ScreenCapture/);assert.equal(f.window.visible,true);
});

test('capture start and completion share a unique token before any hiding delay', async () => {
  const f=indexFixture();
  const pending=f.run('attachScreenshot({interactive:false})');
  const start=f.events.find(([name])=>name==='liuwa:capture-start');
  assert.ok(start?.[1].captureId);
  assert.ok(f.events.indexOf(start)<f.events.findIndex(([name])=>name==='app:privacy-hidden'));
  f.timers[0].fn();await pending;
  assert.equal(f.events.find(([name])=>name==='liuwa:capture')[1].captureId,start[1].captureId);
  f.run('lastScreenshotTime=0');
  f.state.capture=async()=>{throw Error('capture unavailable');};
  const second=f.run('attachScreenshot({interactive:false})');
  const next=f.events.filter(([name])=>name==='liuwa:capture-start').at(-1);
  assert.notEqual(next[1].captureId,start[1].captureId);
  f.timers[1].fn();await second;
  assert.equal(f.events.find(([name])=>name==='liuwa:capture-error')[1].captureId,next[1].captureId);
});

test('hide during the capture preparation delay never creates a selector or takes a screenshot', async () => {
  const f = indexFixture();
  const pending = f.run('attachScreenshot({interactive:true})');
  assert.equal(f.timers[0].ms, 160);
  f.run('toggleAppVisibility()');
  f.timers[0].fn();
  await pending;
  assert.ok(!f.events.some(([name]) => ['select', 'capture', 'liuwa:capture'].includes(name)));
  assert.equal(f.window.visible, false);
  assert.equal(f.run('screenBusy'), false);
});

test('hide after selecting a region prevents the delayed screenshot step', async () => {
  const f = indexFixture(), selection = deferred();
  f.state.selection = () => selection.promise;
  const pending = f.run('attachScreenshot({interactive:true})');
  f.timers[0].fn();
  await Promise.resolve(); await Promise.resolve();
  assert.ok(f.events.some(([name]) => name === 'select'));
  f.run('toggleAppVisibility()');
  selection.resolve({ x: 0, y: 0, width: 20, height: 20 });
  await pending;
  assert.ok(!f.events.some(([name]) => ['capture', 'liuwa:capture', 'external'].includes(name)));
  assert.equal(f.window.visible, false);
});

for (const fails of [false, true]) {
  test(`hide while screenshot is pending suppresses its ${fails ? 'error and permission dialog' : 'image result'}`, async () => {
    const f = indexFixture(), capture = deferred();
    f.state.capture = () => capture.promise;
    const pending = f.run('attachScreenshot({interactive:false})');
    f.timers[0].fn();
    await Promise.resolve(); await Promise.resolve();
    assert.ok(f.events.some(([name]) => name === 'capture'));
    f.run('toggleAppVisibility()');
    if (fails) capture.reject(new Error('could not create image'));
    else capture.resolve({ mime: 'image/png', data: Buffer.from('image') });
    await pending;
    assert.ok(!f.events.some(([name]) => ['liuwa:capture', 'liuwa:capture-error', 'dialog', 'external'].includes(name)));
    assert.equal(f.window.visible, false);
  });
}

test('second instance cannot reveal a privacy-hidden or capture-hidden main window', async () => {
  const f = indexFixture();
  f.run('visibility.hideAll()'); f.appEvents.get('second-instance')();
  assert.equal(f.window.visible, false);
  f.run('visibility.toggle()');
  const pending = f.run('attachScreenshot({interactive:false})');
  f.appEvents.get('second-instance')(); assert.equal(f.window.visible, false);
  f.timers[0].fn(); await pending;
});

for (const stage of ['backend', 'settings']) {
  test(`hide suppresses a pending ${stage} failure without creating a native dialog`, async () => {
    const f = indexFixture(), failure = deferred();
    f.state[stage] = () => failure.promise;
    const pending = f.handlers.get('cockpit:openSettings')({}, 'assets');
    await Promise.resolve();
    f.run('visibility.hideAll()'); failure.resolve(false);
    assert.equal(await pending, false);
    assert.ok(!f.events.some(([name]) => ['dialog', 'liuwa:capture-error'].includes(name)));
    assert.equal(f.window.visible, false);
  });
}

test('return from settings hides only the owned settings frame and never shows another window', () => {
  const f=indexFixture(),messages=[];
  const settings={visible:true,isDestroyed:()=>false,hide(){this.visible=false;},webContents:{mainFrame:{},send:(...event)=>messages.push(event)}};
  f.state.settingsWindow=settings;
  const close=f.handlers.get('settings:close');
  assert.equal(close({sender:f.window.webContents,senderFrame:settings.webContents.mainFrame}),false);
  assert.equal(close({sender:settings.webContents,senderFrame:{}}),false);
  assert.equal(settings.visible,true);
  assert.equal(close({sender:settings.webContents,senderFrame:settings.webContents.mainFrame}),true);
  assert.equal(settings.visible,false);assert.equal(f.window.visible,true);
  assert.deepEqual(messages,[['app:privacy-hidden']]);
});

test('audio permission recovery accepts only the owned settings main frame and fixed destinations', async () => {
  const f=indexFixture();
  const settings={isDestroyed:()=>false,webContents:{mainFrame:{}}};f.state.settingsWindow=settings;
  const open=f.handlers.get('settings:audioPermissions');
  assert.equal(await open({sender:f.window.webContents,senderFrame:settings.webContents.mainFrame},'system'),false);
  assert.equal(await open({sender:settings.webContents,senderFrame:{}},'system'),false);
  const event={sender:settings.webContents,senderFrame:settings.webContents.mainFrame};
  assert.equal(await open(event,'https://external.test'),false);
  assert.equal(await open(event,'mic'),true);assert.equal(await open(event,'system'),true);
  const destinations=f.events.filter(([name])=>name==='external').map(([,url])=>url);
  assert.deepEqual(destinations,['x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone','x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture']);
});

test('visible settings failures report inside the protected renderer instead of a native dialog', async () => {
  const f = indexFixture(); f.state.backend = async () => false;
  assert.equal(await f.handlers.get('cockpit:openSettings')({}, 'assets'), false);
  assert.ok(f.events.some(([name, detail]) => name === 'liuwa:capture-error' && detail.detail.includes('设置服务')));
  assert.ok(!f.events.some(([name]) => name === 'dialog'));
});

for (const allowed of [true, false]) {
  test(`main ready-to-show ${allowed ? 'reveals a permitted' : 'does not reveal a privacy-hidden'} window`, () => {
    class Window extends EventEmitter {
      constructor(options) {
        super(); this.bounds = { x: 0, y: 0, width: options.width, height: options.height }; this.visible = false;
        this.webContents = new EventEmitter(); this.webContents.send = () => {}; this.webContents.setWindowOpenHandler = () => {};
      }
      isDestroyed() { return false; } getBounds() { return this.bounds; }
      setSize(width, height) { Object.assign(this.bounds, { width, height }); }
      setPosition(x, y) { Object.assign(this.bounds, { x, y }); }
      setOpacity() {} setContentProtection() {} setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {}
      setBackgroundColor() {} setFocusable() {} setSkipTaskbar() {} setIgnoreMouseEvents() {} loadFile() {}
      showInactive() { this.visible = true; }
    }
    const electron = { app: { isPackaged: false }, BrowserWindow: Window, screen: { getAllDisplays: () => [display], getDisplayMatching: () => display, getPrimaryDisplay: () => display } };
    const context = { module: { exports: {} }, __dirname: '/app/main', process: { ...process, platform: 'win32' }, setInterval: () => 1, clearInterval() {}, clearTimeout() {}, require: name => name === 'electron' ? electron : name === './capture-options' ? require('../desktop/main/capture-options.js') : require(name) };
    vm.runInNewContext(source('window'), context);
    const win = context.module.exports.createWindow({}, { canShow: () => allowed });
    win.emit('ready-to-show'); assert.equal(win.visible, allowed);
  });
}

function selectorFixture() {
  const windows = [], timers = [], handlers = new Map(), shortcuts = new Map();
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.destroyed = false; this.visible = false; this.protected = false; this.webContents = {}; windows.push(this); }
    setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {} loadFile() {}
    setContentProtection(value) { this.protected = value; }
    isDestroyed() { return this.destroyed; }
    showInactive() { assert.equal(this.protected, true); this.visible = true; }
    destroy() { this.destroyed = true; this.visible = false; }
  }
  const electron = { BrowserWindow: Window, app: { isPackaged: false }, screen: { getPrimaryDisplay: () => display }, ipcMain: { on: (name, fn) => handlers.set(name, fn) }, globalShortcut: { register: (name, fn) => { shortcuts.set(name, fn); return true; }, unregister: name => shortcuts.delete(name) } };
  const context = { module: { exports: {} }, __dirname: '/app/main', setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {}, require: name => name === 'electron' ? electron : require(name) };
  vm.runInNewContext(source('selector'), context);
  return { api: context.module.exports, windows, timers, handlers, shortcuts };
}

test('selector starts hidden and a privacy cancellation before ready prevents it showing', async () => {
  const f = selectorFixture(); let allowed = true;
  const pending = f.api.selectRegion(display, () => allowed), win = f.windows[0];
  assert.equal(win.options.show, false); assert.equal(win.visible, false); assert.equal(win.protected, true);
  allowed = false; win.emit('ready-to-show');
  assert.equal(await pending, null); assert.equal(win.visible, false); assert.equal(win.destroyed, true);
  assert.equal(f.shortcuts.size, 0);
});

test('stale selector readiness, timeout, close and IPC callbacks cannot affect a replacement', async () => {
  const f = selectorFixture();
  const first = f.api.selectRegion(display), old = f.windows[0];
  const oldReady = old.listeners('ready-to-show')[0];
  old.emit('ready-to-show'); const oldEscape = f.shortcuts.get('Escape');
  f.api.cancelSelection(); assert.equal(await first, null);
  const second = f.api.selectRegion(display), current = f.windows[1];
  current.emit('ready-to-show'); assert.equal(current.visible, true); assert.equal(f.shortcuts.has('Escape'), true);
  oldReady(); oldEscape(); f.timers[0](); old.emit('closed');
  f.handlers.get('selector:cancel')({ sender: old.webContents });
  f.handlers.get('selector:commit')({ sender: old.webContents }, { left: 0, top: 0, width: 20, height: 20 });
  assert.equal(current.visible, true); assert.equal(current.destroyed, false); assert.equal(old.visible, false);
  assert.equal(f.shortcuts.has('Escape'), true);
  f.handlers.get('selector:commit')({ sender: current.webContents }, { left: 0, top: 0, width: 20, height: 20 });
  assert.equal((await second).width, 20); assert.equal(f.shortcuts.size, 0);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const indexSource = fs.readFileSync(new URL('../desktop/main/index.js', import.meta.url), 'utf8');

test('preload exposes isolated text-editing requests and removable state subscriptions',async()=>{
  const exposed={},listeners=new Map(),requests=[];
  const ipcRenderer={
    on:(name,listener)=>listeners.set(name,listener),
    removeListener:(name,listener)=>{assert.equal(listeners.get(name),listener);listeners.delete(name);},
    invoke:async(...args)=>{requests.push(args);return true;},
    sendSync:()=>({}),
  };
  const context={require:name=>{assert.equal(name,'electron');return {contextBridge:{exposeInMainWorld:(name,value)=>exposed[name]=value},ipcRenderer};}};
  vm.runInNewContext(fs.readFileSync(new URL('../desktop/preload/bridge.js',import.meta.url),'utf8'),context);
  assert.equal(await exposed.cockpit.setTextEditing(true),true);
  assert.deepEqual(requests,[['cockpit:setTextEditing',true]]);
  const states=[],unsubscribe=exposed.cockpit.onTextEditing(value=>states.push(value));
  const listener=listeners.get('cockpit:textEditing');listener({},true);listener({},false);
  assert.deepEqual(states,[true,false]);unsubscribe();assert.equal(listeners.has('cockpit:textEditing'),false);
});

function startup({ platform = 'win32', backend = Promise.resolve(false) } = {}) {
  const events = [], windows = [];
  const screen = new EventEmitter();
  const app = new EventEmitter();
  Object.assign(app, { userAgentFallback:'Mozilla/5.0 左右/0.1.0 Electron/45', setName() {}, getPath: () => '/test-user-data', requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }), dock: { hide() {} }, setActivationPolicy() {} });
  const modules = {
    './config': { loadConfig: () => ({}), saveConfig() {} },
    './window': {
      RENDERER_INDEX: '/app/web/index.html',
      getDisplayState: () => ({interview:false}),
      setInteractive: (_window, held) => events.push(['armed', held]),
      isInteractive:()=>false,
      setTextEditing: (_window, value) => {events.push(['editing',value]);return value;},
      isTextEditing:()=>false,
      createWindow(_config, options) {
        const window = new EventEmitter();
        Object.assign(window, { visible: false, destroyed: false, options,
          isDestroyed() { return this.destroyed; }, isVisible() { return this.visible; },
          hide() { this.visible = false; }, showInactive() { this.visible = true; events.push(['show']); },
          webContents: new EventEmitter() });
        window.webContents.send = (...args) => events.push(args);
        windows.push(window); events.push(['create']);
        return window;
      },
    },
    './backend': { ensureBackend: () => backend },
    './hotkeys': { BINDINGS: [], registerHotkeys: () => [] },
    './interview-relay': { registerInterviewRelay() {} },
    './interview-socket': { registerInterviewSocket() {} },
    './knowledge-import': { registerKnowledgeImport() {} },
    './audio-capture': { audioCapabilities: () => ({}), configureAudioCapture() {} },
    './command-key': { startCommandKeyMonitor: () => () => {} },
    './window-visibility': require('../desktop/main/window-visibility.js'),
    './capture': {}, './capture-options': {}, './selector': {}, './settings-window': {},
  };
  const electron = { app, screen, nativeTheme: {}, Menu: { setApplicationMenu: menu => events.push(['menu', menu]) },
    dialog: { showErrorBox() { throw Error('Native startup dialog escaped the protected renderer'); } },
    BrowserWindow: { getAllWindows: () => windows }, ipcMain: { handle() {}, on() {} },
    session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } } };
  const context = vm.createContext({ process: { ...process, platform }, AbortSignal,
    fetch: async () => ({ ok: false }), setInterval() {},
    require: name => name === 'electron' ? electron : modules[name] || require(name) });
  vm.runInContext(indexSource, context);
  return { events, windows, run: code => vm.runInContext(code, context), boot: () => vm.runInContext('boot()', context) };
}

for (const platform of ['win32', 'darwin']) {
  test(`${platform} startup ${platform === 'win32' ? 'removes' : 'does not change'} the Windows application menu`, async () => {
    const f = startup({ platform, backend: Promise.resolve(true) });
    await f.boot();
    const menu = f.events.findIndex(([name]) => name === 'menu');
    if (platform === 'win32') {
      assert.ok(menu >= 0 && menu < f.events.findIndex(([name]) => name === 'create'));
      assert.deepEqual(f.events[menu], ['menu', null]);
    } else assert.equal(menu, -1);
    f.windows[0].webContents.emit('did-finish-load');
    assert.ok(!f.events.some(([name]) => name === 'liuwa:capture-error'));
  });
}

test('startup failure waits for the protected renderer and reports exactly once without showing a window', async () => {
  const f = startup(); await f.boot();
  assert.equal(f.windows.length, 1);
  assert.ok(!f.events.some(([name]) => name === 'liuwa:capture-error'));
  f.windows[0].webContents.emit('did-finish-load');
  f.windows[0].webContents.emit('did-finish-load');
  const messages = f.events.filter(([name]) => name === 'liuwa:capture-error');
  assert.equal(messages.length, 1);
  assert.match(messages[0][1].detail, /本地服务未能启动/);
  assert.ok(!f.events.some(([name]) => name === 'show'));
});

for (const restore of [false, true]) {
  test(`privacy hide${restore ? ' followed by restore' : ''} invalidates pending startup error delivery`, async () => {
    const f = startup(); await f.boot();
    f.run('visibility.hideAll()');
    if (restore) f.run('visibility.toggle()');
    const showsBefore = f.events.filter(([name]) => name === 'show').length;
    f.windows[0].webContents.emit('did-finish-load');
    assert.ok(!f.events.some(([name]) => name === 'liuwa:capture-error'));
    assert.equal(f.events.filter(([name]) => name === 'show').length, showsBefore);
  });
}

test('startup privacy revision is captured before awaiting the backend', async () => {
  let resolve;
  const f = startup({ backend: new Promise(done => { resolve = done; }) });
  const boot = f.boot();
  f.run('visibility.hideAll()');
  resolve(false); await boot;
  assert.equal(f.windows[0].options.canShow(), false);
  f.windows[0].webContents.emit('did-finish-load');
  assert.ok(!f.events.some(([name]) => name === 'liuwa:capture-error'));
});

function lightboxFixture() {
  class Target {
    constructor() { this.listeners = new Map(); }
    addEventListener(name, callback) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(callback);
    }
    removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
    dispatch(name, detail = {}) {
      for (const callback of [...this.listeners.get(name) || []]) callback({ preventDefault() {}, stopPropagation() {}, ...detail });
    }
    count(name) { return this.listeners.get(name)?.size || 0; }
  }
  class Element extends Target {
    constructor() {
      super(); this.children = []; this.style = {}; const classes = new Set();
      this.classList = { add: name => classes.add(name), remove: name => classes.delete(name),
        contains: name => classes.has(name), toggle: (name, value) => value ? classes.add(name) : classes.delete(name) };
    }
    setAttribute() {}
    append(...children) { children.forEach(child => { child.parent = this; this.children.push(child); }); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    setPointerCapture() {} releasePointerCapture() {}
  }
  const document = new Target();
  document.hidden = false; document.body = new Element(); document.createElement = () => new Element();
  const window = new Target();
  const context = vm.createContext({ window, document });
  const source = fs.readFileSync(new URL('../web/modules/lightbox.js', import.meta.url), 'utf8').replaceAll('export function ', 'function ');
  vm.runInContext(source, context);
  return { window, document, run: code => vm.runInContext(code, context) };
}

test('privacy hide clears the main screenshot preview and its keyboard handler without reopening it', () => {
  const f = lightboxFixture(); f.run('openLightbox(["first", "second"], 1)');
  const stage = f.document.body.children[0].children[0];
  stage.dispatch('wheel', { deltaY: -1 });
  stage.dispatch('pointerdown', { button: 0, clientX: 20, clientY: 30, pointerId: 1 });
  assert.equal(f.document.count('keydown'), 1);
  f.window.dispatch('app:privacy-hidden');
  f.window.dispatch('app:privacy-hidden');
  assert.equal(f.run('isLightboxOpen()'), false);
  assert.equal(f.document.body.children.length, 0);
  assert.equal(f.document.body.classList.contains('is-lightbox'), false);
  assert.equal(f.document.count('keydown'), 0);
  assert.equal(f.run('items.length'), 0);
  assert.equal(f.run('drag'), null);
  f.document.dispatch('visibilitychange');
  assert.equal(f.run('isLightboxOpen()'), false);
  f.run('openLightbox(["new-first", "new-second"])');
  const reopened = f.document.body.children[0].children[0];
  assert.equal(reopened.children[0].style.transform, 'translate(0px, 0px) scale(1)');
  f.document.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(reopened.children[0].src, 'new-second');
  assert.equal(f.window.count('app:privacy-hidden'), 1);
  assert.equal(f.document.count('visibilitychange'), 1);
});

test('document hiding dismisses the preview, while visible changes preserve an open preview', () => {
  const f = lightboxFixture(); f.run('openLightbox(["first"])');
  f.document.dispatch('visibilitychange');
  assert.equal(f.run('isLightboxOpen()'), true);
  f.document.hidden = true; f.document.dispatch('visibilitychange');
  assert.equal(f.run('isLightboxOpen()'), false);
  assert.equal(f.document.count('keydown'), 0);
  f.document.hidden = false; f.document.dispatch('visibilitychange');
  assert.equal(f.run('isLightboxOpen()'), false);
});

test('network user agent remains ASCII without changing app display identity',()=>{
 const f=startup();const ua=f.run('app.userAgentFallback');assert.doesNotMatch(ua,/[^\x20-\x7e]/);assert.match(ua,/LeftOrRight/);
});

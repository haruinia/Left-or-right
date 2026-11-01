import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';

const source = fs.readFileSync(new URL('../desktop/main/settings-window.js', import.meta.url), 'utf8');
function setup({failLoad=false}={}) {
  const windows=[];
  class Window extends EventEmitter {
    constructor(options) {
      super();this.options=options;this.calls=[];this.destroyed=false;
      this.webContents=new EventEmitter();
      this.webContents.setWindowOpenHandler=fn=>{this.openHandler=fn;};
      this.webContents.send=(...args)=>this.calls.push(['send',...args]);
      windows.push(this);
    }
    isDestroyed(){return this.destroyed;}
    setContentProtection(value){this.protected=value;this.calls.push(['protect',value]);}
    setMenuBarVisibility(value){this.calls.push(['menu',value]);}
    async loadURL(url){this.calls.push(['load',url]);if(failLoad)throw Error('load failed');}
    hide(){this.protected=false;this.calls.push(['hide']);}
    show(){this.calls.push(['show']);this.emit('show');}
    focus(){this.calls.push(['focus']);}
    destroy(){this.destroyed=true;this.emit('closed');}
  }
  const area={x:-1920,y:0,width:1920,height:1080};
  const sandbox={module:{exports:{}},__dirname:'/app/main',URL,require:name=>name==='node:path'?path:name==='electron'?{BrowserWindow:Window,screen:{getDisplayMatching:()=>({workArea:area}),getPrimaryDisplay:()=>({workArea:area})}}:null};
  vm.runInNewContext(source,sandbox);
  return {api:sandbox.module.exports,windows};
}
const config={gatewayUrl:'http://127.0.0.1:9958'};
const main={isDestroyed:()=>false,getBounds:()=>({x:-1000,y:50,width:560,height:76})};

test('settings open inside a sandboxed, capture-protected app window before loading',async()=>{
  const {api,windows}=setup();
  assert.equal(await api.openSettingsWindow(config,'study',main),true);
  const w=windows[0];
  assert.equal(w.options.skipTaskbar,true);
  assert.equal(w.options.neverShowInTaskbar,true);
  assert.equal(w.options.webPreferences.contextIsolation,true);
  assert.equal(w.options.webPreferences.nodeIntegration,false);
  assert.equal(w.options.webPreferences.sandbox,true);
  assert.match(w.options.webPreferences.preload,/settings-bridge\.js$/);
  assert.ok(w.calls.findIndex(c=>c[0]==='protect'&&c[1]===true)<w.calls.findIndex(c=>c[0]==='load'));
  assert.equal(w.calls.find(c=>c[0]==='load')[1],'http://127.0.0.1:9958/settings#study');
  assert.ok(w.options.x<0);
  assert.equal(api.getSettingsWindow(),w);
});

test('reopening reuses the protected window and navigates without reloading the form',async()=>{
  const {api,windows}=setup();
  await api.openSettingsWindow(config,'models',main);
  await api.openSettingsWindow(config,'assets',main);
  assert.equal(windows.length,1);
  assert.equal(windows[0].calls.filter(c=>c[0]==='load').length,1);
  assert.deepEqual(windows[0].calls.find(c=>c[0]==='send'),['send','settings:navigate','assets']);
});

test('showing settings restores capture protection lost on Windows hide',async()=>{
  const {api,windows}=setup();
  await api.openSettingsWindow(config,'models',main);
  const w=windows[0];
  assert.equal(w.protected,true);
  // Electron 33 can lose the native display affinity when hiding a window.
  w.hide();
  assert.equal(w.protected,false);
  await api.openSettingsWindow(config,'study',main);
  assert.equal(w.protected,true);
  // The visibility shortcut restores windows directly, without reopening settings.
  w.hide();w.show();
  assert.equal(w.protected,true);
});

test('settings navigation stays on trusted settings routes and denies new windows',async()=>{
  const {api,windows}=setup();
  await api.openSettingsWindow(config,'javascript:bad',main);
  const w=windows[0];
  assert.ok(w.calls.find(c=>c[0]==='load')[1].endsWith('#models'));
  for(const url of ['https://untrusted.test/settings','http://127.0.0.1:9958/','file:///tmp/secrets']) {
    let blocked=false;w.webContents.emit('will-navigate',{preventDefault(){blocked=true;}},url);assert.equal(blocked,true,url);
  }
  let blocked=false;w.webContents.emit('will-navigate',{preventDefault(){blocked=true;}},'http://127.0.0.1:9958/settings#study');assert.equal(blocked,false);
  assert.equal(w.openHandler({url:'https://untrusted.test'}).action,'deny');
});

test('a privacy hide issued during loading prevents the settings window from reappearing',async()=>{
  const {api,windows}=setup();
  assert.equal(await api.openSettingsWindow(config,'models',main,()=>false),true);
  assert.ok(!windows[0].calls.some(c=>c[0]==='show'));
});

test('failed page load closes the window rather than showing unprotected fallback content',async()=>{
  const {api,windows}=setup({failLoad:true});
  assert.equal(await api.openSettingsWindow(config,'models',main),false);
  assert.equal(windows[0].destroyed,true);
  assert.equal(api.getSettingsWindow(),null);
  assert.ok(!windows[0].calls.some(c=>c[0]==='show'));
});

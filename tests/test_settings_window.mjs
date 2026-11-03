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
      super();this.options=options;this.calls=[];this.destroyed=false;this.bounds={x:options.x,y:options.y,width:options.width,height:options.height};
      this.webContents=new EventEmitter();
      this.webContents.setWindowOpenHandler=fn=>{this.openHandler=fn;};
      this.webContents.send=(...args)=>this.calls.push(['send',...args]);
      windows.push(this);
    }
    isDestroyed(){return this.destroyed;}
    getBounds(){return {...this.bounds};}
    setBounds(bounds){this.bounds={...bounds};this.calls.push(['bounds',bounds]);}
    setMinimumSize(width,height){this.calls.push(['minimum',width,height]);}
    setContentProtection(value){this.calls.push(['protect',value]);}
    removeMenu(){this.calls.push(['removeMenu']);}
    async loadURL(url){this.calls.push(['load',url]);if(failLoad)throw Error('load failed');}
    show(){this.calls.push(['show']);}
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
  assert.equal(w.options.webPreferences.contextIsolation,true);
  assert.equal(w.options.webPreferences.nodeIntegration,false);
  assert.equal(w.options.webPreferences.sandbox,true);
  assert.match(w.options.webPreferences.preload,/settings-bridge\.js$/);
  assert.ok(w.calls.findIndex(c=>c[0]==='protect'&&c[1]===true)<w.calls.findIndex(c=>c[0]==='load'));
  assert.ok(w.calls.findIndex(c=>c[0]==='removeMenu')>=0);
  assert.ok(w.calls.findIndex(c=>c[0]==='removeMenu')<w.calls.findIndex(c=>c[0]==='load'));
  assert.equal(w.options.autoHideMenuBar,undefined);
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

test('audio permission step is compact and returning to settings restores full size',async()=>{
  const {api,windows}=setup();
  await api.openSettingsWindow(config,'interview',main);
  const w=windows[0];assert.equal(w.options.width,520);assert.equal(w.options.height,340);assert.equal(w.options.show,false);
  w.webContents.emit('did-navigate-in-page',{},'http://127.0.0.1:9958/settings#models/asr',true);
  assert.equal(w.getBounds().width,1120);assert.equal(w.getBounds().height,850);
  w.setBounds({x:-1500,y:50,width:900,height:700});
  w.webContents.emit('did-navigate-in-page',{},'http://127.0.0.1:9958/settings#interview',true);
  assert.equal(w.getBounds().width,520);assert.equal(w.getBounds().height,340);
  w.webContents.emit('did-navigate-in-page',{},'http://127.0.0.1:9958/settings#briefing',true);
  assert.equal(w.getBounds().width,900);assert.equal(w.getBounds().height,700);
});

test('subframe and external navigation cannot resize the protected window',async()=>{
  const {api,windows}=setup();await api.openSettingsWindow(config,'models',main);
  const w=windows[0],before=w.getBounds();
  w.webContents.emit('did-navigate-in-page',{},'http://127.0.0.1:9958/settings#interview',false);
  w.webContents.emit('did-navigate-in-page',{},'https://untrusted.test/settings#interview',true);
  assert.deepEqual(w.getBounds(),before);
});

test('failed page load closes the window rather than showing unprotected fallback content',async()=>{
  const {api,windows}=setup({failLoad:true});
  assert.equal(await api.openSettingsWindow(config,'models',main),false);
  assert.equal(windows[0].destroyed,true);
  assert.equal(api.getSettingsWindow(),null);
  assert.ok(!windows[0].calls.some(c=>c[0]==='show'));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const source = fs.readFileSync(new URL('../desktop/main/settings-window.js', import.meta.url), 'utf8');
function setup({failLoad=false}={}) {
  const windows=[];
  class Window extends EventEmitter {
    constructor(options) {
      super();this.options=options;this.calls=[];this.destroyed=false;this.bounds={x:options.x,y:options.y,width:options.width,height:options.height};
      this.webContents=new EventEmitter();
      this.webContents.setWindowOpenHandler=fn=>{this.openHandler=fn;};
      this.webContents.send=(...args)=>this.calls.push(['send',...args]);
      this.webContents.setZoomFactor=value=>this.calls.push(['zoom',value]);
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
  assert.deepEqual(windows[0].calls.find(c=>c[0]==='send'&&c[1]==='settings:navigate'),['send','settings:navigate','assets']);
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

test('legacy recording links open materials without a separate compact recording window',async()=>{
  const {api,windows}=setup();
  await api.openSettingsWindow(config,'interview',main);
  const w=windows[0];assert.equal(w.options.width,1120);assert.equal(w.options.height,850);assert.equal(w.options.show,false);
  assert.equal(w.calls.find(c=>c[0]==='load')[1],'http://127.0.0.1:9958/settings#briefing');
  w.setBounds({x:-1500,y:50,width:900,height:700});
  w.webContents.emit('did-navigate-in-page',{},'http://127.0.0.1:9958/settings#interview',true);
  assert.equal(w.getBounds().width,900);assert.equal(w.getBounds().height,700);
});

test('knowledge uses the same protected settings window and hidden requests never reveal it',async()=>{
  const {api,windows}=setup();
  await api.openSettingsWindow(config,'knowledge',main,()=>false);
  const w=windows[0];assert.equal(w.calls.find(c=>c[0]==='load')[1],'http://127.0.0.1:9958/settings#knowledge');
  assert.ok(!w.calls.some(c=>c[0]==='show'));
  await api.openSettingsWindow(config,'knowledge',main,()=>false);
  assert.equal(windows.length,1);assert.ok(!w.calls.some(c=>c[0]==='show'));
});

test('subframe and external navigation cannot resize the protected window',async()=>{
  const {api,windows}=setup();await api.openSettingsWindow(config,'models',main);
  const w=windows[0],before=w.getBounds();
  w.webContents.emit('did-navigate-in-page',{},'http://127.0.0.1:9958/settings#interview',false);
  w.webContents.emit('did-navigate-in-page',{},'https://untrusted.test/settings#interview',true);
  assert.deepEqual(w.getBounds(),before);
});

test('display settings use the latest shared appearance before showing and when reopening',async()=>{
  const {api,windows}=setup();
  let display={readingFontSize:20,zoomFactor:1.3,revision:4};
  await api.openSettingsWindow(config,'display',main,()=>true,()=>display);
  const w=windows[0];
  assert.ok(w.calls.find(c=>c[0]==='load')[1].endsWith('#display'));
  assert.ok(w.calls.findIndex(c=>c[0]==='zoom'&&c[1]===1.3)<w.calls.findIndex(c=>c[0]==='show'));
  assert.equal(w.calls.find(c=>c[0]==='send'&&c[1]==='cockpit:display')[2].readingFontSize,20);
  display={readingFontSize:24,zoomFactor:1.6,revision:5};
  w.webContents.emit('did-finish-load');
  assert.equal(w.calls.filter(c=>c[0]==='zoom').at(-1)[1],1.6);
  const shows=w.calls.filter(c=>c[0]==='show').length;
  await api.openSettingsWindow(config,'display',main,()=>false,()=>display);
  assert.equal(windows.length,1);
  assert.equal(w.calls.filter(c=>c[0]==='show').length,shows);
  assert.equal(w.calls.filter(c=>c[0]==='send'&&c[1]==='cockpit:display').at(-1)[2].readingFontSize,24);
});

function appearanceIpc() {
  const handlers=new Map(),events=[],writes=[];
  const state={readingFontSize:18,zoomFactor:1,revision:0,saved:true};
  const settings={isDestroyed:()=>false,webContents:{mainFrame:{},getURL:()=> 'http://127.0.0.1:9958/settings#display',setZoomFactor:value=>events.push(['zoom',value]),send:(...args)=>events.push(['send',...args])}};
  const modules={
    './config':{loadConfig:()=>({gatewayUrl:'http://127.0.0.1:9958'}),saveConfig:patch=>{writes.push(patch);return state.saved;}},
    './window':{getDisplayState:()=>({...state}),setReadingFontSize:(_win,value)=>{state.readingFontSize=value;state.revision++;},setZoom:(_win,value)=>{state.zoomFactor=value;state.revision++;}},
    './window-visibility':{createWindowVisibility:()=>({})},
    './settings-window':{getSettingsWindow:()=>settings},
    './interview-relay':{registerInterviewRelay(){}},
    './interview-socket':{registerInterviewSocket(){}},
    './knowledge-import':{registerKnowledgeImport(){}},
    './hotkeys':{BINDINGS:[]},
    './audio-capture':{audioCapabilities:()=>({})},
  };
  const electron={app:{userAgentFallback:'test',setName(){},requestSingleInstanceLock:()=>true,on(){},whenReady:()=>({then(){}}),getPath:()=>'/isolated'},ipcMain:{handle:(name,fn)=>handlers.set(name,fn),on(){}}};
  const sandbox=vm.createContext({URL,Buffer,process:{...process,platform:'darwin'},require:name=>name==='electron'?electron:modules[name]||(name.startsWith('./')?{}:require(name))});
  vm.runInContext(fs.readFileSync(new URL('../desktop/main/index.js',import.meta.url),'utf8'),sandbox);
  vm.runInContext('registerIpc()',sandbox);
  return {handlers,settings,state,events,writes,run:code=>vm.runInContext(code,sandbox),event:{sender:settings.webContents,senderFrame:settings.webContents.mainFrame}};
}

test('appearance IPC only accepts the trusted settings main frame and known fields',()=>{
  const f=appearanceIpc(),read=f.handlers.get('settings:getDisplay'),write=f.handlers.get('settings:setDisplay');
  assert.equal(read(f.event).readingFontSize,18);
  for(const event of [{},{sender:{},senderFrame:f.event.senderFrame},{sender:f.event.sender,senderFrame:{}}]){
    assert.throws(()=>read(event));assert.throws(()=>write(event,{zoomFactor:1.3}));
  }
  for(const url of ['https://outside.test/settings','http://127.0.0.1:9958/','http://127.0.0.1:9958/settings.evil']){
    f.settings.webContents.getURL=()=>url;assert.throws(()=>write(f.event,{zoomFactor:1.3}));
  }
  f.settings.webContents.getURL=()=> 'http://127.0.0.1:9958/settings.html#display';
  for(const patch of [null,[],{theme:'dark'},{readingFontSize:17},{readingFontSize:'20'},{zoomFactor:NaN},{zoomFactor:.6},{zoomFactor:1.7},{readingFontSize:22,zoomFactor:Infinity}])assert.throws(()=>write(f.event,patch));
  assert.equal(f.state.readingFontSize,18);assert.equal(f.state.zoomFactor,1);
  assert.equal(write(f.event,{readingFontSize:22,zoomFactor:1.4}).readingFontSize,22);
  assert.equal(f.state.zoomFactor,1.4);
});

test('appearance persistence broadcasts failure without revealing hidden settings windows',()=>{
  const f=appearanceIpc();f.state.saved=false;
  f.run('persistDisplay({readingFontSize:24,zoomFactor:1.6},{readingFontSize:24,zoomFactor:1.6,revision:8})');
  assert.equal(f.writes.length,1);
  assert.equal(f.events.find(([name])=>name==='zoom')[1],1.6);
  const message=f.events.find(([name,channel])=>name==='send'&&channel==='cockpit:display')[2];
  assert.equal(message.readingFontSize,24);assert.equal(message.saved,false);
  assert.ok(!f.events.some(([name])=>['show','focus'].includes(name)));
  assert.equal(f.run('config.readingFontSize'),24);
});

test('failed page load closes the window rather than showing unprotected fallback content',async()=>{
  const {api,windows}=setup({failLoad:true});
  assert.equal(await api.openSettingsWindow(config,'models',main),false);
  assert.equal(windows[0].destroyed,true);
  assert.equal(api.getSettingsWindow(),null);
  assert.ok(!windows[0].calls.some(c=>c[0]==='show'));
});

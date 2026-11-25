import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);

function windowModule(area = {x:0,y:24,width:1440,height:876}, platform = process.platform) {
  const sandbox = {module:{exports:{}}, __dirname:'/app/main', process:{...process,platform},
    require: name => name === 'electron' ? {app:{isPackaged:false},screen:{getDisplayMatching:()=>({workArea:area})}} : name === './capture-options' ? require('../desktop/main/capture-options.js') : name === './command-key' ? {
      getWindowsForegroundWindow:()=> '456',
      restoreWindowsForegroundWindow:(target,expected)=>events.push(['restoreForeground',target,expected]),
    } : require(name)};
  vm.runInNewContext(fs.readFileSync(new URL('../desktop/main/window.js', import.meta.url),'utf8'),sandbox);
  let bounds = {x:900,y:500,width:640,height:700};
  const events = [];
  const win = {isDestroyed:()=>false,getBounds:()=>bounds,
    getNativeWindowHandle:()=>Buffer.from([123,0,0,0,0,0,0,0]),
    setSize:(width,height)=>{bounds={...bounds,width,height};},
    setPosition:(x,y)=>{bounds={...bounds,x,y};},
    setBounds:value=>{bounds={...bounds,...value};},
    setOpacity:value=>events.push(['nativeOpacity',value]),
    setIgnoreMouseEvents:(ignore,options)=>events.push(['ignoreMouse',ignore,options]),
    setFocusable:focusable=>{events.push(['focusable',focusable]);if(platform==='win32')win.taskbarSkipped=!focusable;},
    setSkipTaskbar:skip=>{events.push(['skipTaskbar',skip]);win.taskbarSkipped=skip;},
    taskbarSkipped:true,
    isVisible:()=>true,
    isFocused:()=>true,
    showInactive:()=>events.push(['showInactive']),
    webContents:{send:(...args)=>events.push(args),setZoomFactor:value=>events.push(['zoom',value])}};
  return {api:sandbox.module.exports,win,events};
}

function createdWindow(config, onDisplay) {
  const area={x:0,y:0,width:1440,height:900};
  const display={id:1,bounds:area,workArea:area};
  const events=[];
  class Window extends EventEmitter {
    constructor(options){
      super();this.bounds={x:0,y:0,width:options.width,height:options.height};
      this.webContents=new EventEmitter();
      this.webContents.send=(...args)=>events.push(args);
      this.webContents.setZoomFactor=value=>events.push(['zoom',value]);
      this.webContents.setWindowOpenHandler=()=>{};
      this.webContents.getURL=()=> 'file:///app/index.html';
    }
    isDestroyed(){return false;} getBounds(){return {...this.bounds};}
    setSize(width,height){Object.assign(this.bounds,{width,height});}
    setPosition(x,y){Object.assign(this.bounds,{x,y});}
    setOpacity(){} setContentProtection(){} setAlwaysOnTop(){} setVisibleOnAllWorkspaces(){} setBackgroundColor(){} loadFile(){}
  }
  const sandbox={module:{exports:{}},__dirname:'/app/main',process:{...process,platform:'darwin'},setInterval:()=>1,clearInterval(){},clearTimeout(){},require:name=>name==='electron'?{app:{isPackaged:false},BrowserWindow:Window,screen:{getAllDisplays:()=>[display],getPrimaryDisplay:()=>display,getDisplayMatching:()=>display}}:name==='./capture-options'?require('../desktop/main/capture-options.js'):require(name)};
  vm.runInNewContext(fs.readFileSync(new URL('../desktop/main/window.js',import.meta.url),'utf8'),sandbox);
  const api=sandbox.module.exports,win=api.createWindow(config,{onDisplay});
  win.webContents.emit('did-finish-load');
  return {api,win,events};
}

test('reading size and interface scale notify separately and reset keeps the selected font',()=>{
  const {api,win,events}=windowModule();
  assert.equal(api.getDisplayState(win).readingFontSize,18);
  assert.equal(api.getDisplayState(win).zoomFactor,1);
  const revision=api.getDisplayState(win).revision;
  api.setReadingFontSize(win,24);
  api.setZoom(win,1.4);
  assert.equal(api.getDisplayState(win).readingFontSize,24);
  assert.equal(api.getDisplayState(win).zoomFactor,1.4);
  assert.ok(api.getDisplayState(win).revision>revision);
  assert.ok(events.some(([name,display])=>name==='cockpit:display'&&display.readingFontSize===24&&display.zoomFactor===1.4));
  api.resetZoom(win);
  assert.equal(api.getDisplayState(win).zoomFactor,1);
  assert.equal(api.getDisplayState(win).readingFontSize,24);
});

test('invalid font sizes and nonfinite scales never poison display state',()=>{
  const {api,win}=windowModule();
  for(const value of [undefined,null,NaN,Infinity,'20',15,19,26,{},[]])api.setReadingFontSize(win,value);
  assert.equal(api.getDisplayState(win).readingFontSize,18);
  for(const value of [undefined,null,NaN,Infinity,'1.2',{},[]])api.setZoom(win,value);
  assert.equal(api.getDisplayState(win).zoomFactor,1);
  api.setZoom(win,10);assert.equal(api.getDisplayState(win).zoomFactor,1.6);
  api.setZoom(win,-10);assert.equal(api.getDisplayState(win).zoomFactor,.7);
});

test('saved appearance restores after load and save failures remain visible in display state',()=>{
  let saved;
  const first=createdWindow({readingFontSize:20,zoomFactor:1.2},patch=>{saved={...patch};return true;});
  assert.equal(first.events.find(([name])=>name==='zoom')[1],1.2);
  first.api.setReadingFontSize(first.win,22);first.api.setZoom(first.win,1.4);
  const restarted=createdWindow(saved,()=>true);
  assert.equal(restarted.api.getDisplayState(restarted.win).readingFontSize,22);
  assert.equal(restarted.events.find(([name])=>name==='zoom')[1],1.4);
  const failed=createdWindow({readingFontSize:24},()=>false);
  assert.equal(failed.api.getDisplayState(failed.win).saved,false);
  assert.equal(failed.events.find(([name])=>name==='cockpit:display')[1].saved,false);
  const invalid=createdWindow({readingFontSize:9,zoomFactor:NaN},()=>true);
  assert.equal(invalid.api.getDisplayState(invalid.win).readingFontSize,18);
  assert.equal(invalid.api.getDisplayState(invalid.win).zoomFactor,1);
});

test('zoom grows compact chrome without scaling saved reading bounds repeatedly',()=>{
  const {api,win}=windowModule();
  api.setSurface(win,{answer:true});api.setLayout(win,'standard');
  const expanded=win.getBounds();
  api.toggleCompact(win);api.setZoom(win,1.6);
  assert.ok(win.getBounds().height>=76*1.6);
  api.toggleCompact(win);
  assert.equal(win.getBounds().width,expanded.width);assert.equal(win.getBounds().height,expanded.height);
  api.setZoom(win,1.4);api.setZoom(win,1.6);
  assert.equal(win.getBounds().height,expanded.height);
  const small=windowModule({x:0,y:0,width:640,height:480});
  small.api.setSurface(small.win,{answer:false});small.api.setZoom(small.win,1.6);
  assert.ok(small.win.getBounds().width<=640&&small.win.getBounds().height<=480);
});

test('compact restores the actual resized reading window and layouts stay within the screen',()=>{
  const {api,win} = windowModule();
  api.setSurface(win,{answer:true});
  win.setSize(640,700);
  win.setPosition(900,500);
  assert.equal(api.toggleCompact(win),true);
  assert.equal(win.getBounds().width,560);
  assert.equal(win.getBounds().height,76);
  assert.equal(api.toggleCompact(win),false);
  assert.deepEqual([win.getBounds().width,win.getBounds().height],[640,700]);
  api.setLayout(win,'wide');
  assert.deepEqual([win.getBounds().width,win.getBounds().height],[1000,680]);
  assert.equal(win.getBounds().x,440);
  assert.equal(win.getBounds().y,200);
  api.setLayout(win,'unrecognized');
  assert.equal(api.getDisplayState(win).layout,'wide');
  const small = windowModule({x:0,y:0,width:800,height:600});
  small.api.setSurface(small.win,{answer:true});
  small.api.setLayout(small.win,'wide');
  assert.deepEqual([small.win.getBounds().width,small.win.getBounds().height],[800,600]);
});

test('choosing a running display moves and fits the app onto that screen',()=>{
  const {api,win}=windowModule();
  api.moveToDisplay(win,{id:2,workArea:{x:-1280,y:0,width:1280,height:720}});
  const b=win.getBounds();
  assert.ok(b.x>=-1280 && b.x+b.width<=0);
  assert.ok(b.y>=0 && b.y+b.height<=720);
  api.moveToDisplay(win,{id:3,workArea:{x:1440,y:0,width:400,height:500}});
  assert.deepEqual([win.getBounds().x,win.getBounds().y,win.getBounds().width,win.getBounds().height],[1440,0,400,500]);
});

test('opacity changes the background state while native text remains fully opaque',()=>{
  const {api,win,events} = windowModule();
  api.setOpacity(win,.5);
  assert.equal(api.getDisplayState(win).opacity,.5);
  assert.ok(events.some(([event,value])=>event==='nativeOpacity'&&value===1));
  assert.ok(events.some(([event,value])=>event==='cockpit:display'&&value.opacity===.5));
  const revision=api.getDisplayState(win).revision;
  api.setOpacity(win,.37);
  assert.equal(api.getDisplayState(win).opacity,.37);
  assert.ok(api.getDisplayState(win).revision>revision);
  api.changeOpacity(win,-10);
  assert.equal(api.getDisplayState(win).opacity,0);
  api.setOpacity(win,NaN);
  assert.equal(api.getDisplayState(win).opacity,0);
});

test('idle surface grows for separate image previews and temporary settings then restores the reader',()=>{
  const {api,win}=windowModule();
  api.setSurface(win,{answer:false,shotCount:1});
  assert.deepEqual([win.getBounds().width,win.getBounds().height],[560,160]);
  api.setSurface(win,{settingsOpen:true});
  assert.equal(win.getBounds().height,650);
  api.setSurface(win,{settingsOpen:false});
  assert.equal(win.getBounds().height,160);
  api.setSurface(win,{answer:true});
  api.setLayout(win,'narrow');
  assert.deepEqual([win.getBounds().width,win.getBounds().height],[560,720]);
  api.setTheme(win,'transparent-white');
  assert.equal(api.getDisplayState(win).theme,'transparent-white');
  api.setSurface(win,{answer:false,shotCount:0});
  assert.equal(win.getBounds().height,76);
});

test('interview opens a separate wide surface and restores the narrow reader afterwards',()=>{
  const {api,win}=windowModule();
  // 面试是独立工作面：左右两栏，需要真正的横向空间。
  api.setSurface(win,{answer:false,interview:true,transcriptOpen:false});
  assert.deepEqual([win.getBounds().width,win.getBounds().height],[900,700]);
  assert.equal(api.getDisplayState(win).compact,false);
  api.changeZoom(win,.5);assert.equal(win.getBounds().height,700);
  api.resetZoom(win);assert.equal(win.getBounds().height,700);
  api.setSurface(win,{transcriptOpen:true});
  assert.equal(win.getBounds().height,700);
  api.setLayout(win,'wide');
  assert.equal(win.getBounds().width,900);
  api.toggleCompact(win);assert.equal(win.getBounds().height,76);
  api.toggleCompact(win);assert.equal(win.getBounds().height,700);
  api.setSurface(win,{answer:true});
  assert.equal(win.getBounds().width,900);
  api.setSurface(win,{answer:false,interview:false,transcriptOpen:false});
  assert.deepEqual([win.getBounds().width,win.getBounds().height],[560,76]);
  assert.deepEqual([win.getBounds().width,win.getBounds().height],[560,76]);
});

test('the overlay passes clicks through by default and only captures them while Command is held',()=>{
  const {api,win,events}=windowModule();
  const lastIgnore=()=>[...events].reverse().find(([event])=>event==='ignoreMouse')?.[1];

  api.showWindow(win);
  assert.equal(lastIgnore(),true);
  assert.equal(api.isInteractive(),false);

  api.setInteractive(win,true,{restore:false});
  assert.equal(lastIgnore(),false);
  assert.equal(api.isInteractive(),true);
  assert.ok(events.some(([event,value])=>event==='focusable'&&value===true));

  api.setInteractive(win,false,{restore:false});
  assert.equal(lastIgnore(),true);
  assert.equal(api.isInteractive(),false);
  assert.ok(events.some(([event,value])=>event==='focusable'&&value===false));
  assert.ok(events.some(([event,value])=>event==='cockpit:armed'&&value===false));
  const mouseEvents = events.filter(([event])=>event==='ignoreMouse');
  assert.equal(mouseEvents.length,3);
  assert.ok(mouseEvents.every(([, , options])=>options.forward===false));
});

test('text editing requires an armed, focused and visible window',()=>{
  const {api,win}=windowModule();
  assert.equal(api.setTextEditing(win,true),false);
  api.setInteractive(win,true,{restore:false});
  win.isFocused=()=>false;assert.equal(api.setTextEditing(win,true),false);
  win.isFocused=()=>true;win.isVisible=()=>false;assert.equal(api.setTextEditing(win,true),false);
  win.isVisible=()=>true;assert.equal(api.setTextEditing(win,'true'),false);
  assert.equal(api.setTextEditing(win,true),true);assert.equal(api.isTextEditing(),true);
});

test('a focused editor keeps only the keyboard after modifier release',()=>{
  const {api,win,events}=windowModule(undefined,'win32');
  const last=name=>events.filter(([event])=>event===name).at(-1)?.[1];
  api.setInteractive(win,true,{restore:false});assert.equal(api.setTextEditing(win,true),true);
  api.setInteractive(win,false);
  assert.equal(api.isInteractive(),false);assert.equal(api.isTextEditing(),true);
  assert.equal(last('ignoreMouse'),true);assert.equal(last('focusable'),true);assert.equal(last('cockpit:armed'),false);
  assert.ok(!events.some(([name])=>name==='restoreForeground'));
  api.setInteractive(win,false);assert.equal(last('focusable'),true);assert.equal(last('ignoreMouse'),true);
  api.setTextEditing(win,false);
  assert.equal(api.isTextEditing(),false);assert.equal(last('focusable'),false);assert.equal(last('ignoreMouse'),true);
  assert.equal(last('cockpit:textEditing'),false);
  assert.deepEqual(events.find(([name])=>name==='restoreForeground'),['restoreForeground','456','123']);
  events.forEach(([name],index)=>{if(name==='focusable')assert.deepEqual(events[index+1],['skipTaskbar',true]);});
});

test('ending an editor cannot reveal a hidden window or steal foreground on a lifecycle dismissal',()=>{
  const {api,win,events}=windowModule(undefined,'win32');
  api.setInteractive(win,true,{restore:false});api.setTextEditing(win,true);api.setInteractive(win,false);
  win.isVisible=()=>false;
  api.setTextEditing(win,false,{restore:false});
  assert.equal(api.isTextEditing(),false);assert.equal(api.isInteractive(),false);
  assert.ok(!events.some(([name])=>name==='showInactive'||name==='restoreForeground'));
});

test('modifier key release immediately disarms both written and interview workspaces',()=>{
  const events=[];
  class Window extends EventEmitter {
    constructor(options){super();this.visible=false;this.bounds={x:0,y:0,width:options.width,height:options.height};this.webContents=new EventEmitter();this.webContents.send=(...args)=>events.push(args);this.webContents.setWindowOpenHandler=()=>{};this.webContents.getURL=()=> 'file:///app/index.html';}
    isDestroyed(){return false;} isVisible(){return this.visible;} isFocused(){return true;}
    getBounds(){return this.bounds;} setSize(width,height){Object.assign(this.bounds,{width,height});} setPosition(x,y){Object.assign(this.bounds,{x,y});}
    setOpacity(){} setContentProtection(){} setAlwaysOnTop(){} setVisibleOnAllWorkspaces(){} setBackgroundColor(){} setSkipTaskbar(){} loadFile(){}
    setFocusable(value){events.push(['focusable',value]);} setIgnoreMouseEvents(value){events.push(['ignoreMouse',value]);} showInactive(){this.visible=true;events.push(['showInactive']);} hide(){this.visible=false;this.emit('hide');}
    getNativeWindowHandle(){return Buffer.from([123,0,0,0,0,0,0,0]);}
  }
  const display={id:1,bounds:{x:0,y:0,width:1440,height:900},workArea:{x:0,y:0,width:1440,height:900}};
  const electron={app:{isPackaged:false},BrowserWindow:Window,screen:{getAllDisplays:()=>[display],getPrimaryDisplay:()=>display,getDisplayMatching:()=>display}};
  const context={module:{exports:{}},__dirname:'/app/main',process:{...process,platform:'win32'},setInterval:()=>1,clearInterval(){},clearTimeout(){},require:name=>name==='electron'?electron:name==='./capture-options'?require('../desktop/main/capture-options.js'):name==='./command-key'?{getWindowsForegroundWindow:()=>'',restoreWindowsForegroundWindow(){}}:require(name)};
  vm.runInNewContext(fs.readFileSync(new URL('../desktop/main/window.js',import.meta.url),'utf8'),context);
  const api=context.module.exports,win=api.createWindow({});win.emit('ready-to-show');
  for(const interview of [false,true]){
    api.setSurface(win,{interview});
    for(const key of ['Meta','Control','Shift','Alt',' ','Space']){
      api.setInteractive(win,true,{restore:false});
      win.webContents.emit('before-input-event',{}, {type:'keyUp',key});
      assert.equal(api.isInteractive(),false,`${key} release in ${interview?'interview':'written'} mode`);
      assert.equal(events.filter(([name])=>name==='ignoreMouse').at(-1)[1],true);
      assert.equal(events.filter(([name])=>name==='focusable').at(-1)[1],false);
      assert.equal(events.filter(([name])=>name==='cockpit:armed').at(-1)[1],false);
    }
  }
  api.setSurface(win,{interview:false});api.setInteractive(win,true,{restore:false});
  win.webContents.emit('before-input-event',{}, {type:'keyDown',key:'Meta'});assert.equal(api.isInteractive(),true);
  for(const action of ['blur','hide','hideWindow','navigation','will-navigate','did-navigate','render-process-gone','leaveInterview','closed']){
    win.visible=true;api.setSurface(win,{interview:true});api.setInteractive(win,true,{restore:false});
    assert.equal(api.setTextEditing(win,true),true);
    win.webContents.emit('before-input-event',{}, {type:'keyUp',key:'Meta'});
    assert.equal(api.isInteractive(),false);assert.equal(api.isTextEditing(),true);
    assert.equal(events.filter(([name])=>name==='ignoreMouse').at(-1)[1],true);
    assert.equal(events.filter(([name])=>name==='focusable').at(-1)[1],true);
    const shows=events.filter(([name])=>name==='showInactive').length;
    if(action==='blur'||action==='hide')win.emit(action);
    else if(action==='hideWindow')api.hideWindow(win);
    else if(action==='navigation')win.webContents.emit('did-start-navigation',{},'file:///app/index.html',false,true);
    else if(action==='will-navigate')win.webContents.emit('will-navigate',{},'file:///app/index.html');
    else if(action==='leaveInterview')api.setSurface(win,{interview:false});
    else if(action==='closed'){win.isDestroyed=()=>true;win.emit('closed');}
    else win.webContents.emit(action);
    assert.equal(api.isTextEditing(),false,`${action} retained text editing`);
    assert.equal(api.isInteractive(),false);
    assert.equal(events.filter(([name])=>name==='showInactive').length,shows,`${action} revealed a window`);
    if(action!=='closed')assert.equal(events.filter(([name])=>name==='focusable').at(-1)[1],false);
  }
});

test('Windows Ctrl interaction restores foreground only after the overlay took focus',()=>{
  const {api,win,events}=windowModule(undefined,'win32');
  api.setInteractive(win,true);
  assert.equal(api.isInteractive(),true);
  assert.ok(!events.some(([event])=>event==='restoreForeground'));
  api.setInteractive(win,false);
  assert.deepEqual(events.find(([event])=>event==='restoreForeground'),['restoreForeground','456','123']);

  const passive=windowModule(undefined,'win32');
  passive.win.isFocused=()=>false;
  passive.api.setInteractive(passive.win,true);
  passive.api.setInteractive(passive.win,false);
  assert.ok(!passive.events.some(([event])=>event==='restoreForeground'));
});

test('Windows focusability changes immediately restore taskbar exclusion',()=>{
  const {api,win,events}=windowModule(undefined,'win32');
  const assertSkipped=()=>assert.equal(win.taskbarSkipped,true);
  api.showWindow(win);assertSkipped();
  for(const held of [true,true,false,false,true,false]) {
    api.setInteractive(win,held,{restore:false});assertSkipped();
  }
  events.forEach(([event],index)=>{
    if(event==='focusable')assert.deepEqual(events[index+1],['skipTaskbar',true]);
  });
  assert.ok(events.some(([event,value])=>event==='focusable'&&value));
  assert.ok(events.some(([event,value])=>event==='ignoreMouse'&&!value));
});

test('Mac focusability changes do not invoke the Windows taskbar workaround',()=>{
  const {api,win,events}=windowModule(undefined,'darwin');
  api.showWindow(win);
  api.setInteractive(win,true,{restore:false});
  api.setInteractive(win,false,{restore:false});
  assert.ok(!events.some(([event])=>event==='skipTaskbar'));
});

test('a repeated unarmed state still forces native and renderer interaction off',()=>{
  const {api,win,events}=windowModule(undefined,'win32');
  api.setInteractive(win,false);
  assert.ok(events.some(([event,ignore])=>event==='ignoreMouse'&&ignore===true));
  assert.ok(events.some(([event,focusable])=>event==='focusable'&&focusable===false));
  assert.ok(events.some(([event,armed])=>event==='cockpit:armed'&&armed===false));
});

test('preferences write outside app.asar and merge with existing gateway configuration',()=>{
  const records = new Map([['/app/config.json',JSON.stringify({gatewayUrl:'http://localhost:8001',gatewayApiKey:'existing',spawnBackend:false})]]);
  const sandbox = {module:{exports:{}},__dirname:'/app/main',process:{env:{}},require:name=>{
    if(name==='electron')return {app:{isPackaged:true,getPath:()=>'/profile'}};
    if(name==='node:fs')return {readFileSync:p=>{if(!records.has(p))throw Error('missing');return records.get(p);},mkdirSync:()=>{},writeFileSync:(p,s)=>records.set(p,s)};
    return require(name);
  }};
  vm.runInNewContext(fs.readFileSync(new URL('../desktop/main/config.js',import.meta.url),'utf8'),sandbox);
  const {loadConfig,saveConfig} = sandbox.module.exports;
  assert.equal(saveConfig({panelOpacity:.6,windowBounds:{x:1,y:2,width:560,height:740}}),true);
  const config = loadConfig();
  assert.equal(config.gatewayApiKey,'existing');
  assert.equal(config.panelOpacity,.6);
  assert.equal(config.windowBounds.width,560);
  assert.equal(records.size,2);
  assert.ok(records.has('/profile/config.json'));
});

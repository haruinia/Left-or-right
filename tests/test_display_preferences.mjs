import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
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

test('interview standby fits its controls without replacing the saved answer dimensions',()=>{
  const {api,win}=windowModule();
  api.setSurface(win,{answer:false,interview:true,transcriptOpen:false});
  assert.deepEqual([win.getBounds().width,win.getBounds().height],[560,150]);
  assert.equal(api.getDisplayState(win).compact,false);
  api.changeZoom(win,.5);assert.equal(win.getBounds().height,225);
  api.resetZoom(win);assert.equal(win.getBounds().height,150);
  api.setSurface(win,{transcriptOpen:true});
  assert.equal(win.getBounds().height,340);
  api.setLayout(win,'wide');
  assert.equal(win.getBounds().height,340);
  api.toggleCompact(win);assert.equal(win.getBounds().height,76);
  api.toggleCompact(win);assert.equal(win.getBounds().height,340);
  api.setSurface(win,{answer:true});
  assert.deepEqual([win.getBounds().width,win.getBounds().height],[1000,680]);
  api.setSurface(win,{answer:false,interview:false,transcriptOpen:false});
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

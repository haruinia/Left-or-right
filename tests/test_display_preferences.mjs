import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);

function windowModule(area = {x:0,y:24,width:1440,height:876}) {
  const sandbox = {module:{exports:{}}, __dirname:'/app/main', process,
    require: name => name === 'electron' ? {app:{isPackaged:false},screen:{getDisplayMatching:()=>({workArea:area})}} : require(name)};
  vm.runInNewContext(fs.readFileSync(new URL('../desktop/main/window.js', import.meta.url),'utf8'),sandbox);
  let bounds = {x:900,y:500,width:640,height:700};
  const events = [];
  const win = {isDestroyed:()=>false,getBounds:()=>bounds,
    setSize:(width,height)=>{bounds={...bounds,width,height};},
    setPosition:(x,y)=>{bounds={...bounds,x,y};},
    setOpacity:value=>events.push(['nativeOpacity',value]),
    webContents:{send:(...args)=>events.push(args)}};
  return {api:sandbox.module.exports,win,events};
}

test('compact restores the actual resized reading window and layouts stay within the screen',()=>{
  const {api,win} = windowModule();
  assert.equal(api.toggleCompact(win),true);
  assert.equal(win.getBounds().width,320);
  assert.equal(api.toggleCompact(win),false);
  assert.deepEqual([win.getBounds().width,win.getBounds().height],[640,700]);
  api.setLayout(win,'wide');
  assert.deepEqual([win.getBounds().width,win.getBounds().height],[1000,680]);
  assert.equal(win.getBounds().x,440);
  assert.equal(win.getBounds().y,200);
  api.setLayout(win,'unrecognized');
  assert.equal(api.getDisplayState(win).layout,'wide');
  const small = windowModule({x:0,y:0,width:800,height:600});
  small.api.setLayout(small.win,'wide');
  assert.deepEqual([small.win.getBounds().width,small.win.getBounds().height],[800,600]);
});

test('opacity changes the background state while native text remains fully opaque',()=>{
  const {api,win,events} = windowModule();
  api.setOpacity(win,.5);
  assert.equal(api.getDisplayState(win).opacity,.5);
  assert.ok(events.some(([event,value])=>event==='nativeOpacity'&&value===1));
  assert.ok(events.some(([event,value])=>event==='cockpit:display'&&value.opacity===.5));
  api.changeOpacity(win,-10);
  assert.equal(api.getDisplayState(win).opacity,.3);
  api.setOpacity(win,NaN);
  assert.equal(api.getDisplayState(win).opacity,.3);
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

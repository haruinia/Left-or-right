import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const configSource=fs.readFileSync(new URL('../desktop/main/config.js',import.meta.url),'utf8');
const indexSource=fs.readFileSync(new URL('../desktop/main/index.js',import.meta.url),'utf8');
function loadConfig(platform,preferences={}) {
  const paths=platform==='win32'?path.win32:path.posix;
  const userData=platform==='win32'?'C:\\profile':'/profile';
  const context={module:{exports:{}},__dirname:platform==='win32'?'C:\\app\\main':'/app/main',process:{platform,env:{}},require(name){
    if(name==='node:path')return paths;
    if(name==='electron')return {app:{getPath:()=>userData}};
    if(name==='node:fs')return {readFileSync:file=>JSON.stringify(file===paths.join(userData,'config.json')?preferences:{})};
    throw Error(name);
  }};
  vm.runInNewContext(configSource,context);
  return context.module.exports.loadConfig();
}

for(const platform of ['darwin','win32']) {
  test(`${platform} defaults to full-screen capture without changing a saved area preference`,()=>{
    assert.equal(loadConfig(platform).screenshotMode,'full');
    const saved=loadConfig(platform,{screenshotMode:'area',windowDisplayId:'second-screen',panelOpacity:.15});
    assert.equal(saved.screenshotMode,'area');
    assert.equal(saved.windowDisplayId,'second-screen');
    assert.equal(saved.panelOpacity,.15);
  });
}

test('the capture shortcut is full-screen when no screenshot preference exists',()=>{
  const captures=[];
  const sandbox={config:{},attachScreenshot:options=>captures.push(options)};
  const context=vm.createContext(sandbox);
  vm.runInContext(indexSource.slice(indexSource.indexOf('function hotkeyHandlers()'),indexSource.indexOf('async function refreshUiHotkeys()')),context);
  vm.runInContext('hotkeyHandlers().captureRegion()',context);
  assert.equal(captures[0].interactive,false);
  sandbox.config.screenshotMode='area';
  vm.runInContext('hotkeyHandlers().captureRegion()',context);
  assert.equal(captures[1].interactive,true);
  sandbox.config.screenshotMode='full';
  vm.runInContext('hotkeyHandlers().captureRegion()',context);
  assert.equal(captures[2].interactive,false);
});

test('capture options report the same full-screen default',()=>{
  const display={id:1,label:'Screen',bounds:{width:1440,height:900},scaleFactor:1};
  const sandbox={config:{},runningDisplay:()=>display,screen:{getAllDisplays:()=>[display]}};
  const context=vm.createContext(sandbox);
  vm.runInContext(indexSource.slice(indexSource.indexOf('function captureOptions()'),indexSource.indexOf('function registerIpc()')),context);
  assert.equal(vm.runInContext('captureOptions().mode',context),'full');
  sandbox.config.screenshotMode='area';
  assert.equal(vm.runInContext('captureOptions().mode',context),'area');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);

test('area selection uses selected display bounds and local Retina crop coordinates',async()=>{
  const handlers=new Map();let options;
  class Window {
    constructor(value){options=value;}
    setAlwaysOnTop(){} setVisibleOnAllWorkspaces(){} setContentProtection(){} loadFile(){}
    once(){} on(){} isDestroyed(){return false;} destroy(){}
  }
  const electron={BrowserWindow:Window,ipcMain:{on:(key,fn)=>handlers.set(key,fn)},globalShortcut:{unregister(){}},app:{isPackaged:false},screen:{getPrimaryDisplay:()=>({id:1,bounds:{x:0,y:0,width:1512,height:982},scaleFactor:1})}};
  const sandbox={module:{exports:{}},__dirname:'/app/main',process,setTimeout:()=>1,clearTimeout(){},require:name=>name==='electron'?electron:require(name)};
  vm.runInNewContext(fs.readFileSync(new URL('../desktop/main/selector.js',import.meta.url),'utf8'),sandbox);
  const target={id:2,bounds:{x:-1920,y:0,width:1920,height:1080},scaleFactor:2};
  const result=sandbox.module.exports.selectRegion(target);
  assert.equal(options.x,-1920);assert.equal(options.width,1920);
  assert.equal(options.show,false);
  assert.equal(options.neverShowInTaskbar,true);
  handlers.get('selector:commit')({}, {left:10,top:20,width:100,height:80});
  const rect=await result;
  assert.deepEqual([rect.x,rect.y,rect.width,rect.height],[20,40,200,160]);
});

for (const scaleFactor of [1.25, 1.5, 2]) {
  test(`area selector converts local CSS coordinates at ${scaleFactor * 100}% DPI`, async () => {
    const handlers = new Map();
    class Window {
      setAlwaysOnTop(){} setVisibleOnAllWorkspaces(){} setContentProtection(){} loadFile(){}
      once(){} on(){} isDestroyed(){return false;} destroy(){}
    }
    const display = { id: 42, bounds: { x: -1600, y: -900, width: 1600, height: 900 }, scaleFactor };
    const electron = { BrowserWindow: Window, ipcMain: { on: (key, fn) => handlers.set(key, fn) }, globalShortcut: { unregister(){} }, app: { isPackaged: false }, screen: { getPrimaryDisplay: () => display } };
    const sandbox = { module: { exports: {} }, __dirname: '/app/main', process, setTimeout: () => 1, clearTimeout(){}, require: name => name === 'electron' ? electron : require(name) };
    vm.runInNewContext(fs.readFileSync(new URL('../desktop/main/selector.js', import.meta.url), 'utf8'), sandbox);
    const pending = sandbox.module.exports.selectRegion(display);
    handlers.get('selector:commit')({}, { left: 10.4, top: 20.4, width: 100, height: 80 });
    const rect = await pending;
    assert.deepEqual([rect.x, rect.y, rect.width, rect.height], [
      Math.round(10.4 * scaleFactor), Math.round(20.4 * scaleFactor),
      Math.round(110.4 * scaleFactor) - Math.round(10.4 * scaleFactor),
      Math.round(100.4 * scaleFactor) - Math.round(20.4 * scaleFactor),
    ]);
  });
}

test('privacy hide cancels and closes an active selector',async()=>{
  let destroyed=false;
  class Window {
    setAlwaysOnTop(){} setVisibleOnAllWorkspaces(){} setContentProtection(){} loadFile(){}
    once(){} on(){} isDestroyed(){return destroyed;} destroy(){destroyed=true;}
  }
  const display={id:1,bounds:{x:0,y:0,width:1440,height:900},scaleFactor:1};
  const electron={BrowserWindow:Window,ipcMain:{on(){}},globalShortcut:{unregister(){}},app:{isPackaged:false},screen:{getPrimaryDisplay:()=>display}};
  const sandbox={module:{exports:{}},__dirname:'/app/main',process,setTimeout:()=>1,clearTimeout(){},require:name=>name==='electron'?electron:require(name)};
  vm.runInNewContext(fs.readFileSync(new URL('../desktop/main/selector.js',import.meta.url),'utf8'),sandbox);
  const pending=sandbox.module.exports.selectRegion(display);
  sandbox.module.exports.cancelSelection();
  assert.equal(await pending,null);assert.equal(destroyed,true);
});

test('capture requests the selected display before applying its crop',async()=>{
  const calls=[];
  const fakeFs={existsSync:()=>true,readFileSync:()=>Buffer.from('png'),unlinkSync(){},renameSync(){}};
  const sandbox={module:{exports:{}},Buffer,URLSearchParams,process:{platform:'darwin'},require:name=>{
    if(name==='node:fs')return fakeFs;
    if(name==='node:child_process')return {execFile:(command,args,cb)=>{calls.push([command,args]);cb(null,'','');}};
    return require(name);
  }};
  vm.runInNewContext(fs.readFileSync(new URL('../desktop/main/capture.js',import.meta.url),'utf8'),sandbox);
  await sandbox.module.exports.captureScreenshot({interactive:false,displayIndex:2,rect:{x:20,y:40,width:200,height:160}});
  const args=calls[0][1];assert.equal(args[args.indexOf('-D')+1],'2');
  assert.equal(calls[1][0],'/usr/bin/sips');
  assert.equal(calls[1][1][calls[1][1].indexOf('--cropOffset')+1],'40');
});

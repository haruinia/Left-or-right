import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

function displayModule(bridgeName = 'cockpit') {
  const elements = new Map();
  for (const id of ['#liuwaOpacity', '#liuwaOpacityValue', '#liuwaLayout', '#liuwaCompact', '#liuwaDisplayStatus', '#liuwaReadingFontSize', '#liuwaZoom', '#liuwaDisplayReset']) {
    elements.set(id, {value:'', textContent:'', addEventListener(type, fn) {this[type] = fn;}});
  }
  const requests = [];
  let receive, hydrate;
  const root = {style:{setProperty(key,value) {this[key]=value;}}, dataset:{}};
  const sandbox = {document:{querySelector:id=>elements.get(id),querySelectorAll:()=>[],documentElement:root,body:{classList:{toggle() {}}}},
    window:{[bridgeName]:{getDisplay:()=>new Promise(resolve=>hydrate=resolve),onDisplay:fn=>receive=fn,setDisplay:patch=>new Promise((resolve,reject)=>requests.push({patch,resolve,reject}))}}};
  vm.runInNewContext(fs.readFileSync(new URL('../web/modules/display.js',import.meta.url),'utf8').replace('export function applyDisplay','function applyDisplay'),sandbox);
  const slider = elements.get('#liuwaOpacity');
  return {slider,requests,elements,root,hydrate:display=>hydrate(display),receive:display=>receive(display),move:value=>{slider.value=String(value);return slider.input();},change:(selector,value)=>{const input=elements.get(selector);input.value=String(value);return input.change();}};
}

test('rapid opacity input stays at the latest value while earlier acknowledgements arrive',async()=>{
  const ui=displayModule();
  ui.receive({opacity:.9,revision:0});
  const first=ui.move(20);
  const last=ui.move(80);
  ui.receive({opacity:.2,revision:1});
  assert.equal(ui.slider.value,'80','earlier native event rolled the slider back during a drag');
  ui.requests[0].resolve({opacity:.2,revision:1,saved:true});await first;
  assert.equal(ui.slider.value,'80','earlier IPC reply rolled the slider back during a drag');
  ui.receive({opacity:.8,revision:2});
  ui.requests[1].resolve({opacity:.8,revision:2,saved:true});await last;
  ui.receive({opacity:.9,revision:0});
  assert.equal(ui.slider.value,'80','late settings hydration replaced the saved opacity');
  ui.receive({opacity:.7,revision:3});
  assert.equal(ui.slider.value,'70','a later keyboard opacity change must still update the slider');
});

test('out-of-order replies cannot undo a completed newer opacity change',async()=>{
  const ui=displayModule();
  const first=ui.move(20);const last=ui.move(83);
  ui.requests[1].resolve({opacity:.83,revision:2,saved:true});await last;
  ui.requests[0].resolve({opacity:.2,revision:1,saved:true});await first;
  assert.equal(ui.slider.value,'83');
});

test('a failed older change does not roll back the latest drag or a keyboard change',async()=>{
  const ui=displayModule();
  ui.receive({opacity:.9,revision:0});
  const first=ui.move(20);const last=ui.move(80);
  ui.requests[0].reject(Error('IPC unavailable'));await first;
  assert.equal(ui.slider.value,'80');
  ui.receive({opacity:.7,revision:3});
  ui.requests[1].reject(Error('IPC unavailable'));await last;
  assert.equal(ui.slider.value,'70');
});

test('full transparency shows zero while retaining the normal-mode opacity',()=>{
  const ui=displayModule();
  ui.receive({opacity:.37,theme:'transparent-white',revision:1});
  assert.equal(ui.slider.value,'0');assert.equal(ui.slider.disabled,true);
  ui.receive({theme:'light',revision:2});
  assert.equal(ui.slider.value,'37');assert.equal(ui.slider.disabled,false);
});

test('reading size and interface zoom are independent optimistic preferences',async()=>{
  const ui=displayModule();
  ui.receive({readingFontSize:18,zoomFactor:1,revision:0});
  const font=ui.change('#liuwaReadingFontSize',24);
  const zoom=ui.change('#liuwaZoom',1.3);
  assert.equal(ui.root.style['--reading-font-size'],'1.5rem');
  assert.equal(ui.root.style.zoom,undefined,'native zoom must not be applied a second time in CSS');
  ui.requests[1].resolve({readingFontSize:24,zoomFactor:1.3,revision:2,saved:true});await zoom;
  ui.requests[0].resolve({readingFontSize:24,zoomFactor:1,revision:1,saved:true});await font;
  assert.equal(ui.elements.get('#liuwaZoom').value,'1.3');
  assert.equal(ui.elements.get('#liuwaReadingFontSize').value,'24');
  ui.receive({readingFontSize:24,zoomFactor:1,revision:3});
  assert.equal(ui.elements.get('#liuwaZoom').value,'1');
  assert.equal(ui.elements.get('#liuwaReadingFontSize').value,'24');
});

test('settings appearance bridge hydrates without rolling back a newer event',async()=>{
  const ui=displayModule('appearanceBridge');
  ui.receive({readingFontSize:22,zoomFactor:1.2,revision:4});
  ui.hydrate({readingFontSize:18,zoomFactor:1,revision:1});
  await Promise.resolve();
  assert.equal(ui.elements.get('#liuwaReadingFontSize').value,'22');
  assert.equal(ui.elements.get('#liuwaZoom').value,'1.2');
  const request=ui.change('#liuwaReadingFontSize',20);
  assert.equal(ui.requests[0].patch.readingFontSize,20);
  ui.requests[0].resolve({readingFontSize:20,zoomFactor:1.2,revision:5,saved:true});await request;
  assert.equal(ui.root.style['--reading-font-size'],'1.25rem');
});

test('restore default only sends the two appearance fields',async()=>{
  const ui=displayModule();
  ui.receive({readingFontSize:24,zoomFactor:1.6,opacity:.37,theme:'dark',revision:1});
  const resetting=ui.elements.get('#liuwaDisplayReset').click();
  assert.equal(JSON.stringify(ui.requests[0].patch),JSON.stringify({readingFontSize:18,zoomFactor:1}));
  ui.requests[0].resolve({readingFontSize:18,zoomFactor:1,revision:2,saved:true});await resetting;
  assert.equal(ui.root.dataset.theme,'dark');
  assert.equal(ui.slider.value,'37');
});

test('appearance persistence failure is visible without discarding the applied value',async()=>{
  const ui=displayModule();
  const request=ui.change('#liuwaReadingFontSize',22);
  ui.requests[0].resolve({readingFontSize:22,revision:1,saved:false});await request;
  assert.equal(ui.elements.get('#liuwaReadingFontSize').value,'22');
  assert.match(ui.elements.get('#liuwaDisplayStatus').textContent,/保存失败/);
});

test('browser preview saves and restores appearance without a gateway write',async()=>{
  const elements=new Map(['#liuwaReadingFontSize','#liuwaZoom','#liuwaDisplayReset','#liuwaDisplayStatus'].map(id=>[id,{value:'',addEventListener(type,fn){this[type]=fn;}}]));
  const records=new Map();
  const root={style:{setProperty(key,value){this[key]=value;}},dataset:{}};
  const sandbox={document:{querySelector:id=>elements.get(id),querySelectorAll:()=>[],documentElement:root,body:{classList:{toggle(){}}}},window:{},localStorage:{getItem:key=>records.get(key),setItem:(key,value)=>records.set(key,value)}};
  const source=fs.readFileSync(new URL('../web/modules/display.js',import.meta.url),'utf8').replace('export function applyDisplay','function applyDisplay');
  vm.runInNewContext(source,sandbox);
  elements.get('#liuwaReadingFontSize').value='24';await elements.get('#liuwaReadingFontSize').change();
  elements.get('#liuwaZoom').value='1.4';await elements.get('#liuwaZoom').change();
  assert.equal(root.style['--reading-font-size'],'1.5rem');
  assert.equal(root.style.zoom,'1.4');
  vm.runInNewContext(source,{...sandbox,window:{}});
  assert.equal(elements.get('#liuwaReadingFontSize').value,'24');
  assert.equal(elements.get('#liuwaZoom').value,'1.4');
  await elements.get('#liuwaDisplayReset').click();
  assert.equal(root.style['--reading-font-size'],'1.125rem');
  assert.equal(root.style.zoom,'1');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

function displayModule() {
  const elements = new Map();
  for (const id of ['#liuwaOpacity', '#liuwaOpacityValue', '#liuwaLayout', '#liuwaCompact', '#liuwaDisplayStatus']) {
    elements.set(id, {value:'', textContent:'', addEventListener(type, fn) {this[type] = fn;}});
  }
  const requests = [];
  let receive;
  const root = {style:{setProperty() {}}, dataset:{}};
  const sandbox = {document:{querySelector:id=>elements.get(id),querySelectorAll:()=>[],documentElement:root,body:{classList:{toggle() {}}}},
    window:{cockpit:{onDisplay:fn=>receive=fn,setDisplay:patch=>new Promise((resolve,reject)=>requests.push({patch,resolve,reject}))}}};
  vm.runInNewContext(fs.readFileSync(new URL('../web/modules/display.js',import.meta.url),'utf8').replace('export function applyDisplay','function applyDisplay'),sandbox);
  const slider = elements.get('#liuwaOpacity');
  return {slider,requests,receive:display=>receive(display),move:value=>{slider.value=String(value);return slider.input();}};
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

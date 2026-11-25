import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createWindowVisibility}=require('../desktop/main/window-visibility.js');
function setup(){
  const window=visible=>{
    const record={visible,destroyed:false,hiddenSignals:0,isDestroyed(){return this.destroyed;},isVisible(){return this.visible;},hide(){this.visible=false;},showInactive(){this.visible=true;}};
    record.webContents={send:channel=>{assert.equal(channel,'app:privacy-hidden');record.hiddenSignals+=1;}};
    return record;
  };
  const main=window(true),settings=window(true),armed=[],windows=[main,settings];
  const api=createWindowVisibility({getMainWindow:()=>main,getWindows:()=>windows,setInteractive:value=>armed.push(value)});
  return {main,settings,armed,api,windows,window};
}

test('refreshing interaction never arms a visible workspace without a held modifier',()=>{
  const {api,armed}=setup();
  api.refreshInteraction();assert.equal(armed.at(-1),false);
  api.refreshInteraction();assert.equal(armed.at(-1),false);
  api.modifierChanged(true);api.refreshInteraction();assert.equal(armed.at(-1),true);
  api.modifierChanged(false);api.refreshInteraction();assert.equal(armed.at(-1),false);
});

for(const heldAtEnd of [false,true])test(`capture restores interaction only when the modifier is ${heldAtEnd?'held':'released'}`,()=>{
  const {api,armed,main,settings}=setup();api.modifierChanged(true);
  const snapshot=api.beginCapture();
  assert.equal(armed.at(-1),false);assert.ok(!main.visible&&!settings.visible);
  for(const held of [true,false,heldAtEnd]){api.modifierChanged(held);api.refreshInteraction();assert.equal(armed.at(-1),false);assert.equal(main.visible,false);}
  api.showMain();assert.equal(main.visible,false);assert.equal(armed.at(-1),false);
  api.endCapture(snapshot);assert.ok(main.visible&&settings.visible);assert.equal(armed.at(-1),heldAtEnd);
});

test('interaction refresh and second-instance reveal cannot bypass hide-all',()=>{
  const {api,armed,main,settings}=setup();api.modifierChanged(true);api.hideAll();
  api.refreshInteraction();api.modifierChanged(false);api.modifierChanged(true);api.showMain();
  assert.equal(armed.at(-1),false);assert.ok(!main.visible&&!settings.visible);
  api.modifierChanged(false);api.toggle();
  assert.ok(main.visible&&settings.visible);assert.equal(armed.at(-1),false);
  api.modifierChanged(true);assert.equal(armed.at(-1),true);
});

test('explicit hide during capture prevents restoration and never arms the resumed workspace',()=>{
  const {api,armed,main,settings}=setup();api.modifierChanged(true);
  const snapshot=api.beginCapture();api.hideAll();api.endCapture(snapshot);api.refreshInteraction();api.showMain();
  assert.equal(armed.at(-1),false);assert.ok(!main.visible&&!settings.visible);
  api.modifierChanged(false);api.toggle();assert.ok(main.visible&&settings.visible);assert.equal(armed.at(-1),false);
});

test('second-instance reveal does not enable clicking without the modifier',()=>{
  const {api,armed,main}=setup();main.visible=false;
  api.showMain();assert.equal(main.visible,true);assert.equal(armed.at(-1),false);
  api.modifierChanged(true);assert.equal(armed.at(-1),true);
  api.modifierChanged(false);assert.equal(armed.at(-1),false);
});

test('one visibility action hides both app windows, and restores only previously visible ones',()=>{
  const {main,settings,api}=setup();api.toggle();assert.equal(main.visible,false);assert.equal(settings.visible,false);
  api.toggle();assert.equal(main.visible,true);assert.equal(settings.visible,true);
  settings.visible=false;api.toggle();api.toggle();assert.equal(main.visible,true);assert.equal(settings.visible,false);
});

test('hiding and capture explicitly dismiss private popups in every owned window',()=>{
  const {main,settings,api}=setup();api.hideAll();assert.equal(main.hiddenSignals,1);assert.equal(settings.hiddenSignals,1);
  api.toggle();api.beginCapture();assert.equal(main.hiddenSignals,2);assert.equal(settings.hiddenSignals,2);
});

test('auxiliary app windows are included automatically rather than relying on a fixed two-window list',()=>{
  const {main,settings,api,windows,window}=setup();const auxiliary=window(true);windows.push(auxiliary);
  api.hideAll();assert.ok(windows.every(w=>!w.visible));assert.equal(auxiliary.hiddenSignals,1);
  api.toggle();assert.ok(main.visible&&settings.visible&&auxiliary.visible);
});

test('holding the modifier never reveals a privacy-hidden app',()=>{
  const {main,settings,armed,api}=setup();api.hideAll();api.modifierChanged(true);
  assert.equal(main.visible,false);assert.equal(settings.visible,false);assert.equal(armed.at(-1),false);
  api.toggle();assert.equal(main.visible,true);assert.equal(armed.at(-1),true);
  api.modifierChanged(false);assert.equal(armed.at(-1),false);
});

test('capture suspends interaction and hides settings as well as the overlay',()=>{
  const {main,settings,armed,api}=setup();api.modifierChanged(true);const snapshot=api.beginCapture();
  assert.equal(main.visible,false);assert.equal(settings.visible,false);assert.equal(armed.at(-1),false);
  api.modifierChanged(true);assert.equal(main.visible,false);assert.equal(armed.at(-1),false);
  api.modifierChanged(false);api.endCapture(snapshot);
  assert.equal(main.visible,true);assert.equal(settings.visible,true);assert.equal(armed.at(-1),false);
});

test('explicit hide during a capture prevents automatic window restoration',()=>{
  const {main,settings,api}=setup();const snapshot=api.beginCapture();api.toggle();api.endCapture(snapshot);
  assert.equal(main.visible,false);assert.equal(settings.visible,false);
  api.toggle();assert.equal(main.visible,true);assert.equal(settings.visible,true);
});

test('old settings-show requests are invalidated by privacy hide and capture',()=>{
  const {api}=setup();const version=api.version();assert.equal(api.canShow(version),true);
  const snapshot=api.beginCapture();assert.equal(api.canShow(version),false);api.endCapture(snapshot);assert.equal(api.canShow(version),true);
  api.hideAll();assert.equal(api.canShow(version),false);
});

test('capture tokens expire on explicit hide and remain invalid after capture finishes',()=>{
  const {api}=setup();const snapshot=api.beginCapture();assert.equal(api.canCapture(snapshot),true);
  api.hideAll();assert.equal(api.canCapture(snapshot),false);api.endCapture(snapshot);
  assert.equal(api.canCapture(snapshot),false);
});

test('second-instance reveal never overrides privacy hide or capture',()=>{
  const {main,settings,api}=setup();api.hideAll();api.showMain();assert.equal(main.visible,false);assert.equal(settings.visible,false);
  api.toggle();const snapshot=api.beginCapture();api.showMain();assert.equal(main.visible,false);
  api.endCapture(snapshot);api.showMain();assert.equal(main.visible,true);
});

test('hiding before the main window is ready invalidates its pending show request',()=>{
  const {main,settings,api}=setup();main.visible=false;settings.visible=false;
  const version=api.version();api.toggle();assert.equal(api.canShow(version),false);assert.equal(main.visible,false);
  api.showMain();assert.equal(main.visible,false);api.toggle();assert.equal(main.visible,true);
});

test('new delayed show requests cannot reopen an already privacy-hidden app',()=>{
  const {api}=setup();api.hideAll();assert.equal(api.canShow(api.version()),false);
});

test('a settings window closed while hidden is not recreated by the visibility shortcut',()=>{
  const {main,settings,api}=setup();api.hideAll();settings.destroyed=true;api.toggle();assert.equal(main.visible,true);assert.equal(settings.visible,false);
});

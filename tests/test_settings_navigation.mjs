import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { settingsRoute } from '../web/modules/settings-navigation.js';

test('model and speech routes share one section while retaining distinct list and editor states',()=>{
  assert.deepEqual(settingsRoute('#asr'),{section:'models',tab:'asr',kind:'list',hash:'#models/asr'});
  assert.equal(settingsRoute('#models').kind,'list');
  assert.equal(settingsRoute('#models/import').kind,'import');
  assert.equal(settingsRoute('#models/llm/new').kind,'editor');
  assert.equal(settingsRoute('#models/asr/speech').id,'speech');
  assert.equal(settingsRoute('#assets/kb').section,'assets');
  assert.equal(settingsRoute('#models/llm/bad%').kind,'list');
});

test('direct editor return replaces its route instead of navigating outside the app history',()=>{
  const calls=[];
  const context=vm.createContext({location:{hash:'#models/llm/saved'},history:{state:null,replaceState(state,_title,hash){calls.push(['replace',hash]);this.state=state;if(hash)context.location.hash=hash;},pushState(){throw Error('Unexpected push');},back(){throw Error('Unexpected external history back');}},window:{scrollY:0,dispatchEvent(){}},Event:class{}});
  const source=fs.readFileSync(new URL('../web/modules/settings-navigation.js',import.meta.url),'utf8').replaceAll('export function','function');
  vm.runInContext(source,context);context.returnToConnections('llm');
  assert.equal(context.location.hash,'#models');
  assert.equal(calls.at(-1)[0],'replace');
});

test('editor return uses its in-app list history when an explicit parent is known',()=>{
  let backed=false;
  const context=vm.createContext({history:{state:{settingsParent:'#models/asr'},back(){backed=true;}},location:{hash:'#models/asr/profile'}});
  const source=fs.readFileSync(new URL('../web/modules/settings-navigation.js',import.meta.url),'utf8').replaceAll('export function','function');
  vm.runInContext(source,context);context.returnToConnections('asr');
  assert.equal(backed,true);
});

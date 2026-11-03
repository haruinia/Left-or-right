import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../web/modules/home.js', import.meta.url), 'utf8');
const refresh = source.slice(source.indexOf('let refreshingContext = false;'), source.indexOf('\n// ⌘L', source.indexOf('let refreshingContext = false;')));
function setup(config) {
  const statuses=[];
  const sandbox={
    currentModel:'previous-model',state:{apiOrigin:'http://localhost'},window:{},
    ensureGateway:async()=>{},authHeaders:()=>({}),AbortSignal,
    fetch:async()=>({ok:true,json:async()=>config}),
    setStatus:text=>statuses.push(text),applyHotkeyHints(){},
  };
  const context=vm.createContext(sandbox);
  vm.runInContext(refresh,context);
  return {sandbox,statuses,run:()=>vm.runInContext('refreshContext()',context)};
}

test('a selected live model updates silently without a demo banner',async()=>{
  const {sandbox,statuses,run}=setup({llm_provider:'openai_compatible',llm_model:'selected-model',llm_api_key_configured:true,llm_base_url_configured:true});
  await run();assert.equal(sandbox.currentModel,'selected-model');assert.deepEqual(statuses,[]);
});

test('a live local endpoint without authentication is not classified as a demo model',async()=>{
  const {sandbox,statuses,run}=setup({llm_provider:'openai_compatible',llm_model:'local-model',llm_api_key_configured:false,llm_base_url_configured:true});
  await run();assert.equal(sandbox.currentModel,'local-model');assert.deepEqual(statuses,[]);
});

test('mock configuration does not add an automatic mode banner to the home screen',async()=>{
  const {sandbox,statuses,run}=setup({llm_provider:'mock',llm_model:'example-model'});
  await run();assert.equal(sandbox.currentModel,'');assert.deepEqual(statuses,[]);
});

test('a subsequent status refresh uses the newly selected model',async()=>{
  const config={llm_provider:'openai_compatible',llm_model:'first-model'};
  const {sandbox,statuses,run}=setup(config);
  await run();config.llm_model='second-model';await run();
  assert.equal(sandbox.currentModel,'second-model');assert.deepEqual(statuses,[]);
});

test('the home source no longer contains the automatic demo-mode message',()=>{
  assert.ok(!source.includes('演示模式：'));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../web/modules/interview-transcription.js',import.meta.url),'utf8');
const context=vm.createContext({});
vm.runInContext(source.slice(source.indexOf('export function interviewAudioSetup'),source.indexOf('\nfunction publish')).replace('export function','function'),context);
const setup=(profiles,preferences)=>JSON.parse(JSON.stringify(context.interviewAudioSetup(profiles,preferences)));
const profiles={active_profile_id:'chosen',profiles:[{id:'other',api_key_configured:true},{id:'chosen',api_key_configured:true}]};

test('audio uses only the active speech profile and the existing saved identity',()=>{
  assert.deepEqual(setup(profiles,{assistant_role:'candidate'}),{role:'candidate',configured:true});
  assert.deepEqual(setup(profiles,{assistant_role:'interviewer'}),{role:'interviewer',configured:true});
  assert.equal(profiles.profiles.length,2);
});

test('NLS uses its complete credential configuration rather than a DashScope key flag',()=>{
  const nls={active_profile_id:'nls',profiles:[{id:'nls',provider:'aliyun_nls_ws',api_key_configured:false,configured:true}]};
  assert.deepEqual(setup(nls,{assistant_role:'candidate'}),{role:'candidate',configured:true});
  nls.profiles[0].configured=false;
  assert.equal(setup(nls,{assistant_role:'candidate'}).configured,false);
});

test('no profile is silently activated and an unconfigured active entry is not usable',()=>{
  assert.equal(setup({...profiles,active_profile_id:''},{}).configured,false);
  assert.equal(setup({...profiles,active_profile_id:'missing'},{}).configured,false);
  assert.equal(setup({active_profile_id:'chosen',profiles:[{id:'chosen',api_key_configured:false}]},{}).configured,false);
});

test('unknown identity resolves to the same candidate default without adding another preference',()=>{
  assert.deepEqual(setup({profiles:[]},{assistant_role:'other'}),{role:'candidate',configured:false});
});

test('recording starts only from the visible action with fixed independent sources',()=>{
  assert.match(source,/sources: \['mic', 'system'\], role: runRole, deviceId: 'default'/);
  assert.doesNotMatch(source,/getElementById\(['"]interviewRole|#interviewRole|#interviewProfile|#interviewMicDevice|#interviewMicEnabled|#interviewSystemEnabled/);
  const startCalls=[...source.matchAll(/controller\.start\(/g)];
  assert.equal(startCalls.length,1);
  assert.match(source,/\$\('#interviewStart'\)\.addEventListener\('click', start\)/);
});

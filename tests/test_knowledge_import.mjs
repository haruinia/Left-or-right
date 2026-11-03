import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../web/modules/knowledge-base.js',import.meta.url),'utf8');
const context=vm.createContext({});
vm.runInContext(source.slice(source.indexOf('export function extractKnowledgeFromSession'),source.indexOf('// 批量导入会话记录')).replace('export function','function'),context);
const extract=record=>context.extractKnowledgeFromSession(record);
const record={id:'source-session',turns:[{role:'user',text:'如何避免缓存击穿？'},{role:'assistant',text:'缓存击穿可以通过互斥重建或逻辑过期来处理，需要结合业务一致性要求选择方案。'}]};

test('imported knowledge retains source and explicitly marks generated answers',()=>{
  const items=extract(record);
  assert.equal(items.length,1);
  assert.equal(items[0].sourceSessionId,record.id);
  assert.equal(items[0].answerOrigin,'model');
  assert.equal(items[0].question,record.turns[0].text);
});

test('interrupted answers and incomplete records are not imported',()=>{
  assert.equal(extract({...record,partial:true}).length,0);
  assert.equal(extract({...record,turns:[record.turns[0],{...record.turns[1],partial:true}]}).length,0);
  assert.equal(extract({...record,turns:[{...record.turns[0],partial:true},record.turns[1]]}).length,0);
  assert.equal(extract({...record,turns:[record.turns[0]]}).length,0);
});

test('a later complete question remains importable after an interrupted one',()=>{
  const items=extract({...record,turns:[record.turns[0],{...record.turns[1],partial:true},record.turns[0],record.turns[1]]});
  assert.equal(items.length,1);
  assert.equal(items[0].id,'kb_source-session_2');
});

test('speaker transcripts alone never become invented knowledge answers',()=>{
  assert.equal(extract({...record,kind:'transcription',turns:record.turns.map(turn=>({...turn,role:'user'}))}).length,0);
});

const settingsSource=fs.readFileSync(new URL('../web/modules/settings.js',import.meta.url),'utf8');
test('knowledge preference is a boolean field rather than a text control',()=>{
  const form={'#studySpecialtyCustom':{},'#studyLanguageCustom':{},'#jdText':{value:'job'},'#resumeText':{value:'resume'},'#interviewUseKnowledge':{checked:false}};
  const c=vm.createContext({studyFields:{study_specialty:{value:'后端'},study_language:{value:'Go'}},$:id=>form[id],readStudyChoice:select=>select.value,readHotkeys:()=>({})});
  vm.runInContext(settingsSource.slice(settingsSource.indexOf('function readSettings()'),settingsSource.indexOf('function changedSettings()')),c);
  assert.equal(c.readSettings().interview_use_knowledge,false);
  form['#interviewUseKnowledge'].checked=true;
  assert.equal(c.readSettings().interview_use_knowledge,true);
});

test('knowledge checkbox saves only its own changed preference',async()=>{
  let payload;
  const c=vm.createContext({savedSettings:{interview_use_knowledge:false,study_language:'Go',hotkeys:{}},saving:false,window:{dispatchEvent(){}},Event:class{},saveState:{},readSettings:()=>({interview_use_knowledge:true,study_language:'Go',hotkeys:{}}),validateHotkeys:()=>true,$:()=>({}),postJson:async(_url,body)=>{payload=body;return body;}});
  vm.runInContext(settingsSource.slice(settingsSource.indexOf('function changedSettings()'),settingsSource.indexOf('function validateHotkeys()'))+settingsSource.slice(settingsSource.indexOf('async function saveSettings('),settingsSource.indexOf('\nhotkeyInputs().forEach')),c);
  await c.saveSettings({preventDefault(){}});
  assert.deepEqual(JSON.parse(JSON.stringify(payload)),{interview_use_knowledge:true});
});

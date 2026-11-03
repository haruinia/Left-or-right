import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {registerInterviewRelay}=require('../desktop/main/interview-relay');
function fixture(){
  const listeners=new Map(),handlers=new Map();
  const window=url=>{
    const win=new EventEmitter();win.visible=true;win.destroyed=false;win.sent=[];
    win.isDestroyed=()=>win.destroyed;win.isVisible=()=>win.visible;win.hide=()=>{win.visible=false;};
    win.webContents=new EventEmitter();win.webContents.mainFrame={};win.webContents.getURL=()=>url;
    win.webContents.send=(...args)=>win.sent.push(args);return win;
  };
  const main=window('file:///app/index.html'),settings=window('http://127.0.0.1:9958/settings#interview');
  let revision=0,hidden=false;
  const ipcMain={on:(name,fn)=>listeners.set(name,fn),handle:(name,fn)=>handlers.set(name,fn)};
  registerInterviewRelay({ipcMain,getMainWindow:()=>main,getSettingsWindow:()=>settings,gatewayUrl:'http://127.0.0.1:9958',visibility:{version:()=>revision,canShow:value=>!hidden&&value===revision}});
  const event=win=>({sender:win.webContents,senderFrame:win.webContents.mainFrame});
  const send=data=>listeners.get('interview:publish')(event(settings),{run_id:'run-1',...data});
  const read=()=>handlers.get('interview:getState')(event(main));
  const command=data=>handlers.get('interview:command')(event(main),{run_id:'run-1',...data});
  const start=(role='candidate')=>{send({type:'state',state:'acquiring',role,sources:['mic','system']});send({type:'ready',session_id:'session-1',role,sources:['mic','system']});};
  return {main,settings,listeners,handlers,event,send,read,command,start,hide(){hidden=true;revision++;main.visible=false;settings.visible=false;},restore(){hidden=false;main.visible=true;settings.visible=true;}};
}
const segment=(source,ms=0,final=true)=>({type:'transcript',source,speaker:'unknown',text:'测试转写',start_ms:ms,end_ms:ms+100,is_final:final,segment_id:`${source}:${ms}`});

test('only the owned main frame can publish or read private transcripts',()=>{
  const f=fixture();
  f.listeners.get('interview:publish')(f.event(f.main),{run_id:'bad',type:'state',state:'acquiring',role:'candidate',sources:['mic']});
  f.listeners.get('interview:publish')({sender:f.settings.webContents,senderFrame:{}},{run_id:'bad',type:'state',state:'acquiring',role:'candidate',sources:['mic']});
  assert.equal(f.read().run_id,'');
  assert.equal(f.handlers.get('interview:getState')(f.event(f.settings)),null);
  f.start();f.send(segment('mic'));
  assert.equal(f.read().transcripts.length,1);
});

for(const role of ['candidate','interviewer'])test(`relay assigns physical sources using ${role} session identity`,()=>{
  const f=fixture();f.start(role);f.send(segment('mic'));f.send(segment('system'));
  assert.equal(f.read().transcripts[0].speaker,role);
  assert.equal(f.read().transcripts[1].speaker,role==='candidate'?'interviewer':'candidate');
});

test('partials replace independently and finals deduplicate without deleting the other source',()=>{
  const f=fixture();f.start();f.send(segment('mic',0,false));f.send(segment('system',0,false));
  assert.ok(f.read().partials.mic&&f.read().partials.system);
  f.send(segment('mic'));f.send(segment('mic'));
  assert.equal(f.read().transcripts.length,1);assert.equal(f.read().partials.mic,null);assert.ok(f.read().partials.system);
  f.send(segment('mic',0,false));assert.equal(f.read().partials.mic,null);
});

test('different source recognition latency does not reverse the displayed conversation',()=>{
  const f=fixture();f.start();
  f.send(segment('system',2000));f.send(segment('mic',0));f.send(segment('system',1000));
  assert.deepEqual(f.read().transcripts.map(item=>[item.source,item.start_ms]),[['mic',0],['system',1000],['system',2000]]);
  f.send({...segment('mic',0),text:'修正后的最终句子'});
  assert.equal(f.read().transcripts[0].text,'修正后的最终句子');
});

test('audio, keys and arbitrary fields never enter the relay snapshot',()=>{
  const f=fixture();f.start();f.send({...segment('mic'),audio:'private-audio',api_key:'private-key',record:{password:'private-record'}});
  const result=JSON.stringify(f.read());assert.ok(!result.includes('private-'));
  const changed=f.read();changed.transcripts[0].text='altered';assert.equal(f.read().transcripts[0].text,'测试转写');
});

test('history remains bounded and long visible text is marked truncated',()=>{
  const f=fixture();f.start();for(let index=0;index<100;index++)f.send({...segment('mic',index),text:'x'.repeat(1000)});
  assert.ok(f.read().transcripts.length<=80);assert.ok(f.read().transcripts.reduce((n,item)=>n+item.text.length,0)<=32000);
  f.send({...segment('system',200),text:'x'.repeat(10000)});const last=f.read().transcripts.at(-1);
  assert.equal(last.text.length,8000);assert.ok(last.text.endsWith('…'));
});

test('successful recording hides setup only, never shows a privacy-hidden window',()=>{
  const f=fixture();f.start();f.send({type:'state',state:'recording'});
  assert.equal(f.settings.visible,false);assert.equal(f.main.visible,true);assert.ok(f.settings.sent.some(([channel])=>channel==='app:privacy-hidden'));
  const hidden=fixture();hidden.start();hidden.hide();hidden.send({type:'state',state:'recording'});hidden.send(segment('system'));
  assert.equal(hidden.main.visible,false);assert.equal(hidden.settings.visible,false);
});

test('hide and restore invalidate pending automatic setup dismissal',()=>{
  const f=fixture();f.start();f.hide();f.restore();f.send({type:'state',state:'recording'});
  assert.equal(f.settings.visible,true);
});

test('main controls can stop or mute only the active run and cannot start recording',()=>{
  const f=fixture();f.start();f.send({type:'state',state:'recording'});
  assert.equal(f.command({action:'start'}),false);
  assert.equal(f.command({action:'mute',source:'other',muted:true}),false);
  assert.equal(f.command({run_id:'old',action:'stop'}),false);
  assert.equal(f.command({action:'mute',source:'mic',muted:true,api_key:'ignored'}),true);
  assert.deepEqual(f.settings.sent.at(-1),['interview:command',{run_id:'run-1',action:'mute',source:'mic',muted:true}]);
  assert.equal(f.handlers.get('interview:command')(f.event(f.settings),{run_id:'run-1',action:'stop'}),false);
  f.send({type:'stopped',saved:true});assert.equal(f.command({action:'stop'}),false);
});

test('closing or navigating setup retires the producer and drops late events',()=>{
  for(const action of [f=>{f.settings.destroyed=true;f.settings.emit('closed');},f=>f.settings.webContents.emit('did-navigate')]){
    const f=fixture();f.start();f.send(segment('system'));action(f);
    assert.equal(f.read().phase,'idle');const revision=f.read().revision;
    f.send({type:'state',state:'recording'});f.send(segment('mic'));
    assert.equal(f.read().revision,revision);assert.equal(f.read().transcripts.length,1);
    f.send({run_id:'run-2',type:'state',state:'acquiring',role:'candidate',sources:['mic']});
    assert.equal(f.read().run_id,f.settings.destroyed?'run-1':'run-2');
    assert.equal(f.read().transcripts.length,f.settings.destroyed?1:0);
  }
});

test('invalid phase, sources and timestamps cannot corrupt cached state',()=>{
  const f=fixture();f.send({type:'state',state:'acquiring',role:'candidate',sources:['mic','mic']});assert.equal(f.read().run_id,'');
  f.start();const revision=f.read().revision;
  f.send({type:'state',state:'made-up'});f.send({...segment('system'),start_ms:-1});f.send({...segment('system'),source:'mixed'});
  assert.equal(f.read().revision,revision);
});

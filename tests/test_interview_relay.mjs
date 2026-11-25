import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {registerInterviewRelay}=require('../desktop/main/interview-relay');
function fixture({inline=false}={}){
  const listeners=new Map(),handlers=new Map();
  const window=url=>{
    const win=new EventEmitter();win.visible=true;win.destroyed=false;win.sent=[];
    win.isDestroyed=()=>win.destroyed;win.isVisible=()=>win.visible;win.hide=()=>{win.visible=false;};
    win.webContents=new EventEmitter();win.webContents.mainFrame={};win.webContents.getURL=()=>url;
    win.webContents.send=(...args)=>win.sent.push(args);return win;
  };
  const main=window('file:///app/index.html'),settings=window('http://127.0.0.1:9958/settings#interview');
  let revision=0,hidden=false,clock=1000;
  const ipcMain={on:(name,fn)=>listeners.set(name,fn),handle:(name,fn)=>handlers.set(name,fn)};
  registerInterviewRelay({ipcMain,getMainWindow:()=>main,getSettingsWindow:()=>settings,gatewayUrl:'http://127.0.0.1:9958',rendererIndex:inline?'/app/index.html':undefined,now:()=>clock,visibility:{version:()=>revision,canShow:value=>!hidden&&value===revision}});
  const event=win=>({sender:win.webContents,senderFrame:win.webContents.mainFrame});
  const send=data=>listeners.get('interview:publish')(event(inline?main:settings),{run_id:'run-1',...data});
  const read=()=>handlers.get('interview:getState')(event(main));
  const command=data=>handlers.get('interview:command')(event(main),{run_id:'run-1',...data});
  const start=(role='candidate',run_id='run-1')=>{send({run_id,type:'state',state:'acquiring',role,sources:['mic','system']});send({run_id,type:'ready',session_id:`session-${run_id}`,role,sources:['mic','system']});};
  return {main,settings,listeners,handlers,event,send,read,command,start,tick(ms){clock+=ms;},hide(){hidden=true;revision++;main.visible=false;settings.visible=false;},restore(){hidden=false;main.visible=true;settings.visible=true;}};
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

test('NLS finals clear covered partials even when their start timestamps differ',()=>{
  const f=fixture();f.start();
  const partial={...segment('mic',0,false),end_ms:8000};
  f.send(partial);f.send(segment('system',0,false));
  f.send({...segment('mic',200),end_ms:8100});
  assert.equal(f.read().partials.mic,null);assert.ok(f.read().partials.system);
  f.send(partial);assert.equal(f.read().partials.mic,null);
});

test('a late final does not clear the next utterance partial from the same source',()=>{
  for(const [start_ms,end_ms] of [[8200,9000],[8100,8100]]){
    const f=fixture();f.start();
    const partial={...segment('mic',start_ms,false),end_ms};
    f.send(partial);
    f.send({...segment('mic',200),end_ms:8100});
    assert.equal(f.read().partials.mic.start_ms,start_ms);
    f.send(partial);assert.equal(f.read().partials.mic.start_ms,start_ms);
  }
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
    assert.equal(f.read().transcripts.length,1);
    assert.equal(f.read().conversation_id,'run-1');
  }
});

test('invalid phase, sources and timestamps cannot corrupt cached state',()=>{
  const f=fixture();f.send({type:'state',state:'acquiring',role:'candidate',sources:['mic','mic']});assert.equal(f.read().run_id,'');
  f.start();const revision=f.read().revision;
  f.send({type:'state',state:'made-up'});f.send({...segment('system'),start_ms:-1});f.send({...segment('system'),source:'mixed'});
  assert.equal(f.read().revision,revision);
});

test('inline recorder publishes and receives commands without hiding its own panel',()=>{
 const f=fixture({inline:true});f.start();f.send({type:'state',state:'recording'});
 assert.equal(f.read().phase,'recording');assert.equal(f.main.visible,true);
 assert.equal(f.command({action:'mute',source:'mic',muted:true}),true);
 assert.ok(f.main.sent.some(([name])=>name==='interview:command'));
 assert.ok(!f.settings.sent.some(([name])=>name==='interview:command'));
});

test('continuing recording preserves the conversation and separates provider timelines',()=>{
  const f=fixture();f.start();f.send({...segment('mic'),text:'第一段'});
  const first=f.read().transcripts[0];
  f.send({type:'mute',source:'mic',muted:true});
  f.send({type:'error',detail:'旧错误'});
  f.send({type:'stopped',saved:true});
  f.start('candidate','run-2');
  assert.equal(f.read().conversation_id,'run-1');assert.equal(f.read().run_id,'run-2');
  assert.deepEqual(f.read().transcripts,[first]);assert.equal(f.read().error,'');assert.equal(f.read().saved,false);
  assert.deepEqual(f.read().muted,{mic:false,system:false});
  f.send({...segment('mic'),run_id:'run-2',text:'第二段',timelineOffset:-100000});
  const result=f.read().transcripts;
  assert.equal(result.length,2);assert.equal(result[0].text,'第一段');assert.equal(result[1].text,'第二段');
  assert.ok(result[1].start_ms>=first.end_ms+2000);assert.notEqual(result[0].segment_id,result[1].segment_id);
  const revision=f.read().revision;f.send({...segment('system'),text:'过期消息'});
  assert.equal(f.read().revision,revision);
});

test('continued finals clear only the matching source partial on the adjusted timeline',()=>{
  const f=fixture();f.start();f.send(segment('mic'));f.send({type:'stopped',saved:true});f.start('candidate','run-2');
  f.send({...segment('mic',0,false),run_id:'run-2',end_ms:8000});
  f.send({...segment('system',0,false),run_id:'run-2',end_ms:8000});
  f.send({...segment('mic',200),run_id:'run-2',end_ms:8100});
  assert.equal(f.read().partials.mic,null);assert.ok(f.read().partials.system);
  assert.ok(f.read().partials.system.start_ms>=2100);
});

test('stopped drops unfinished previews but retains final transcript text',()=>{
  const f=fixture();f.start();f.send(segment('system'));f.send(segment('mic',200,false));
  f.send({type:'state',state:'stopping'});f.send(segment('system',300));
  f.send({type:'stopped',saved:true});
  assert.equal(f.read().transcripts.length,2);assert.deepEqual(f.read().partials,{mic:null,system:null});
});

test('one conversation retains its identity until an explicit reset',()=>{
  const f=fixture();f.start();f.send(segment('mic'));f.send({type:'stopped',saved:true});
  const revision=f.read().revision;f.start('interviewer','run-2');
  assert.equal(f.read().revision,revision);assert.equal(f.read().role,'candidate');assert.equal(f.read().run_id,'run-1');
  assert.equal(f.command({action:'reset'}),true);
  f.start('interviewer','run-3');
  assert.equal(f.read().role,'interviewer');assert.equal(f.read().conversation_id,'run-3');
});

test('reset is restricted to the owned main frame and the idle current run',()=>{
  const f=fixture();f.start();f.send({type:'state',state:'recording'});f.send(segment('system'));
  assert.equal(f.command({action:'reset'}),false);
  f.send({type:'stopped',saved:true});
  assert.equal(f.command({action:'reset',run_id:'stale'}),false);
  assert.equal(f.handlers.get('interview:command')(f.event(f.settings),{run_id:'run-1',action:'reset'}),false);
  assert.equal(f.handlers.get('interview:command')({sender:f.main.webContents,senderFrame:{}},{run_id:'run-1',action:'reset'}),false);
  const forwarded=f.settings.sent.length;
  assert.equal(f.command({action:'reset'}),true);
  assert.equal(f.settings.sent.length,forwarded);assert.equal(f.read().run_id,'');assert.equal(f.read().conversation_id,'');
  assert.equal(f.read().session_id,'');assert.equal(f.read().phase,'idle');assert.deepEqual(f.read().transcripts,[]);
  assert.deepEqual(f.read().sources,[]);assert.equal(f.read().saved,false);assert.equal(f.read().error,'');
  const revision=f.read().revision;
  f.send({type:'state',state:'acquiring',role:'candidate',sources:['mic','system']});f.send(segment('mic'));
  assert.equal(f.read().revision,revision);
  f.start('candidate','run-2');f.send({...segment('mic'),run_id:'run-2'});
  assert.equal(f.read().conversation_id,'run-2');assert.equal(f.read().transcripts[0].start_ms,0);
});

test('an empty conversation can be reset without a live recording producer',()=>{
  const f=fixture();assert.equal(f.command({action:'reset',run_id:''}),true);
  assert.equal(f.read().phase,'idle');assert.equal(f.read().conversation_id,'');
  f.start();f.settings.destroyed=true;f.settings.emit('closed');
  assert.equal(f.command({action:'reset'}),true);assert.equal(f.read().run_id,'');
});

test('recording time excludes preparation and pauses, continues monotonically, and resets explicitly',()=>{
  const f=fixture();f.start();f.tick(3000);
  assert.equal(f.read().elapsed_ms,0);assert.equal(f.read().recording_started_at,0);
  f.send({type:'state',state:'recording'});assert.equal(f.read().recording_started_at,4000);
  f.tick(500);f.send({type:'state',state:'recording'});assert.equal(f.read().recording_started_at,4000);
  f.tick(700);f.send({type:'state',state:'stopping'});
  assert.equal(f.read().elapsed_ms,1200);assert.equal(f.read().recording_started_at,0);
  f.tick(3000);f.send({type:'stopped',saved:true});assert.equal(f.read().elapsed_ms,1200);
  f.tick(10000);f.start('candidate','run-2');f.tick(2000);
  f.send({run_id:'run-2',type:'state',state:'recording'});f.tick(800);
  f.send({run_id:'run-2',type:'stopped',saved:true});
  assert.equal(f.read().elapsed_ms,2000);assert.equal(f.read().recording_started_at,0);
  assert.equal(f.command({run_id:'run-2',action:'reset'}),true);
  assert.equal(f.read().elapsed_ms,0);assert.equal(f.read().recording_started_at,0);
});

test('producer invalidation freezes recording time and retains the conversation',()=>{
  const f=fixture();f.start();f.send({type:'state',state:'recording'});f.send(segment('system'));
  f.tick(1200);f.settings.webContents.emit('did-navigate');
  assert.equal(f.read().elapsed_ms,1200);assert.equal(f.read().recording_started_at,0);
  assert.equal(f.read().phase,'idle');assert.equal(f.read().conversation_id,'run-1');assert.equal(f.read().transcripts.length,1);
  f.tick(3000);f.settings.webContents.emit('render-process-gone');assert.equal(f.read().elapsed_ms,1200);
});

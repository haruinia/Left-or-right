import assert from 'node:assert/strict';
import test from 'node:test';
import { createInterviewRecording, interviewSocketClass } from '../web/modules/interview-recording.js';

function fixture({configured=true, failure=false, currentState=null, getState}={}) {
  const published=[],notices=[],starts=[],muted=[];
  let command,callbacks,stops=0,current=currentState,settingRole='interviewer';
  const bridge={publishInterview:data=>published.push(data),onInterviewCommand:fn=>command=fn,getInterviewState:()=>getState?getState():Promise.resolve(current)};
  class Capture {
    state='idle';
    constructor(options) {callbacks=options;}
    async start(options) {starts.push(options);this.state='recording';callbacks.onState('acquiring');callbacks.onReady({session_id:'session'});callbacks.onState('recording');return true;}
    stop() {stops++;this.state='idle';callbacks.onState('idle');}
    mute(...args) {muted.push(args);}
    dispose() {this.stop();}
  }
  const request=async url=>{
    if(failure)throw Error('Local service unavailable');
    return {ok:true,json:async()=>url.endsWith('/profiles')?{active_profile_id:'a',profiles:[{id:'a',configured}]}:{assistant_role:settingRole}};
  };
  const recording=createInterviewRecording({bridge,gatewayUrl:()=> 'http://127.0.0.1:9958',gatewayKey:()=>'',onNotice:n=>notices.push(n),request,CaptureClass:Capture,capabilities:{systemAudioSupported:true}});
  return {recording,starts,published,notices,muted,command:data=>command(data),callbacks:()=>callbacks,stops:()=>stops,setCurrent:value=>current=value,setRole:value=>settingRole=value};
}

test('mounting inline recording starts neither audio nor an ASR session',()=>{
  const f=fixture();assert.equal(f.starts.length,0);assert.equal(f.published.length,0);
});

test('one explicit start uses saved identity and both sources without opening a window',async()=>{
  const f=fixture();assert.equal(await f.recording.start(),true);
  assert.equal(f.starts[0].role,'interviewer');assert.deepEqual(f.starts[0].sources,['mic','system']);
  assert.ok(f.published.some(event=>event.state==='recording'));
  await f.recording.start();assert.equal(f.starts.length,1);
});

test('missing configuration and preparation failure are reported in the same panel',async()=>{
  const f=fixture({configured:false});assert.equal(await f.recording.start(),false);assert.equal(f.starts.length,0);
  assert.ok(f.notices.some(n=>n.includes('语音配置')));
  const broken=fixture({failure:true});assert.equal(await broken.recording.start(),false);assert.equal(broken.starts.length,0);
  assert.ok(broken.notices.some(n=>n.includes('unavailable')));
});

test('only current run commands can stop or mute inline recording',async()=>{
  const f=fixture();await f.recording.start();const run=f.published[0].run_id;
  f.command({run_id:'old',action:'stop'});assert.equal(f.stops(),0);
  f.command({run_id:run,action:'mute',source:'mic',muted:true});assert.deepEqual(f.muted,[['mic',true]]);
  f.command({run_id:run,action:'stop'});assert.equal(f.stops(),1);
});

test('continued audio keeps the conversation identity until an explicit reset',async()=>{
  const f=fixture({currentState:{conversation_id:'interview-1',role:'candidate'}});
  f.setRole('candidate');await f.recording.start();
  assert.equal(f.starts[0].role,'candidate');
  const firstRun=f.published.find(event=>event.state==='acquiring').run_id;
  f.command({run_id:firstRun,action:'stop'});
  f.setRole('interviewer');await f.recording.start();
  assert.equal(f.starts[1].role,'candidate');
  const secondRun=f.published.filter(event=>event.state==='acquiring').at(-1).run_id;
  assert.notEqual(secondRun,firstRun);
  f.command({run_id:secondRun,action:'stop'});
  f.setCurrent({conversation_id:'',role:'candidate'});await f.recording.start();
  assert.equal(f.starts[2].role,'interviewer');
});

test('preparing a conversation state prevents a duplicate audio start',async()=>{
  let resolveState,entered;
  const waiting=new Promise(resolve=>entered=resolve);
  const f=fixture({getState:()=>{entered();return new Promise(resolve=>resolveState=resolve);}});
  const first=f.recording.start();await waiting;
  assert.equal(f.starts.length,0);assert.equal(await f.recording.start(),false);
  resolveState({conversation_id:'',role:'candidate'});
  assert.equal(await first,true);assert.equal(f.starts.length,1);
});

test('disposing while awaiting the conversation state never starts audio capture',async()=>{
  let resolveState,entered;
  const waiting=new Promise(resolve=>entered=resolve);
  const f=fixture({getState:()=>{entered();return new Promise(resolve=>resolveState=resolve);}});
  const pending=f.recording.start();await waiting;
  f.recording.dispose();resolveState({conversation_id:'interview-1',role:'candidate'});
  assert.equal(await pending,false);assert.equal(f.starts.length,0);assert.equal(f.published.length,0);
});

test('native socket forwards events and releases listeners at close',async()=>{
  let incoming,released=false;const sent=[];
  const bridge={onInterviewSocketEvent:fn=>{incoming=fn;return()=>released=true;},openInterviewSocket:async()=>true,sendInterviewSocket:(...args)=>sent.push(args),closeInterviewSocket:id=>sent.push(['close',id])};
  const Socket=interviewSocketClass(bridge),socket=new Socket();const received=[];
  socket.addEventListener('message',event=>received.push(event.data));
  incoming({id:'other',type:'message',data:'not ours'});assert.equal(received.length,0);
  incoming({id:socket.id,type:'open'});socket.send('pcm');assert.deepEqual(sent[0],[socket.id,'pcm']);
  incoming({id:socket.id,type:'message',data:'transcript'});assert.deepEqual(received,['transcript']);
  socket.close();incoming({id:socket.id,type:'close'});assert.equal(socket.readyState,3);assert.equal(released,true);
});

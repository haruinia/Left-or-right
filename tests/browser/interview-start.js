async(page,{base=new URL(page.url()).origin}={})=>{
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  let preferences={assistant_role:'candidate',study_specialty:'后端开发',study_language:'Java',study_answer_style:'solution',answer_language:'zh-CN',study_goal:'',study_instructions:'',jd_text:'',resume_text:'',interview_use_knowledge:false};
  const profile={id:'speech',name:'语音服务',model:'paraformer-realtime-v2',api_key_configured:true};
  await page.route('**/api/ui/settings',route=>route.fulfill({json:preferences}));
  await page.route('**/api/config/asr/**',route=>route.fulfill({json:{profiles:[profile],active_profile_id:'speech'}}));
  await page.route('**/api/config/llm/profiles',route=>route.fulfill({json:{profiles:[],presets:[],active_profile_id:''}}));
  await page.route('**/api/learning-assets/**',route=>route.fulfill({json:{items:[]}}));
  await page.addInitScript(()=>{
    window.__APP_SETTINGS__=true;window.__AUDIO_CAPTURE__={systemAudioSupported:true,platform:'darwin'};
    const state=window.__startTest={published:[],sockets:[],tracks:[],contexts:[],constraints:[],permissions:[],denySystem:false};
    window.interviewBridge={publish:event=>state.published.push(event),onCommand:fn=>state.command=fn,openAudioPermissions:async kind=>{state.permissions.push(kind);return true;}};
    class Track extends EventTarget {constructor(source){super();this.source=source;this.kind='audio';this.enabled=true;this.readyState='live';state.tracks.push(this);}stop(){this.readyState='ended';}}
    class Stream {constructor(tracks){this.tracks=tracks;}getTracks(){return this.tracks;}getAudioTracks(){return this.tracks;}getVideoTracks(){return [];}}
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async options=>{state.constraints.push(options);return new Stream([new Track('mic')]);},getDisplayMedia:async options=>{state.constraints.push(options);if(state.denySystem)throw new DOMException('test permission denied','NotAllowedError');return new Stream([new Track('system')]);}}});
    window.MediaStream=Stream;
    window.AudioContext=class{constructor(options){this.sampleRate=options.sampleRate;this.state='suspended';this.destination={};this.audioWorklet={addModule:async()=>{}};state.contexts.push(this);}async resume(){this.state='running';}async close(){this.state='closed';}createGain(){return {gain:{},connect(){},disconnect(){}};}createMediaStreamSource(){return {connect(){},disconnect(){}};}};
    window.AudioWorkletNode=class{constructor(){this.port={onmessage:null,postMessage:data=>this.port.onmessage?.({data:{type:'flushed',id:data.id}}),close(){}};}connect(){this.timer=setInterval(()=>this.port.onmessage?.({data:{type:'chunk',buffer:new ArrayBuffer(3200),rms:.1}}),100);}disconnect(){clearInterval(this.timer);}};
    window.WebSocket=class extends EventTarget{constructor(){super();this.readyState=0;this.bufferedAmount=0;state.sockets.push(this);setTimeout(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));},0);}message(data){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(data)}));}send(raw){const frame=JSON.parse(raw);if(frame.type==='start'){this.start=frame;this.message({type:'ready',session_id:'test-session',role:frame.role,sources:frame.sources,profile:{id:'speech',name:'语音服务',model:'asr'}});}if(frame.type==='audio'&&frame.seq===1)this.message({type:'transcript',source:frame.source,text:'模拟转写文字',start_ms:0,end_ms:100,is_final:true,segment_id:frame.source+':0'});if(frame.type==='stop')this.message({type:'stopped',saved:true,record:null});}close(){this.readyState=3;this.dispatchEvent(new Event('close'));}};
  });
  const check=(value,text)=>{if(!value)throw Error(text);};
  await page.setViewportSize({width:520,height:340});
  await page.goto(base+'/settings?start-test#interview');
  await page.waitForFunction(()=>!document.querySelector('#interviewStart').disabled);
  check(await page.locator('.settings-nav a[href="#interview"]').count()===0,'Audio setup remains in navigation');
  check(await page.locator('#interview select,#interview input[type="checkbox"]').count()===0,'Audio asks for already-established choices');
  check(await page.evaluate(()=>window.__startTest.sockets.length===0&&window.__startTest.tracks.length===0),'Audio started before the explicit action');
  check((await page.locator('#interviewIdentity').textContent()).includes('候选人'),'Saved identity was not loaded');
  check(!await page.locator('#interviewPermissions').isVisible(),'Permission recovery is unnecessarily shown before a failure');
  await page.locator('#interviewStart').click();
  await page.waitForFunction(()=>window.__startTest.published.some(event=>event.type==='state'&&event.state==='recording'));
  const first=await page.evaluate(()=>window.__startTest.sockets[0].start);
  check(first.role==='candidate'&&JSON.stringify(first.sources)===JSON.stringify(['mic','system']),'Built-in dual sources or saved role changed');
  check(await page.evaluate(()=>window.__startTest.constraints[0].audio.deviceId===undefined),'A custom microphone was selected instead of the system default');
  await page.evaluate(()=>{const run=window.__startTest.published.find(event=>event.type==='state'&&event.state==='acquiring');window.__startTest.command({run_id:run.run_id,action:'mute',source:'mic',muted:true});});
  check(await page.evaluate(()=>!window.__startTest.tracks[0].enabled&&window.__startTest.tracks[1].enabled),'Overlay mute mixed audio sources');
  await page.evaluate(()=>{const run=window.__startTest.published.find(event=>event.type==='state'&&event.state==='acquiring');window.__startTest.command({run_id:run.run_id,action:'stop'});});
  await page.waitForFunction(()=>window.__startTest.tracks.every(track=>track.readyState==='ended')&&!document.querySelector('#interviewStart').disabled);
  preferences={...preferences,assistant_role:'interviewer'};
  await page.evaluate(()=>window.dispatchEvent(new Event('settings:saved')));
  await page.waitForFunction(()=>document.querySelector('#interviewIdentity').textContent.startsWith('我（面试官）'));
  await page.locator('#interviewStart').click();
  await page.waitForFunction(()=>window.__startTest.sockets.length===2&&window.__startTest.sockets[1].start);
  check(await page.evaluate(()=>window.__startTest.sockets[1].start.role==='interviewer'),'Next start reused stale identity');
  await page.locator('#interviewStop').click();
  await page.waitForFunction(()=>window.__startTest.tracks.every(track=>track.readyState==='ended'));
  await page.waitForFunction(()=>!document.querySelector('#interviewStart').disabled);
  await page.evaluate(()=>{window.__startTest.denySystem=true;});
  await page.locator('#interviewStart').click();
  await page.locator('#interviewPermissions').waitFor();
  await page.locator('#interviewPermissions').click();
  check(await page.evaluate(()=>window.__startTest.permissions.at(-1)==='system'),'Permission recovery did not target the failed source');
  check(errors.length===0,errors.join('\n'));
  return {passed:true,permissionRecoveryOnFailure:true,noAudioSettingsNav:true,noRedundantChoices:true,noAutomaticRecording:true,builtInDualSources:true,savedIdentity:true,identityRefresh:true,overlayMuteAndStop:true,mockedAudioOnly:true};
}

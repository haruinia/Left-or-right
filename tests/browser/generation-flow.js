async (page) => {
  const errors=[];const sessions=[];const requests=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.setViewportSize({width:780,height:760});
  await page.addInitScript(()=>{
    const events=window.__generationEvents={};
    window.__GATEWAY_URL__='http://127.0.0.1:9958';
    window.cockpit={getConfig:async()=>({armed:true,hotkeys:[],failedHotkeys:[],display:{opacity:.25,theme:'light',layout:'narrow',compact:true},captureOptions:{mode:'full',displayId:'1',displays:[{id:'1',label:'测试屏',width:1440,height:900}]}}),setSurface:async()=>({}),onCapture:fn=>events.capture=fn,onRead:fn=>events.read=fn,onReset:fn=>events.reset=fn,onNewQuestion:fn=>events.newQuestion=fn,onArmed:fn=>events.armed=fn};
    const original=window.fetch;
    window.__generationStreams=[];
    window.fetch=async(url,options)=>{
      if(!String(url).endsWith('/api/chat/stream'))return original(url,options);
      const item={aborted:false,body:JSON.parse(options.body)};
      window.__generationStreams.push(item);
      return new Response(new ReadableStream({start(controller){item.controller=controller;options.signal.addEventListener('abort',()=>{item.aborted=true;controller.error(new DOMException('Aborted','AbortError'));});}}),{headers:{'Content-Type':'text/event-stream'}});
    };
    window.__generationEmit=delta=>{const item=window.__generationStreams.at(-1);item.controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({delta})+'\n\n'));};
    window.__generationDone=()=>{const item=window.__generationStreams.at(-1);item.controller.enqueue(new TextEncoder().encode('data: {"done":true}\n\n'));item.controller.close();};
  });
  await page.route('**/api/ui/settings',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({study_specialty:'计算机 / 软件工程',study_language:'Java',answer_language:'zh-CN',assistant_role:'candidate',study_answer_style:'solution'})}));
  await page.route('**/api/config/status',route=>route.fulfill({status:200,contentType:'application/json',body:'{"llm_provider":"openai_compatible","llm_model":"test-model","llm_api_key_configured":true,"llm_base_url_configured":true}'}));
  await page.route('**/api/learning-assets/**',route=>{
    const item=route.request().method()==='POST'?route.request().postDataJSON():{};
    if(route.request().url().includes('/sessions/upsert'))sessions.push(item.item);
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({items:[],item:item.item})});
  });
  await page.goto('http://127.0.0.1:9958/');
  await page.waitForFunction(()=>!!window.__liuwaSend&&!!window.__generationEvents.capture);
  const png=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=120;canvas.height=60;return canvas.toDataURL('image/png').split(',')[1];});
  const start=async(index)=>{
    await page.evaluate(data=>{window.__generationEvents.capture({mime:'image/png',data});window.__generationSend=window.__liuwaSend();},png);
    await page.waitForFunction(count=>window.__generationStreams.length===count,index);
  };
  const emit=delta=>page.evaluate(value=>window.__generationEmit(value),delta);
  const finish=async()=>{await page.evaluate(()=>window.__generationDone());await page.evaluate(()=>window.__generationSend);};
  const selected=()=>page.locator('.liuwa-stream').getAttribute('data-answer-panel');

  await start(1);
  if(await page.locator('#liuwaStop').count())throw Error('The independent stop button remains.');
  if(!await page.locator('.liuwa-reader .liuwa-analysis-status').isVisible())throw Error('Waiting state is not inside the answer panel.');
  if((await page.locator('#liuwaStatus').textContent()).includes('正在分析'))throw Error('Waiting text is still outside the panel.');
  if(!await page.locator('.liuwa-stream').isHidden())throw Error('A blank answer body replaced the waiting state too early.');
  await emit('<!--');await emit(' liuwa:type=programming -->\n\n## 答案\n');
  await page.waitForTimeout(140);
  if(!await page.locator('.liuwa-analysis-status').isVisible())throw Error('Metadata or a heading prematurely ended analysis.');
  await emit('使用遍历求和。\n');
  await page.waitForFunction(()=>document.querySelector('.liuwa-stream').textContent.includes('遍历求和'));
  if(!await page.locator('.liuwa-analysis-status').isHidden()||await selected()!=='answer')throw Error('The first answer did not replace the waiting state.');
  await emit('## 代码\n```java\nint sum(int a,int b){return a+b;}\n```\n## 解题思路\n依次处理输入。\n');
  await finish();
  if(await page.locator('.is-stream').count())throw Error('Generation animation survived completion.');
  await page.locator('#liuwaReadingNext').click();if(await selected()!=='code')throw Error('Right navigation did not reach code.');
  await page.locator('#liuwaReadingPrev').click();if(await selected()!=='answer')throw Error('Left navigation did not restore the answer.');
  await page.evaluate(()=>window.__generationEvents.read('next'));if(await selected()!=='code')throw Error('Native next navigation stopped working.');
  await page.evaluate(()=>window.__generationEvents.read('prev'));if(await selected()!=='answer')throw Error('Native previous navigation stopped working.');
  await page.locator('#liuwaReset').click();await page.waitForFunction(()=>document.body.classList.contains('is-empty'));
  if(sessions.length!==1||await page.locator('.liuwa-thumb').count())throw Error('Reset did not archive the conversation and clear images.');

  await start(2);
  await page.locator('#liuwaReset').click();await page.waitForFunction(()=>document.body.classList.contains('is-empty'));
  if(!await page.evaluate(()=>window.__generationStreams[1].aborted))throw Error('Reset did not cancel the pending model request.');
  if(await page.locator('.liuwa-analysis-status').count()||await page.locator('.liuwa-thumb').count())throw Error('Reset left a waiting state or old image in the new conversation.');

  await start(3);await emit('<!-- liuwa:type=choice -->\n## 答案\nB. 尚未生成完的内容\n');
  await page.waitForFunction(()=>document.querySelector('.liuwa-stream').textContent.includes('尚未生成完'));
  await page.evaluate(()=>window.__generationEvents.newQuestion());await page.waitForFunction(()=>document.body.classList.contains('is-empty'));
  if(!await page.evaluate(()=>window.__generationStreams[2].aborted)||sessions.length!==2)throw Error('New conversation did not cancel and preserve the partial answer.');

  await start(4);
  if(!await page.evaluate(()=>window.__generationStreams.at(-1).body.history.length===0))throw Error('Old conversation history leaked into the fresh request.');
  await emit('<!-- liuwa:type=choice -->\n## 答案\nA. 新对话\n## 解题思路\n只使用新题。');await finish();
  if((await page.locator('.liuwa-stream').textContent()).includes('尚未生成完'))throw Error('A stale answer returned after reset.');
  if(errors.length)throw Error(errors.join(';'));
  return {passed:true,waitingInsidePanel:true,metadataDoesNotEndWaiting:true,noStopButton:true,answerFirst:true,leftRightAndNativeNavigation:true,resetCancelsWaiting:true,newConversationCancelsPartial:true,historyCleared:true,errors};
}

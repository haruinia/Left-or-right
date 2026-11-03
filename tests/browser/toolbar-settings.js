async(page)=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width:560,height:720});
  await page.addInitScript(()=>{
    window.__GATEWAY_URL__='http://127.0.0.1:8003';
    const e=window.__toolbarEvents={};const calls=window.__toolbarCalls=[];
    const display={opacity:.9,layout:'narrow',compact:true,theme:'light',answer:false};
    const capture={mode:'area',displayId:'1',displays:[{id:'1',label:'内建屏',width:1512,height:982},{id:'2',label:'外接屏',width:1920,height:1080}]};
    window.cockpit={getConfig:async()=>({hotkeys:[],failedHotkeys:[],armed:true,display:{...display},captureOptions:{...capture}}),
      setSurface:async patch=>{calls.push(['surface',patch]);if(patch.answer===false)display.compact=true;else if(patch.answer===true&&!display.answer)display.compact=false;Object.assign(display,patch);return {...display};},
      setDisplay:async patch=>{Object.assign(display,patch);calls.push(['display',patch]);return {...display,saved:true};},
      setCaptureOptions:async patch=>{Object.assign(capture,patch);calls.push(['captureOptions',patch]);return {...capture,saved:true};},
      captureExam:async()=>calls.push(['capture']),
      onCapture:fn=>e.capture=fn,onReset:fn=>e.reset=fn,onRead:fn=>e.read=fn,onArmed:fn=>e.armed=fn};
  });
  let prefs={study_language:'Python',answer_language:'zh-CN',assistant_role:'candidate',study_instructions:'keep'};
  const patches=[];const models=[];let savedSessions=0;
  const profiles={active_profile_id:'personal',profiles:[
    {id:'personal',name:'个人接口',llm_model:'same-model',llm_base_url:'https://personal.example.test/v1'},
    {id:'team',name:'团队接口',llm_model:'same-model',llm_base_url:'https://team.example.test/v1'},
  ]};
  await page.route('**/api/ui/settings',route=>{
    if(route.request().method()==='PATCH'){const patch=route.request().postDataJSON();patches.push(patch);prefs={...prefs,...patch};}
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(prefs)});
  });
  await page.route('**/api/config/llm/profiles',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(profiles)}));
  await page.route('**/api/config/llm/activate',route=>{
    const payload=route.request().postDataJSON();models.push(payload);profiles.active_profile_id=payload.profile_id;
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(profiles)});
  });
  await page.route('**/api/learning-assets/sessions**',route=>{
    const body=route.request().method()==='POST'?route.request().postDataJSON():{};
    if(route.request().url().endsWith('/upsert'))savedSessions++;
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({items:[],item:body.item,imported:0})});
  });
  await page.route('**/api/learning-assets/exams**',route=>{
    const body=route.request().method()==='POST'?route.request().postDataJSON():{};
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({items:[],item:body.item,imported:0})});
  });
  await page.route('**/api/chat/stream',route=>route.fulfill({status:200,contentType:'text/event-stream',body:'data: '+JSON.stringify({delta:'<!-- liuwa:type=choice -->\n## 答案\nB. TCP\n## 解题思路\n可靠、有序的传输。\n## 详细解析\n排除 UDP。'})+'\n\ndata: {"done":true}\n\n'}));
  await page.goto('http://127.0.0.1:9958/');
  await page.waitForFunction(()=>!!window.__liuwaSend);
  if(!await page.locator('.liuwa-reader').isHidden())throw Error('idle still occupies a reading window');
  if(!await page.locator('#liuwaQuestions').isHidden())throw Error('question selector is visible with no questions');
  const barHeight=await page.locator('.liuwa-command-bar').evaluate(e=>e.getBoundingClientRect().height);
  const barWidth=await page.locator('.liuwa-command-bar').evaluate(e=>e.getBoundingClientRect().width);
  if(barWidth<530)throw Error('the idle toolbar does not fill its narrow window');
  if(barHeight>65)throw Error('idle command bar is too tall');
  await page.screenshot({path:'output/playwright/toolbar-idle.png'});
  const png=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=600;canvas.height=240;const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,600,240);ctx.fillStyle='black';ctx.font='24px sans-serif';ctx.fillText('截图测试：两个整数之和',24,80);return canvas.toDataURL('image/png').split(',')[1];});
  await page.evaluate(data=>window.__toolbarEvents.capture({mime:'image/png',data}),png);
  if(await page.locator('#liuwaShots').isHidden())throw Error('idle thumbnail is hidden');
  const position=await page.evaluate(()=>({image:document.querySelector('#liuwaShots').getBoundingClientRect().bottom,bar:document.querySelector('.liuwa-command-bar').getBoundingClientRect().top}));
  if(position.image>position.bar)throw Error('images are still below the toolbar');
  await page.locator('#liuwaSend').click();
  await page.waitForFunction(()=>!document.body.classList.contains('is-busy'));
  if(await page.locator('#liuwaShots').isHidden()||await page.locator('.liuwa-reader').isHidden())throw Error('answer lost its top thumbnail or reader');
  await page.screenshot({path:'output/playwright/toolbar-answer-light.png'});
  await page.locator('#liuwaDisplay > summary').click();
  await page.waitForFunction(()=>!document.querySelector('#quickProgrammingLanguage').disabled);
  if(await page.locator('#quickProgrammingLanguage').evaluate(e=>e.tagName)!=='SELECT')throw Error('programming language is not a directly selectable dropdown');
  await page.locator('#quickProgrammingLanguage').selectOption('Java');
  await page.waitForFunction(()=>document.querySelector('#quickProgrammingLanguage').value==='Java'&&!document.querySelector('#quickProgrammingLanguage').disabled);
  await page.locator('#quickAnswerLanguage').selectOption('en-US');
  await page.waitForFunction(()=>!document.querySelector('#quickAnswerLanguage').disabled);
  await page.locator('#quickIdentity').selectOption('interviewer');
  await page.waitForFunction(()=>!document.querySelector('#quickIdentity').disabled);
  await page.locator('#quickCaptureMode').selectOption('full');
  await page.waitForFunction(()=>!document.querySelector('#quickDisplay').disabled);
  if(await page.locator('#quickDisplay').evaluate(e=>e.tagName)!=='SELECT')throw Error('running display does not use the shared select control');
  if(await page.locator('#quickDisplayHint').count())throw Error('running display includes an extra hint');
  await page.locator('#quickDisplay').selectOption('2');
  await page.waitForFunction(()=>!document.querySelector('#quickDisplay').disabled);
  if(await page.locator('#quickDisplay option:checked').count()!==1)throw Error('more than one running display is selected');
  const capturePatch=await page.evaluate(()=>window.__toolbarCalls.filter(c=>c[0]==='captureOptions').at(-1)?.[1]);
  if(capturePatch?.displayId!=='2'||'displayIds' in capturePatch)throw Error('a single displayId was not sent');
  await page.locator('#quickDisplay').selectOption('1');
  await page.waitForFunction(()=>!document.querySelector('#quickDisplay').disabled);
  if(await page.locator('#quickDisplay').inputValue()!=='1')throw Error('switching back did not select the first screen');
  if(await page.locator('#quickManageModels, #quickModelSummary').count())throw Error('quick settings still includes model management or a duplicate summary');
  await page.waitForFunction(()=>!document.querySelector('#quickModel').disabled);
  if(await page.locator('#quickModel option').count()!==2)throw Error('same-model profiles were deduplicated');
  const labels=await page.locator('#quickModel option').allTextContents();
  if(!labels[0].includes('个人接口')||!labels[1].includes('团队接口'))throw Error('saved model profile names are not shown');
  const modelAfterLayout=await page.locator('#quickModel').evaluate(e=>Boolean(document.querySelector('#liuwaLayout').compareDocumentPosition(e)&Node.DOCUMENT_POSITION_FOLLOWING));
  if(!modelAfterLayout)throw Error('current model was not moved after the display controls');
  await page.locator('#quickModel').selectOption('team');
  await page.waitForFunction(()=>!document.querySelector('#quickModel').disabled);
  if(models.at(-1)?.profile_id!=='team')throw Error('same-model source did not activate by profile id');
  await page.locator('#quickModel').selectOption('personal');
  await page.waitForFunction(()=>!document.querySelector('#quickModel').disabled);
  if(models.at(-1)?.profile_id!=='personal')throw Error('switching model source back failed');
  profiles.profiles.push({id:'new',name:'新增接口',llm_model:'third-model',llm_base_url:'https://new.example.test/v1'});
  await page.locator('#quickRefreshModels').click();
  await page.waitForFunction(()=>!document.querySelector('#quickRefreshModels').disabled);
  if(await page.locator('#quickModel option').count()!==3)throw Error('refresh did not reload all saved models');
  if(await page.locator('#quickModel').inputValue()!=='personal')throw Error('refresh changed the active model selection');
  await page.locator('[data-theme-mode="dark"]').click();
  const dark=await page.locator('.liuwa-reader').evaluate(e=>({bg:getComputedStyle(e).backgroundColor,ink:getComputedStyle(e).color}));
  if(!dark.bg.includes('22, 30, 46'))throw Error('dark appearance is not applied');
  await page.screenshot({path:'output/playwright/toolbar-settings-dark.png'});
  await page.locator('[data-theme-mode="transparent-white"]').click();
  const clear=await page.locator('.liuwa-reader').evaluate(e=>({bg:getComputedStyle(e).backgroundColor,ink:getComputedStyle(document.querySelector('.liuwa-stream')).color}));
  if(clear.bg!=='rgba(0, 0, 0, 0)'||clear.ink!=='rgb(241, 245, 253)')throw Error('transparent white text appearance is wrong');
  await page.locator('[data-theme-mode="transparent-black"]').click();
  if(await page.locator('.liuwa-stream').evaluate(e=>getComputedStyle(e).color)!=='rgb(25, 37, 69)')throw Error('transparent black text appearance is wrong');
  await page.locator('[data-theme-mode="light"]').click();
  await page.locator('#liuwaCloseSettings').click();
  await page.locator('#liuwaReset').click();
  await page.waitForFunction(()=>document.body.classList.contains('is-empty'));
  if(await page.locator('.liuwa-thumb').count()||savedSessions!==1)throw Error('reset did not archive and clear the old view');
  // Reset while a real-style fetch is still streaming: abort, preserve partial, then clear.
  await page.evaluate(data=>{
    const original=window.fetch;window.__toolbarRestoreFetch=()=>window.fetch=original;
    window.fetch=async(url,options)=>{
      if(!String(url).endsWith('/api/chat/stream'))return original(url,options);
      return new Response(new ReadableStream({start(controller){window.__toolbarStream=controller;options.signal.addEventListener('abort',()=>controller.error(new DOMException('Aborted','AbortError')));}}));
    };
    window.__toolbarEvents.capture({mime:'image/png',data});window.__toolbarSend=window.__liuwaSend();
  },png);
  await page.waitForFunction(()=>!!window.__toolbarStream);
  await page.evaluate(()=>window.__toolbarStream.enqueue(new TextEncoder().encode('data: '+JSON.stringify({delta:'## 答案\nB. 部分内容'})+'\n\n')));
  await page.waitForFunction(()=>document.querySelector('.liuwa-stream').textContent.includes('部分内容'));
  await page.locator('#liuwaDisplay > summary').click();
  await page.keyboard.press('Meta+r');
  await page.waitForFunction(()=>document.body.classList.contains('is-empty'));
  if(savedSessions!==2)throw Error('reset during streaming lost the partial session');
  if(await page.locator('#liuwaDisplay').evaluate(e=>e.open))throw Error('reset left settings covering the idle toolbar');
  await page.evaluate(()=>window.__toolbarRestoreFetch());
  if(errors.length)throw Error(errors.join(';'));
  return {passed:true,barHeight,barWidth,position,dark,clear,patches,models,savedSessions,calls:await page.evaluate(()=>window.__toolbarCalls.filter(c=>c[0]!=='surface')),errors};
}

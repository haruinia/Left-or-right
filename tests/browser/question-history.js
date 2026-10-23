async(page)=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width:560,height:720});
  await page.addInitScript(()=>{
    window.__GATEWAY_URL__='http://127.0.0.1:8003';
    const display={opacity:.9,layout:'narrow',compact:true,theme:'light',answer:false,revision:0};
    window.__historyEvents={};
    window.cockpit={getConfig:async()=>({hotkeys:[],failedHotkeys:[],display:{...display}}),
      setSurface:async patch=>{if(patch.answer===false)display.compact=true;else if(patch.answer===true&&!display.answer)display.compact=false;Object.assign(display,patch);display.revision++;return {...display};},
      setDisplay:async patch=>{Object.assign(display,patch);display.revision++;return {...display,saved:true};},
      onCapture:fn=>window.__historyEvents.capture=fn};
  });
  const prefs={study_language:'Python',answer_language:'zh-CN',assistant_role:'candidate'};
  await page.route('**/api/ui/settings',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(prefs)}));
  await page.route('**/api/config/models',route=>route.fulfill({status:200,contentType:'application/json',body:'{"models":["m"],"screenshot_model":"m","interview_model":"m"}'}));
  const sessions=[];
  await page.route('**/api/learning-assets/sessions**',route=>{
    const body=route.request().method()==='POST'?route.request().postDataJSON():{};
    if(route.request().url().endsWith('/upsert'))sessions.push(body);
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({items:[],item:body.item,imported:0})});
  });
  // 三道题：每道题的分区标题可辨认，用来确认切题后正文真的换了。
  const replies=[
    '<!-- liuwa:type=choice -->\n## 答案\nB. TCP\n## 解题思路\n第一题思路。',
    '<!-- liuwa:type=programming -->\n## 代码\n```python\ndef second():\n    return 2\n```\n## 解题思路\n第二题思路。',
    '<!-- liuwa:type=reasoning -->\n## 解题思路\n第三题思路，只有这一节。',
  ];
  let ask=0;
  await page.route('**/api/chat/stream',route=>route.fulfill({status:200,contentType:'text/event-stream',body:'data: '+JSON.stringify({delta:replies[ask++ % replies.length]})+'\n\ndata: {"done":true}\n\n'}));
  await page.goto('http://127.0.0.1:9959/index.html');
  await page.waitForFunction(()=>!!window.__liuwaSend);
  const png=(await(await page.request.get('http://127.0.0.1:9959/mock_q.png')).body()).toString('base64');
  const send=async()=>{
    await page.evaluate(data=>window.__historyEvents.capture({mime:'image/png',data}),png);
    await page.locator('#liuwaSend').click();
    await page.waitForFunction(()=>!document.body.classList.contains('is-busy')&&document.querySelector('.liuwa-stream')?.textContent?.trim().length>0);
  };
  await send();
  if(!await page.locator('#liuwaQuestions').isHidden())throw Error('selector shows up with a single question');
  if(!(await page.locator('.liuwa-stream').textContent()).includes('TCP'))throw Error('first answer missing');

  // 读一点、换个分区，再问第二题：切回来应该还在同一处。
  await page.locator('#liuwaAnswerTabs [data-panel="thought"]').click();
  await page.evaluate(()=>{document.querySelector('.liuwa-stream').scrollTop=40;});
  await send();
  if(await page.locator('#liuwaQuestions').isHidden())throw Error('selector stays hidden after two questions');
  const options=await page.locator('#liuwaQuestions option').allTextContents();
  if(options.length!==2||!options[0].startsWith('第 1 题')||!options[1].startsWith('第 2 题'))throw Error(`unexpected question labels: ${options}`);
  if(await page.locator('#liuwaQuestions').inputValue()!==await page.locator('#liuwaQuestions option').nth(1).getAttribute('value'))throw Error('selector does not follow the newest question');
  // 编程题默认打开「代码」，思路在同一条回答的另一个分区里。
  if(!(await page.locator('.liuwa-stream').textContent()).includes('second()'))throw Error('second answer missing');
  if(!(await page.locator('#liuwaAnswerTabs').textContent()).includes('思路'))throw Error('second answer lost its thought panel');

  await page.locator('#liuwaQuestions').selectOption({index:0});
  // 第一题之前手动停在「思路」分区，因此恢复后看到的是思路正文而不是答案。
  await page.waitForFunction(()=>document.querySelector('.liuwa-stream').textContent.includes('第一题思路'));
  const restored=await page.evaluate(()=>({panel:document.querySelector('.liuwa-stream').dataset.answerPanel,scroll:document.querySelector('.liuwa-stream').scrollTop,
    shots:document.querySelectorAll('.liuwa-thumb').length,label:document.querySelector('#liuwaQuestions').selectedOptions[0].textContent}));
  if(restored.panel!=='thought')throw Error(`panel was not restored: ${restored.panel}`);
  if(restored.shots!==1)throw Error('question thumbnail was not restored');
  if(!restored.label.startsWith('第 1 题'))throw Error('selector did not move to the first question');

  // 切回第一题后继续解题不能带上旧截图（已经发送过）。
  const requests=[];page.on('request',request=>{if(request.url().endsWith('/api/chat/stream'))requests.push(request.postDataJSON());});
  await page.locator('#liuwaSend').click();
  await page.waitForTimeout(300);
  if(requests.length)throw Error('an already-sent screenshot was re-sent without a new capture');
  if(!/先截一张屏/.test(await page.locator('#liuwaStatus').textContent()))throw Error('no hint about needing a new screenshot');
  // 第三题（只有一节）后，选择器和章节下拉互不影响。
  await send();
  if(await page.locator('#liuwaQuestions option').count()!==3)throw Error('third question was not recorded');
  if(await page.locator('#liuwaSections').isVisible())throw Error('section picker should stay hidden for a single section');

  // 重置后同一份列表一起清空。
  await page.locator('#liuwaReset').click();
  await page.waitForFunction(()=>document.body.classList.contains('is-empty'));
  if(sessions.length!==1)throw Error(`reset saved ${sessions.length} sessions`);
  if(!await page.locator('#liuwaQuestions').isHidden())throw Error('selector survived the reset');
  if(await page.locator('#liuwaQuestions option').count())throw Error('old questions came back after reset');

  if(errors.length)throw Error(errors.join(';'));
  return {passed:true,options,restored,sessions:sessions.length,errors};
}

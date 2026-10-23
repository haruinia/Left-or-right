async(page) => {
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width:780,height:760});
  await page.addInitScript(()=>{
    window.__GATEWAY_URL__='http://127.0.0.1:8001';
    window.__tabEvents={};
    window.cockpit={getConfig:async()=>({hotkeys:[],failedHotkeys:[]}),onCapture:fn=>window.__tabEvents.capture=fn,onRead:fn=>window.__tabEvents.read=fn,onNewQuestion:fn=>window.__tabEvents.newQuestion=fn};
  });
  const long='保持区间不变式，每步排除不可能的元素。\n\n'.repeat(40);
  const samples=[
    '<!-- liuwa:type=choice -->\n## 答案\nB. TCP 提供可靠、有序的字节流服务。\n## 解题思路\n'+long+'## 详细解析\nA 为无连接传输；B 符合可靠性要求；C 和 D 是应用层协议。',
    '<!-- liuwa:type=programming -->\n## 代码\n```python\ndef lower_bound(nums, target):\n    lo, hi = 0, len(nums)\n    while lo < hi:\n        mid = (lo + hi) // 2\n        if nums[mid] < target:\n            lo = mid + 1\n        else:\n            hi = mid\n    return lo\n```\n## 解题思路\n'+long+'## 复杂度分析\n时间 $O(\\log n)$，空间 $O(1)$。',
    '<!-- liuwa:type=reasoning -->\n## 解题思路\n先建立不变量，考虑最小反例。\n## 详细解析\n按边界条件分情况讨论。',
    '<!-- liuwa:type=essay -->\n## 参考作答\n完善基层公共服务，应以群众需求为导向，通过资源下沉、流程整合与数字服务协同，提升可及性和办理效率。\n## 写作思路\n提出问题、分析原因、落实对策。\n## 材料分析\n对应材料一的资源缺口、材料二的服务案例。',
    '<!-- liuwa:type=calculation -->\n## 答案\n$6$ 米。\n## 详细解析\n$2+4=6$。',
    '<!-- liuwa:type=mixed -->\n## 第1题\n### 答案\nB\n## 第2题\n### 代码\n```py\nprint(42)\n```',
    '未提供标题的旧回答，完整保留这句话。',
  ];
  let index=0;
  await page.route('**/api/chat/stream',route=>route.fulfill({status:200,contentType:'text/event-stream',body:'data: '+JSON.stringify({delta:samples[index++]})+'\n\ndata: {"done":true}\n\n'}));
  await page.goto('http://127.0.0.1:9958/index.html');
  await page.waitForFunction(()=>!!window.__liuwaSend);
  const png=(await(await page.request.get('http://127.0.0.1:9958/mock_q.png')).body()).toString('base64');
  const capture=()=>page.evaluate(data=>window.__tabEvents.capture({mime:'image/png',data}),png);
  const send=async()=>{await capture();await page.evaluate(()=>window.__liuwaSend());};
  const selected=()=>page.locator('.liuwa-stream').getAttribute('data-answer-panel');
  const click=key=>page.locator(`#liuwaAnswerTabs [data-panel="${key}"]`).click();
  await send();
  if(await selected()!=='answer')throw Error('choice did not open the answer');
  if((await page.locator('.liuwa-stream').textContent()).includes('保持区间'))throw Error('thoughts still share the answer pane');
  await page.screenshot({path:'output/playwright/answer-tabs-choice.png'});
  await click('thought');
  await page.locator('#liuwaReadingNext').click();
  await page.waitForTimeout(450);
  const thoughtTop=await page.locator('.liuwa-stream').evaluate(b=>b.scrollTop);
  if(thoughtTop<100)throw Error('thought paging did not scroll');
  await click('answer');await click('thought');
  const restoredTop=await page.locator('.liuwa-stream').evaluate(b=>b.scrollTop);
  if(Math.abs(thoughtTop-restoredTop)>1)throw Error('tab switching lost scroll position');
  await click('all');
  if(!(await page.locator('.liuwa-stream').textContent()).includes('保持区间'))throw Error('full answer dropped text');
  await send();
  if(await selected()!=='code'||await page.locator('.liuwa-stream pre').count()!==1)throw Error('programming did not open code');
  await page.screenshot({path:'output/playwright/answer-tabs-code.png'});
  await click('thought');
  if((await page.locator('.liuwa-stream').textContent()).includes('def lower_bound'))throw Error('code leaked into thoughts');
  await send();if(await selected()!=='thought')throw Error('reasoning did not open thoughts');
  if(await page.locator('#liuwaAnswerTabs [data-panel="code"]').count())throw Error('a non-code task has an empty code tab');
  await send();if(await selected()!=='answer')throw Error('essay did not open reference response');
  if(await page.locator('#liuwaAnswerTabs [data-panel="answer"]').textContent()!=='参考作答')throw Error('essay response label is wrong');
  await page.screenshot({path:'output/playwright/answer-tabs-essay.png'});
  await send();if(await selected()!=='answer')throw Error('calculation did not open answer');
  await send();if(await selected()!=='all')throw Error('mixed question context was lost');
  await send();if(await selected()!=='all'||!await page.locator('#liuwaAnswerTabs').isHidden())throw Error('legacy response did not fall back to full text');
  await page.unroute('**/api/chat/stream');
  // The preferred code arrives after thoughts: a user choice must not be stolen.
  await page.evaluate(data=>{
    const original=window.fetch;window.__tabsRestoreFetch=()=>window.fetch=original;
    window.fetch=async(url,options)=>String(url).endsWith('/api/chat/stream')?new Response(new ReadableStream({start(c){window.__tabsStream=c;}}),{headers:{'Content-Type':'text/event-stream'}}):original(url,options);
    window.__tabEvents.capture({mime:'image/png',data});window.__tabsSend=window.__liuwaSend();
  },png);
  await page.waitForFunction(()=>!!window.__tabsStream);
  const append=text=>page.evaluate(text=>window.__tabsStream.enqueue(new TextEncoder().encode('data: '+JSON.stringify({delta:text})+'\n\n')),text);
  await append('<!-- liuwa:type=programming -->\n## 解题思路\n'+long);
  await page.waitForSelector('#liuwaAnswerTabs [data-panel="thought"]');
  await click('thought');
  await page.locator('#liuwaReadingNext').click();await page.waitForTimeout(450);
  const during=await page.locator('.liuwa-stream').evaluate(b=>b.scrollTop);
  await append('\n## 代码\n```python\nprint(42)\n```');
  await page.waitForFunction(()=>document.querySelector('[data-panel="code"]')!==null);
  await page.evaluate(()=>{window.__tabsStream.enqueue(new TextEncoder().encode('data: {"done":true}\n\n'));window.__tabsStream.close();});
  await page.evaluate(()=>window.__tabsSend);
  const after=await page.locator('.liuwa-stream').evaluate(b=>b.scrollTop);
  if(await selected()!=='thought'||Math.abs(during-after)>1)throw Error('later code stole the chosen pane or scroll position');
  await page.evaluate(()=>window.__tabsRestoreFetch());
  await page.setViewportSize({width:320,height:500});
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('tabs overflow the small window');
  // New question removes old tab state as well as the answer. Save is intercepted locally.
  await page.route('**/api/learning-assets/sessions**',route=>route.fulfill({status:200,contentType:'application/json',body:'{"records":[]}'}));
  await page.evaluate(()=>window.__tabEvents.newQuestion());
  await page.waitForFunction(()=>document.body.classList.contains('is-empty'));
  if(!await page.locator('#liuwaAnswerTabs').isHidden())throw Error('new question retained old tabs');
  if(errors.length)throw Error(errors.join(';'));
  return {passed:true,questionTypes:7,thoughtTop,restoredTop,stream:{during,after},errors};
}

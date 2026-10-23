async (page) => {
  await page.setViewportSize({width:780,height:760});
  await page.addInitScript(() => {
    window.__GATEWAY_URL__ = 'http://127.0.0.1:8001';
    window.__spaceEvents = {};
    window.cockpit = {
      getConfig:async()=>({hotkeys:[],failedHotkeys:[],display:{opacity:.9,layout:'standard'}}),
      onCapture:fn=>window.__spaceEvents.capture=fn,
    };
  });
  let requestCount = 0;
  const answer = '# 二分查找\n\n## 解题思路\n\n' + ('维护左闭右开的搜索区间，每次缩小一半，保留可能的目标。\n\n'.repeat(25)) +
    '## 代码\n\n```python\ndef search(nums, target):\n    return [3, 4]\n```\n\n## 最终答案\n\n样例的答案是 `[3, 4]`。';
  await page.route('**/api/chat/stream', route => {
    requestCount++;
    return route.fulfill({status:200,contentType:'text/event-stream',body:'data: '+JSON.stringify({delta:answer})+'\n\ndata: {"done":true}\n\n'});
  });
  await page.goto('http://127.0.0.1:9958/index.html');
  await page.waitForFunction(()=>typeof window.__liuwaSend==='function');
  const png = await (await page.request.get('http://127.0.0.1:9958/mock_q.png')).body();
  const capture = () => page.evaluate(data=>window.__spaceEvents.capture({mime:'image/png',data}),png.toString('base64'));
  const state = () => page.evaluate(() => {
    const b=document.querySelector('.liuwa-stream');
    return {top:b.scrollTop,height:b.clientHeight,total:b.scrollHeight,shotsHidden:document.querySelector('#liuwaShots').hidden,
      count:document.querySelectorAll('.liuwa-thumb').length,expanded:document.querySelector('#liuwaToggleShots').getAttribute('aria-expanded'),
      horizontal:document.documentElement.scrollWidth>innerWidth};
  });
  for(let i=0;i<8;i++) await capture();
  if(await page.locator('#liuwaShots').isHidden()) throw Error('pending images disappeared before sending');
  await page.evaluate(()=>window.__liuwaSend());
  await page.locator('#liuwaAnswerTabs [data-panel="all"]').click();
  const expanded=await state();
  if(expanded.shotsHidden||expanded.count!==8||expanded.height<350) throw Error('answered images are missing or oversized');
  await page.screenshot({path:'output/playwright/reading-space-top-images.png'});
  await page.locator('[data-open="8"]').click();
  if(!await page.locator('.liuwa-lightbox').isVisible()) throw Error('top images cannot be reopened');
  await page.keyboard.press('Escape');
  await page.locator('#liuwaToggleShots').click();
  const collapsed=await state();
  if(!collapsed.shotsHidden||collapsed.height-expanded.height<60)throw Error('manual image collapse does not recover space');
  const titles=await page.locator('#liuwaSections option').allTextContents();
  if(!titles.includes('解题思路')||!titles.includes('最终答案')) throw Error('real answer sections missing');
  await page.locator('#liuwaSections').selectOption({label:'最终答案'});
  await page.waitForFunction(()=>document.querySelector('.liuwa-stream').scrollTop>500);
  await page.waitForTimeout(400);
  const answerPosition=await state();
  await page.locator('#liuwaSections').selectOption({label:'解题思路'});
  await page.waitForFunction(()=>document.querySelector('.liuwa-stream').scrollTop<150);
  const thoughtPosition=await state();
  if(!(answerPosition.top>thoughtPosition.top))throw Error('section navigation did not move');
  await page.locator('#liuwaDisplay > summary').click();
  await page.locator('#liuwaOpacity').fill('50');
  const opacity=await page.evaluate(()=>({panel:getComputedStyle(document.querySelector('.liuwa-reader')).backgroundColor,text:getComputedStyle(document.querySelector('.liuwa-stream')).opacity,value:document.querySelector('#liuwaOpacityValue').textContent}));
  if(!opacity.panel.includes('0.5')||opacity.text!=='1'||opacity.value!=='50%')throw Error('background opacity also faded text');
  await page.locator('#liuwaDisplay > summary').click();
  const sizes=[];
  for(const size of [{width:560,height:760},{width:1000,height:680},{width:320,height:500}]){
    await page.setViewportSize(size);
    const s=await state();
    if(s.horizontal||s.height<200)throw Error('reader overflows a supported size');
    sizes.push({...size,...s});
  }
  await page.setViewportSize({width:560,height:760});
  await page.screenshot({path:'output/playwright/reading-space-narrow.png'});
  await page.locator('#liuwaDisplay > summary').click();
  await page.locator('#liuwaLayout').selectOption('wide');
  await page.locator('#liuwaCompact').click();
  if(!await page.locator('.liuwa-reader').isHidden())throw Error('compact did not hide the reader');
  await page.locator('#liuwaCompact').click();
  if(await page.locator('.liuwa-reader').isHidden())throw Error('expanding lost the answer');
  await page.locator('#liuwaDisplay > summary').click();
  await page.evaluate(()=>window.__spaceEvents.capture({mime:'image/png',data:document.querySelector('.liuwa-thumb img').src.split(',')[1]}));
  // The queue is full: remove one first, then confirm a new capture expands the tray.
  await page.locator('#liuwaToggleShots').click();
  await page.locator('[data-remove="8"]').click({force:true});
  await page.locator('#liuwaToggleShots').click();
  await capture();
  if(await page.locator('#liuwaShots').isHidden())throw Error('a new capture stayed hidden');
  await page.evaluate(()=>window.__liuwaSend());
  if((await state()).shotsHidden||requestCount!==2)throw Error('the next answer lost top images');
  await page.unroute('**/api/chat/stream');
  return {passed:true,collapsed,expanded,titles,answerPosition,thoughtPosition,opacity,sizes};
}

async (page) => {
  const phase = 'regression';
  await page.setViewportSize({width:780,height:760});
  await page.addInitScript(()=>{
    const events=window.__readingEvents={};
    window.__GATEWAY_URL__='http://127.0.0.1:8001';
    window.cockpit={getConfig:async()=>({hotkeys:[],failedHotkeys:[]}),onCapture:fn=>events.capture=fn,onRead:fn=>events.read=fn,onScroll:fn=>events.scroll=fn};
  });
  const answer = '# 二分查找：边界与验证\n\n'+Array.from({length:10},(_,i)=>`## ${i+1}. ${['题意','区间定义','循环不变式','收缩左边界','收缩右边界','空数组','重复元素','复杂度','代码说明','最终答案'][i]}\n\n维护左闭右开的搜索区间。根据中点与目标值的关系缩小范围，每一步排除不可能成为答案的元素。\n\n这样在含重复元素时也可以定位第一个和最后一个目标值，不需要退化为逐个扫描。`).join('\n\n')+'\n\n```python\ndef lower_bound(nums, target):\n    lo, hi = 0, len(nums)\n    while lo < hi:\n        mid = (lo + hi) // 2\n        if nums[mid] < target:\n            lo = mid + 1\n        else:\n            hi = mid\n    return lo\n```\n\n结论：时间复杂度 $O(\\log n)$，样例答案为 `[3, 4]`。';
  let requests=0;
  await page.route('**/api/chat/stream',route=>{
    requests++;
    const text=requests===1?answer:'## 第二题\n\n这是另一道题的新回答，用来检查是否仍堆积上一题。';
    return route.fulfill({status:200,contentType:'text/event-stream',body:'data: '+JSON.stringify({delta:text})+'\n\ndata: {"done":true}\n\n'});
  });
  const cdp=await page.context().newCDPSession(page);await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
  await page.goto('http://127.0.0.1:9958/index.html');
  await page.waitForFunction(()=>typeof window.__liuwaSend==='function');
  const png=await (await page.request.get('http://127.0.0.1:9958/mock_q.png')).body();
  const capture=()=>page.evaluate(data=>window.__readingEvents.capture({mime:'image/png',data}),png.toString('base64'));
  const metrics=()=>page.evaluate(()=>{
    const body=document.querySelector('.liuwa-turn:last-child .liuwa-stream');
    const p=body?.querySelector('p');const style=p&&getComputedStyle(p);
    return {cards:document.querySelectorAll('.liuwa-turn').length,top:body?.scrollTop,height:body?.clientHeight,total:body?.scrollHeight,paragraphPadding:style?.padding,font:style?.fontSize,pagination:!!document.querySelector('#liuwaReadingNext')};
  });
  await capture();await page.evaluate(()=>window.__liuwaSend());
  await page.locator('#liuwaAnswerTabs [data-panel="all"]').click();
  const returned=await metrics();await page.screenshot({path:`output/playwright/reading-${phase}-returned.png`});
  await page.evaluate(()=>window.__readingEvents.read('next'));
  await page.waitForTimeout(450);
  const next=await metrics();
  await page.evaluate(()=>window.__readingEvents.read('prev'));
  await page.waitForTimeout(450);
  const previous=await metrics();
  await capture();await page.evaluate(()=>window.__liuwaSend());
  const second=await metrics();await page.screenshot({path:`output/playwright/reading-${phase}-second.png`});
  await page.unroute('**/api/chat/stream');
  if (returned.top !== 0) throw new Error('a completed answer starts at its end');
  if (!(next.top > 0 && previous.top === 0)) throw new Error('reading shortcuts do not page the current answer');
  if (second.cards !== 1 || second.height < 300 || second.top !== 0) throw new Error('the previous answer squeezed or displaced the new answer');
  if (!returned.pagination || returned.paragraphPadding !== '0px') throw new Error('the fixed reading layout did not load');

  // Actual streaming updates: pause the source, let the reader move, then append more.
  await page.evaluate(() => {
    const originalFetch = window.fetch;
    window.__restoreReadingFetch = () => { window.fetch = originalFetch; };
    window.fetch = async (url, options) => {
      if (!String(url).endsWith('/api/chat/stream')) return originalFetch(url, options);
      return new Response(new ReadableStream({start(controller) {window.__readingStream = controller;}}), {headers:{'Content-Type':'text/event-stream'}});
    };
    window.__readingEvents.capture({mime:'image/png',data:document.querySelector('.liuwa-thumb img').src.split(',')[1]});
    window.__readingSend = window.__liuwaSend();
  });
  await page.waitForFunction(() => !!window.__readingStream);
  await page.evaluate(text => window.__readingStream.enqueue(new TextEncoder().encode('data: '+JSON.stringify({delta:text})+'\n\n')), answer);
  await page.waitForSelector('#liuwaAnswerTabs [data-panel="all"]');
  await page.locator('#liuwaAnswerTabs [data-panel="all"]').click();
  await page.waitForFunction(() => document.querySelector('.liuwa-stream').scrollHeight > 1000);
  await page.locator('#liuwaReadingNext').click();
  await page.waitForFunction(() => document.querySelector('.liuwa-stream').scrollTop > 100);
  await page.waitForTimeout(450); // Wait for the requested smooth page movement to settle.
  const during = await metrics();
  await page.evaluate(() => window.__readingStream.enqueue(new TextEncoder().encode('data: '+JSON.stringify({delta:'\n\n新增内容到达，保留当前阅读位置。\n'})+'\n\n')));
  await page.waitForFunction(() => document.querySelector('.liuwa-stream').textContent.includes('新增内容到达'));
  const appended = await metrics();
  if (Math.abs(appended.top-during.top)>1) throw new Error('incoming tokens pulled the reader away from their position');
  await page.evaluate(() => { window.__readingStream.enqueue(new TextEncoder().encode('data: {"done":true}\n\n'));window.__readingStream.close(); });
  await page.evaluate(() => window.__readingSend);
  await page.locator('#liuwaReadingPrev').click();
  await page.waitForFunction(() => document.querySelector('.liuwa-stream').scrollTop === 0);
  await page.evaluate(() => window.__restoreReadingFetch());
  return {passed:true,returned,next,previous,second,during,appended};
}

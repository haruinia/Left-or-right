async(page)=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width:560,height:720});
  await page.addInitScript(()=>{
    window.__GATEWAY_URL__='http://127.0.0.1:8003';
    const display={opacity:.9,layout:'narrow',compact:true,theme:'light',answer:false,revision:0};
    window.__codeEvents={};
    window.cockpit={getConfig:async()=>({hotkeys:[],failedHotkeys:[],display:{...display}}),
      setSurface:async patch=>{if(patch.answer===false)display.compact=true;else if(patch.answer===true&&!display.answer)display.compact=false;Object.assign(display,patch);display.revision++;return {...display};},
      setDisplay:async patch=>{Object.assign(display,patch);display.revision++;return {...display,saved:true};},
      onCapture:fn=>window.__codeEvents.capture=fn};
    // Electron 的剪贴板写入不是可靠的安全上下文；用桩验证复制的是纯源码。
    window.__copied='';
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copied=text;}}});
  });
  const prefs={study_language:'Java',answer_language:'zh-CN',assistant_role:'candidate',study_instructions:''};
  await page.route('**/api/ui/settings',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(prefs)}));
  await page.route('**/api/config/models',route=>route.fulfill({status:200,contentType:'application/json',body:'{"models":["fixture-model"],"screenshot_model":"fixture-model","interview_model":"fixture-model"}'}));
  await page.route('**/api/learning-assets/sessions**',route=>route.fulfill({status:200,contentType:'application/json',body:'{"items":[],"imported":0}'}));
  const answer='<!-- liuwa:type=programming -->\n## 代码\n```java\npublic int search(int[] nums, int target) {\n    int left = 0, right = nums.length;\n    while (left < right) {\n        int mid = (left + right) >>> 1;\n        if (nums[mid] < target) left = mid + 1; else right = mid;\n    }\n    return left;\n}\n```\n## 解题思路\n二分查左边界。';
  await page.route('**/api/chat/stream',route=>route.fulfill({status:200,contentType:'text/event-stream',body:'data: '+JSON.stringify({delta:answer})+'\n\ndata: {"done":true}\n\n'}));
  await page.goto('http://127.0.0.1:9959/index.html');
  await page.waitForFunction(()=>!!window.__liuwaSend);
  const png=(await(await page.request.get('http://127.0.0.1:9959/mock_q.png')).body()).toString('base64');
  await page.evaluate(data=>window.__codeEvents.capture({mime:'image/png',data}),png);
  await page.locator('#liuwaSend').click();
  await page.waitForFunction(()=>!document.body.classList.contains('is-busy')&&document.querySelector('.md-code'));

  const shape=await page.evaluate(()=>{
    const block=document.querySelector('.md-code-block');
    const pre=block.querySelector('.md-code');
    const code=pre.querySelector('code');
    const gutter=block.querySelector('.md-code-gutter');
    const copy=block.querySelector('.md-copy');
    return {hasBlock:Boolean(block),lang:block.querySelector('.md-code-lang').textContent.trim(),
      gutter:gutter.textContent.trim().split('\n').map(Number),
      lineCount:code.textContent.replace(/\n$/,'').split('\n').length,
      copyText:copy.textContent.trim(),copyInPre:pre.contains(copy),gutterInPre:pre.contains(gutter),
      source:code.textContent.replace(/\n$/,'')};
  });
  if(!shape.hasBlock)throw Error('code block wrapper missing');
  if(shape.lang!=='java')throw Error('language label missing');
  if(shape.gutter.length!==shape.lineCount)throw Error(`gutter has ${shape.gutter.length} rows for ${shape.lineCount} lines`);
  if(shape.gutter[0]!==1||shape.gutter.at(-1)!==shape.lineCount)throw Error('gutter is not 1..n');
  if(shape.copyInPre||shape.gutterInPre)throw Error('copy button or gutter leaked into the copied source');
  if(shape.copyText!=='复制')throw Error('copy button is not labelled');

  // 复制的是原始源码，不含行号和按钮文字。
  await page.locator('.md-copy').click();
  await page.waitForFunction(()=>window.__copied.length>0);
  const copied=await page.evaluate(()=>window.__copied);
  if(copied!==shape.source)throw Error(`copied text does not match the source: ${JSON.stringify(copied.slice(0,80))}`);
  if(/^\s*1\s/m.test(copied)||copied.includes('复制'))throw Error('copied text includes the gutter or button label');
  if(await page.locator('.md-copy').textContent()!=='已复制')throw Error('copy button did not confirm');
  await page.waitForFunction(()=>document.querySelector('.md-copy').textContent==='复制',{timeout:3000});

  // 四种外观下代码块与行号都跟随主题，不重新出现深蓝实底。
  const themes=[];
  for(const theme of ['light','dark','transparent-black','transparent-white']){
    await page.locator('#liuwaDisplay > summary').click();
    await page.locator(`[data-theme-mode="${theme}"]`).click();
    await page.locator('#liuwaCloseSettings').click();
    await page.waitForTimeout(80);
    const style=await page.evaluate(()=>{
      const block=document.querySelector('.md-code-block'),reader=document.querySelector('.liuwa-reader');
      return {blockBg:getComputedStyle(block).backgroundColor,ink:getComputedStyle(reader).color,
        gutter:getComputedStyle(document.querySelector('.md-code-gutter')).color,
        codeInk:getComputedStyle(document.querySelector('.md-code code')).color};
    });
    // 普通模式代码块带深色底是原有设计；透明模式必须完全去掉实底。
    if(theme.startsWith('transparent-')){
      if(style.blockBg!=='rgba(0, 0, 0, 0)')throw Error(`${theme}: code block keeps a solid background`);
      if(new Set([style.codeInk,style.ink]).size!==1)throw Error(`${theme}: code text does not follow the theme`);
    }
    themes.push({theme,...style});
    await page.screenshot({path:`output/playwright/code-block-${theme}.png`});
  }

  // 长行只让代码横向滚动，行号列不跟着移动。
  await page.setViewportSize({width:320,height:600});
  await page.waitForTimeout(120);
  await page.evaluate(()=>{
    const body=document.createElement('div');
    body.className='liuwa-stream md';
    body.innerHTML='<div class="md-code-block"><div class="md-code-head"><span class="md-code-lang">java</span><button type="button" class="md-copy">复制</button></div><div class="md-code-body"><span class="md-code-gutter">1\n2</span><pre class="md-code"><code>public int veryLongMethodName(int alpha, int beta, int gamma, int delta) { return alpha + beta + gamma + delta; }</code></pre></div></div>';
    document.querySelector('.liuwa-turn.is-assistant').append(body);
  });
  const overflow=await page.evaluate(()=>{
    const pre=[...document.querySelectorAll('.md-code')].at(-1),gutter=pre.closest('.md-code-block').querySelector('.md-code-gutter');
    pre.scrollLeft=pre.scrollWidth;
    return {scrollable:pre.scrollWidth>pre.clientWidth,gutterLeft:gutter.getBoundingClientRect().left,preLeft:pre.getBoundingClientRect().left,gutterScroll:gutter.scrollLeft};
  });
  if(!overflow.scrollable)throw Error('a long code line did not make the code scroll');
  if(overflow.gutterScroll!==0)throw Error('gutter scrolled with the code');
  if(overflow.gutterLeft>overflow.preLeft)throw Error('gutter is not left of the code');
  // 行号用正文色加透明度，暗色主题下不会变成看不清的深灰。
  const gutterInk=await page.evaluate(()=>{const g=getComputedStyle([...document.querySelectorAll('.md-code-gutter')].at(-1));return {color:g.color,opacity:g.opacity};});
  if(Number(gutterInk.opacity)>0.6||Number(gutterInk.opacity)<0.2)throw Error(`gutter opacity is ${gutterInk.opacity}`);
  await page.screenshot({path:'output/playwright/code-block-narrow.png'});

  if(errors.length)throw Error(errors.join(';'));
  return {passed:true,shape,copiedLength:copied.length,themes,overflow,errors};
}

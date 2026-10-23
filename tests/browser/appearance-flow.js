async(page)=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width:560,height:720});
  await page.addInitScript(()=>{
    const display={opacity:.37,layout:'narrow',compact:true,theme:'light',answer:false,revision:0};
    window.__appearanceEvents={};
    window.cockpit={getConfig:async()=>({display:{...display}}),
      setSurface:async patch=>{if(patch.answer===false)display.compact=true;else if(patch.answer===true&&!display.answer)display.compact=false;Object.assign(display,patch);display.revision++;window.__appearanceEvents.display?.({...display});return {...display};},
      setDisplay:async patch=>{Object.assign(display,patch);display.revision++;return {...display,saved:true};},
      onDisplay:fn=>window.__appearanceEvents.display=fn,onCapture:fn=>window.__appearanceEvents.capture=fn};
  });
  let prefs={study_language:'Clojure',answer_language:'zh-CN',assistant_role:'candidate'};
  await page.route('**/api/ui/settings',route=>{
    if(route.request().method()==='PATCH')prefs={...prefs,...route.request().postDataJSON()};
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(prefs)});
  });
  await page.route('**/api/config/models',route=>route.fulfill({status:200,contentType:'application/json',body:'{"models":["fixture-model"],"screenshot_model":"fixture-model","interview_model":"fixture-model"}'}));
  await page.route('**/api/learning-assets/sessions**',route=>route.fulfill({status:200,contentType:'application/json',body:'{"items":[],"imported":0}'}));
  await page.route('**/api/chat/stream',route=>route.fulfill({status:200,contentType:'text/event-stream',body:'data: '+JSON.stringify({delta:'<!-- liuwa:type=programming -->\n## 解题思路\n用哈希表记录已经遍历的数。\n## 代码\n```python\ndef two_sum(nums, target):\n    seen = {}\n    for i, value in enumerate(nums):\n        if target - value in seen:\n            return [seen[target - value], i]\n        seen[value] = i\n```\n## 答案\n返回两个下标。'})+'\n\ndata: {"done":true}\n\n'}));
  await page.goto('http://127.0.0.1:9958/index.html');
  await page.waitForFunction(()=>!!window.__liuwaSend);
  const png=(await(await page.request.get('http://127.0.0.1:9958/mock_q.png')).body()).toString('base64');
  await page.evaluate(data=>window.__appearanceEvents.capture({mime:'image/png',data}),png);
  await page.locator('#liuwaSend').click();
  await page.waitForFunction(()=>!document.body.classList.contains('is-busy')&&document.querySelector('.md-code'));
  await page.locator('#liuwaDisplay > summary').click();
  await page.waitForFunction(()=>!document.querySelector('#quickProgrammingLanguage').disabled);
  if(await page.locator('#quickProgrammingLanguage').inputValue()!=='Clojure')throw Error('custom language was lost');
  await page.locator('#quickProgrammingLanguage').selectOption('Java');
  await page.waitForFunction(()=>!document.querySelector('#quickProgrammingLanguage').disabled);
  if(prefs.study_language!=='Java')throw Error('selected programming language was not saved');
  const captures=[];
  for(const theme of ['light','dark','transparent-black','transparent-white']){
    await page.locator(`[data-theme-mode="${theme}"]`).click();
    await page.mouse.move(0,0);await page.waitForTimeout(150);
    const details=await page.evaluate(()=>{
      const panel=document.querySelector('.liuwa-display-panel'),reader=document.querySelector('.liuwa-reader');
      const h=panel.querySelector('header').getBoundingClientRect(),k=panel.querySelector('.liuwa-shortcuts').getBoundingClientRect();
      const colors=[...document.querySelectorAll('.liuwa-command-bar,.liuwa-reader,.liuwa-display-panel')].map(e=>getComputedStyle(e).backgroundColor);
      const samples=[...document.querySelectorAll('.liuwa-command-bar,.liuwa-reader,.liuwa-display-panel')].map(e=>{const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+3)};});
      return {colors,samples,clip:reader.style.clipPath,codeBg:getComputedStyle(document.querySelector('.md-code')).backgroundColor,codeInk:getComputedStyle(document.querySelector('.md-code code')).color,ink:getComputedStyle(reader).color,
        controls:[...panel.querySelectorAll('select,button,input:not([type="range"])')].map(e=>getComputedStyle(e).backgroundColor),header:h.top,keys:k.top,ratio:devicePixelRatio};
    });
    if(new Set(details.colors).size!==1)throw Error(`${theme}: surface colors differ`);
    if(details.header>=details.keys)throw Error('shortcut list moved ahead of the settings header');
    if(!details.clip.startsWith('polygon'))throw Error('settings background still layers over the reader');
    if(details.codeInk!==details.ink)throw Error(`${theme}: code text does not follow the theme`);
    if(details.codeBg!=='rgba(0, 0, 0, 0)'||details.controls.some(c=>c!=='rgba(0, 0, 0, 0)'))throw Error(`${theme}: opaque code or controls remain`);
    const path=`output/playwright/appearance-${theme}.png`;
    await page.screenshot({path,omitBackground:true});captures.push({theme,path,...details});
  }
  for(const size of [{width:320,height:500},{width:1000,height:680}]){
    await page.setViewportSize(size);
    await page.waitForTimeout(50);
    const bounds=await page.locator('.liuwa-display-panel').boundingBox();
    if(bounds.x<0||bounds.x+bounds.width>size.width||bounds.y+bounds.height>size.height+1)throw Error('settings overflow a supported viewport');
  }
  await page.locator('#liuwaCloseSettings').click();
  await page.waitForFunction(()=>document.querySelector('.liuwa-reader').style.clipPath==='');
  if(!await page.locator('.md-code').isVisible())throw Error('closing settings lost the code');
  await page.reload();await page.locator('#liuwaDisplay > summary').click();
  await page.waitForFunction(()=>!document.querySelector('#quickProgrammingLanguage').disabled);
  if(await page.locator('#quickProgrammingLanguage').inputValue()!=='Java')throw Error('reopening lost the selected language');
  if(errors.length)throw Error(errors.join(';'));
  return {passed:true,prefs,captures,errors};
}

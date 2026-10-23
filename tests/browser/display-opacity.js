async(page)=>{
  await page.setViewportSize({width:560,height:720});
  await page.addInitScript(()=>{
    const display={opacity:.9,layout:'narrow',compact:true,theme:'light',answer:false,revision:0};
    window.cockpit={getConfig:async()=>({display:{...display}}),
      setSurface:async patch=>({...display,...patch}),
      setDisplay:async patch=>{Object.assign(display,patch);display.revision++;return {...display,saved:true};}};
  });
  await page.route('**/api/**',route=>route.fulfill({status:200,contentType:'application/json',body:'{"items":[],"models":[]}'}));
  await page.goto('http://127.0.0.1:9958/index.html');
  await page.waitForFunction(()=>!!window.__liuwaSend);
  await page.locator('#liuwaDisplay > summary').click();
  const results=[];const failures=[];
  for(const theme of ['light','dark','transparent-black','transparent-white']){
    await page.locator(`[data-theme-mode="${theme}"]`).click();
    for(const opacity of [30,80,0,100]){
      await page.evaluate(value=>{const input=document.querySelector('#liuwaOpacity');input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));},opacity);
      await page.evaluate(async()=>{
        const {applyDisplay}=await import('/modules/display.js');applyDisplay({compact:false,answer:true});
        document.body.classList.remove('is-empty');
      });
      const panels=await page.locator('.liuwa-command-bar,.liuwa-reader,.liuwa-display-panel').evaluateAll(elements=>elements.map(el=>{
        const css=getComputedStyle(el);return {panel:el.className,alpha:Number(css.backgroundColor.match(/[\d.]+/g)?.[3]??1),border:css.borderTopWidth,shadow:css.boxShadow,opacity:css.opacity};
      }));
      for(const panel of panels){
        if(Math.abs(panel.alpha-(theme.startsWith('transparent-')?0:opacity/100))>.001)failures.push(`${theme} ${panel.panel}: requested ${opacity}%, got background alpha ${panel.alpha}`);
        if(panel.border!=='0px'||panel.shadow!=='none')failures.push(`${panel.panel}: still has an outer frame`);
        if(panel.opacity!=='1')failures.push(`${panel.panel}: text opacity must stay at 100%`);
      }
      const backgrounds=await page.locator('.liuwa-command-bar,.liuwa-reader,.liuwa-display-panel').evaluateAll(es=>es.map(e=>getComputedStyle(e).backgroundColor));
      if(new Set(backgrounds).size!==1)failures.push(`${theme}: panels use different background colors`);
      results.push({theme,opacity,panels});
      if(opacity===30)await page.screenshot({path:`output/playwright/opacity-${theme}-30.png`,omitBackground:true});
    }
  }
  if(failures.length)throw Error([...new Set(failures)].join('; '));
  return {passed:true,results};
}

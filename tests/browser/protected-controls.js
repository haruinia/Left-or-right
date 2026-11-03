async (page) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.__APP_SETTINGS__ = true; });
  const prefs = {study_specialty:'计算机 / 软件工程',study_language:'Go',answer_language:'zh-CN',assistant_role:'candidate',study_answer_style:'solution',study_goal:'',study_instructions:'',jd_text:'',resume_text:'',long_term_memory_consent:false};
  await page.route('**/api/ui/settings', route => route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(prefs)}));
  await page.route('**/api/config/llm/profiles', route => route.fulfill({status:200,contentType:'application/json',body:'{"profiles":[],"presets":[],"active_profile_id":""}'}));
  await page.route('**/api/learning-assets/**', route => route.fulfill({status:200,contentType:'application/json',body:'{"items":[]}'}));
  await page.setViewportSize({width:1280,height:900});
  await page.goto('http://127.0.0.1:9958/settings#study');
  await page.waitForFunction(() => !document.querySelector('#studySpecialty').disabled);
  const specialty = page.locator('#studySpecialty');
  const language = page.locator('#studyLanguage');
  await specialty.evaluate(select => {
    window.__protectedChanges = 0;
    select.addEventListener('change', () => { window.__protectedChanges += 1; });
    select.addEventListener('pointerdown', event => { window.__protectedDefaultPrevented = event.defaultPrevented; });
  });
  await specialty.click();
  const menu = page.locator('.protected-select-menu');
  await menu.waitFor();
  if (!await page.evaluate(() => window.__protectedDefaultPrevented)) throw Error('The OS dropdown event was not suppressed.');
  if (!await specialty.isVisible() || await specialty.evaluate(select => select.tagName) !== 'SELECT') throw Error('The bound SELECT was replaced or hidden.');
  if (await menu.locator('[role="group"]').count() !== 3) throw Error('Study option groups were not retained.');
  if (await menu.locator('[role="option"]').count() < 33) throw Error('The complete shared study list is missing.');
  const opacityChecks = await page.evaluate(() => {
    const root = document.documentElement;
    const previousTheme = root.getAttribute('data-theme');
    const previousStyle = document.body.getAttribute('style');
    const channels = color => (color.match(/[\d.]+/g) || []).map(Number);
    const luminance = color => channels(color).slice(0,3).map(value => {
      const c=value/255;return c<=.04045 ? c/12.92 : ((c+.055)/1.055)**2.4;
    }).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);
    const checks=[];
    for(const opacity of [.15,.3]) {
      document.body.style.setProperty('--panel-opacity',String(opacity));
      document.body.style.setProperty('--surface',`rgba(255,255,255,${opacity})`);
      document.body.style.setProperty('--ink','rgba(25,37,69,.2)');
      for(const theme of ['light','dark','transparent-black','transparent-white']) {
        root.dataset.theme=theme;
        const popup=document.querySelector('.protected-select-menu');
        const style=getComputedStyle(popup);
        const option=getComputedStyle(popup.querySelector('.protected-select-option'));
        const group=getComputedStyle(popup.querySelector('.protected-select-group'));
        const background=luminance(style.backgroundColor);
        const contrast=foreground=>(Math.max(luminance(foreground),background)+.05)/(Math.min(luminance(foreground),background)+.05);
        const bgChannels=channels(style.backgroundColor);
        const dark=['dark','transparent-white'].includes(theme);
        checks.push({opacity,theme,menuAlpha:bgChannels.length>3?bgChannels[3]:1,elementOpacity:style.opacity,optionContrast:contrast(option.color),groupContrast:contrast(group.color),correctTone:dark?background<.1:background>.8});
      }
    }
    if(previousTheme===null)root.removeAttribute('data-theme');else root.setAttribute('data-theme',previousTheme);
    if(previousStyle===null)document.body.removeAttribute('style');else document.body.setAttribute('style',previousStyle);
    return checks;
  });
  if(opacityChecks.some(check=>check.menuAlpha!==1 || check.elementOpacity!=='1' || check.optionContrast<4.5 || check.groupContrast<4.5 || !check.correctTone))throw Error(`Protected menu contrast or opacity failed: ${JSON.stringify(opacityChecks)}`);
  await menu.getByRole('option', {name:'行测',exact:true}).click();
  if (await specialty.inputValue() !== '行测' || !await language.isDisabled()) throw Error('DOM choice did not update the original study binding.');
  if (await page.evaluate(() => window.__protectedChanges) !== 1 || await menu.count()) throw Error('Choice dispatched duplicate changes or left the popup open.');

  await specialty.press('Space');
  await menu.waitFor();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  if (await specialty.inputValue() !== '计算机 / 软件工程' || await language.isDisabled()) throw Error('Keyboard navigation did not restore the technical direction.');
  await specialty.click();
  await menu.getByRole('option', {name:'计算机 / 软件工程',exact:true}).click();
  if (await page.evaluate(() => window.__protectedChanges) !== 2) throw Error('Choosing the same value emitted another change.');

  await language.evaluate(select => {
    [...select.options].find(option => option.value === 'Java').disabled = true;
    [...select.querySelectorAll('optgroup')].find(group => group.label === '其他语言').disabled = true;
  });
  await language.click();
  if (!await menu.getByRole('option', {name:'Java',exact:true}).isDisabled()) throw Error('Disabled options became selectable.');
  if (!await menu.getByRole('option', {name:'MATLAB',exact:true}).isDisabled()) throw Error('Disabled option groups became selectable.');
  await page.keyboard.press('Escape');
  if (await menu.count() || !await language.evaluate(select => select === document.activeElement)) throw Error('Escape did not close and restore focus.');
  await language.press('F4');
  await menu.waitFor();
  await page.keyboard.press('Tab');
  if (await menu.count()) throw Error('Tab did not close the popup.');
  await language.press('Alt+ArrowDown');
  await menu.waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  if (await menu.count()) throw Error('Blur left the private dropdown visible.');

  await language.evaluate(select => select.add(new Option('<img src=x onerror=alert(1)>', 'literal-test')));
  await language.click();
  const literal = menu.getByRole('option', {name:'<img src=x onerror=alert(1)>',exact:true});
  if (await literal.count() !== 1 || await menu.locator('img').count()) throw Error('An option label was interpreted as HTML.');
  await page.keyboard.press('Escape');

  await page.setViewportSize({width:375,height:812});
  await language.click();
  const rect = await menu.boundingBox();
  if (!rect || rect.x < 0 || rect.y < 0 || rect.x + rect.width > 376 || rect.y + rect.height > 813) throw Error('Private dropdown escaped the mobile viewport.');
  if (!await menu.evaluate(element => element.scrollHeight > element.clientHeight)) throw Error('The long language list is not scrollable.');
  await page.keyboard.press('Escape');

  await page.locator('.settings-nav a[href="#models"]').click();
  await page.locator('#llmNewProfile').click();
  await page.locator('#llmModel').focus();
  if (await page.locator('#llmModel').getAttribute('list') !== null) throw Error('A protected model field still opens system datalist suggestions.');
  await page.locator('a[href="#study"]').click();
  await page.evaluate(() => { window.__APP_SETTINGS__ = false; document.documentElement.classList.remove('liuwa-host'); });
  const ordinary = await language.evaluate(select => {
    const event = new PointerEvent('pointerdown', {bubbles:true,cancelable:true,button:0});
    select.dispatchEvent(event);
    return {defaultPrevented:event.defaultPrevented,popup:!!document.querySelector('.protected-select-menu')};
  });
  if (ordinary.defaultPrevented || ordinary.popup) throw Error('The ordinary browser page lost its native dropdown behavior.');

  await page.evaluate(() => { document.documentElement.classList.add('liuwa-host'); document.body.classList.add('liuwa-armed'); });
  await language.click();
  await menu.waitFor();
  await page.evaluate(() => { document.body.classList.remove('liuwa-armed'); document.body.inert = true; });
  await page.waitForFunction(() => !document.querySelector('.protected-select-menu'));
  if (errors.length) throw Error(errors.join(';'));
  return {passed:true,sameWindowPopup:true,opaqueMenusAcrossThemes:true,menuContrastChecks:opacityChecks.length,selectBindingsPreserved:true,groupsAndDisabledOptions:true,keyboardAndEscape:true,noDuplicateChange:true,literalLabels:true,longListAndMobile:true,ordinaryBrowserUnchanged:true,gateReleaseClosesPopup:true,errors};
}

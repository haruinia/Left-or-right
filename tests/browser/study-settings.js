async (page) => {
  const base = 'http://127.0.0.1:9958';
  const defaults = await (await page.request.get(`${base}/api/ui/settings`, {headers:{'user-agent':'Left-or-right UI test'}})).json();
  let prefs = {...defaults,study_specialty:'计算机 / 软件工程',study_language:'Go',jd_text:'',resume_text:'',study_goal:'',study_instructions:''};
  const patches=[];
  const errors=[];
  const routePreferences=async route=>{
    if(route.request().method()==='PATCH') {
      const body=route.request().postDataJSON();patches.push(body);prefs={...prefs,...body};
    }
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(prefs)});
  };
  await page.route('**/api/ui/settings',routePreferences);
  await page.route('**/api/learning-assets/**',route=>route.fulfill({status:200,contentType:'application/json',body:'{"items":[]}'}));
  page.on('pageerror',error=>errors.push(error.message));
  await page.setViewportSize({width:1440,height:1000});
  await page.goto(`${base}/settings#study`);
  await page.waitForFunction(()=>!document.querySelector('#studySpecialty').disabled);
  const options=async(selector,target=page)=>target.locator(`${selector} option`).evaluateAll(nodes=>nodes.map(option=>option.value));
  const languages=await options('#studyLanguage');
  const specialties=await options('#studySpecialty');
  if(languages.length<30 || !languages.includes('PHP') || !languages.includes('Java') || !languages.includes('CUDA'))throw Error('web language menu is incomplete');
  if(!specialties.includes('行测') || !specialties.includes('申论'))throw Error('exam directions are missing');
  if(await page.locator('#studyLanguage').inputValue()!=='Go')throw Error('saved Go was not preserved');
  if(await page.locator('#studySpecialty optgroup').evaluateAll(groups=>groups.map(group=>group.label)).then(groups=>!groups.includes('考试与资格')))throw Error('exam directions are not grouped');

  await page.locator('#studySpecialty').selectOption('行测');
  if(!await page.locator('#studyLanguage').isDisabled())throw Error('exam still offers code language');
  await page.locator('#saveUiSettings').click();
  await page.waitForFunction(()=>document.querySelector('#saveUiSettings').disabled);
  if(JSON.stringify(patches.at(-1))!==JSON.stringify({study_specialty:'行测'}))throw Error('specialty save overwrote unrelated fields');

  const app=await page.context().newPage();
  try {
    app.on('pageerror',error=>errors.push(error.message));
    await app.setViewportSize({width:560,height:720});
    await app.route('**/api/ui/settings',routePreferences);
    await app.route('**/api/learning-assets/**',route=>route.fulfill({status:200,contentType:'application/json',body:'{"items":[]}'}));
    await app.addInitScript(()=>{
      window.__GATEWAY_URL__='http://127.0.0.1:9958';
      window.cockpit={getConfig:async()=>({armed:true,hotkeys:[],failedHotkeys:[],display:{opacity:.9,theme:'light',layout:'narrow',compact:true},captureOptions:{mode:'area',displayId:'1',displays:[{id:'1',label:'测试屏',width:1440,height:900}]}}),setSurface:async()=>({}),onArmed(){}};
    });
    await app.goto(`${base}/`);
    await app.locator('#liuwaDisplay > summary').click();
    await app.waitForFunction(()=>!document.querySelector('#quickSpecialty').disabled);
    if(JSON.stringify(await options('#quickSpecialty',app))!==JSON.stringify(specialties))throw Error('app and web specialty menus differ');
    if(JSON.stringify(await options('#quickProgrammingLanguage',app))!==JSON.stringify(languages))throw Error('app and web language menus differ');
    if(await app.locator('#quickSpecialty').inputValue()!=='行测' || !await app.locator('#quickProgrammingLanguage').isDisabled())throw Error('app did not pick up web exam selection');
    await app.locator('#quickSpecialty').selectOption('后端开发');
    await app.waitForFunction(()=>!document.querySelector('#quickProgrammingLanguage').disabled);
    if(await app.locator('#quickProgrammingLanguage').inputValue()!=='Go')throw Error('returning from exam discarded code language');
    await app.locator('#quickProgrammingLanguage').selectOption('Rust');
    await app.waitForFunction(()=>!document.querySelector('#quickProgrammingLanguage').disabled);
    await page.reload();
    await page.waitForFunction(()=>!document.querySelector('#studySpecialty').disabled);
    if(await page.locator('#studySpecialty').inputValue()!=='后端开发' || await page.locator('#studyLanguage').inputValue()!=='Rust')throw Error('web did not pick up app preferences');

    await page.locator('#studySpecialty').selectOption('__custom__');
    await page.locator('#studySpecialtyCustom').fill('物流管理');
    await page.locator('#studyLanguage').selectOption('__custom__');
    await page.locator('#studyLanguageCustom').fill('OCaml');
    await page.locator('#saveUiSettings').click();
    await page.waitForFunction(()=>document.querySelector('#saveUiSettings').disabled);
    await app.locator('#liuwaCloseSettings').click();
    await app.locator('#liuwaDisplay > summary').click();
    await app.waitForFunction(()=>document.querySelector('#quickProgrammingLanguage').value==='OCaml');
    if(await app.locator('#quickSpecialty').inputValue()!=='物流管理')throw Error('custom specialty lost in app');
    await app.locator('#quickProgrammingLanguage').selectOption('__custom__');
    await app.locator('#quickProgrammingLanguageCustom').fill('Fortran');
    await app.locator('#quickProgrammingLanguageCustom').press('Tab');
    await app.waitForFunction(()=>document.querySelector('#quickProgrammingLanguage').value==='Fortran');
    await page.reload();
    await page.waitForFunction(()=>document.querySelector('#studyLanguage').value==='Fortran');
    if((await options('#studyLanguage')).filter(value=>value==='Fortran').length!==1)throw Error('custom language duplicated');
    await page.setViewportSize({width:375,height:812});
    if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('mobile study form overflows');
    await app.locator('#quickSpecialty').selectOption('申论');
    await app.waitForFunction(()=>!document.querySelector('#quickSpecialty').disabled);
    if(!await app.locator('#quickProgrammingLanguage').isDisabled())throw Error('custom language remained enabled for exam');
    if(errors.length)throw Error(errors.join(';'));
    return {passed:true,specialtyChoices:specialties.length,languageChoices:languages.length,appWebOptionsMatch:true,bidirectionalSave:true,examRetainsCodeLanguage:true,customValuesPreserved:true,mobileOverflow:false,errors};
  } finally {await app.close();}
}

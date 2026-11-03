async (page, {base=new URL(page.url()).origin}={})=>{
  const errors=[],patches=[];
  page.on('pageerror',error=>errors.push(error.message));
  const initial=await(await page.request.get(`${base}/api/ui/settings`,{headers:{'user-agent':'Left-or-right UI test'}})).json();
  let settings={...initial,interview_use_knowledge:false,study_language:'Java',jd_text:'保留的岗位',resume_text:'保留的简历'};
  await page.route('**/api/ui/settings',async route=>{
    if(route.request().method()==='PATCH'){const body=route.request().postDataJSON();patches.push(body);settings={...settings,...body};}
    await route.fulfill({json:settings});
  });
  await page.route('**/api/config/llm/profiles',route=>route.fulfill({json:{profiles:[],presets:[],active_profile_id:''}}));
  await page.route('**/api/learning-assets/**',route=>route.fulfill({json:{items:[]}}));
  const check=(value,message)=>{if(!value)throw Error(message);};
  await page.setViewportSize({width:1100,height:850});
  await page.goto(`${base}/settings?knowledge-test#briefing`);
  const checkbox=page.locator('#interviewUseKnowledge');
  await page.waitForFunction(()=>!document.querySelector('#interviewUseKnowledge').disabled);
  check(!await checkbox.isChecked(),'Knowledge must not start enabled');
  check((await page.locator('#interviewKnowledgeHint').textContent()).includes('发送给当前大模型'),'Outbound reference disclosure missing');
  check(await page.locator('#interviewUseKnowledge').count()===1,'Knowledge controls duplicated');
  await checkbox.check();
  await page.locator('#saveUiSettings').click();
  await page.waitForFunction(()=>document.querySelector('#saveUiSettings').disabled);
  check(patches.length===1&&JSON.stringify(patches[0])===JSON.stringify({interview_use_knowledge:true}),'Saving knowledge overwrote another setting');
  await page.reload();
  await page.waitForFunction(()=>!document.querySelector('#interviewUseKnowledge').disabled);
  check(await checkbox.isChecked(),'Knowledge preference did not survive reopening');
  check(await page.locator('#jdText').inputValue()==='保留的岗位'&&await page.locator('#resumeText').inputValue()==='保留的简历','Briefing fields changed');
  await page.locator('#interviewKnowledgeHint a').click();
  await page.waitForFunction(()=>!document.querySelector('#assetKB').hidden&&!document.querySelector('#assets').hidden);
  check(await page.locator('.settings-nav a[href="#assets"]').getAttribute('aria-current')==='page','Knowledge deep link did not select learning records');
  await page.goBack();
  await page.waitForFunction(()=>!document.querySelector('#briefing').hidden);
  await checkbox.uncheck();await page.locator('#saveUiSettings').click();
  await page.waitForFunction(()=>document.querySelector('#saveUiSettings').disabled);
  check(patches.length===2&&JSON.stringify(patches[1])===JSON.stringify({interview_use_knowledge:false}),'Disabling knowledge did not save just the preference');
  await page.setViewportSize({width:375,height:812});
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Knowledge setting overflows narrow layout');
  check(errors.length===0,errors.join('\n'));
  return {passed:true,optInDefaultOff:true,oneControl:true,outboundDisclosure:true,patchIsolation:true,reloadPersistence:true,knowledgeDeepLink:true,narrowLayout:true};
}

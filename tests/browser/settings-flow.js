async (page, {base=new URL(page.url()).origin}={})=>{
  const errors=[],writes=[],reveals=[];
  page.on('pageerror',error=>errors.push(error.message));
  const initial=await(await page.request.get(`${base}/api/ui/settings`,{headers:{'user-agent':'Left-or-right UI test'}})).json();
  const prefs={...initial,interview_use_knowledge:false,assistant_role:'candidate'};
  let active='personal',saveFails=false,next=0;
  let models=[{id:'personal',name:'个人接口',llm_model:'shared-model',llm_base_url:'https://personal.example.test/v1',llm_protocol:'auto',llm_api_path:'/chat/completions',llm_auth_header:'Authorization',llm_auth_scheme:'Bearer',llm_response_content_path:'choices.0.message.content',llm_extra_body_json:'',llm_max_tokens:30000,vision_model:'',llm_api_key_configured:true},{id:'work',name:'公司接口',llm_model:'shared-model',llm_base_url:'https://work.example.test/v1',llm_protocol:'auto',llm_api_path:'/chat/completions',llm_auth_header:'Authorization',llm_auth_scheme:'Bearer',llm_response_content_path:'choices.0.message.content',llm_extra_body_json:'',llm_max_tokens:30000,vision_model:'',llm_api_key_configured:true}];
  let asrActive='speech',speech=[{id:'speech',name:'个人语音',provider:'aliyun_ws',endpoint:'wss://speech.example.test/inference',model:'speech-model',language_hints:'zh,en',vocabulary_id:'',api_key_configured:true}];
  await page.route('**/api/ui/settings',route=>route.fulfill({json:prefs}));
  await page.route('**/api/learning-assets/**',route=>route.fulfill({json:{items:[]}}));
  await page.route('**/api/config/llm**',async route=>{
    const path=new URL(route.request().url()).pathname,method=route.request().method();
    const store=()=>({profiles:models,active_profile_id:active,presets:[]});
    if(path.endsWith('/key')){reveals.push(path);return route.fulfill({json:{llm_api_key:'local-test-key'}});}
    if(path.endsWith('/check'))return route.fulfill({json:{ok:true}});
    if(path.endsWith('/activate')){const value=route.request().postDataJSON();writes.push({path,body:value});active=value.profile_id;return route.fulfill({json:store()});}
    if(method==='DELETE'){models=models.filter(item=>item.id!==decodeURIComponent(path.split('/').at(-1)));return route.fulfill({json:store()});}
    if(path.endsWith('/import')){writes.push({path,body:route.request().postDataJSON()});models.push({...models[0],id:'imported',name:'导入接口'});return route.fulfill({json:{...store(),imported:1}});}
    if(method==='POST'&&path==='/api/config/llm'){
      const value=route.request().postDataJSON();writes.push({path,body:value});
      if(saveFails)return route.fulfill({status:503,json:{detail:'测试保存失败'}});
      const profile={...value,id:value.profile_id||`created-${++next}`,llm_api_key_configured:true};
      const index=models.findIndex(item=>item.id===profile.id);if(index>=0)models[index]=profile;else models.push(profile);active=profile.id;
    }
    return route.fulfill({json:store()});
  });
  await page.route('**/api/config/asr/**',async route=>{
    const path=new URL(route.request().url()).pathname,method=route.request().method();
    if(path.endsWith('/key'))return route.fulfill({json:{api_key:'local-speech-key'}});
    if(path.endsWith('/check'))return route.fulfill({json:{ok:true,detail:'连接验证通过；尚未进行语音识别。'}});
    if(path.endsWith('/activate'))asrActive=route.request().postDataJSON().profile_id;
    if(method==='DELETE')speech=speech.filter(item=>item.id!==path.split('/').at(-1));
    if(method==='POST'&&path.endsWith('/profiles')){const value=route.request().postDataJSON();writes.push({path,body:value});const profile={...value,id:value.id||'new-speech',api_key_configured:true};delete profile.api_key;const index=speech.findIndex(item=>item.id===profile.id);if(index>=0)speech[index]=profile;else speech.push(profile);asrActive=profile.id;}
    return route.fulfill({json:{profiles:speech,active_profile_id:asrActive}});
  });
  const check=(value,message)=>{if(!value)throw Error(message);};
  await page.setViewportSize({width:1100,height:850});
  await page.goto(`${base}/settings?flow#models`);
  await page.locator('[data-edit="personal"]').waitFor();
  check(!await page.locator('#llmForm').isVisible()&&!await page.locator('#asrForm').isVisible()&&!await page.locator('#llmImport').isVisible(),'Root list exposes editor/import fields');
  check(await page.locator('.settings-nav a[href="#asr"]').count()===0&&await page.locator('.settings-nav a[href="#interview"]').count()===0,'Redundant sections remain in navigation');
  await page.locator('[data-edit="work"]').click();
  await page.waitForFunction(()=>document.querySelector('#llmName').value==='公司接口'&&!document.querySelector('#llmForm').hidden);
  check(active==='personal','Opening inactive profile changed current model');
  check(await page.locator('#llmApiKey').inputValue()==='************','Editor did not mask saved credential');
  check(!await page.locator('#checkModel').isVisible(),'Inactive profile offers misleading active-model check');
  await page.locator('#llmToggleKey').click();
  await page.waitForFunction(()=>document.querySelector('#llmApiKey').type==='text'&&document.querySelector('#llmApiKey').value==='local-test-key');
  check(reveals.at(-1)==='/api/config/llm/profiles/work/key','Reveal did not use selected profile');
  await page.locator('#llmName').fill('保留的编辑草稿');
  await page.locator('.settings-nav a[href="#briefing"]').click();
  check(await page.locator('#llmApiKey').getAttribute('type')==='password'&&await page.locator('#llmApiKey').inputValue()==='************','Leaving editor retained revealed credential');
  await page.locator('.settings-nav a[href="#models"]').click();
  await page.locator('[data-edit="work"]').click();
  check(await page.locator('#llmName').inputValue()==='保留的编辑草稿','Unrelated navigation discarded unsaved editor input');
  await page.locator('#llmCancelEdit').click();await page.waitForFunction(()=>!document.querySelector('#llmList').hidden);
  await page.locator('[data-edit="work"]').click();check(await page.locator('#llmName').inputValue()==='公司接口','Cancel did not discard draft');
  await page.locator('#settingsBack').click();await page.waitForFunction(()=>!document.querySelector('#llmList').hidden);
  await page.locator('#llmNewProfile').click();await page.locator('#llmName').fill('备用模型');await page.locator('#llmBaseUrl').fill('https://new.example.test/v1');await page.locator('#llmModel').fill('new-model');
  saveFails=true;await page.locator('#saveLlmProfile').click();await page.getByText(/保存未完成/).waitFor();
  check(await page.locator('#llmForm').isVisible()&&await page.locator('#llmName').inputValue()==='备用模型','Failed save lost editor draft');
  saveFails=false;await page.locator('#saveLlmProfile').click();await page.waitForFunction(()=>!document.querySelector('#llmList').hidden);await page.getByText('备用模型',{exact:true}).waitFor();
  await page.locator('#llmOpenImport').click();check(await page.locator('#llmImport').isVisible()&&!await page.locator('#llmForm').isVisible(),'Import is not a separate view');
  await page.locator('#llmImportText').fill('{invalid');await page.locator('#importLlmProfile').click();check((await page.locator('#llmImportState').textContent()).includes('JSON'),'Invalid import did not retain actionable error');
  const beforeImport=active;await page.locator('#llmImportText').fill('{"base_url":"https://import.example.test/v1","model":"imported-model"}');await page.locator('#importLlmProfile').click();await page.waitForFunction(()=>!document.querySelector('#llmList').hidden);check(active===beforeImport,'Import switched current model');
  await page.locator('#connectionTabs a[href="#models/asr"]').click();await page.locator('[data-asr-edit="speech"]').waitFor();
  check(!await page.locator('#asrForm').isVisible(),'Speech list exposes its editor');
  await page.locator('[data-asr-edit="speech"]').click();await page.waitForFunction(()=>document.querySelector('#asrApiKey').value==='************');
  check(await page.locator('#asrProvider option').count()===2&&await page.locator('#asrProvider').isDisabled(),'Saved speech provider must remain immutable while both services are available');
  await page.locator('#asrName').fill('语音草稿');check(await page.locator('#asrCheck').isDisabled(),'Dirty speech editor tests stale saved config');
  await page.locator('#settingsBack').click();await page.waitForFunction(()=>!document.querySelector('#asrList').hidden);await page.goForward();await page.waitForFunction(()=>!document.querySelector('#asrForm').hidden);check(await page.locator('#asrName').inputValue()==='语音草稿','Forward navigation lost speech draft');
  await page.locator('#asrCancel').click();await page.waitForFunction(()=>!document.querySelector('#asrList').hidden);
  await page.goto(`${base}/settings?deep#models/llm/personal`);await page.waitForFunction(()=>document.querySelector('#llmName').value==='个人接口');
  await page.locator('#settingsBack').click();await page.waitForFunction(()=>!document.querySelector('#llmList').hidden);
  check(await page.locator('#llmForm').isVisible()===false,'Direct editor Back did not return to its list');
  await page.locator('[data-delete="work"]').click();await page.locator('dialog[open]').waitFor();await page.evaluate(()=>window.dispatchEvent(new Event('app:privacy-hidden')));await page.waitForFunction(()=>!document.querySelector('dialog'));
  check(models.some(item=>item.id==='work'),'Privacy hide confirmed model deletion');
  await page.locator('.settings-nav a[href="#briefing"]').click();await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
  check(await page.locator('.site-header').evaluate(node=>Math.abs(node.getBoundingClientRect().top)<1),'Settings navigation is not fixed while scrolling');
  check((await page.locator('#briefingTitle').textContent())==='面试资料','Marketing headline remains in briefing');
  await page.setViewportSize({width:375,height:812});check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Settings flow overflows narrow viewport');
  check(errors.length===0,errors.join('\n'));
  return {passed:true,unifiedConnections:true,progressiveEditors:true,noAutomaticActivation:true,draftRetention:true,cancelDiscards:true,keyRemasking:true,saveFailureRetention:true,separateImport:true,speechDetail:true,historyBackForward:true,directLinkBack:true,privacyDismissedDelete:true,stickyNavigation:true,narrowLayout:true};
}

async (page, {base='http://127.0.0.1:9958'}={}) => {
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.setViewportSize({width:900,height:700});
  await page.addInitScript(base=>{
    const events={};
    let display={revision:0,theme:'light',opacity:.9,compact:true,layout:'narrow',answer:false,interview:false};
    let snapshot={revision:0,run_id:'',conversation_id:'',phase:'idle',role:'candidate',sources:[],transcripts:[],partials:{},muted:{}};
    const update=patch=>{display={...display,...patch,revision:display.revision+1};events.display?.({...display});return {...display,saved:true};};
    window.__GATEWAY_URL__=base;
    window.__themeOpacity=value=>update({opacity:value});
    window.__themeRecording=()=>{snapshot={...snapshot,revision:snapshot.revision+1,run_id:'theme-run',conversation_id:'theme-session',session_id:'theme-asr',phase:'recording',sources:['mic','system'],recording_started_at:Date.now()-12000,elapsed_ms:0,transcripts:[{segment_id:'mic:0',source:'mic',speaker:'candidate',text:'先明确一致性要求，再考虑缓存。',start_ms:0,end_ms:1000,is_final:true}],partials:{system:{segment_id:'system:1200',source:'system',speaker:'interviewer',text:'请进一步说明技术取舍…',start_ms:1200,end_ms:2000,is_final:false}}};events.interview?.(structuredClone(snapshot));};
    window.cockpit={
      getConfig:async()=>({armed:true,hotkeys:[],failedHotkeys:[],display:{...display},captureOptions:{mode:'full',displayId:'1',displays:[]}}),
      setSurface:async patch=>update({...patch,compact:!(patch.answer??display.answer)&&!(patch.interview??display.interview)}),
      setDisplay:async patch=>update(patch),onDisplay:fn=>events.display=fn,
      onArmed:()=>{},onInterviewState:fn=>events.interview=fn,onInterviewControl:()=>{},getInterviewState:async()=>structuredClone(snapshot),
      interviewCommand:async command=>{if(command.action!=='mute')return false;snapshot={...snapshot,revision:snapshot.revision+1,muted:{...snapshot.muted,[command.source]:command.muted}};events.interview?.(structuredClone(snapshot));return true;},
    };
  },base);
  await page.route('**/health',r=>r.fulfill({json:{service:'shuihuo-killer-gateway'}}));
  await page.route('**/api/ui/settings',r=>r.fulfill({json:{assistant_role:'candidate',interview_auto_answer:false,study_specialty:'后端开发',study_language:'Java',answer_language:'zh-CN'}}));
  await page.route('**/api/config/status',r=>r.fulfill({json:{llm_provider:'mock',llm_model:'theme-fixture'}}));
  await page.route('**/api/config/llm/profiles',r=>r.fulfill({json:{profiles:[],presets:[],active_profile_id:''}}));
  await page.route('**/api/learning-assets/**',r=>r.fulfill({json:{items:[],item:{id:'theme-record'}}}));
  const markdown='## 答案\n**先保证一致性**，再通过监控验证性能收益。\n\n| 方案 | 取舍 |\n| --- | --- |\n| 缓存 | 明确失效与回源策略 |\n\n## 代码\n```javascript\nconst result = await loadOrder();\n```';
  await page.route('**/api/chat/stream',r=>r.fulfill({status:200,contentType:'text/event-stream',body:`data: ${JSON.stringify({delta:markdown})}\n\ndata: {"done":true}\n\n`}));
  await page.goto(base+'/?transparent-workspaces-test');
  await page.waitForFunction(()=>window.__liuwaSend&&window.cockpit);
  const check=(value,message)=>{if(!value)throw Error(message);};
  const switchMode=async interview=>{
    if(await page.evaluate(()=>document.body.classList.contains('interview-mode'))===interview)return;
    await page.locator('#liuwaInterviewView').click();
    await page.waitForFunction(interview=>document.body.classList.contains('interview-mode')===interview&&!document.querySelector('#quickMode').disabled,interview);
  };
  const setTheme=async theme=>{
    await page.locator('#liuwaDisplay > summary').click();
    await page.locator(`[data-theme-mode="${theme}"]`).click();
    await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);
    await page.locator('#liuwaCloseSettings').click();
  };
  const allSections=async selector=>{
    const button=page.locator(selector+' [data-panel="all"]');
    if(await button.count())await button.click();
  };
  const styles=selector=>page.locator(selector).first().evaluate(node=>{
    const s=getComputedStyle(node);
    const alpha=color=>{if(color==='transparent')return 0;if(color.startsWith('rgba('))return Number(color.slice(5,-1).split(',')[3]);if(color.includes('/')){const a=color.split('/').at(-1).replace(')','').trim();return a.endsWith('%')?parseFloat(a)/100:parseFloat(a);}return 1;};
    return {background:s.backgroundColor,backgroundAlpha:alpha(s.backgroundColor),borderAlpha:alpha(s.borderBottomColor),rightBorderAlpha:alpha(s.borderRightColor),color:s.color,shadow:s.boxShadow,backdrop:s.backdropFilter,decoration:s.textDecorationLine};
  });
  await page.evaluate(()=>window.__liuwaSend({text:'说明缓存的一致性。'}));
  await allSections('#liuwaAnswerTabs');
  await switchMode(true);
  await page.evaluate(()=>window.__liuwaSend({context:'interview',text:'解释缓存方案的取舍。'}));
  await page.evaluate(()=>window.__liuwaSend({context:'interview',text:'如何验证优化收益？'}));
  await page.evaluate(()=>window.__themeRecording());
  await page.waitForFunction(()=>!document.querySelector('#liuwaInterviewTimer').hidden);
  await allSections('.liuwa-stack-entry:first-child');
  const checked=[];
  for(const theme of ['light','dark','transparent-black','transparent-white']){
    await setTheme(theme);
    const transparent=theme.startsWith('transparent-');
    check(await page.evaluate(()=>!document.body.classList.contains('liuwa-compact')),'Theme fixture collapsed the interview workspace');
    check((await styles('.liuwa-orb')).backgroundAlpha===(transparent?0:.9),`${theme}: interview workspace has the wrong fill`);
    if(!transparent){
      check((await styles('.liuwa-interview-modes button[aria-pressed="true"]')).backgroundAlpha>0,`${theme}: selected mode lost its solid-theme fill`);
      checked.push(theme);continue;
    }
    const surfaces=['.liuwa-orb','.liuwa-command-bar','.liuwa-interview','.liuwa-reader','.liuwa-interview-heading','.liuwa-transcript > summary','.liuwa-transcript-turn','.liuwa-stack-entry','.liuwa-stack-head','.liuwa-interview-modes'];
    for(const opacity of [.2,.9]){
      await page.evaluate(value=>window.__themeOpacity(value),opacity);
      for(const selector of surfaces){const s=await styles(selector);check(s.backgroundAlpha===0&&s.shadow==='none',`${theme}/${opacity}: ${selector} still paints a background or shadow`);check(s.borderAlpha===0&&s.rightBorderAlpha===0,`${theme}: ${selector} retains a panel divider`);}
    }
    await page.locator('#liuwaInterviewAuto').click();
    check((await styles('#liuwaInterviewAuto')).backgroundAlpha===0&&(await styles('#liuwaInterviewAuto')).decoration.includes('underline'),`${theme}: automatic mode is still a filled pill`);
    await page.locator('#liuwaInterviewManual').click();
    check((await styles('#liuwaInterviewManual')).backgroundAlpha===0&&(await styles('#liuwaInterviewManual')).decoration.includes('underline'),`${theme}: manual mode is still a filled pill`);
    await page.locator('#liuwaInterviewMic').click();
    check((await styles('#liuwaInterviewMic')).backgroundAlpha===0,`${theme}: muted microphone has a solid fill`);
    await page.locator('#liuwaInterviewMic').click();
    await page.locator('#liuwaInterviewExtraToggle').click();
    check((await styles('.liuwa-interview-extra')).backgroundAlpha===0&&(await styles('#liuwaInterviewExtraText')).backgroundAlpha===0,`${theme}: extra requirements paints a panel`);
    await page.locator('#liuwaInterviewExtraToggle').click();
    check(await page.locator('.liuwa-stack-entry:first-child .md-code code').count()>0,'Code fixture is not visible in the interview');
    check(await page.locator('.liuwa-stack-entry:first-child .md-table th').count()>0,'Table fixture is missing');
    const interview={text:(await styles('.liuwa-stack-entry:first-child .liuwa-stream p')).color,code:(await styles('.liuwa-stack-entry:first-child .md-code code')).color,muted:(await styles('.liuwa-stack-question')).color,table:(await styles('.liuwa-stack-entry:first-child .md-table th')).backgroundAlpha};
    const muted=theme==='transparent-white'?'rgb(182, 193, 215)':'rgb(82, 97, 122)';
    check(interview.muted===muted&&(await styles('.liuwa-transcript-turn header')).color===muted,`${theme}: secondary labels use the wrong foreground palette`);
    check(interview.table===0,`${theme}: interview table header is opaque`);
    await switchMode(false);await allSections('#liuwaAnswerTabs');
    const written={text:(await styles('#liuwaThread .liuwa-stream p')).color,code:(await styles('#liuwaThread .md-code code')).color,muted:(await styles('#hintCapture')).color};
    check(interview.text===written.text&&interview.code===written.code&&interview.muted===written.muted,`${theme}: interview foreground differs from written mode`);
    check((await styles('.liuwa-orb')).backgroundAlpha===0&&(await styles('.liuwa-reader')).backgroundAlpha===0,`${theme}: written mode regressed`);
    await switchMode(true);
    await page.locator('#liuwaDisplay > summary').click();
    await page.locator('#quickMode').click();
    check((await styles('.protected-select-menu')).backgroundAlpha>=.95,`${theme}: the settings option menu became transparent`);
    await page.keyboard.press('Escape');
    await page.locator('#liuwaCloseSettings').click();
    await page.screenshot({path:`output/${theme}-interview.png`,omitBackground:true});
    checked.push(theme);
  }
  check(await page.locator('.liuwa-stack-entry').count()===2,'Changing themes lost stacked answers or triggered automatic generation');
  check(errors.length===0,errors.join('\n'));
  return {passed:true,themes:checked,interviewMatchesWritten:true,noPanelFills:true,noSolidModePills:true,codeAndTableTransparent:true,opacityIndependent:true,opaqueSelectMenusPreserved:true,answersPreserved:true,errors};
}

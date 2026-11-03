import {state} from './state.js';
import {applyDisplay} from './display.js';
import {SPECIALTY_GROUPS, LANGUAGE_GROUPS, CUSTOM_STUDY_VALUE, isExamSpecialty, fillStudyChoice, syncStudyCustom, readStudyChoice} from './study-presets.js';

const byId = id => document.getElementById(id);
const menu = byId('liuwaDisplay');
const reader = document.querySelector('.liuwa-reader');
const status = byId('quickSettingsStatus');
const notice = text => { if(status) status.textContent = text; };
const fields = {study_specialty:'quickSpecialty',study_language:'quickProgrammingLanguage',answer_language:'quickAnswerLanguage',assistant_role:'quickIdentity'};
const studyChoices = {
  study_specialty: {input:'quickSpecialtyCustom',groups:SPECIALTY_GROUPS},
  study_language: {input:'quickProgrammingLanguageCustom',groups:LANGUAGE_GROUPS},
};
let modelsLoading = false;
let modelProfiles = [];
let activeProfileId = '';
let ui = null;
let origin = '';

function gateway() {
  // 页面与 API 同源：直接用当前 origin，避免重复探测拖慢每次打开。
  origin = state.apiOrigin || window.location.origin;
  return origin;
}

async function request(path, body, method = 'POST') {
  const key = state.gatewayApiKey || window.__GATEWAY_KEY__ || '';
  const response = await fetch(`${gateway()}${path}`, {method:body === undefined?'GET':method,cache:'no-store',
    headers:{...(key?{'X-API-Key':key}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(9000)});
  const data=await response.json();
  if(!response.ok) throw Error(typeof data.detail==='string'?data.detail:'设置未能保存，请重试。');
  return data;
}

function hydrateUi(data) {
  ui=data;
  for(const [key,id] of Object.entries(fields)) {
    const input=byId(id), value=data[key] || '';
    input.disabled=false;
    const choice=studyChoices[key];
    if(choice)fillStudyChoice(input,byId(choice.input),choice.groups,value);
    else input.value=value;
  }
  syncStudyAvailability();
}
function syncStudyAvailability() {
  byId('quickProgrammingLanguage').disabled=isExamSpecialty(readStudyChoice(byId('quickSpecialty'),byId('quickSpecialtyCustom')));
  for(const [key,choice] of Object.entries(studyChoices))syncStudyCustom(byId(fields[key]),byId(choice.input));
}
function hydrateCapture(config) {
  const options=config.captureOptions;
  const select=byId('quickDisplay');
  if(!options) {
    byId('quickCaptureMode').disabled=true;select.disabled=true;
    select.replaceChildren(new Option('桌面版可选择显示器',''));
    return;
  }
  byId('quickCaptureMode').value=options.mode;byId('quickCaptureMode').disabled=false;
  select.replaceChildren(...options.displays.map(display=>new Option(`${display.label} · ${display.width}×${display.height}`,String(display.id))));
  select.value=String(options.displayId);
  select.disabled=false;
}
function hydrateModels(data) {
  modelProfiles=data.profiles || [];
  activeProfileId=data.active_profile_id || '';
  const select=byId('quickModel');
  const names=new Map();
  for(const profile of modelProfiles) {
    const name=profile.name || profile.llm_model;
    names.set(name,(names.get(name) || 0)+1);
  }
  select.replaceChildren(...modelProfiles.map(profile=>{
    const name=profile.name || profile.llm_model;
    let label=name===profile.llm_model ? name : `${name} · ${profile.llm_model}`;
    if(names.get(name)>1) {
      let host=profile.llm_base_url || '';
      try {host=new URL(host).host;} catch {}
      label+=` · ${host}`;
    }
    return new Option(label,profile.id);
  }));
  if(!modelProfiles.length)select.replaceChildren(new Option('暂无已保存模型',''));
  select.value=activeProfileId;
  select.disabled=modelsLoading || !modelProfiles.length;
}
function setModelBusy(busy) {
  modelsLoading=busy;
  byId('quickRefreshModels').disabled=busy;
  byId('quickModel').disabled=busy || !modelProfiles.length;
}
async function loadModels() {
  if(modelsLoading)return;
  setModelBusy(true);
  try {hydrateModels(await request('/api/config/llm/profiles'));}
  catch(error) {notice(`模型列表读取失败：${error.message}`);}
  finally {setModelBusy(false);}
}
async function activateModel() {
  const select=byId('quickModel');
  const profileId=select.value;
  if(modelsLoading || !modelProfiles.some(profile=>profile.id===profileId))return;
  const previous=activeProfileId;
  setModelBusy(true);
  try {
    hydrateModels(await request('/api/config/llm/activate',{profile_id:profileId}));
    notice('已保存。');
  } catch(error) {
    try {hydrateModels(await request('/api/config/llm/profiles'));}
    catch {select.value=previous;}
    notice(`模型切换失败：${error.message}`);
  } finally {setModelBusy(false);}
}
async function reloadSettings() {
  try {hydrateUi(await request('/api/ui/settings'));notice('修改后自动保存。');}
  catch(error){notice(`读取失败：${error.message}`);}
  if(window.cockpit?.getConfig) {
    try {const config=await window.cockpit.getConfig();hydrateCapture(config);applyDisplay(config.display || {});}
    catch {notice('桌面设置读取失败，请重试。');}
  } else hydrateCapture({});
  await loadModels();
}
export async function loadQuickSettings() {
  // 每次打开都重读：设置页或其他窗口改了语言、模型、显示器后，这里必须跟上。
  await reloadSettings();
}
async function saveUiField(key) {
  const input=byId(fields[key]);
  const choice=studyChoices[key];
  const custom=choice && byId(choice.input);
  const value=choice ? readStudyChoice(input,custom) : input.value.trim();
  if(custom && input.value===CUSTOM_STUDY_VALUE && !value) {notice('请填写自定义内容。');return;}
  input.disabled=true;
  if(custom)custom.disabled=true;
  try {hydrateUi(await request('/api/ui/settings',{[key]:value},'PATCH'));notice('已保存，下次提问生效。');}
  catch(error){if(ui)hydrateUi(ui);notice(error.message);}
  finally {input.disabled=false;syncStudyAvailability();}
}
for(const [key,id] of Object.entries(fields)) {
  byId(id)?.addEventListener('change',()=>{
    const choice=studyChoices[key];
    if(choice && byId(id).value===CUSTOM_STUDY_VALUE) {
      syncStudyAvailability();byId(choice.input).focus();return;
    }
    return saveUiField(key);
  });
  const choice=studyChoices[key];
  if(choice)byId(choice.input)?.addEventListener('change',()=>saveUiField(key));
}
let captureSaving=false;
async function saveCaptureOptions(patch) {
  if(captureSaving)return;
  captureSaving=true;byId('quickCaptureMode').disabled=true;byId('quickDisplay').disabled=true;
  try {const data=await window.cockpit.setCaptureOptions(patch);hydrateCapture({captureOptions:data});notice(data.saved===false?'本次已应用，偏好保存失败。':'已保存。');}
  catch(error){notice(error.message);try{hydrateCapture(await window.cockpit.getConfig());}catch{}}
  finally {captureSaving=false;byId('quickCaptureMode').disabled=false;byId('quickDisplay').disabled=false;}
}
byId('quickCaptureMode')?.addEventListener('change',()=>saveCaptureOptions({mode:byId('quickCaptureMode').value}));
byId('quickDisplay')?.addEventListener('change',()=>{
  const displayId=byId('quickDisplay').value;
  if(captureSaving || !displayId)return;
  return saveCaptureOptions({displayId:String(displayId)});
});
byId('quickModel')?.addEventListener('change',activateModel);
byId('quickRefreshModels')?.addEventListener('click',loadModels);
function openSettings(section = '') {
  if (menu) menu.open = false;
  const url = `/settings${section ? `#${section}` : ''}`;
  return window.cockpit?.openSettings ? window.cockpit.openSettings(section) : window.open(url,'_blank','noopener');
}
byId('quickAdvancedSettings')?.addEventListener('click',()=>openSettings('study'));
byId('quickManageAssets')?.addEventListener('click',()=>openSettings('assets'));
byId('liuwaCloseSettings')?.addEventListener('click',()=>{menu.open=false;});
function fitPanel() {
  // Exclude the area behind the popover so translucent backgrounds do not stack
  // and answer text cannot bleed through the settings. Closing restores it.
  const regions=[reader,byId('liuwaInterview')].filter(Boolean);
  regions.forEach(region=>{region.style.clipPath='';});
  const panel=menu?.querySelector('.liuwa-display-panel');if(!panel||!menu.open)return;
  panel.style.maxHeight=`${Math.max(150,innerHeight-menu.querySelector('summary').getBoundingClientRect().bottom-18)}px`;
  const p=panel.getBoundingClientRect();
  for(const region of regions) {
    const r=region.getBoundingClientRect();
    if(!r.width||!r.height)continue;
    const left=Math.max(0,p.left-r.left), top=Math.max(0,p.top-r.top);
    const right=Math.min(r.width,p.right-r.left), bottom=Math.min(r.height,p.bottom-r.top);
    if(right>left&&bottom>top)region.style.clipPath=`polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${left}px ${top}px, ${right}px ${top}px, ${right}px ${bottom}px, ${left}px ${bottom}px, ${left}px ${top}px)`;
  }
}
menu?.addEventListener('toggle',async()=>{
  try {await window.cockpit?.setSurface?.({settingsOpen:menu.open});}catch{notice('窗口尺寸调整失败。');}
  fitPanel();
  if(menu.open)await loadQuickSettings();
});
window.addEventListener('resize',fitPanel);
if(menu) {
  const observer=new ResizeObserver(fitPanel);
  observer.observe(menu.querySelector('.liuwa-display-panel'));
  if(reader)observer.observe(reader);
  if(byId('liuwaInterview'))observer.observe(byId('liuwaInterview'));
}
document.addEventListener('pointerdown',event=>{if(menu?.open&&!menu.contains(event.target))menu.open=false;});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&menu?.open){menu.open=false;menu.querySelector('summary').focus();}});

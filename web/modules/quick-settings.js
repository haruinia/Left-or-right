import {state, fallbackGatewayOrigins} from './state.js';
import {applyDisplay} from './display.js';

const byId = id => document.getElementById(id);
const menu = byId('liuwaDisplay');
const reader = document.querySelector('.liuwa-reader');
const status = byId('quickSettingsStatus');
const notice = text => { if(status) status.textContent = text; };
const fields = {study_language:'quickProgrammingLanguage',answer_language:'quickAnswerLanguage',assistant_role:'quickIdentity'};
let initialized = false;
let modelsLoading = false;
let ui = null;
let origin = '';

async function gateway() {
  if(origin)return origin;
  for(const candidate of [...new Set([state.apiOrigin,window.__GATEWAY_URL__,...fallbackGatewayOrigins].filter(Boolean))]) {
    try {const response=await fetch(`${candidate}/health`,{signal:AbortSignal.timeout(2000)});if(response.ok&&(await response.json()).service==='shuihuo-killer-gateway'){origin=candidate;state.apiOrigin=origin;return origin;}}
    catch{}
  }
  throw Error('本地服务未连接');
}

async function request(path, body, method = 'POST') {
  const key = state.gatewayApiKey || window.__GATEWAY_KEY__ || '';
  const response = await fetch(`${await gateway()}${path}`, {method:body === undefined?'GET':method,cache:'no-store',
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
    // Preserve languages configured in advanced settings, even outside the common list.
    if(key==='study_language' && value && ![...input.options].some(option=>option.value===value)) input.add(new Option(value,value));
    input.value=value;input.disabled=false;
  }
}
function hydrateCapture(config) {
  const options=config.captureOptions;
  if(!options) {
    byId('quickCaptureMode').disabled=true;byId('quickDisplay').replaceChildren(new Option('桌面版可选择显示器',''));
    return;
  }
  byId('quickCaptureMode').value=options.mode;byId('quickCaptureMode').disabled=false;
  byId('quickDisplay').replaceChildren(...options.displays.map(d=>new Option(`${d.label} · ${d.width}×${d.height}`,d.id)));
  byId('quickDisplay').value=options.displayId;byId('quickDisplay').disabled=false;
}
async function loadModels() {
  if(modelsLoading)return;modelsLoading=true;byId('quickRefreshModels').disabled=true;
  try {
    const data=await request('/api/config/models');
    byId('quickScreenshotModel').value=data.screenshot_model;
    byId('quickInterviewModel').value=data.interview_model;
    byId('quickModelOptions').replaceChildren(...data.models.map(name=>new Option(name,name)));
    for(const id of ['quickScreenshotModel','quickInterviewModel','quickSaveModels'])byId(id).disabled=false;
    if(data.warning)notice(data.warning);
  } catch(error) {notice(`模型列表读取失败：${error.message}`);}
  finally {modelsLoading=false;byId('quickRefreshModels').disabled=false;}
}
export async function loadQuickSettings() {
  if(initialized)return;
  try {hydrateUi(await request('/api/ui/settings'));initialized=true;notice('修改后自动保存。');}
  catch(error){notice(`读取失败：${error.message}`);}
  if(window.cockpit?.getConfig) {
    try {const config=await window.cockpit.getConfig();hydrateCapture(config);applyDisplay(config.display || {});}
    catch {notice('桌面设置读取失败，请重试。');}
  } else hydrateCapture({});
  await loadModels();
}
for(const [key,id] of Object.entries(fields))byId(id)?.addEventListener('change',async()=>{
  const input=byId(id), previous=ui?.[key];input.disabled=true;
  try {hydrateUi(await request('/api/ui/settings',{[key]:input.value.trim()},'PATCH'));notice('已保存，下次提问生效。');}
  catch(error){input.value=previous || '';notice(error.message);}
  finally {input.disabled=false;}
});
for(const [id,key] of [['quickCaptureMode','mode'],['quickDisplay','displayId']])byId(id)?.addEventListener('change',async()=>{
  const input=byId(id);input.disabled=true;
  try {const data=await window.cockpit.setCaptureOptions({[key]:input.value});hydrateCapture({captureOptions:data});notice(data.saved===false?'本次已应用，偏好保存失败。':'截图设置已保存。');}
  catch(error){notice(error.message);try{hydrateCapture(await window.cockpit.getConfig());}catch{}}
  finally {input.disabled=false;}
});
byId('quickSaveModels')?.addEventListener('click',async()=>{
  const button=byId('quickSaveModels');button.disabled=true;
  try {await request('/api/config/models',{screenshot_model:byId('quickScreenshotModel').value.trim(),interview_model:byId('quickInterviewModel').value.trim()});notice('模型已保存，下次调用生效。');}
  catch(error){notice(error.message);}finally{button.disabled=false;}
});
byId('quickRefreshModels')?.addEventListener('click',loadModels);
byId('quickAdvancedSettings')?.addEventListener('click',()=>window.cockpit?.openSettings ? window.cockpit.openSettings() : window.open('settings.html','_blank','noopener'));
byId('liuwaCloseSettings')?.addEventListener('click',()=>{menu.open=false;});
function fitPanel() {
  // Exclude the area behind the popover so translucent backgrounds do not stack
  // and answer text cannot bleed through the settings. Closing restores it.
  if(reader)reader.style.clipPath='';
  const panel=menu?.querySelector('.liuwa-display-panel');if(!panel||!menu.open)return;
  panel.style.maxHeight=`${Math.max(150,innerHeight-menu.querySelector('summary').getBoundingClientRect().bottom-18)}px`;
  if(!reader)return;
  const r=reader.getBoundingClientRect(), p=panel.getBoundingClientRect();
  if(!r.width||!r.height)return;
  const left=Math.max(0,p.left-r.left), top=Math.max(0,p.top-r.top);
  const right=Math.min(r.width,p.right-r.left), bottom=Math.min(r.height,p.bottom-r.top);
  if(right>left&&bottom>top)reader.style.clipPath=`polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${left}px ${top}px, ${right}px ${top}px, ${right}px ${bottom}px, ${left}px ${bottom}px, ${left}px ${top}px)`;
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
}
document.addEventListener('pointerdown',event=>{if(menu?.open&&!menu.contains(event.target))menu.open=false;});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&menu?.open){menu.open=false;menu.querySelector('summary').focus();}});

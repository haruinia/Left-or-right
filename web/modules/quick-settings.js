import {state} from './state.js';
import {applyDisplay} from './display.js';

const byId = id => document.getElementById(id);
const menu = byId('liuwaDisplay');
const reader = document.querySelector('.liuwa-reader');
const status = byId('quickSettingsStatus');
const notice = text => { if(status) status.textContent = text; };
const fields = {study_language:'quickProgrammingLanguage',answer_language:'quickAnswerLanguage',assistant_role:'quickIdentity'};
let modelsLoading = false;
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
    // Preserve languages configured in advanced settings, even outside the common list.
    if(key==='study_language' && value && ![...input.options].some(option=>option.value===value)) input.add(new Option(value,value));
    input.value=value;
    if(key==='study_language' && value==='') input.selectedIndex=-1;
    input.disabled=false;
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
    const summary=byId('quickModelSummary');
    if(summary) summary.textContent = data.interview_model
      ? `${data.interview_model}${data.screenshot_model && data.screenshot_model !== data.interview_model ? ` · 截图 ${data.screenshot_model}` : ''}`
      : '尚未配置模型';
    if(data.warning)notice(data.warning);
  } catch(error) {notice(`模型状态读取失败：${error.message}`);}
  finally {modelsLoading=false;byId('quickRefreshModels').disabled=false;}
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
byId('quickManageModels')?.addEventListener('click',()=>openSettings('models'));
byId('quickRefreshModels')?.addEventListener('click',loadModels);
function openSettings(section = '') {
  const url = `/settings${section ? `#${section}` : ''}`;
  return window.cockpit?.openSettings ? window.cockpit.openSettings(section) : window.open(url,'_blank','noopener');
}
byId('quickAdvancedSettings')?.addEventListener('click',()=>openSettings('study'));
byId('quickManageAssets')?.addEventListener('click',()=>openSettings('assets'));
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

import { asrRequest } from './asr-api.js';
import { settingsRoute, navigateSettings, returnToConnections, confirmSettingsAction } from './settings-navigation.js';

const $ = selector => document.querySelector(selector);
const KEY_MASK = '************';
const ENDPOINTS = { aliyun_nls_ws: 'wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1', aliyun_ws: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference', xfyun_rtasr: 'wss://rtasr.xfyun.cn/v1/ws' };
const SECRET_FIELDS = {
  api_key: { id: 'asrApiKey', toggle: 'asrToggleKey', label: 'API Key' },
  app_id: { id: 'asrAppId', toggle: 'asrToggleAppId', label: 'APPID' },
  app_key: { id: 'asrAppKey', toggle: 'asrToggleAppKey', label: 'AppKey' },
  nls_token: { id: 'asrNlsToken', toggle: 'asrToggleNlsToken', label: 'AccessToken' },
  access_key_id: { id: 'asrAccessKeyId', toggle: 'asrToggleAccessKeyId', label: 'AccessKey ID' },
  access_key_secret: { id: 'asrAccessKeySecret', toggle: 'asrToggleAccessKeySecret', label: 'AccessKey Secret' },
};
const fieldIds = ['asrName', 'asrProvider', 'asrAuthMode', 'asrEndpoint', 'asrModel', 'asrLanguageHints', 'asrVocabulary', ...Object.values(SECRET_FIELDS).map(field => field.id)];
const drafts = new Map();
let profiles = [], activeId = '', editingId = '', epoch = 0, busy = false;
let loaded = false, stale = false, formDirty = false, loadEpoch = 0, editingRoute = '';
let secrets = {};

function secretState(profile) {
  return Object.fromEntries(Object.keys(SECRET_FIELDS).map(field => [field, { configured: Boolean(profile?.[`${field}_configured`]), changed: false, masked: Boolean(profile?.[`${field}_configured`]) }]));
}

function provider() { return $('#asrProvider').value || 'aliyun_nls_ws'; }
function relevantSecrets() {
  if (provider() === 'aliyun_ws') return ['api_key'];
  if (provider() === 'xfyun_rtasr') return ['app_id', 'api_key'];
  return $('#asrAuthMode').value === 'access_key' ? ['app_key', 'access_key_id', 'access_key_secret'] : ['app_key', 'nls_token'];
}

function remask() {
  for (const [field, detail] of Object.entries(SECRET_FIELDS)) {
    const state = secrets[field];
    if (!state?.changed && state?.configured) { $(`#${detail.id}`).value = KEY_MASK; state.masked = true; }
    const input = $(`#${detail.id}`), toggle = $(`#${detail.toggle}`);
    input.type = 'password'; toggle.disabled = false;
    toggle.setAttribute('aria-pressed', 'false'); toggle.setAttribute('aria-label', `显示 ${detail.label}`);
  }
}

function syncFields() {
  const current = provider(), nls = current === 'aliyun_nls_ws', bailian = current === 'aliyun_ws', xfyun = current === 'xfyun_rtasr';
  const automatic = nls && $('#asrAuthMode').value === 'access_key';
  const visible = new Set(nls ? ['app_key', ...(automatic ? ['access_key_id', 'access_key_secret'] : ['nls_token'])] : xfyun ? ['app_id', 'api_key'] : ['api_key']);
  for (const [field, detail] of Object.entries(SECRET_FIELDS)) {
    $(`#${detail.id}Label`).hidden = !visible.has(field);
    $(`#${detail.id}Field`).hidden = !visible.has(field);
    $(`#${detail.id}`).disabled = !visible.has(field);
  }
  $('#asrAuthModeLabel').hidden = !nls; $('#asrAuthMode').hidden = !nls; $('#asrAuthMode').disabled = !nls;
  $('#asrModelLabel').hidden = !bailian; $('#asrModel').disabled = !bailian; $('#asrModel').required = bailian;
  $('#asrLanguageHintsLabel').hidden = !bailian; $('#asrLanguageHints').disabled = !bailian;
  $('#asrVocabularyLabel').hidden = xfyun; $('#asrVocabulary').disabled = xfyun;
  $('#asrProvider').disabled = Boolean(editingId);
}

function retainDraft() {
  if (!editingRoute || !formDirty) return;
  const values = Object.fromEntries(fieldIds.map(id => {
    const field = Object.entries(SECRET_FIELDS).find(([, detail]) => detail.id === id)?.[0];
    return [id, field && !secrets[field]?.changed ? (secrets[field]?.configured ? KEY_MASK : '') : $(`#${id}`).value];
  }));
  drafts.set(editingRoute, { values, secrets: structuredClone(secrets), editingId });
}

function syncEditorRoute() {
  const route = settingsRoute();
  const next = route.section === 'models' && route.tab === 'asr' && route.kind === 'editor' ? route.hash : '';
  if (next === editingRoute) return;
  retainDraft(); editingRoute = next; epoch += 1; remask();
  if (!next) return;
  if (!loaded) {
    if (route.id === 'new') fill(null);
    else $('#asrForm').hidden = true;
    return;
  }
  const saved = drafts.get(next), profile = route.id === 'new' ? null : profiles.find(item => item.id === route.id);
  $('#asrForm').dataset.profileMissing = String(!saved && route.id !== 'new' && !profile);
  if ($('#asrForm').dataset.profileMissing === 'true') { $('#asrForm').hidden = true; status('这个语音接入已不存在。', true); return; }
  $('#asrForm').hidden = false; fill(profile);
  if (saved) {
    fieldIds.forEach(id => { $(`#${id}`).value = saved.values[id]; });
    editingId = saved.editingId; secrets = structuredClone(saved.secrets); formDirty = true;
    remask(); syncFields(); $('#asrCheck').disabled = true;
  }
  status('');
}

function openEditor(id = 'new') {
  navigateSettings(`#models/asr/${encodeURIComponent(id)}`, { focus: id === 'new' ? { kind: 'button', id: 'asrNew' } : { kind: 'asr', id } });
}

function status(text, error = false) {
  $('#asrProfileState').textContent = text;
  $('#asrProfileState').dataset.kind = error ? 'error' : '';
}

function button(text, action, id, className = 'secondary') {
  const node = document.createElement('button');
  node.type = 'button'; node.className = className; node.textContent = text; node.dataset[action] = id;
  return node;
}

function renderCards() {
  const root = $('#asrProfileCards'); root.replaceChildren();
  if (!profiles.length) { const empty = document.createElement('p'); empty.className = 'empty-state'; empty.textContent = '还没有语音接入。'; root.append(empty); }
  for (const profile of profiles) {
    const card = document.createElement('article'); card.className = `model-card${profile.id === activeId ? ' is-active' : ''}`;
    const top = document.createElement('div'); top.className = 'model-card-top';
    const name = document.createElement('strong'); name.textContent = profile.name; top.append(name);
    if (profile.id === activeId) { const badge = document.createElement('span'); badge.className = 'model-badge'; badge.textContent = '使用中'; top.append(badge); }
    const model = document.createElement('p'); model.className = 'model-card-model';
    model.textContent = profile.provider === 'aliyun_nls_ws' ? '阿里云 NLS' : profile.provider === 'xfyun_rtasr' ? '讯飞实时转写' : `阿里云百炼 · ${profile.model}`;
    const endpoint = document.createElement('p'); endpoint.className = 'model-card-url'; endpoint.textContent = profile.endpoint;
    const footer = document.createElement('footer');
    if (profile.id !== activeId) footer.append(button('使用', 'asrActivate', profile.id));
    footer.append(button('编辑', 'asrEdit', profile.id, 'text-button'), button('删除', 'asrDelete', profile.id, 'text-button is-danger'));
    card.append(top, model, endpoint, footer); root.append(card);
  }
}

function fill(profile) {
  epoch += 1; formDirty = false; editingId = profile?.id || '';
  $('#asrName').value = profile?.name || '';
  $('#asrProvider').value = profile?.provider || 'aliyun_nls_ws';
  $('#asrAuthMode').value = profile?.auth_mode || 'token';
  $('#asrEndpoint').value = profile?.endpoint || ENDPOINTS[provider()];
  $('#asrModel').value = profile?.model || 'paraformer-realtime-v2';
  $('#asrLanguageHints').value = profile?.language_hints ?? 'zh,en';
  $('#asrVocabulary').value = profile?.vocabulary_id || '';
  secrets = secretState(profile);
  for (const [field, detail] of Object.entries(SECRET_FIELDS)) $(`#${detail.id}`).value = secrets[field].configured ? KEY_MASK : '';
  remask(); syncFields();
  $('#asrFormTitle').textContent = profile ? '编辑语音接入' : '添加语音接入';
  $('#asrCheck').disabled = !profile || !(profile.configured ?? profile.api_key_configured);
}

function apply(data) {
  profiles = data.profiles || []; activeId = data.active_profile_id || ''; renderCards();
  window.dispatchEvent(new Event('asr:profiles-changed'));
}

async function load() {
  const request = ++loadEpoch;
  try {
    const data = await asrRequest('/api/config/asr/profiles');
    if (request !== loadEpoch) return;
    profiles = data.profiles || []; activeId = data.active_profile_id || ''; renderCards();
    const firstLoad = !loaded; loaded = true; stale = false;
    if (firstLoad) { retainDraft(); editingRoute = ''; }
    syncEditorRoute(); if (!editingRoute) status('');
  } catch (error) { if (request === loadEpoch) status(`读取语音接入失败：${error.message}`, true); }
}

async function save(event) {
  event.preventDefault(); if (busy) return;
  if (!$('#asrName').value.trim()) { status('请填写名称。', true); return; }
  if (provider() === 'aliyun_ws' && !$('#asrModel').value.trim()) { status('请填写模型名称。', true); return; }
  for (const field of relevantSecrets()) {
    const state = secrets[field], detail = SECRET_FIELDS[field];
    if ((!state?.configured || state.changed) && !$(`#${detail.id}`).value.trim()) { status(`请填写 ${detail.label}。`, true); return; }
  }
  const version = epoch;
  const payload = {
    ...(editingId ? { id: editingId } : {}), name: $('#asrName').value.trim(), provider: provider(),
    endpoint: $('#asrEndpoint').value.trim(), vocabulary_id: $('#asrVocabulary').value.trim(),
    ...(provider() === 'aliyun_ws' ? { model: $('#asrModel').value.trim(), language_hints: $('#asrLanguageHints').value.trim() } : provider() === 'aliyun_nls_ws' ? { auth_mode: $('#asrAuthMode').value } : {}),
  };
  for (const field of relevantSecrets()) if (!secrets[field]?.configured || secrets[field].changed) payload[field] = $(`#${SECRET_FIELDS[field].id}`).value.trim();
  busy = true; $('#asrSave').disabled = true; status('正在保存…');
  try {
    apply(await asrRequest('/api/config/asr/profiles', { method: 'POST', body: payload }));
    if (epoch === version) { formDirty = false; drafts.delete(editingRoute); fill(profiles.find(profile => profile.id === activeId)); returnToConnections('asr'); status('已保存。'); }
  } catch (error) { if (epoch === version) status(`保存失败：${error.message}`, true); }
  finally { busy = false; $('#asrSave').disabled = false; }
}

async function reveal(field = 'api_key') {
  const detail = SECRET_FIELDS[field], state = secrets[field];
  if (!detail || !state) return;
  const input = $(`#${detail.id}`), toggle = $(`#${detail.toggle}`), version = epoch;
  if (state.masked && !state.changed) {
    toggle.disabled = true;
    try {
      const path = field === 'api_key' ? `/api/config/asr/profiles/${encodeURIComponent(editingId)}/key` : `/api/config/asr/profiles/${encodeURIComponent(editingId)}/secrets/${field}`;
      const result = await asrRequest(path, { method: 'POST', body: {} });
      if (epoch !== version || state.changed || secrets[field] !== state) return;
      input.value = field === 'api_key' ? result.api_key : result.value; state.masked = false;
    } catch (error) { if (epoch === version) status(`无法显示密钥：${error.message}`, true); return; }
    finally { if (epoch === version) toggle.disabled = false; }
  }
  input.type = input.type === 'password' ? 'text' : 'password';
  toggle.setAttribute('aria-pressed', String(input.type === 'text'));
  toggle.setAttribute('aria-label', `${input.type === 'text' ? '隐藏' : '显示'} ${detail.label}`);
}

function init() {
  $('#asrForm').addEventListener('submit', save);
  $('#asrForm').addEventListener('input', () => { formDirty = true; epoch += 1; $('#asrCheck').disabled = true; for (const detail of Object.values(SECRET_FIELDS)) $(`#${detail.toggle}`).disabled = false; });
  $('#asrProvider').addEventListener('change', () => {
    if (editingId) { $('#asrProvider').value = profiles.find(profile => profile.id === editingId)?.provider || 'aliyun_nls_ws'; return; }
    epoch += 1; formDirty = true; secrets = secretState(null);
    for (const detail of Object.values(SECRET_FIELDS)) $(`#${detail.id}`).value = '';
    $('#asrEndpoint').value = ENDPOINTS[provider()]; $('#asrModel').value = 'paraformer-realtime-v2'; $('#asrLanguageHints').value = 'zh,en'; $('#asrVocabulary').value = '';
    remask(); syncFields(); $('#asrCheck').disabled = true;
  });
  $('#asrAuthMode').addEventListener('change', () => { epoch += 1; formDirty = true; remask(); syncFields(); $('#asrCheck').disabled = true; });
  $('#asrRefresh').addEventListener('click', () => { if (!busy) load(); });
  $('#asrNew').addEventListener('click', () => { if (!busy) openEditor(); });
  $('#asrCancel').addEventListener('click', () => { if (busy) return; formDirty = false; drafts.delete(editingRoute); epoch += 1; fill(profiles.find(profile => profile.id === editingId)); returnToConnections('asr'); status(''); });
  for (const [field, detail] of Object.entries(SECRET_FIELDS)) {
    $(`#${detail.id}`).addEventListener('focus', () => { if (secrets[field]?.masked) $(`#${detail.id}`).select(); });
    $(`#${detail.id}`).addEventListener('input', () => { secrets[field].changed = true; secrets[field].masked = false; $(`#${detail.toggle}`).disabled = false; });
    $(`#${detail.toggle}`).addEventListener('click', () => reveal(field));
  }
  $('#asrProfileCards').addEventListener('click', async event => {
    if (busy) return;
    const edit = event.target.closest('[data-asr-edit]')?.dataset.asrEdit, activate = event.target.closest('[data-asr-activate]')?.dataset.asrActivate, remove = event.target.closest('[data-asr-delete]')?.dataset.asrDelete;
    if (edit) { openEditor(edit); return; }
    if (!activate && !remove) return;
    busy = true;
    try {
      if (remove && !await confirmSettingsAction('删除这个语音接入？')) return;
      apply(await asrRequest(activate ? '/api/config/asr/activate' : `/api/config/asr/profiles/${encodeURIComponent(remove)}`, activate ? { method: 'POST', body: { profile_id: activate } } : { method: 'DELETE' }));
      if (remove) drafts.delete(`#models/asr/${encodeURIComponent(remove)}`);
      status(activate ? '已切换，下一次转写时生效。' : '已删除语音接入。');
    } catch (error) { status(error.message, true); }
    finally { busy = false; }
  });
  $('#asrCheck').addEventListener('click', async () => {
    if (busy || !editingId || formDirty) return;
    const version = epoch; busy = true; $('#asrCheck').disabled = true; status('正在验证已保存的语音接入…');
    try { const result = await asrRequest(`/api/config/asr/profiles/${encodeURIComponent(editingId)}/check`, { method: 'POST', body: {} }); if (epoch === version) status(result.detail || (result.ok ? '接入验证通过，尚未进行语音识别。' : '接入验证失败。'), !result.ok); }
    catch (error) { if (epoch === version) status(`接入验证失败：${error.message}`, true); }
    finally { busy = false; $('#asrCheck').disabled = !editingId || formDirty; }
  });
  const ensure = () => { syncEditorRoute(); const route = settingsRoute(); if (route.section === 'models' && route.tab === 'asr' && (!loaded || stale) && !busy) load(); };
  for (const event of ['hashchange', 'popstate', 'settings:navigate']) window.addEventListener(event, ensure);
  window.addEventListener('asr:profiles-changed', () => { const route = settingsRoute(); if (route.section !== 'models' || route.tab !== 'asr') stale = true; });
  window.addEventListener('app:privacy-hidden', () => { remask(); epoch += 1; });
  ensure();
}

if ($('#asrForm')) init();

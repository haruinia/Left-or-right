import { fetchGateway, fetchGatewayJson, postJson } from "./gateway.js";
import { escapeHtml } from "./ui.js";
import { settingsRoute, navigateSettings, returnToConnections, confirmSettingsAction } from './settings-navigation.js';

const $ = (selector) => document.querySelector(selector);
const DEFAULT_TOKENS = 30000;
const KEY_MASK = "************";
let profiles = [];
let presets = [];
let activeId = "";
let editingId = "";
let draft = null;
let keyMasked = false;
let keyChanged = false;
let formEpoch = 0;
let busy = false;
let loaded = false;
let loadEpoch = 0;
let editingRoute = '';
let lastRouteHash = '';
let importEpoch = 0;
let formDirty = false;
const drafts = new Map();
const fieldIds = ['llmName', 'llmBaseUrl', 'llmModel', 'llmMaxTokens', 'llmApiKey'];

function retainDraft() {
  if (!editingRoute || !formDirty) return;
  const values = Object.fromEntries(fieldIds.map(id => [id, id === 'llmApiKey' && !keyChanged ? (draft?.llm_api_key_configured ? KEY_MASK : '') : $(`#${id}`).value]));
  drafts.set(editingRoute, { values, draft, keyChanged, keyMasked: !keyChanged && Boolean(draft?.llm_api_key_configured) });
}

function syncEditorRoute() {
  if (location.hash !== lastRouteHash) { lastRouteHash = location.hash; importEpoch += 1; }
  const route = settingsRoute();
  const next = route.section === 'models' && route.tab === 'llm' && route.kind === 'editor' ? route.hash : '';
  if (next === editingRoute) return;
  retainDraft();
  editingRoute = next;
  formEpoch += 1;
  $('#llmApiKey').type = 'password';
  if (!keyChanged && draft?.llm_api_key_configured) { $('#llmApiKey').value = KEY_MASK; keyMasked = true; }
  $('#llmToggleKey').disabled = false; $('#llmToggleKey').setAttribute('aria-pressed', 'false'); $('#llmToggleKey').setAttribute('aria-label', '显示 API Key');
  if (!next) { renderCards(); return; }
  if (!loaded) return;
  const saved = drafts.get(next);
  const profile = route.id === 'new' ? null : profiles.find(item => item.id === route.id);
  $('#llmForm').dataset.profileMissing = String(!saved && route.id !== 'new' && !profile);
  if ($('#llmForm').dataset.profileMissing === 'true') { $('#llmForm').hidden = true; setState('这个模型配置已不存在。', 'error'); return; }
  $('#llmForm').hidden = false;
  fillForm(saved?.draft || profile);
  if (saved) {
    fieldIds.forEach(id => { $(`#${id}`).value = saved.values[id]; });
    keyChanged = saved.keyChanged; keyMasked = saved.keyMasked; formDirty = true; $('#checkModel').disabled = true;
  }
  setState('');
  $('#checkModel').hidden = !editingId || editingId !== activeId;
}

function openEditor(id = 'new') {
  navigateSettings(`#models/llm/${encodeURIComponent(id)}`, { focus: id === 'new' ? { kind: 'button', id: 'llmNewProfile' } : { kind: 'llm', id } });
}

function cancelEdit() {
  if (busy) return;
  formDirty = false; drafts.delete(editingRoute); formEpoch += 1;
  fillForm(profiles.find(item => item.id === editingId) || null);
  returnToConnections('llm');
  setState('');
}

function setState(text, kind = "") {
  const node = $("#llmProfileState");
  node.textContent = text;
  node.dataset.kind = kind;
}

function readForm() {
  return {
    name: $("#llmName").value.trim(),
    llm_base_url: $("#llmBaseUrl").value.trim(),
    llm_model: $("#llmModel").value.trim(),
    llm_max_tokens: Number($("#llmMaxTokens").value || DEFAULT_TOKENS),
    llm_api_key: keyChanged ? $("#llmApiKey").value.trim() : "",
  };
}

function fillForm(profile) {
  formEpoch += 1;
  formDirty = false;
  editingId = profile?.id || "";
  draft = profile;
  $("#llmName").value = profile?.name || profile?.llm_model || "";
  $("#llmBaseUrl").value = profile?.llm_base_url || "";
  $("#llmModel").value = profile?.llm_model || "";
  $("#llmMaxTokens").value = String(profile?.llm_max_tokens ?? DEFAULT_TOKENS);
  keyMasked = Boolean(profile?.llm_api_key_configured);
  keyChanged = false;
  $("#llmApiKey").type = "password";
  $("#llmApiKey").value = keyMasked ? KEY_MASK : "";
  $("#llmToggleKey").setAttribute("aria-label", "显示 API Key");
  $("#llmToggleKey").setAttribute("title", "显示 API Key");
  $("#llmToggleKey").setAttribute("aria-pressed", "false");
  $("#llmToggleKey").disabled = false;
  $("#llmFormTitle").textContent = profile?.id ? "编辑模型" : "添加模型";
  $('#checkModel').hidden = !editingId || editingId !== activeId;
  $('#checkModel').disabled = false;
  renderCards();
}

async function toggleKey() {
  const input = $("#llmApiKey");
  const button = $("#llmToggleKey");
  const epoch = formEpoch;
  if (keyMasked && !keyChanged) {
    button.disabled = true;
    try {
      const result = await postJson(`/api/config/llm/profiles/${encodeURIComponent(editingId)}/key`, {});
      // 等待密钥时可能切换模型或输入新值，不能用迟到的响应覆盖新表单。
      if (formEpoch !== epoch || keyChanged) return;
      input.value = result.llm_api_key;
      keyMasked = false;
    } catch (error) {
      if (formEpoch === epoch) setState(`无法显示密钥：${error.message || error}`, "error");
      return;
    } finally {
      if (formEpoch === epoch) button.disabled = false;
    }
  }
  input.type = input.type === "password" ? "text" : "password";
  const visible = input.type === "text";
  button.setAttribute("aria-label", visible ? "隐藏 API Key" : "显示 API Key");
  button.setAttribute("title", visible ? "隐藏 API Key" : "显示 API Key");
  button.setAttribute("aria-pressed", String(visible));
}

function profileCard(profile) {
  const active = profile.id === activeId;
  const editing = Boolean(editingRoute) && profile.id === editingId;
  return `<article class="model-card${active ? " is-active" : ""}${editing ? " is-editing" : ""}">
    <div class="model-card-top"><strong>${escapeHtml(profile.name || profile.llm_model || "未命名接入")}</strong>${active ? '<span class="model-badge">使用中</span>' : ""}</div>
    <p class="model-card-model">${escapeHtml(profile.llm_model || "未设置模型")}</p>
    <p class="model-card-url">${escapeHtml(profile.llm_base_url || "待填写接口 URL")}</p>
    <footer>${active ? "" : `<button type="button" class="secondary" data-activate="${escapeHtml(profile.id)}">使用</button>`}<button type="button" class="text-button" data-edit="${escapeHtml(profile.id)}">编辑</button><button type="button" class="text-button is-danger" data-delete="${escapeHtml(profile.id)}">删除</button></footer>
  </article>`;
}

function renderCards() {
  $("#llmProfileCards").innerHTML = profiles.length
    ? profiles.map(profileCard).join("")
    : '<p class="empty-state">还没有回答模型。</p>';
  $("#llmPresetCards").innerHTML = presets.map((preset) => `<button type="button" class="preset-button" data-preset="${escapeHtml(preset.id)}"><strong>${escapeHtml(preset.name)}</strong><span>${escapeHtml(preset.llm_base_url)}</span><span>${escapeHtml(preset.llm_model)}</span></button>`).join("");
  $("#llmPresetBlock").hidden = !presets.length;
  const models = new Set(profiles.map((profile) => profile.llm_model));
  presets.forEach((preset) => (preset.models || []).forEach((model) => models.add(model)));
  $("#llmModelOptions").replaceChildren(...[...models].filter(Boolean).map((model) => new Option(model, model)));
}

export function applyProfiles(data) {
  profiles = data.profiles || [];
  presets = data.presets || [];
  activeId = data.active_profile_id || "";
  renderCards();
}

export async function loadProfiles() {
  const request = ++loadEpoch;
  try {
    const data = await fetchGatewayJson('/api/config/llm/profiles');
    if (request !== loadEpoch) return;
    applyProfiles(data);
    const firstLoad = !loaded; loaded = true;
    if (firstLoad) editingRoute = '';
    syncEditorRoute();
    if (!editingRoute) setState('');
  } catch (error) {
    if (request === loadEpoch) setState(`读取失败：${error.message || error}`, 'error');
  }
}

function payloadFor(profile) {
  const form = readForm();
  const sameUrl = profile?.llm_base_url.replace(/\/+$/, "") === form.llm_base_url.replace(/\/+$/, "");
  return {
    ...form,
    profile_id: profile?.id || `p_${crypto.randomUUID()}`,
    llm_protocol: sameUrl ? profile.llm_protocol : "auto",
    llm_api_path: sameUrl ? profile.llm_api_path : "/chat/completions",
    llm_auth_header: sameUrl ? profile.llm_auth_header : "Authorization",
    llm_auth_scheme: sameUrl ? profile.llm_auth_scheme : "Bearer",
    llm_response_content_path: sameUrl ? profile.llm_response_content_path : "choices.0.message.content",
    llm_extra_body_json: sameUrl ? profile.llm_extra_body_json : "",
    vision_model: sameUrl ? profile.vision_model : "",
    clear_api_key: keyChanged && !form.llm_api_key,
  };
}

async function saveProfile(event) {
  event?.preventDefault();
  if (busy) return false;
  const form = readForm();
  if (!form.name || !form.llm_base_url || !form.llm_model) {
    setState("请填写名称、接口 URL 和模型名称。", "error");
    return false;
  }
  if (!Number.isInteger(form.llm_max_tokens) || form.llm_max_tokens < 1 || form.llm_max_tokens > 1000000) {
    setState("输出额度应为 1 到 1,000,000 之间的整数。", "error");
    return false;
  }
  let profile = profiles.find((item) => item.id === editingId) || draft;
  if (!profile?.id) {
    profile = profiles.find((item) => item.llm_base_url.replace(/\/+$/, "") === form.llm_base_url.replace(/\/+$/, "") && item.llm_model === form.llm_model) || profile;
  }
  const payload = payloadFor(profile);
  const epoch = formEpoch;
  busy = true;
  $("#saveLlmProfile").disabled = true;
  setState("正在保存…");
  try {
    await postJson("/api/config/llm", payload);
    applyProfiles(await fetchGatewayJson("/api/config/llm/profiles"));
    if (formEpoch === epoch) {
      formDirty = false; drafts.delete(editingRoute);
      fillForm(profiles.find(item => item.id === activeId) || null);
      returnToConnections('llm');
      setState('已保存。');
    }
    return true;
  } catch (error) {
    if (formEpoch === epoch) setState(`保存未完成：${error.message || error}`, "error");
    return false;
  } finally {
    busy = false;
    $("#saveLlmProfile").disabled = false;
  }
}

async function activateProfile(id) {
  if (busy) return;
  busy = true;
  try {
    applyProfiles(await postJson("/api/config/llm/activate", { profile_id: id }));
    setState('已切换当前模型。');
  } catch (error) {
    setState(`切换失败：${error.message || error}`, "error");
  } finally { busy = false; }
}

async function deleteProfile(id) {
  if (busy) return;
  busy = true;
  try {
    if (!await confirmSettingsAction('删除这个模型配置？')) return;
    const response = await fetchGateway(`/api/config/llm/profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
    applyProfiles(await response.json());
    drafts.delete(`#models/llm/${encodeURIComponent(id)}`);
    if (editingId === id && editingRoute) { formDirty = false; returnToConnections('llm'); }
    setState('已删除模型配置。');
  } catch (error) {
    setState(`删除失败：${error.message || error}`, "error");
  } finally { busy = false; }
}

async function importConfig() {
  const status = $("#llmImportState");
  if (busy) return;
  let config;
  try { config = JSON.parse($("#llmImportText").value); }
  catch { status.textContent = "请输入有效的 JSON 配置。"; return; }
  const version = importEpoch;
  busy = true;
  $("#importLlmProfile").disabled = true;
  try {
    const result = await postJson("/api/config/llm/import", { config });
    applyProfiles(result);
    if (version === importEpoch) {
      $('#llmImportText').value = '';
      $('#llmImportFile').value = '';
      status.textContent = '';
      if (settingsRoute().kind === 'import') returnToConnections('llm');
      setState(`已导入 ${result.imported} 个模型，当前模型未切换。`);
    }
  } catch (error) { if (version === importEpoch) status.textContent = `导入失败：${error.message || error}`; }
  finally { busy = false; $("#importLlmProfile").disabled = false; }
}

async function checkConnection() {
  if (!editingId || editingId !== activeId || busy || formDirty) return;
  const epoch = formEpoch;
  const button = $("#checkModel");
  button.disabled = true;
  setState("正在测试已保存的当前模型…");
  try {
    const result = await fetchGatewayJson("/api/config/llm/check", { method: "POST", timeoutMs: 120000 });
    if (formEpoch === epoch) setState(result.ok ? "当前模型连接正常。" : result.message || "连接失败，请检查接口和密钥。", result.ok ? "" : "error");
  } catch (error) { if (formEpoch === epoch) setState(`测试失败：${error.message || error}`, "error"); }
  finally { button.disabled = formDirty; }
}

export function wireModelConfig() {
  $("#llmForm").addEventListener("submit", saveProfile);
  $("#llmToggleKey").addEventListener("click", toggleKey);
  $("#llmApiKey").addEventListener("focus", () => { if (keyMasked) $("#llmApiKey").select(); });
  $("#llmApiKey").addEventListener("input", () => { keyChanged = true; keyMasked = false; });
  $('#llmForm').addEventListener('input', () => { formDirty = true; $('#checkModel').disabled = true; });
  $('#llmNewProfile').addEventListener('click', () => { if (!busy) openEditor(); });
  $('#llmCancelEdit').addEventListener('click', cancelEdit);
  $('#llmOpenImport').addEventListener('click', () => { if (!busy) navigateSettings('#models/import', { focus: { kind: 'button', id: 'llmOpenImport' } }); });
  $('#llmCancelImport').addEventListener('click', () => { if (!busy) { $('#llmImportText').value = ''; $('#llmImportFile').value = ''; $('#llmImportState').textContent = ''; returnToConnections('llm'); } });
  $("#llmProfileCards").addEventListener("click", (event) => {
    if (busy) return;
    const edit = event.target.closest("[data-edit]")?.dataset.edit;
    const activate = event.target.closest("[data-activate]")?.dataset.activate;
    const remove = event.target.closest("[data-delete]")?.dataset.delete;
    if (edit) openEditor(edit);
    if (activate) activateProfile(activate);
    if (remove) deleteProfile(remove);
  });
  $("#llmPresetCards").addEventListener("click", (event) => {
    if (busy) return;
    const id = event.target.closest("[data-preset]")?.dataset.preset;
    const preset = presets.find((item) => item.id === id);
    if (preset) { fillForm(preset.id ? { ...preset, id: '', llm_api_key_configured: false, llm_max_tokens: DEFAULT_TOKENS } : null); formDirty = true; $('#llmApiKey').focus(); }
  });
  $("#importLlmProfile").addEventListener("click", importConfig);
  $("#llmImportFile").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const version = importEpoch;
    try { const text = await file.text(); if (importEpoch !== version || settingsRoute().kind !== 'import') return; $('#llmImportText').value = text; await importConfig(); }
    catch { if (importEpoch === version) $('#llmImportState').textContent = '无法读取文件，请重新选择。'; }
  });
  $('#checkModel').addEventListener('click', checkConnection);
  for (const event of ['hashchange', 'popstate', 'settings:navigate']) window.addEventListener(event, syncEditorRoute);
  window.addEventListener('app:privacy-hidden', () => {
    importEpoch += 1;
    if (!keyChanged && draft?.llm_api_key_configured) { $('#llmApiKey').value = KEY_MASK; keyMasked = true; }
    $('#llmApiKey').type = 'password'; $('#llmToggleKey').disabled = false; $('#llmToggleKey').setAttribute('aria-pressed', 'false'); $('#llmToggleKey').setAttribute('aria-label', '显示 API Key');
    formEpoch += 1;
  });
  syncEditorRoute();
}

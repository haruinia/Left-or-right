import { fetchGateway, fetchGatewayJson, postJson } from "./gateway.js";
import { escapeHtml } from "./ui.js";

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

function setState(text, kind = "") {
  const node = $("#llmProfileState");
  node.textContent = text;
  node.dataset.kind = kind;
}

function readForm() {
  return {
    llm_base_url: $("#llmBaseUrl").value.trim(),
    llm_model: $("#llmModel").value.trim(),
    llm_max_tokens: Number($("#llmMaxTokens").value || DEFAULT_TOKENS),
    llm_api_key: keyChanged ? $("#llmApiKey").value.trim() : "",
  };
}

function fillForm(profile) {
  formEpoch += 1;
  editingId = profile?.id || "";
  draft = profile;
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
  const editing = profile.id === editingId;
  return `<article class="model-card${active ? " is-active" : ""}${editing ? " is-editing" : ""}">
    <div class="model-card-top"><strong>${escapeHtml(profile.llm_model || "未设置模型")}</strong>${active ? '<span class="model-badge">使用中</span>' : ""}</div>
    <p class="model-card-url">${escapeHtml(profile.llm_base_url || "待填写接口 URL")}</p>
    <footer>${active ? "" : `<button type="button" class="secondary" data-activate="${escapeHtml(profile.id)}">使用</button>`}<button type="button" class="text-button" data-edit="${escapeHtml(profile.id)}">编辑</button><button type="button" class="text-button is-danger" data-delete="${escapeHtml(profile.id)}">删除</button></footer>
  </article>`;
}

function renderCards() {
  $("#llmProfileCards").innerHTML = profiles.length
    ? profiles.map(profileCard).join("")
    : '<p class="empty-state">添加接口 URL、API Key 和模型名称，就可以开始使用。</p>';
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
  try {
    applyProfiles(await fetchGatewayJson("/api/config/llm/profiles"));
    fillForm(profiles.find((profile) => profile.id === activeId) || null);
    setState("");
  } catch (error) {
    setState(`读取失败：${error.message || error}`, "error");
  }
}

function payloadFor(profile) {
  const form = readForm();
  const sameUrl = profile?.llm_base_url.replace(/\/+$/, "") === form.llm_base_url.replace(/\/+$/, "");
  return {
    ...form,
    profile_id: profile?.id || `p_${crypto.randomUUID()}`,
    name: form.llm_model,
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
  if (!form.llm_base_url || !form.llm_model) {
    setState("请填写接口 URL 和模型名称。", "error");
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
    if (formEpoch === epoch) fillForm(profiles.find((item) => item.id === activeId) || null);
    setState("已保存，下次提问使用这个模型。");
    return true;
  } catch (error) {
    setState(`保存未完成：${error.message || error}`, "error");
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
    fillForm(profiles.find((item) => item.id === activeId) || null);
    setState("已切换当前模型。");
  } catch (error) {
    setState(`切换失败：${error.message || error}`, "error");
  } finally { busy = false; }
}

async function deleteProfile(id) {
  if (busy || !confirm("删除这个模型配置？")) return;
  busy = true;
  try {
    const response = await fetchGateway(`/api/config/llm/profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
    applyProfiles(await response.json());
    if (editingId === id) fillForm(profiles.find((item) => item.id === activeId) || null);
    setState("已删除模型配置。");
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
  busy = true;
  $("#importLlmProfile").disabled = true;
  try {
    const result = await postJson("/api/config/llm/import", { config });
    applyProfiles(result);
    $("#llmImportText").value = "";
    $("#llmImportFile").value = "";
    status.textContent = `已导入 ${result.imported} 个模型，当前模型未切换。`;
  } catch (error) { status.textContent = `导入失败：${error.message || error}`; }
  finally { busy = false; $("#importLlmProfile").disabled = false; }
}

async function checkConnection() {
  const button = $("#checkModel");
  button.disabled = true;
  setState("正在测试已保存的当前模型…");
  try {
    const result = await fetchGatewayJson("/api/config/llm/check", { method: "POST", timeoutMs: 120000 });
    setState(result.ok ? "当前模型连接正常。" : result.message || "连接失败，请检查接口和密钥。", result.ok ? "" : "error");
  } catch (error) { setState(`测试失败：${error.message || error}`, "error"); }
  finally { button.disabled = false; }
}

export function wireModelConfig() {
  $("#llmForm").addEventListener("submit", saveProfile);
  $("#llmToggleKey").addEventListener("click", toggleKey);
  $("#llmApiKey").addEventListener("focus", () => { if (keyMasked) $("#llmApiKey").select(); });
  $("#llmApiKey").addEventListener("input", () => { keyChanged = true; keyMasked = false; });
  $("#llmNewProfile").addEventListener("click", () => { if (busy) return; fillForm(null); setState(""); $("#llmBaseUrl").focus(); });
  $("#llmCancelEdit").addEventListener("click", () => {
    if (busy) return;
    fillForm(profiles.find((item) => item.id === editingId) || profiles.find((item) => item.id === activeId) || null);
    setState("");
  });
  $("#llmProfileCards").addEventListener("click", (event) => {
    if (busy) return;
    const edit = event.target.closest("[data-edit]")?.dataset.edit;
    const activate = event.target.closest("[data-activate]")?.dataset.activate;
    const remove = event.target.closest("[data-delete]")?.dataset.delete;
    if (edit) { fillForm(profiles.find((item) => item.id === edit)); setState(""); $("#llmBaseUrl").focus(); }
    if (activate) activateProfile(activate);
    if (remove) deleteProfile(remove);
  });
  $("#llmPresetCards").addEventListener("click", (event) => {
    if (busy) return;
    const id = event.target.closest("[data-preset]")?.dataset.preset;
    const preset = presets.find((item) => item.id === id);
    if (preset) { fillForm(preset.id ? { ...preset, id: "", llm_api_key_configured: false, llm_max_tokens: DEFAULT_TOKENS } : null); setState("已填入预置，保存后才会切换。"); $("#llmApiKey").focus(); }
  });
  $("#importLlmProfile").addEventListener("click", importConfig);
  $("#llmImportFile").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try { $("#llmImportText").value = await file.text(); await importConfig(); }
    catch { $("#llmImportState").textContent = "无法读取文件，请重新选择。"; }
  });
  $("#checkModel").addEventListener("click", checkConnection);
}

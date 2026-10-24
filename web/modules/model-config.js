import { fetchGateway, fetchGatewayJson, postJson } from "./gateway.js";
import { appendEvent, escapeHtml } from "./ui.js";

const $ = (selector) => document.querySelector(selector);

// 表单只在用户没改过时跟随服务端值，避免刷新状态时把草稿覆盖掉。
const fields = {
  name: "#llmProfileName",
  llm_base_url: "#llmBaseUrl",
  llm_model: "#llmModel",
  vision_model: "#llmVisionModel",
  llm_protocol: "#llmProtocol",
  llm_max_tokens: "#llmMaxTokens",
  llm_api_path: "#llmApiPath",
  llm_auth_header: "#llmAuthHeader",
  llm_auth_scheme: "#llmAuthScheme",
  llm_response_content_path: "#llmResponsePath",
  llm_extra_body_json: "#llmExtraBody",
};

let profiles = [];
let activeId = "";
let presets = [];
let dirty = false;
const stateNode = () => $("#llmProfileState");

function setState(text, kind = "") {
  const node = stateNode();
  if (!node) return;
  node.textContent = text;
  if (kind) node.dataset.kind = kind;
}

function readForm() {
  const read = (selector) => $(selector)?.value.trim() ?? "";
  return {
    llm_profile_id: activeId,
    name: read("#llmProfileName"),
    llm_base_url: read("#llmBaseUrl"),
    llm_model: read("#llmModel"),
    vision_model: read("#llmVisionModel"),
    llm_protocol: read("#llmProtocol") || "auto",
    llm_max_tokens: Number(read("#llmMaxTokens") || 16384),
    llm_api_path: read("#llmApiPath"),
    llm_auth_header: read("#llmAuthHeader"),
    llm_auth_scheme: read("#llmAuthScheme"),
    llm_response_content_path: read("#llmResponsePath"),
    llm_extra_body_json: read("#llmExtraBody"),
    llm_api_key: $("#llmApiKey")?.value ?? "",
    clear_api_key: Boolean($("#llmClearKey")?.checked),
  };
}

function fillForm(profile) {
  if (!profile) return;
  activeId = profile.id;
  for (const [key, selector] of Object.entries(fields)) {
    const input = $(selector);
    if (!input) continue;
    const value = profile[key] ?? "";
    input.value = key === "llm_max_tokens" ? value || 16384 : value;
  }
  const keyInput = $("#llmApiKey");
  if (keyInput) {
    keyInput.value = "";
    keyInput.placeholder = profile.llm_api_key_configured ? "已配置，留空保持不变" : "尚未配置";
  }
  if ($("#llmClearKey")) $("#llmClearKey").checked = false;
  dirty = false;
  renderModelOptions();
}

function renderProfiles() {
  const select = $("#llmProfileSelect");
  if (!select) return;
  select.replaceChildren(
    ...profiles.map((profile) => new Option(
      `${profile.name || profile.llm_model}${profile.id === activeId ? " · 使用中" : ""}`,
      profile.id,
    )),
  );
  if (profiles.some((profile) => profile.id === activeId)) select.value = activeId;
}

function renderPresets() {
  const list = $("#llmModelOptions");
  if (!list) return;
  const models = new Set(profiles.flatMap((profile) => [profile.llm_model, profile.vision_model]));
  presets.forEach((preset) => (preset.models || []).forEach((model) => models.add(model)));
  list.replaceChildren(...[...models].filter(Boolean).map((model) => new Option(model, model)));
}

function renderModelOptions() {
  renderProfiles();
  renderPresets();
}

export function applyProfiles(data) {
  profiles = data.profiles || [];
  activeId = data.active_profile_id || profiles[0]?.id || "";
  presets = data.presets || presets;
  renderModelOptions();
  const active = profiles.find((profile) => profile.id === activeId);
  if (active && !dirty) fillForm(active);
  const connected = document.querySelector("#connectedModel");
  if (connected && active) {
    connected.textContent = `${active.name || active.llm_model} · ${active.llm_model}`;
  }
}

export async function loadProfiles() {
  try {
    applyProfiles(await fetchGatewayJson("/api/config/llm/profiles"));
    setState("选择已保存的接入继续编辑，或新建一套。");
  } catch (error) {
    setState(`读取接入配置失败：${error.message || error}`, "error");
  }
}

function markDirty() {
  dirty = true;
  setState("有未保存的修改");
}

async function saveProfile(extra = {}) {
  const button = $("#saveLlmProfile");
  if (button) button.disabled = true;
  try {
    const payload = { ...readForm(), ...extra };
    await postJson("/api/config/llm", payload);
    const keyInput = $("#llmApiKey");
    if (keyInput) keyInput.value = "";
    if ($("#llmClearKey")) $("#llmClearKey").checked = false;
    dirty = false;
    await loadProfiles();
    setState("已保存并启用。", "ok");
    appendEvent("模型配置", `已启用：${escapeHtml(payload.name || payload.llm_model)}`, "green");
    return true;
  } catch (error) {
    setState(`保存失败：${error.message || error}`, "error");
    return false;
  } finally {
    if (button) button.disabled = false;
  }
}

async function importConfig() {
  const text = $("#llmImportText")?.value.trim() ?? "";
  const status = $("#llmImportState");
  if (!text) {
    if (status) status.textContent = "先粘贴 JSON 或选择文件。";
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (status) status.textContent = "JSON 格式无效，请检查引号和逗号。";
    return;
  }
  try {
    const result = await postJson("/api/config/llm/import", { config: parsed });
    applyProfiles(result);
    if (status) status.textContent = `已导入 ${result.imported} 条配置，选择后点「保存并启用」才会生效。`;
    appendEvent("模型配置", `已导入 ${result.imported} 条接入配置。`, "green");
  } catch (error) {
    if (status) status.textContent = `导入失败：${error.message || error}`;
  }
}

export function wireModelConfig() {
  document.querySelectorAll(Object.values(fields).join(",")).forEach((input) => {
    input.addEventListener("input", markDirty);
    input.addEventListener("change", markDirty);
  });

  $("#llmProfileSelect")?.addEventListener("change", (event) => {
    const profile = profiles.find((item) => item.id === event.target.value);
    if (!profile) return;
    fillForm(profile);
    setState("已切换到这套接入，保存后会立即启用。");
  });
  $("#llmNewProfile")?.addEventListener("click", () => {
    fillForm({
      id: "",
      name: "",
      llm_model: "",
      llm_base_url: "",
      llm_protocol: "auto",
      llm_api_path: "/chat/completions",
      llm_auth_header: "Authorization",
      llm_auth_scheme: "Bearer",
      llm_response_content_path: "choices.0.message.content",
      llm_extra_body_json: "",
      llm_max_tokens: 16384,
      vision_model: "",
      llm_api_key_configured: false,
    });
    markDirty();
    setState("正在新建接入，填写后保存并启用。");
  });
  $("#llmDeleteProfile")?.addEventListener("click", async () => {
    if (!activeId) return;
    try {
      const response = await fetchGateway(`/api/config/llm/profiles/${encodeURIComponent(activeId)}`, {
        method: "DELETE",
      });
      applyProfiles(await response.json());
      setState("已删除所选接入。");
    } catch (error) {
      setState(`删除失败：${error.message || error}`, "error");
    }
  });
  $("#saveLlmProfile")?.addEventListener("click", () => saveProfile());
  $("#saveLlmApiOnly")?.addEventListener("click", async () => {
    const saved = await saveProfile();
    if (saved && $("#llmImportState")) $("#llmImportState").textContent = "密钥已保存到本机。";
  });
  $("#importLlmProfile")?.addEventListener("click", importConfig);
  $("#llmImportFile")?.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const input = $("#llmImportText");
      if (input) input.value = String(reader.result || "");
      importConfig();
    };
    reader.readAsText(file);
  });
  // 深链接：从首页「管理模型接入」直接定位到本区。
  if (location.hash === "#models") {
    document.querySelector("#models")?.scrollIntoView({ block: "start" });
  }
}

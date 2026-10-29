import { fetchGateway, fetchGatewayJson, postJson } from "./gateway.js";
import { appendEvent, escapeHtml } from "./ui.js";

const $ = (selector) => document.querySelector(selector);

let profiles = [];
let presets = [];
let activeId = "";
let editingId = "";
let draft = null;

const DEFAULT_TOKENS = 30000;

function setState(text, kind = "") {
  const node = $("#llmProfileState");
  if (!node) return;
  node.textContent = text;
  node.dataset.kind = kind;
}

function readForm() {
  const value = (selector) => $(selector)?.value.trim() ?? "";
  return {
    name: value("#llmName"),
    llm_base_url: value("#llmBaseUrl"),
    llm_model: value("#llmModel"),
    llm_max_tokens: Number(value("#llmMaxTokens") || DEFAULT_TOKENS),
    llm_api_key: $("#llmApiKey")?.value ?? "",
  };
}

// 表单只编辑地址、名称、模型、额度和密钥；协议与鉴权沿用所选配置，避免保存时被重置。
function payloadFor(profile) {
  const form = readForm();
  return {
    // 新建时给唯一 id，避免后端把新增当成覆盖当前配置。
    profile_id: profile?.id || `p_${Date.now().toString(36)}`,
    name: form.name || profile?.name || "",
    llm_base_url: form.llm_base_url,
    llm_model: form.llm_model,
    llm_max_tokens: form.llm_max_tokens,
    llm_api_key: form.llm_api_key,
    llm_protocol: profile?.llm_protocol || "auto",
    llm_api_path: profile?.llm_api_path || "/chat/completions",
    llm_auth_header: profile?.llm_auth_header || "Authorization",
    llm_auth_scheme: profile?.llm_auth_scheme ?? "Bearer",
    llm_response_content_path:
      profile?.llm_response_content_path || "choices.0.message.content",
    llm_extra_body_json: profile?.llm_extra_body_json || "",
    vision_model: profile?.vision_model || "",
  };
}

function keyHint(profile) {
  return profile?.llm_api_key_configured ? "密钥已保存" : "未配置密钥";
}

function tokenLabel(profile) {
  const value = Number(profile?.llm_max_tokens || DEFAULT_TOKENS);
  return value >= 1000 ? `${Math.round(value / 1000)}k tokens` : `${value} tokens`;
}

function fillForm(profile) {
  editingId = profile?.id || "";
  draft = profile || null;
  if ($("#llmName")) $("#llmName").value = profile?.name || "";
  if ($("#llmBaseUrl")) $("#llmBaseUrl").value = profile?.llm_base_url || "";
  if ($("#llmModel")) $("#llmModel").value = profile?.llm_model || "";
  if ($("#llmMaxTokens")) $("#llmMaxTokens").value = String(profile?.llm_max_tokens || DEFAULT_TOKENS);
  const keyInput = $("#llmApiKey");
  if (keyInput) {
    keyInput.value = "";
    keyInput.placeholder = profile?.llm_api_key_configured ? "已配置，留空保持不变" : "尚未配置";
  }
  const title = $("#llmFormTitle");
  if (title) {
    title.textContent = profile?.id ? "编辑接入" : "新建接入";
  }
  const tag = $("#llmEditTag");
  if (tag) {
    tag.hidden = !profile?.id;
    tag.textContent = profile?.id === activeId ? "当前使用中" : "";
  }
  const cancel = $("#llmCancelEdit");
  if (cancel) cancel.hidden = !profile?.id;
  setEditingHighlight();
}

function setEditingHighlight() {
  document.querySelectorAll("#llmProfileCards .model-card").forEach((card) => {
    card.classList.toggle("is-editing", card.dataset.id === editingId);
  });
}

function currentPanel(profile) {
  if (!profile) {
    return `
      <div class="model-current is-empty">
        <div>
          <strong>还没有可用的接入</strong>
          <p class="small">选一个本地预置，或新建一条接入后保存。</p>
        </div>
        <button type="button" class="secondary" data-focus-form>去填写</button>
      </div>
    `;
  }
  return `
    <div class="model-current">
      <div class="model-current-main">
        <span class="model-eyebrow">当前使用</span>
        <strong>${escapeHtml(profile.name || profile.llm_model)}</strong>
        <div class="model-current-meta">
          <code title="${escapeHtml(profile.llm_model)}">${escapeHtml(profile.llm_model)}</code>
          <span class="model-dot" aria-hidden="true"></span>
          <span title="${escapeHtml(profile.llm_base_url)}">${escapeHtml(profile.llm_base_url)}</span>
          <span class="model-dot" aria-hidden="true"></span>
          <span>${escapeHtml(tokenLabel(profile))}</span>
          <span class="model-dot" aria-hidden="true"></span>
          <span class="${profile.llm_api_key_configured ? "" : "is-warn"}">${escapeHtml(keyHint(profile))}</span>
        </div>
      </div>
      <div class="model-current-actions">
        <button type="button" class="secondary" data-edit="${escapeHtml(profile.id)}">编辑</button>
        <button type="button" class="ghost small-button" data-test="${escapeHtml(profile.id)}">检查连接</button>
      </div>
    </div>
  `;
}

function profileCard(profile) {
  return `
    <article class="model-card" data-id="${escapeHtml(profile.id)}">
      <div class="model-card-top">
        <strong>${escapeHtml(profile.name || profile.llm_model)}</strong>
        <span class="model-card-key ${profile.llm_api_key_configured ? "" : "is-warn"}">${escapeHtml(keyHint(profile))}</span>
      </div>
      <code title="${escapeHtml(profile.llm_model)}">${escapeHtml(profile.llm_model)}</code>
      <span class="model-card-url" title="${escapeHtml(profile.llm_base_url)}">${escapeHtml(profile.llm_base_url)}</span>
      <footer>
        <button type="button" class="ghost small-button" data-activate="${escapeHtml(profile.id)}">启用</button>
        <button type="button" class="ghost small-button" data-edit="${escapeHtml(profile.id)}">编辑</button>
        <button type="button" class="ghost small-button is-danger" data-delete="${escapeHtml(profile.id)}">删除</button>
      </footer>
    </article>
  `;
}

function presetCard(preset) {
  return `
    <button type="button" class="model-preset" data-preset="${escapeHtml(preset.id)}">
      <strong>${escapeHtml(preset.name)}</strong>
      <code>${escapeHtml(preset.llm_model)}</code>
      <span>${escapeHtml(preset.llm_base_url)}</span>
    </button>
  `;
}

function renderCards() {
  const active = profiles.find((profile) => profile.id === activeId) || null;
  const others = profiles.filter((profile) => profile.id !== activeId);

  const current = $("#llmCurrent");
  if (current) current.innerHTML = currentPanel(active);

  const saved = $("#llmProfileCards");
  if (saved) {
    saved.innerHTML = others.length
      ? others.map(profileCard).join("")
      : '<p class="small model-empty">只保存了一条接入。新建一条后，这里可以随时切换。</p>';
  }

  const presetNode = $("#llmPresetCards");
  if (presetNode) {
    presetNode.innerHTML = presets.length ? presets.map(presetCard).join("") : "";
    const presetBlock = $("#llmPresetBlock");
    if (presetBlock) presetBlock.hidden = !presets.length;
  }

  const list = $("#llmModelOptions");
  if (list) {
    const models = new Set(profiles.flatMap((profile) => [profile.llm_model, profile.vision_model]));
    presets.forEach((preset) => (preset.models || []).forEach((model) => models.add(model)));
    list.replaceChildren(...[...models].filter(Boolean).map((model) => new Option(model, model)));
  }
  setEditingHighlight();
}

export function applyProfiles(data) {
  profiles = data.profiles || [];
  presets = data.presets || presets;
  activeId = data.active_profile_id || profiles[0]?.id || "";
  renderCards();
  // 首次加载，或正在编辑的配置已被删除时，回填当前使用的配置。
  const editing = profiles.find((profile) => profile.id === editingId);
  if (!editingId || !editing) fillForm(profiles.find((profile) => profile.id === activeId) || null);
}

export async function loadProfiles() {
  try {
    applyProfiles(await fetchGatewayJson("/api/config/llm/profiles"));
    setState("修改后点保存并启用。");
  } catch (error) {
    setState(`读取接入配置失败：${error.message || error}`, "error");
  }
}

// 新建时如果地址和模型已经存在，就直接更新那一条，避免同一套接入出现两张卡。
function matchExisting(form) {
  const base = form.llm_base_url.replace(/\/+$/, "");
  return profiles.find(
    (item) => item.id !== editingId
      && item.llm_base_url.replace(/\/+$/, "") === base
      && item.llm_model === form.llm_model,
  );
}

async function saveProfile() {
  const button = $("#saveLlmProfile");
  let profile = profiles.find((item) => item.id === editingId) || draft;
  if (!profile?.id) {
    const match = matchExisting(readForm());
    if (match) profile = match;
  }
  const payload = payloadFor(profile);
  if (!payload.llm_base_url || !payload.llm_model) {
    setState("请先填写接口地址和模型名。", "error");
    return false;
  }
  if (button) button.disabled = true;
  setState("正在保存…");
  try {
    await postJson("/api/config/llm", payload);
    const keyInput = $("#llmApiKey");
    if (keyInput) keyInput.value = "";
    editingId = "";
    draft = null;
    await loadProfiles();
    setState("已保存并启用。", "ok");
    appendEvent("模型配置", `已启用：${escapeHtml(payload.llm_model)}`, "green");
    return true;
  } catch (error) {
    setState(`保存失败：${error.message || error}`, "error");
    return false;
  } finally {
    if (button) button.disabled = false;
  }
}

async function activateProfile(profileId) {
  const profile = profiles.find((item) => item.id === profileId);
  if (!profile) return;
  setState(`正在切换到 ${profile.name || profile.llm_model}…`);
  try {
    applyProfiles(await postJson("/api/config/llm/activate", { profile_id: profileId }));
    editingId = "";
    draft = null;
    fillForm(profiles.find((item) => item.id === activeId) || null);
    setState(`已启用 ${profile.name || profile.llm_model}。`, "ok");
  } catch (error) {
    setState(`切换失败：${error.message || error}`, "error");
  }
}

async function deleteProfile(profileId) {
  if (!profileId) return;
  if (!confirm("删除这套接入配置？")) return;
  try {
    const response = await fetchGateway(
      `/api/config/llm/profiles/${encodeURIComponent(profileId)}`,
      { method: "DELETE" },
    );
    if (editingId === profileId) {
      editingId = "";
      draft = null;
    }
    applyProfiles(await response.json());
    setState("已删除。");
  } catch (error) {
    setState(`删除失败：${error.message || error}`, "error");
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
  } catch {
    if (status) status.textContent = "JSON 格式无效，请检查引号和逗号。";
    return;
  }
  try {
    const result = await postJson("/api/config/llm/import", { config: parsed });
    applyProfiles(result);
    if (status) status.textContent = `已导入 ${result.imported} 条配置，点卡片编辑后保存启用。`;
    appendEvent("模型配置", `已导入 ${result.imported} 条接入配置。`, "green");
  } catch (error) {
    if (status) status.textContent = `导入失败：${error.message || error}`;
  }
}

function handleCardClick(event) {
  const activateId = event.target.closest("[data-activate]")?.dataset.activate;
  if (activateId) {
    activateProfile(activateId);
    return;
  }
  const editId = event.target.closest("[data-edit]")?.dataset.edit;
  if (editId) {
    const profile = profiles.find((item) => item.id === editId);
    if (profile) {
      fillForm(profile);
      $("#llmName")?.focus();
    }
    return;
  }
  const testId = event.target.closest("[data-test]")?.dataset.test;
  if (testId) {
    document.querySelector("#checkModel")?.click();
    return;
  }
  const deleteId = event.target.closest("[data-delete]")?.dataset.delete;
  if (deleteId) deleteProfile(deleteId);
}

function handlePresetClick(event) {
  const presetId = event.target.closest("[data-preset]")?.dataset.preset;
  if (!presetId) return;
  const preset = presets.find((item) => item.id === presetId);
  if (!preset) return;
  fillForm({
    id: "",
    name: preset.name,
    llm_base_url: preset.llm_base_url,
    llm_model: preset.llm_model,
    llm_max_tokens: DEFAULT_TOKENS,
    llm_protocol: "auto",
    llm_api_path: "/chat/completions",
    llm_auth_header: "Authorization",
    llm_auth_scheme: "Bearer",
    llm_response_content_path: "choices.0.message.content",
    llm_extra_body_json: "",
    vision_model: "",
    llm_api_key_configured: false,
  });
  setState("已填入预置，补上 API Key 后保存并启用。");
  $("#llmApiKey")?.focus();
}

function wireCards() {
  $("#llmProfileCards")?.addEventListener("click", handleCardClick);
  $("#llmCurrent")?.addEventListener("click", (event) => {
    if (event.target.closest("[data-focus-form]")) {
      $("#llmBaseUrl")?.focus();
      return;
    }
    handleCardClick(event);
  });
  $("#llmPresetCards")?.addEventListener("click", handlePresetClick);
}

export function wireModelConfig() {
  wireCards();
  $("#llmNewProfile")?.addEventListener("click", () => {
    fillForm(null);
    setState("正在新建接入，填写后保存并启用。");
    $("#llmBaseUrl")?.focus();
  });
  $("#llmCancelEdit")?.addEventListener("click", () => {
    fillForm(profiles.find((item) => item.id === activeId) || null);
    setState("已取消编辑，表单回到当前使用的接入。");
  });
  $("#saveLlmProfile")?.addEventListener("click", saveProfile);
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
  if (location.hash === "#models") {
    $("#models")?.scrollIntoView({ block: "start" });
  }
}

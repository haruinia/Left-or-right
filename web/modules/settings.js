import { DEFAULT_HOTKEYS, formatAccelerator, acceleratorFromEvent, shortcutConflict } from "./shortcuts.js";
import { isExamSpecialty } from "./study-presets.js";
import { parseDocumentFile } from "./documents.js";
import { checkAsr, checkModel, gatewayKey, jdText, longTermMemoryConsent, refreshStatus, resumeText, saveGatewayKey } from "./dom.js";
import { fetchGatewayJson, postJson, saveGatewayConnection } from "./gateway.js";
import { checkAsrReadiness, checkLlmConnection, checkRuntime } from "./runtime.js";
import { state } from "./state.js";
import { appendEvent, escapeHtml } from "./ui.js";
import "./assets.js"; // 学习资产板块（会话记录/知识库/反馈）

const studyFields = {
  study_specialty: document.querySelector("#studySpecialty"),
  study_language: document.querySelector("#studyLanguage"),
  study_goal: document.querySelector("#studyGoal"),
  study_answer_style: document.querySelector("#studyAnswerStyle"),
  study_instructions: document.querySelector("#studyInstructions"),
};
const saveState = document.querySelector("#settingsSaveState");
let settingsLoaded = false;
let savedUiSettings = {};

const HOTKEY_ACTIONS = Object.keys(DEFAULT_HOTKEYS);
const mac = /Mac|iPhone|iPad/.test(navigator.platform);
const hotkeyFeedback = document.querySelector("#hotkeyFeedback");

function hotkeyInputs() {
  return HOTKEY_ACTIONS.map((action) => document.querySelector(`[data-hotkey="${action}"]`)).filter(Boolean);
}

function readHotkeysFromForm() {
  const hotkeys = {};
  for (const input of hotkeyInputs()) {
    hotkeys[input.dataset.hotkey] = input.dataset.accelerator;
  }
  return hotkeys;
}

function applyHotkeysToForm(hotkeys) {
  for (const input of hotkeyInputs()) {
    const value = hotkeys[input.dataset.hotkey];
    input.disabled = false;
    if (value) input.dataset.accelerator = value;
    input.value = formatAccelerator(input.dataset.accelerator || "", mac);
    const preview = document.querySelector(`[data-preview="${input.dataset.hotkey}"]`);
    if (preview) preview.textContent = "点击录入组合键";
  }
}

function hydrateForm(saved) {
  savedUiSettings = saved;
  for (const [key, input] of Object.entries(studyFields)) input.value = saved[key] ?? "";
  if (jdText) jdText.value = saved.jd_text || "";
  if (resumeText) resumeText.value = saved.resume_text || "";
  if (longTermMemoryConsent && typeof saved.long_term_memory_consent === "boolean") {
    longTermMemoryConsent.checked = saved.long_term_memory_consent;
  }
  applyHotkeysToForm(saved.hotkeys || DEFAULT_HOTKEYS);
  validateHotkeys();
  syncStudyHint();
}

function syncStudyHint() {
  const hint = document.querySelector("#studySpecialtyHint");
  if (!hint || !studyFields.study_specialty) return;
  hint.hidden = !isExamSpecialty(studyFields.study_specialty.value);
}

async function loadUiSettings() {
  try {
    const saved = await fetchGatewayJson("/api/ui/settings");
    hydrateForm(saved);
    settingsLoaded = true;
    document.querySelector("#resetHotkeys").disabled = false;
    document.querySelector("#saveUiSettings").disabled = false;
    saveState.textContent = "修改后点击保存，同步到桌面应用。";
  } catch (error) {
    saveState.textContent = "读取失败，请检查服务连接后刷新页面。";
    appendEvent("设置", `读取失败：${escapeHtml(error.message || error)}`, "red");
  }
}

async function saveUiSettings(event) {
  event.preventDefault();
  if (!settingsLoaded || !validateHotkeys()) return;
  const button = document.querySelector("#saveUiSettings");
  if (button) button.disabled = true;
  try {
    const saved = await postJson("/api/ui/settings", {
      ...savedUiSettings,
      ...Object.fromEntries(Object.entries(studyFields).map(([key, input]) => [key, input.value.trim()])),
      jd_text: jdText ? jdText.value : "",
      resume_text: resumeText ? resumeText.value : "",
      long_term_memory_consent: Boolean(longTermMemoryConsent && longTermMemoryConsent.checked),
      hotkeys: readHotkeysFromForm(),
    });
    hydrateForm(saved);
    saveState.textContent = "已保存，下次提问会使用新的复习预设。";
    appendEvent("设置", "复习预设与快捷键已保存。", "green");
  } catch (error) {
    saveState.textContent = "保存失败，修改仍保留在页面中。";
    appendEvent("设置", `保存失败：${escapeHtml(error.message || error)}`, "red");
  } finally {
    if (button) button.disabled = false;
  }
}

function loadSampleSettings() {
  if (jdText) {
    jdText.value =
      "负责 LLM 应用平台、FastAPI 微服务、模型调用编排、可靠性治理、评估报告与线上故障排查。要求能独立做技术方案、指标设计、降级策略和跨团队协作。";
  }
  if (resumeText) {
    resumeText.value =
      "候选人自述 5 年 Python 后端经验，最近负责 AI 面试评估系统，涉及 FastAPI 网关、LLM JSON 解析、重试降级、报告生成和可观测性指标。";
  }
  appendEvent("样例资料", "已填入一组 JD 和简历，点击保存设置后生效。");
}

if (!state.gatewayApiKey && typeof window.__GATEWAY_KEY__ === "string") {
  state.gatewayApiKey = window.__GATEWAY_KEY__.trim();
}
if (gatewayKey) gatewayKey.value = state.gatewayApiKey;

document.querySelector("#jdFile")?.addEventListener("change", (event) => {
  parseDocumentFile(event.target.files[0], event.target, jdText, "JD", "jd");
});
document.querySelector("#resumeFile")?.addEventListener("change", (event) => {
  parseDocumentFile(event.target.files[0], event.target, resumeText, "简历", "resume");
});
function validateHotkeys() {
  const conflict = shortcutConflict(readHotkeysFromForm(), mac);
  hotkeyFeedback.classList.toggle("is-error", Boolean(conflict));
  if (conflict) {
    const labels = conflict.map((action) => document.querySelector(`[data-hotkey="${action}"]`).closest("label").firstChild.textContent.trim());
    hotkeyFeedback.textContent = `「${labels[0]}」与「${labels[1]}」使用了相同按键，请修改后保存。`;
    saveState.textContent = "快捷键冲突，尚未保存。";
    return false;
  }
  hotkeyFeedback.textContent = "原有功能全部保留。保存后自动同步；系统占用的组合键会在桌面提示。";
  return true;
}

document.querySelector("#resetHotkeys").disabled = true;
hotkeyInputs().forEach((input) => {
  input.disabled = true;
  input.readOnly = true;
  input.setAttribute("aria-describedby", "hotkeyFeedback");
  input.addEventListener("focus", () => {
    input.value = "";
    input.placeholder = "按下新的组合键…";
  });
  input.addEventListener("blur", () => {
    input.value = formatAccelerator(input.dataset.accelerator || "", mac);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) return;
    event.preventDefault();
    if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      input.blur();
      return;
    }
    const accelerator = acceleratorFromEvent(event, mac);
    if (!accelerator) return;
    input.dataset.accelerator = accelerator;
    input.value = formatAccelerator(accelerator, mac);
    saveState.textContent = "有未保存的修改";
    validateHotkeys();
    input.blur();
  });
});
document.querySelector("#resetHotkeys").addEventListener("click", () => {
  applyHotkeysToForm(DEFAULT_HOTKEYS);
  validateHotkeys();
  saveState.textContent = "已恢复默认快捷键，点击保存后生效。";
});
document.querySelector("#studySettingsForm")?.addEventListener("submit", saveUiSettings);
document.querySelector("#studySettingsForm")?.addEventListener("input", () => {
  syncStudyHint();
  if (settingsLoaded) saveState.textContent = "有未保存的修改";
});
document.querySelector("#loadSampleSettings")?.addEventListener("click", loadSampleSettings);
async function saveLlmConfig() {
  const button = document.querySelector("#saveLlmConfig");
  const model = document.querySelector("#llmModel")?.value.trim() ?? "";
  const baseUrl = document.querySelector("#llmBaseUrl")?.value.trim() ?? "";
  const apiKey = document.querySelector("#llmApiKey")?.value ?? "";
  if (!model || !baseUrl) {
    saveState.textContent = "请先填写模型名和模型接口地址。";
    return;
  }
  if (button) button.disabled = true;
  try {
    const status = await postJson("/api/config/llm", {
      llm_model: model,
      llm_base_url: baseUrl,
      llm_api_key: apiKey,
    });
    const keyInput = document.querySelector("#llmApiKey");
    if (keyInput) keyInput.value = "";
    saveState.textContent = "模型配置已保存并生效。";
    appendEvent("模型配置", `已保存并生效：${escapeHtml(status.llm_provider)} · ${escapeHtml(status.llm_model)}`, "green");
    checkRuntime();
  } catch (error) {
    saveState.textContent = "模型配置保存失败。";
    appendEvent("模型配置", `保存失败：${escapeHtml(error.message || error)}`, "red");
  } finally {
    if (button) button.disabled = false;
  }
}
const LAN_PRESET = {
  baseUrl: "http://192.168.2.251:9555/v1",
  apiKey: "tfl_807202ed3a706f06d7338b68e9286f444671c6a602fbd0518a56aff2b6a4cee3",
  defaultModel: "antigravity/claude-opus-4-6-thinking",
};
const SILICON_PRESET = {
  baseUrl: "https://api.siliconflow.cn/v1",
  apiKey: "sk-amdyurxdspunioseickjxswmxrjqgqhptygtkcmvcamtumdy",
  defaultModel: "deepseek-ai/DeepSeek-V4.1-Flash",
};

document.querySelector("#presetLan")?.addEventListener("click", () => {
  const baseUrlInput = document.querySelector("#llmBaseUrl");
  const apiKeyInput = document.querySelector("#llmApiKey");
  const modelInput = document.querySelector("#llmModel");
  if (baseUrlInput) baseUrlInput.value = LAN_PRESET.baseUrl;
  if (apiKeyInput) apiKeyInput.value = LAN_PRESET.apiKey;
  if (modelInput && (!modelInput.value || modelInput.value.includes("deepseek-ai"))) {
    modelInput.value = LAN_PRESET.defaultModel;
  }
  saveState.textContent = "已填入局域网测试网关配置，点击【保存模型】生效。";
});

document.querySelector("#presetSiliconFlow")?.addEventListener("click", () => {
  const baseUrlInput = document.querySelector("#llmBaseUrl");
  const apiKeyInput = document.querySelector("#llmApiKey");
  const modelInput = document.querySelector("#llmModel");
  if (baseUrlInput) baseUrlInput.value = SILICON_PRESET.baseUrl;
  if (apiKeyInput) apiKeyInput.value = SILICON_PRESET.apiKey;
  if (modelInput) modelInput.value = SILICON_PRESET.defaultModel;
  saveState.textContent = "已填入 SiliconFlow 云端配置，点击【保存模型】生效。";
});

document.querySelector("#modelPresetChips")?.addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-preset-model]");
  if (!btn) return;
  const model = btn.dataset.presetModel;
  const modelInput = document.querySelector("#llmModel");
  if (modelInput) modelInput.value = model;
  const baseUrlInput = document.querySelector("#llmBaseUrl");
  const apiKeyInput = document.querySelector("#llmApiKey");
  if (model.startsWith("antigravity/") || model.startsWith("workbuddy/") || model.startsWith("qoder/")) {
    if (baseUrlInput && (!baseUrlInput.value || baseUrlInput.value.includes("siliconflow"))) {
      baseUrlInput.value = LAN_PRESET.baseUrl;
      if (apiKeyInput) apiKeyInput.value = LAN_PRESET.apiKey;
    }
  } else if (model.startsWith("deepseek-ai/")) {
    if (baseUrlInput && (!baseUrlInput.value || baseUrlInput.value.includes("192.168.2.251"))) {
      baseUrlInput.value = SILICON_PRESET.baseUrl;
      if (apiKeyInput) apiKeyInput.value = SILICON_PRESET.apiKey;
    }
  }
  saveState.textContent = `已选择模型 ${model}，点击【保存模型】生效。`;
});

document.querySelector("#saveLlmConfig")?.addEventListener("click", saveLlmConfig);
async function saveConnection() {
  const origin = document.querySelector("#gatewayOrigin");
  if (!origin.reportValidity()) return;
  saveGatewayConnection();
  settingsLoaded = false;
  document.querySelector("#saveUiSettings").disabled = true;
  saveState.textContent = "正在读取设置…";
  await loadUiSettings();
}
saveGatewayKey?.addEventListener("click", saveConnection);
for (const input of [gatewayKey, document.querySelector("#gatewayOrigin")]) {
  input?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    saveConnection();
  });
}
refreshStatus?.addEventListener("click", checkRuntime);
checkModel?.addEventListener("click", checkLlmConnection);
checkAsr?.addEventListener("click", checkAsrReadiness);

// 9958 只托管静态页；先完成服务发现，再读取8001上的配置。
checkRuntime().then(loadUiSettings);

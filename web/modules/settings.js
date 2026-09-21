import { parseDocumentFile } from "./documents.js";
import { checkAsr, checkModel, gatewayKey, jdText, longTermMemoryConsent, refreshStatus, resumeText, saveGatewayKey } from "./dom.js";
import { fetchGatewayJson, postJson, saveGatewayConnection } from "./gateway.js";
import { checkAsrReadiness, checkLlmConnection, checkRuntime } from "./runtime.js";
import { state } from "./state.js";
import { appendEvent, escapeHtml } from "./ui.js";

const HOTKEY_ACTIONS = [
  "toggleVisible",
  "showWindow",
  "hideWindow",
  "quitApp",
  "toggleCompact",
  "captureRegion",
  "captureScreen",
  "sendChat",
];

function formatAccelerator(accelerator) {
  const names = {
    CommandOrControl: "⌘",
    Command: "⌘",
    Control: "⌃",
    Ctrl: "Ctrl",
    Shift: "⇧",
    Alt: "⌥",
    Option: "⌥",
    Space: "Space",
    Enter: "Enter",
    Return: "Enter",
  };
  return String(accelerator)
    .split("+")
    .map((token) => names[token] || token)
    .join("");
}

function hotkeyInputs() {
  return HOTKEY_ACTIONS.map((action) => document.querySelector(`[data-hotkey="${action}"]`)).filter(Boolean);
}

function readHotkeysFromForm() {
  const hotkeys = {};
  for (const input of hotkeyInputs()) {
    hotkeys[input.dataset.hotkey] = input.value.trim();
  }
  return hotkeys;
}

function applyHotkeysToForm(hotkeys) {
  for (const input of hotkeyInputs()) {
    const value = hotkeys[input.dataset.hotkey];
    if (value) input.value = value;
    const preview = document.querySelector(`[data-preview="${input.dataset.hotkey}"]`);
    if (preview) preview.textContent = formatAccelerator(input.value || value || "");
  }
}

function hydrateForm(saved) {
  if (saved.jd_text && jdText) jdText.value = saved.jd_text;
  if (saved.resume_text && resumeText) resumeText.value = saved.resume_text;
  if (longTermMemoryConsent && typeof saved.long_term_memory_consent === "boolean") {
    longTermMemoryConsent.checked = saved.long_term_memory_consent;
  }
  applyHotkeysToForm(saved.hotkeys || {});
}

async function loadUiSettings() {
  try {
    const saved = await fetchGatewayJson("/api/ui/settings");
    hydrateForm(saved);
  } catch (error) {
    appendEvent("设置", `读取失败：${escapeHtml(error.message || error)}`, "red");
  }
}

async function saveUiSettings() {
  const button = document.querySelector("#saveUiSettings");
  if (button) button.disabled = true;
  try {
    const saved = await postJson("/api/ui/settings", {
      jd_text: jdText ? jdText.value : "",
      resume_text: resumeText ? resumeText.value : "",
      long_term_memory_consent: Boolean(longTermMemoryConsent && longTermMemoryConsent.checked),
      hotkeys: readHotkeysFromForm(),
    });
    hydrateForm(saved);
    appendEvent("设置", "岗位、简历和快捷键已保存，桌面面板会自动同步。", "green");
  } catch (error) {
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
hotkeyInputs().forEach((input) => {
  input.addEventListener("input", () => {
    const preview = document.querySelector(`[data-preview="${input.dataset.hotkey}"]`);
    if (preview) preview.textContent = formatAccelerator(input.value);
  });
});
document.querySelector("#saveUiSettings")?.addEventListener("click", saveUiSettings);
document.querySelector("#loadSampleSettings")?.addEventListener("click", loadSampleSettings);
saveGatewayKey?.addEventListener("click", saveGatewayConnection);
gatewayKey?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") saveGatewayConnection();
});
document.querySelector("#gatewayOrigin")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") saveGatewayConnection();
});
refreshStatus?.addEventListener("click", checkRuntime);
checkModel?.addEventListener("click", checkLlmConnection);
checkAsr?.addEventListener("click", checkAsrReadiness);

checkRuntime();
loadUiSettings();

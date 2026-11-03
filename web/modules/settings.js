import "./protected-controls.js";
import { DEFAULT_HOTKEYS, formatAccelerator, acceleratorFromEvent, shortcutConflict } from "./shortcuts.js";
import { SPECIALTY_GROUPS, LANGUAGE_GROUPS, isExamSpecialty, fillStudyChoice, syncStudyCustom, readStudyChoice } from "./study-presets.js";
import { parseDocumentFile } from "./documents.js";
import { fetchGatewayJson, postJson } from "./gateway.js";
import { state } from "./state.js";
import { loadProfiles, wireModelConfig } from "./model-config.js";
import { settingsRoute, navigateSettings, returnToConnections } from './settings-navigation.js';
import "./assets.js";
import "./asr-config.js";
import "./interview-transcription.js";

const $ = (selector) => document.querySelector(selector);
document.addEventListener("pointerdown", () => { document.documentElement.dataset.keyboardFocus = "false"; });
document.addEventListener("keydown", (event) => { if (event.key === "Tab") document.documentElement.dataset.keyboardFocus = "true"; });
const studyFields = {
  study_specialty: $("#studySpecialty"),
  study_language: $("#studyLanguage"),
  study_goal: $("#studyGoal"),
  study_answer_style: $("#studyAnswerStyle"),
  study_instructions: $("#studyInstructions"),
  answer_language: $("#studyAnswerLanguage"),
  assistant_role: $("#studyAssistantRole"),
};
const shortcutGroups = [
  ["截图与对话", { captureRegion: "截图", captureScreen: "全屏截图", sendChat: "回答 / 解题", newQuestion: "新对话", resetView: "重置对话", deleteLastShot: "删除最后一张截图", clearShots: "清空截图" }],
  ["面试语音", { toggleInterview: "开始 / 停止面试", muteInterviewMic: "麦克风静音 / 恢复", muteInterviewSystem: "系统声音静音 / 恢复" }],
  ["阅读", { readPrev: "回答上一页", readNext: "回答下一页", scrollUp: "回答内容上滚", scrollDown: "回答内容下滚" }],
  ["窗口", { toggleWindow: "隐藏 / 显示", toggleVisible: "按住操作面板", toggleCompact: "紧凑 / 展开", moveUp: "窗口上移", moveDown: "窗口下移", moveLeft: "窗口左移", moveRight: "窗口右移", opacityDown: "降低不透明度", opacityUp: "提高不透明度", zoomOut: "缩小字号", zoomReset: "还原字号", zoomIn: "放大字号", quitApp: "退出应用" }],
];
const mac = /Mac|iPhone|iPad/.test(navigator.platform);
const saveState = $("#settingsSaveState");
let savedSettings = null;
let saving = false;

$("#hotkeyList").innerHTML = shortcutGroups.map(([group, actions]) => `<div class="shortcut-group"><h3>${group}</h3>${Object.entries(actions).map(([action, label]) => `<label class="shortcut-row"><span>${label}</span><input data-hotkey="${action}" aria-describedby="hotkeyFeedback" readonly disabled /></label>`).join("")}</div>`).join("");

function hotkeyInputs() { return [...document.querySelectorAll("[data-hotkey]")]; }
function readHotkeys() { return Object.fromEntries(hotkeyInputs().map((input) => [input.dataset.hotkey, input.dataset.accelerator])); }
function fillHotkeys(hotkeys) {
  for (const input of hotkeyInputs()) {
    const value = hotkeys[input.dataset.hotkey] || DEFAULT_HOTKEYS[input.dataset.hotkey];
    input.dataset.accelerator = value;
    input.value = formatAccelerator(value, mac);
    input.disabled = false;
  }
}
function readSettings() {
  return {
    ...Object.fromEntries(Object.entries(studyFields).map(([key, input]) => [key, input.value.trim()])),
    study_specialty: readStudyChoice(studyFields.study_specialty, $("#studySpecialtyCustom")),
    study_language: readStudyChoice(studyFields.study_language, $("#studyLanguageCustom")),
    jd_text: $("#jdText").value,
    resume_text: $("#resumeText").value,
    interview_use_knowledge: $("#interviewUseKnowledge").checked,
    hotkeys: readHotkeys(),
  };
}
function changedSettings() {
  return Object.fromEntries(Object.entries(readSettings()).filter(([key, value]) => (
    key === "hotkeys"
      ? Object.entries(value).some(([action, binding]) => binding !== savedSettings?.hotkeys?.[action])
      : value !== savedSettings?.[key]
  )));
}
function validateHotkeys() {
  const conflict = shortcutConflict(readHotkeys());
  const node = $("#hotkeyFeedback");
  node.classList.toggle("is-error", Boolean(conflict));
  node.textContent = conflict
    ? `「${document.querySelector(`[data-hotkey="${conflict[0]}"]`).closest("label").querySelector("span").textContent}」与「${document.querySelector(`[data-hotkey="${conflict[1]}"]`).closest("label").querySelector("span").textContent}」按键冲突。`
    : "组合键需包含 ⌘、Ctrl 或 Alt。";
  return !conflict;
}
function syncDirty() {
  syncStudyCustom(studyFields.study_specialty, $("#studySpecialtyCustom"));
  const exam = isExamSpecialty(readStudyChoice(studyFields.study_specialty, $("#studySpecialtyCustom")));
  $("#studySpecialtyHint").hidden = !exam;
  studyFields.study_language.disabled = exam || !savedSettings;
  syncStudyCustom(studyFields.study_language, $("#studyLanguageCustom"));
  if (!savedSettings || saving) return;
  const valid = validateHotkeys();
  const dirty = Object.keys(changedSettings()).length > 0;
  $("#saveUiSettings").disabled = !valid || !dirty;
  saveState.textContent = !valid ? "快捷键冲突，尚未保存。" : dirty ? "有未保存的修改" : "已与应用同步";
}
function fillSettings(saved) {
  savedSettings = saved;
  for (const [key, input] of Object.entries(studyFields)) input.value = saved[key] ?? "";
  studyFields.study_specialty.disabled = false;
  studyFields.study_language.disabled = false;
  fillStudyChoice(studyFields.study_specialty, $("#studySpecialtyCustom"), SPECIALTY_GROUPS, saved.study_specialty);
  fillStudyChoice(studyFields.study_language, $("#studyLanguageCustom"), LANGUAGE_GROUPS, saved.study_language);
  $("#jdText").value = saved.jd_text || "";
  $("#resumeText").value = saved.resume_text || "";
  $("#interviewUseKnowledge").checked = Boolean(saved.interview_use_knowledge);
  $("#interviewUseKnowledge").disabled = false;
  fillHotkeys(saved.hotkeys || DEFAULT_HOTKEYS);
  $("#resetHotkeys").disabled = false;
}
async function loadSettings() {
  try { fillSettings(await fetchGatewayJson("/api/ui/settings")); syncDirty(); }
  catch { saveState.textContent = "读取设置失败，请重新打开此页。"; }
}
async function saveSettings(event) {
  event.preventDefault();
  if (!savedSettings || saving || !validateHotkeys()) return;
  const changes = changedSettings();
  if (!Object.keys(changes).length) return;
  saving = true;
  $("#saveUiSettings").disabled = true;
  saveState.textContent = "正在保存…";
  try {
    const saved = await postJson("/api/ui/settings", changes, { method: "PATCH" });
    // 请求期间的新输入仍留在表单里，只更新保存基线。
    savedSettings = saved;
    window.dispatchEvent(new Event('settings:saved'));
    saveState.textContent = "已保存并同步到应用";
  } catch { saveState.textContent = "保存失败，修改仍保留在页面中。"; }
  finally {
    saving = false;
    $("#saveUiSettings").disabled = !validateHotkeys() || !Object.keys(changedSettings()).length;
  }
}

hotkeyInputs().forEach((input) => {
  input.addEventListener("focus", () => { input.value = ""; input.placeholder = "按下新的组合键"; });
  input.addEventListener("blur", () => { input.value = formatAccelerator(input.dataset.accelerator || "", mac); });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) return;
    event.preventDefault();
    if (event.key === "Escape") { input.blur(); return; }
    const accelerator = acceleratorFromEvent(event, mac);
    if (!accelerator) return;
    input.dataset.accelerator = accelerator;
    input.blur();
    syncDirty();
  });
});
$("#resetHotkeys").addEventListener("click", () => { fillHotkeys(DEFAULT_HOTKEYS); syncDirty(); });
$("#studySettingsForm").addEventListener("submit", saveSettings);
$("#studySettingsForm").addEventListener("input", syncDirty);
for (const kind of ["jd", "resume"]) {
  $(`#${kind}File`).addEventListener("change", async (event) => {
    await parseDocumentFile(event.target.files[0], event.target, $(`#${kind}Text`), kind === "jd" ? "JD" : "简历", kind);
    syncDirty();
  });
}

const views = [...document.querySelectorAll('.settings-view')];
const links = [...document.querySelectorAll('.settings-nav a')];
let renderedHash = '';
function showView() {
  const previousHash = renderedHash;
  renderedHash = '';
  let route = settingsRoute();
  let id = route.section;
  if (!views.some(view => view.id === id)) { id = 'models'; route = settingsRoute('#models'); }
  if (location.hash === '#asr') history.replaceState(history.state, '', '#models/asr');
  views.forEach(view => { view.hidden = view.id !== id; });
  document.body.classList.toggle('audio-start-view', id === 'interview');
  links.forEach(link => {
    if (link.hash === `#${id}`) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  const connectionDetail = id === 'models' && route.kind !== 'list';
  $('#connectionsHeading').hidden = connectionDetail;
  $('#connectionTabs').hidden = connectionDetail;
  $('#llmPane').hidden = route.tab === 'asr';
  $('#asr').hidden = route.tab !== 'asr';
  $('#llmList').hidden = route.kind !== 'list';
  $('#llmForm').hidden = route.kind !== 'editor' || route.tab !== 'llm' || $('#llmForm').dataset.profileMissing === 'true';
  $('#llmImport').hidden = route.kind !== 'import';
  $('#asrList').hidden = route.kind !== 'list';
  $('#asrForm').hidden = route.kind !== 'editor' || route.tab !== 'asr' || $('#asrForm').dataset.profileMissing === 'true';
  $('#connectionTabs').querySelectorAll('a').forEach(link => {
    if ((route.tab === 'asr') === (link.hash === '#models/asr')) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  $('#settingsSavebar').hidden = !['study', 'briefing', 'shortcuts'].includes(id);
  const title = id === 'interview' ? '开始面试' : links.find(link => link.hash === `#${id}`)?.textContent || '接入设置';
  document.title = `${title} · 左右`;
  const assetDetail = id === 'assets' && location.hash.split('/').length > 2;
  $('#settingsBack').textContent = connectionDetail || assetDetail ? '← 返回列表' : '← 返回';
  $('#settingsBack').setAttribute('aria-label', connectionDetail || assetDetail ? '返回列表' : '返回应用');
  if (id !== 'assets') {
    if (previousHash !== location.hash) {
      window.scrollTo({ top: history.state?.settingsScroll || 0, behavior: 'instant' });
      const focus = history.state?.settingsFocus;
      if (focus?.kind === 'button') document.getElementById(focus.id)?.focus({ preventScroll: true });
      if (focus?.kind === 'llm') [...document.querySelectorAll('[data-edit]')].find(button => button.dataset.edit === focus.id)?.focus({ preventScroll: true });
      if (focus?.kind === 'asr') [...document.querySelectorAll('[data-asr-edit]')].find(button => button.dataset.asrEdit === focus.id)?.focus({ preventScroll: true });
    }
    renderedHash = location.hash;
  }
}
for (const event of ['hashchange', 'popstate', 'settings:navigate']) window.addEventListener(event, showView);
for (const link of [...links, ...$('#connectionTabs').querySelectorAll('a')]) link.addEventListener('click', event => {
  event.preventDefault();
  if (location.hash === link.hash) return;
  history.replaceState({ ...history.state, assetScroll: window.scrollY }, '');
  navigateSettings(link.hash);
});
window.addEventListener('scroll', () => {
  if (renderedHash === location.hash && settingsRoute().section !== 'assets') history.replaceState({ ...history.state, settingsScroll: window.scrollY }, '');
}, { passive: true });
$('#settingsBack').addEventListener('click', () => {
  const route = settingsRoute();
  if (route.section === 'models' && route.kind !== 'list') { returnToConnections(route.tab); return; }
  if (route.section === 'assets' && location.hash.split('/').length > 2) {
    document.querySelector('#assets [data-asset-back]')?.click(); return;
  }
  if (window.interviewBridge?.closeSettings) window.interviewBridge.closeSettings();
  else window.location.href = '/';
});
document.querySelector('.wordmark').addEventListener('click', event => {
  if (!window.interviewBridge?.closeSettings) return;
  event.preventDefault(); window.interviewBridge.closeSettings();
});
const header = document.querySelector('.site-header');
new ResizeObserver(() => document.documentElement.style.setProperty('--settings-header-height', `${header.getBoundingClientRect().height}px`)).observe(header);

if (!state.gatewayApiKey && typeof window.__GATEWAY_KEY__ === "string") state.gatewayApiKey = window.__GATEWAY_KEY__.trim();
showView();
wireModelConfig();
Promise.all([loadSettings(), loadProfiles()]);
fetchGatewayJson("/health").then(() => { $("#serviceStatus").textContent = "本机已连接"; }).catch(() => {
  $("#serviceStatus").textContent = "本机服务未连接";
  $("#serviceStatus").dataset.kind = "error";
});

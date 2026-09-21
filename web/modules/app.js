import { cancelDocumentParses, parseDocumentFile, resetDocumentUploadInputs } from './documents.js';
import { answerText, checkAsr, checkModel, competencyList, credibilityBox, credibilityLevel, currentQuestion, currentQuestionMeta, currentQuestionText, endInterview, gatewayKey, interviewForm, jdText, liveFeed, longTermMemoryConsent, manualProbe, metricCandidate, metricJob, metricTurns, nextOptionCount, nextOptionList, reconnectSocket, refreshStatus, reportLinks, reportPanel, resumeText, saveGatewayKey, setupForm, setupStatus, speakerCandidate, speakerInterviewer, startMic, stopMic } from './dom.js';
import { fetchGatewayJson, saveGatewayConnection } from './gateway.js';
import { closeSocket, reconnectLiveChannel, requestEndInterview, sendScreenshotQuestion, sendTurn } from './live.js';
import { nextMicStartToken, startMicCapture, stopMicCapture } from './mic.js';
import { deleteCurrentCandidateMemories, renderExamStatus, renderMemoryHits, renderProbeCards, renderProbeChains, resetQuestionMetaForManualEdit, scanRepoMemories, setMemoryActionStatus, syncMemoryActions } from './panels.js';
import { clearQueuedReportPolling } from './report.js';
import { checkAsrReadiness, checkLlmConnection, checkRuntime, refreshRuntimeIfVisible } from './runtime.js';
import { joinExistingInterviewFromUrl, joinInterviewIdFromUrl, prepareSession, renderRoleLinks } from './session.js';
import { state } from './state.js';
import { appendEvent, emptyFeedMarkup, escapeHtml, pickQuestionOptionAt, renderExtractionTags, resetAnswerEcho, sendSteeringFocus, setControls, setCurrentSpeaker, setPill, setSteeringFocus, updateTextCounters } from './ui.js';

async function hydrateFromUiSettings() {
  try {
    const saved = await fetchGatewayJson("/api/ui/settings");
    if (saved.jd_text && jdText) jdText.value = saved.jd_text;
    if (saved.resume_text && resumeText) resumeText.value = saved.resume_text;
    if (longTermMemoryConsent && typeof saved.long_term_memory_consent === "boolean") {
      longTermMemoryConsent.checked = saved.long_term_memory_consent;
    }
  } catch {
    // Overlay still works with the HTML defaults if settings have not been saved.
  }
}

function loadSample() {
  if (state.documentParsingCount > 0 || state.preparingInterview || state.interview) {
    appendEvent("样例资料", "当前已有面试或资料正在处理，请重置后再加载样例资料。", "red");
    return;
  }
  setupForm.job_title.value = "高级 AI 后端工程师";
  setupForm.candidate_name.value = "张三";
  renderExtractionTags("高级 AI 后端工程师", "张三", null);
  jdText.value =
    "负责 LLM 应用平台、FastAPI 微服务、模型调用编排、可靠性治理、评估报告与线上故障排查。要求能独立做技术方案、指标设计、降级策略和跨团队协作。";
  resumeText.value =
    "候选人自述 5 年 Python 后端经验，最近负责 AI 面试评估系统，涉及 FastAPI 网关、LLM JSON 解析、重试降级、报告生成和可观测性指标。";
  currentQuestion.value =
    "请讲一个最近负责的 LLM 后端项目，说明你本人写了哪些模块，核心技术取舍是什么，上线后哪些指标发生了变化？";
  currentQuestionText.textContent = currentQuestion.value;
  currentQuestionMeta.textContent = "样例";
  resetQuestionMetaForManualEdit();
  answerText.value =
    "我主要写了 FastAPI 网关和模型调用编排，处理过 JSON 解析失败、超时重试和报告生成。我把失败重试从固定次数改成按错误类型分流，P95 延迟从 3.8 秒降到 2.4 秒。";
  updateTextCounters();
  appendEvent("样例资料", "已填入一组 JD、简历和首问回答。");
}

function resetSessionState() {
  stopMicCapture();
  closeSocket();
  clearQueuedReportPolling();
  nextMicStartToken();
  state.job = null;
  state.candidate = null;
  state.interview = null;
  state.prepareSessionToken += 1;
  state.preparingInterview = false;
  state.seq = 1;
  state.turns = 0;
  state.startedAt = 0;
  state.interviewEnded = false;
  state.endingInterview = false;
  state.reportReady = false;
  state.reportDownloadInFlight.clear();
  state.selectedQuestionSource = "interviewer";
  state.selectedProbeTarget = null;
  state.selectedProbeChainId = null;
  state.selectedCompetency = null;
  state.currentQuestionOption = null;
  state.nextOptions = null;
  state.renderedOptions = [];
  resetAnswerEcho();
  setMemoryActionStatus(
    "扫描范围受 MEMORY_REPO_ROOTS 限制；删除会移除该候选人全部跨面试记忆且不可恢复。"
  );
  syncMemoryActions();
  state.questionBank = null;
  state.steeringFocus = "balanced";
  state.currentSpeaker = "candidate";
  state.micStarting = false;
  state.micError = "";
  state.documentParsingCount = 0;
  cancelDocumentParses();
  resetDocumentUploadInputs();
  metricJob.textContent = "待创建";
  metricCandidate.textContent = "待创建";
  renderExtractionTags();
  metricTurns.textContent = "0";
  renderRoleLinks();
  currentQuestion.value = "";
  currentQuestionText.textContent = "创建面试后自动生成首题。";
  currentQuestionMeta.textContent = "等待题库";
  answerText.value = "";
  nextOptionCount.textContent = "0 条";
  nextOptionList.innerHTML = '<div class="empty">候选人回答后显示深挖与换题选项</div>';
  setSteeringFocus("balanced");
  updateTextCounters();
  resetQuestionMetaForManualEdit();
  competencyList.innerHTML = '<div class="empty">创建面试后显示岗位能力维度</div>';
  renderProbeCards([]);
  credibilityLevel.textContent = "待观察";
  credibilityBox.innerHTML = "<p>等待候选人首个回答。</p>";
  liveFeed.innerHTML = emptyFeedMarkup();
  renderProbeChains([]);
  renderMemoryHits([]);
  reportLinks.innerHTML = "";
  reportPanel.innerHTML = '<div class="empty">结束面试后生成综合评分</div>';
  setPill(setupStatus, "未建面试", "");
  setControls();
}

const PANEL_HOTKEYS = {
  toggleVisible: { id: "cockpitVisible", display: "⌘⇧Space", label: "按住操作" },
  captureRegion: { id: "cockpitExam", display: "⌘⇧U", label: "截图" },
};

function applyHotkeyHints(cfg) {
  const failed = new Set(cfg.failedHotkeys || []);
  const host = document.querySelector("#cockpitHotkeys");
  const hotkeys = Array.isArray(cfg.hotkeys) ? cfg.hotkeys : [];
  const byAction = new Map(hotkeys.map((binding) => [binding.action, binding]));
  const shown = Object.entries(PANEL_HOTKEYS).map(([action, fallback]) => {
    const binding = byAction.get(action) || {};
    return {
      action,
      id: fallback.id,
      display: binding.display || fallback.display,
      label: fallback.label,
      title: binding.label || fallback.label,
      accelerator: binding.accelerator,
    };
  });
  if (!host) return;
  host.innerHTML = shown
    .map((binding) => {
      const taken = failed.has(binding.accelerator);
      const hint = binding.display || binding.accelerator;
      const title = taken ? `${binding.title}（被其他应用占用）` : `${binding.title} ${hint}`;
      return `<button type="button" class="shortcut-item" id="${escapeHtml(binding.id)}" data-action="${escapeHtml(binding.action)}" title="${escapeHtml(title)}"><kbd class="${taken ? "taken" : ""}">${escapeHtml(hint)}</kbd><span>${escapeHtml(binding.label)}</span></button>`;
    })
    .join("");
}

function activateShellChrome(cockpit) {
  if (!cockpit) return;
  document.documentElement.classList.add("cockpit-host");
  document.body.classList.add("cockpit-shell");
  const host = document.querySelector("#cockpitHotkeys");
  if (host && host.dataset.wired !== "1") {
    host.dataset.wired = "1";
    host.addEventListener("click", (event) => {
      const item = event.target.closest("[data-action]");
      if (!item) return;
      if (item.dataset.action === "captureRegion") cockpit.captureExam({ interactive: true });
    });
  }
  if (typeof cockpit.onExam === "function") {
    cockpit.onExam((event) => {
      renderExamStatus(event);
      if (event.status === "ready" && event.solution) {
        sendScreenshotQuestion(event.solution);
      }
    });
  }
  if (typeof cockpit.onCompact === "function") {
    cockpit.onCompact((value) => {
      document.body.classList.toggle("cockpit-compact", Boolean(value));
    });
  }
  if (typeof cockpit.onArmed === "function") {
    cockpit.onArmed((value) => {
      document.body.classList.toggle("cockpit-armed", Boolean(value));
    });
  }
  if (typeof cockpit.getConfig === "function") {
    cockpit.getConfig().then((cfg) => applyHotkeyHints(cfg));
  }
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (event.target.closest("input, textarea, select")) return;
    if (document.querySelector(".sys-menu")?.open) return;
    event.preventDefault();
    cockpit.toggleVisible();
  });
}

setupForm.addEventListener("submit", (event) => {
  event.preventDefault();
  prepareSession(event.currentTarget);
});

interviewForm.addEventListener("submit", (event) => {
  event.preventDefault();
  sendTurn(false);
});

document.querySelector("#jdFile").addEventListener("change", (event) => {
  parseDocumentFile(event.target.files[0], event.target, jdText, "JD", "jd");
});

document.querySelector("#resumeFile").addEventListener("change", (event) => {
  parseDocumentFile(event.target.files[0], event.target, resumeText, "简历", "resume");
});

refreshStatus.addEventListener("click", checkRuntime);
checkModel.addEventListener("click", checkLlmConnection);
checkAsr.addEventListener("click", checkAsrReadiness);
saveGatewayKey.addEventListener("click", saveGatewayConnection);
gatewayKey.addEventListener("keydown", (event) => {
  if (event.key === "Enter") saveGatewayConnection();
});
const gatewayOrigin = document.querySelector("#gatewayOrigin");
if (gatewayOrigin) {
  gatewayOrigin.value = state.apiOrigin;
  gatewayOrigin.addEventListener("keydown", (event) => {
    if (event.key === "Enter") saveGatewayConnection();
  });
}
document.querySelector("#loadSample").addEventListener("click", loadSample);
document.querySelector("#resetSession").addEventListener("click", resetSessionState);

liveFeed.addEventListener("click", (event) => {
  const action = event.target.closest("[data-welcome]")?.dataset.welcome;
  if (action === "prepare") setupForm.requestSubmit();
  if (action === "capture") {
    if (window.cockpit && typeof window.cockpit.captureExam === "function") {
      window.cockpit.captureExam({ interactive: true });
    } else {
      appendEvent("截图问题", "请在桌面悬浮窗里用 ⌘⇧U 框选题目。", "amber");
    }
  }
  if (action === "connect") document.querySelector(".sys-menu")?.setAttribute("open", "");
});

const sysMenu = document.querySelector(".sys-menu");
if (sysMenu) {
  sysMenu.querySelector(".sys-menu-panel")?.addEventListener("click", (event) => {
    if (event.target.closest("button, a")) sysMenu.removeAttribute("open");
  });
  document.addEventListener("pointerdown", (event) => {
    if (sysMenu.open && !sysMenu.contains(event.target)) sysMenu.removeAttribute("open");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && sysMenu.open) sysMenu.removeAttribute("open");
  });
}
document.querySelector("#scanRepoMemory").addEventListener("click", scanRepoMemories);
document.querySelector("#deleteCandidateMemory").addEventListener("click", deleteCurrentCandidateMemories);
startMic.addEventListener("click", startMicCapture);
stopMic.addEventListener("click", stopMicCapture);
reconnectSocket.addEventListener("click", reconnectLiveChannel);
manualProbe.addEventListener("click", () => sendTurn(true));
endInterview.addEventListener("click", requestEndInterview);
speakerCandidate.addEventListener("click", () => setCurrentSpeaker("candidate"));
speakerInterviewer.addEventListener("click", () => setCurrentSpeaker("interviewer"));
document.querySelectorAll("[data-steering-focus]").forEach((button) => {
  button.addEventListener("click", () => sendSteeringFocus(button.dataset.steeringFocus));
});
currentQuestion.addEventListener("input", () => {
  resetQuestionMetaForManualEdit();
  updateTextCounters();
});
answerText.addEventListener("input", updateTextCounters);
answerText.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  sendTurn(false);
});
// Mid-answer the interviewer is listening, not reading: Cmd/Ctrl+1..9 promotes the
// n-th suggested question straight to "current question" without hunting for its
// button. Plain digits are left alone so typing into the text boxes still works.
document.addEventListener("keydown", (event) => {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
  if (/^[1-9]$/.test(event.key)) {
    if (pickQuestionOptionAt(Number(event.key) - 1)) event.preventDefault();
    return;
  }
  // Mislabelled audio is the most expensive mistake in this panel, so flipping
  // the label must not require finding a button while someone is talking.
  if (event.key === "\\") {
    setCurrentSpeaker(state.currentSpeaker === "candidate" ? "interviewer" : "candidate");
    event.preventDefault();
  }
});

document.addEventListener("visibilitychange", refreshRuntimeIfVisible);
window.addEventListener("focus", refreshRuntimeIfVisible);
window.addEventListener("online", refreshRuntimeIfVisible);

if (!state.gatewayApiKey && typeof window.__GATEWAY_KEY__ === "string") {
  state.gatewayApiKey = window.__GATEWAY_KEY__.trim();
}
gatewayKey.value = state.gatewayApiKey;
if (window.cockpit) {
  activateShellChrome(window.cockpit);
}
checkRuntime();
hydrateFromUiSettings();
if (joinInterviewIdFromUrl()) {
  joinExistingInterviewFromUrl();
}
updateTextCounters();
setControls();
syncMemoryActions();


export {
  loadSample,
  resetSessionState,
};

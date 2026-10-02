import { answerCharCount, answerEchoMeta, answerEchoText, answerText, controlHint, currentQuestion, currentQuestionMeta, currentQuestionText, debugTextPanel, endInterview, extractedCandidate, extractedJob, extractionConfidence, liveFeed, liveStatus, loadSampleButton, manualProbe, micStatus, nextOptionCount, nextOptionList, prepareInterview, questionCharCount, reconnectSocket, sendAnswer, speakerCandidate, speakerInterviewer, startMic, stopMic } from './dom.js';
import { liveChannelReadyForInput, sendLiveSocketPayload } from './live.js';
import { answerMinChars, maxLiveFeedEvents, state } from './state.js';

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setPill(node, text, tone = "") {
  if (!node) return;
  node.className = `status-pill ${tone}`;
  node.innerHTML = `<span class="status-dot"></span><span>${escapeHtml(text)}</span>`;
}

function setButtonBusy(button, busy) {
  if (busy) {
    button.dataset.busy = "true";
    button.setAttribute("aria-busy", "true");
  } else {
    delete button.dataset.busy;
    button.removeAttribute("aria-busy");
  }
}

function syncSpeakerControls() {
  speakerCandidate.classList.toggle("active", state.currentSpeaker === "candidate");
  speakerInterviewer.classList.toggle("active", state.currentSpeaker === "interviewer");
  speakerCandidate.setAttribute("aria-pressed", state.currentSpeaker === "candidate");
  speakerInterviewer.setAttribute("aria-pressed", state.currentSpeaker === "interviewer");
  const dual = Boolean(state.micDualCapture && state.micRecording);
  speakerCandidate.hidden = dual;
  speakerInterviewer.hidden = dual;
  const group = speakerCandidate.closest(".speaker-switch");
  if (group) group.hidden = dual;
}

function setCurrentSpeaker(speaker) {
  if (state.micDualCapture && state.micRecording) {
    appendEvent("说话人", "双声道采集中会自动区分：麦克风=面试官，会议声=候选人。");
    return;
  }
  const next = speaker === "interviewer" ? "interviewer" : "candidate";
  const changedMidCapture = state.micRecording && next !== state.currentSpeaker;
  state.currentSpeaker = next;
  syncSpeakerControls();
  // The pill shows the label while capturing, so it has to follow the switch.
  if (changedMidCapture) setControls();
  appendEvent(
    "说话人",
    state.currentSpeaker === "interviewer" ? "当前麦克风归属：面试官" : "当前麦克风归属：候选人"
  );
}

function applyDebugTextVisibility() {
  if (!debugTextPanel || !sendAnswer || !manualProbe) return;
  debugTextPanel.hidden = !state.debugTextInputEnabled;
  sendAnswer.hidden = !state.debugTextInputEnabled;
  manualProbe.hidden = !state.debugTextInputEnabled;
}

function renderExtractionTags(jobTitle = "待自动提取", candidateName = "待自动提取", confident = null) {
  extractedJob.textContent = jobTitle || "待自动提取";
  extractedCandidate.textContent = candidateName || "待自动提取";
  if (confident === true) {
    setPill(extractionConfidence, "提取可信", "ready");
  } else if (confident === false) {
    setPill(extractionConfidence, "低置信", "");
  } else {
    setPill(extractionConfidence, "未提取", "");
  }
}

function optionKindLabel(kind) {
  return {
    follow_up: "深挖",
    bank: "题库",
    generated: "生成",
  }[kind] || "建议";
}

function steeringLabel(focus) {
  return {
    balanced: "均衡",
    resume_drill: "深挖简历",
    jd_professional: "JD 专业题",
  }[focus] || focus;
}

function setSteeringFocus(focus) {
  state.steeringFocus = focus || "balanced";
  document.querySelectorAll("[data-steering-focus]").forEach((button) => {
    const active = button.dataset.steeringFocus === state.steeringFocus;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function renderCurrentQuestionOption(option) {
  state.currentQuestionOption = option || null;
  const question = option && option.question ? option.question : "创建面试后自动生成首题。";
  currentQuestionText.textContent = question;
  currentQuestion.value = option && option.question ? option.question : "";
  currentQuestionMeta.textContent = option
    ? `${optionKindLabel(option.kind)}${option.category ? ` · ${option.category}` : ""}`
    : "等待题库";
  state.selectedQuestionSource = "interviewer";
  state.selectedProbeTarget = option && option.reason ? option.reason : null;
  state.selectedProbeChainId = option && option.chain_id ? option.chain_id : null;
  state.selectedCompetency = option && option.category ? option.category : null;
  updateTextCounters();
}

// The suggested questions are only useful next to what the candidate just said,
// and the interviewer cannot read the scrolling feed while listening. This keeps
// the latest candidate speech pinned directly above the options.
function renderAnswerEcho(text, { partial = false } = {}) {
  const body = String(text || "").trim();
  if (!body) return;
  answerEchoText.textContent = body;
  answerEchoMeta.textContent = partial ? "正在说" : "已说完";
  answerEchoMeta.classList.toggle("amber", partial);
}

function resetAnswerEcho() {
  answerEchoText.textContent = "候选人开口后，这里同步显示转写，便于对照下面的候选题。";
  answerEchoMeta.textContent = "等待回答";
  answerEchoMeta.classList.remove("amber");
}

function renderNextOptions(options, label = "下一步选项") {
  state.nextOptions = options || null;
  state.renderedOptions = [];
  const followUp = Array.isArray(options && options.follow_up) ? options.follow_up : [];
  const alternatives = Array.isArray(options && options.alternatives) ? options.alternatives : [];
  const items = [
    ...followUp.map((option) => ({ ...option, groupLabel: "深挖" })),
    ...alternatives.map((option) => ({ ...option, groupLabel: "换题" })),
  ];
  state.renderedOptions = items;
  nextOptionCount.textContent = `${items.length} 条`;
  if (!items.length) {
    nextOptionList.innerHTML = '<div class="empty">候选人回答后显示深挖与换题选项</div>';
    return;
  }
  nextOptionList.innerHTML = items
    .map(
      (option, index) => `
        <div class="option-card">
          <div class="probe-top">
            <span class="tag amber">${escapeHtml(option.groupLabel)}</span>
            <span class="tag blue">${escapeHtml(optionKindLabel(option.kind))}</span>
            ${option.category ? `<span class="tag">${escapeHtml(option.category)}</span>` : ""}
          </div>
          <h3><span class="option-index">${index + 1}</span>${escapeHtml(option.question)}</h3>
          <p>${escapeHtml(option.reason || "")}</p>
          <button class="secondary" type="button" data-option-index="${index}" title="设为当前问题（⌘${index + 1}）">设为当前问题</button>
        </div>
      `
    )
    .join("");
  nextOptionList.querySelectorAll("[data-option-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const option = items[Number(button.dataset.optionIndex)];
      pickQuestionOption(option);
    });
  });
  appendEvent(label, `已收到 ${items.length} 条问题建议。`, "blue");
}

function pickQuestionOptionAt(index) {
  const items = Array.isArray(state.renderedOptions) ? state.renderedOptions : [];
  if (index < 0 || index >= items.length) return false;
  pickQuestionOption(items[index]);
  return true;
}

function pickQuestionOption(option) {
  if (!option) return;
  if (!liveChannelReadyForInput()) return;
  if (sendLiveSocketPayload({ type: "pick_option", option_id: option.option_id }, "选题失败")) {
    renderCurrentQuestionOption(option);
    appendEvent("当前问题", escapeHtml(option.question), "blue");
  }
}

function sendSteeringFocus(focus) {
  setSteeringFocus(focus);
  if (!state.interview || !state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  sendLiveSocketPayload({ type: "set_steering", focus }, "策略切换失败");
}

function setControls() {
  if (!prepareInterview || !sendAnswer) return;
  applyDebugTextVisibility();
  document.body.classList.toggle("has-interview", Boolean(state.interview));
  tickLiveTimer();
  const socketState = state.socket ? state.socket.readyState : WebSocket.CLOSED;
  const connected = socketState === WebSocket.OPEN;
  const connecting = socketState === WebSocket.CONNECTING;
  const active = connected && !state.interviewEnded && !state.endingInterview;
  const textReady = active && textTurnReady();
  sendAnswer.disabled = !textReady;
  startMic.disabled = !active || state.micRecording || state.micStarting;
  stopMic.disabled = !connected || !state.micRecording;
  reconnectSocket.disabled = !state.interview || connected || connecting || state.interviewEnded;
  manualProbe.disabled = !textReady;
  endInterview.disabled = !active;
  speakerCandidate.disabled =
    !state.interview || state.interviewEnded || state.endingInterview || state.micDualCapture;
  speakerInterviewer.disabled =
    !state.interview || state.interviewEnded || state.endingInterview || state.micDualCapture;
  loadSampleButton.disabled =
    state.documentParsingCount > 0 || state.preparingInterview || Boolean(state.interview);
  prepareInterview.disabled =
    state.documentParsingCount > 0 ||
    state.preparingInterview ||
    Boolean(state.interview) ||
    connected ||
    connecting;
  setButtonBusy(prepareInterview, state.preparingInterview);
  setButtonBusy(startMic, state.micStarting);
  setButtonBusy(endInterview, state.endingInterview);
  syncSpeakerControls();
  setControlHints(connected, connecting);
  controlHint.textContent = controlHintText(connected, connecting);
  controlHint.className = `control-hint ${controlHintTone(connected, connecting)}`.trim();
  if (state.reportReady) {
    setPill(liveStatus, "报告已生成", "ready");
  } else if (state.interviewEnded) {
    setPill(liveStatus, "面试已结束", "ready");
  } else if (state.endingInterview) {
    setPill(liveStatus, "评分中", "live");
  } else if (connected) {
    setPill(liveStatus, `已连接 ${state.interview.id.slice(0, 8)}`, "live");
  } else if (connecting) {
    setPill(liveStatus, "连接中", "live");
  } else if (state.interview) {
    setPill(liveStatus, "通道未连接", "");
  } else {
    setPill(liveStatus, "未建面试", "");
  }
  if (state.micStarting) {
    setPill(micStatus, "麦克风启动中", "live");
  } else if (state.micRecording) {
    setPill(
      micStatus,
      state.micDualCapture
        ? "双声道 · 麦=我 / 会议=对方"
        : state.currentSpeaker === "interviewer"
          ? "采集中 · 记为面试官"
          : "采集中 · 记为候选人",
      "live"
    );
  } else if (connecting) {
    setPill(micStatus, "等待实时通道", "live");
  } else if (state.interviewEnded) {
    setPill(micStatus, "面试已结束", "ready");
  } else if (state.micError) {
    setPill(micStatus, state.micError, "");
  } else if (connected) {
    setPill(micStatus, "麦克风未开启", "");
  } else if (state.interview) {
    setPill(micStatus, "等待重连通道", "");
  } else {
    setPill(micStatus, "先创建实时面试", "");
  }
}

function liveChannelUnavailableReason(connecting) {
  if (connecting) return "实时通道连接中";
  if (state.interview) return "实时通道未连接，请点击重连通道";
  return "请先创建实时面试并等待实时通道连接";
}

function setControlHints(connected, connecting) {
  const reason = liveChannelUnavailableReason(connecting);
  const inputReason = "当前问题和候选人回答都需要填写";
  const endedReason = "面试已结束，请重置后创建新的面试";
  const endingReason = "正在结束面试并生成评分报告，请等待结果";
  sendAnswer.title = state.interviewEnded
    ? endedReason
    : state.endingInterview
      ? endingReason
    : connected && textTurnReady()
      ? "发送文本回答并触发追问"
    : connected
      ? inputReason
      : reason;
  startMic.title = state.interviewEnded
    ? endedReason
    : state.endingInterview
      ? endingReason
    : state.micStarting
      ? "正在请求麦克风权限并初始化音频采集"
    : connected
      ? "开始浏览器麦克风采集"
      : reason;
  stopMic.title = state.micRecording ? "停止麦克风采集" : "麦克风尚未开启";
  reconnectSocket.title = state.interviewEnded
    ? endedReason
    : state.interview
      ? "重新连接当前面试实时通道"
      : "请先创建实时面试";
  manualProbe.title = state.interviewEnded
    ? endedReason
    : state.endingInterview
      ? endingReason
    : connected && textTurnReady()
      ? "基于当前回答立即生成追问"
    : connected
      ? inputReason
      : reason;
  endInterview.title = state.interviewEnded
    ? endedReason
    : state.endingInterview
      ? endingReason
    : connected
      ? "结束面试并生成评分报告"
      : reason;
  prepareInterview.title = state.preparingInterview
    ? "正在创建实时面试"
    : state.documentParsingCount > 0
      ? "资料正在解析，完成后再创建实时面试"
    : state.interview
      ? "当前已有面试，请重置后再创建新的面试"
      : "创建实时面试通道";
  loadSampleButton.title = state.preparingInterview
    ? "正在创建实时面试，不能覆盖资料"
    : state.documentParsingCount > 0
      ? "资料正在解析，不能覆盖资料"
    : state.interview
      ? "当前已有面试，请重置后再加载样例资料"
      : "填入一组 JD、简历和首问回答";
}

function controlHintText(connected, connecting) {
  if (state.reportReady) return "报告已生成。可以下载 HTML、PDF、JSON 或转写，或重置后开始新的面试。";
  if (state.interviewEnded) return "面试已结束。请重置后创建新的面试。";
  if (state.endingInterview) return "正在结束面试并生成评分报告，请等待结果。";
  if (state.micStarting) return "麦克风启动中。请在浏览器权限弹窗中允许麦克风，并等待初始化完成。";
  if (state.micRecording) {
    return state.micDualCapture
      ? "双声道采集中：麦克风是你，会议扬声器是对方。无需手动切换说话人。"
      : "麦克风采集中。可以停止麦克风，或结束面试生成评分报告。";
  }
  if (state.micError) return `${state.micError} 可以修复后再次点击开始麦克风。`;
  if (connected && !textTurnReady()) {
    return "实时通道已连接。请填写当前问题和候选人回答后发送文字回答，或直接开始麦克风。";
  }
  if (connected) {
    return "实时通道已连接。建议用 BlackHole/Loopback 分开你和会议声；也可先单麦并手动切换说话人。";
  }
  if (connecting) return "实时通道连接中，请稍候。连接成功后按钮会自动启用。";
  if (state.interview) return "实时通道未连接。请点击重连通道，或重置后重新创建面试。";
  return "请先创建实时面试并等待实时通道连接。";
}

function controlHintTone(connected, connecting) {
  if (state.reportReady || state.interviewEnded || connected || state.micRecording) return "ready";
  if (state.endingInterview || state.micStarting || connecting) return "live";
  if (state.micError || state.interview) return "warn";
  return "";
}

function updateTextCounters() {
  const questionChars = currentQuestion.value.trim().length;
  const answerChars = answerText.value.trim().length;
  questionCharCount.textContent = `问题 ${questionChars} 字`;
  answerCharCount.textContent =
    answerChars > 0 && answerChars < answerMinChars
      ? `回答 ${answerChars} 字，建议至少 ${answerMinChars} 字`
      : `回答 ${answerChars} 字`;
  answerCharCount.className =
    answerChars > 0 && answerChars < answerMinChars
      ? "small text-counter warn"
      : "small text-counter";
  setControls();
}

function textTurnReady() {
  return Boolean(currentQuestion.value.trim() && answerText.value.trim());
}

function emptyFeedMarkup() {
  return `<div class="chat-welcome">
    <div class="welcome-identity">
      <span class="brand-mark" aria-hidden="true">六</span>
      <span class="welcome-kicker">左右 · 面试工作台</span>
    </div>
    <h2>今天，推进这一场面试？</h2>
    <p>把转写和下一问交给驾驶舱，<br />把注意力留给对话。</p>
    <div class="welcome-section-label">从一项动作开始 <span>也可以直接在下方输入</span></div>
    <div class="chat-suggestions">
      <button type="button" data-welcome="prepare"><span class="task-suggestion-text"><strong>创建实时面试</strong><small>用当前岗位与简历打开实时通道</small></span></button>
      <button type="button" data-welcome="capture"><span class="task-suggestion-text"><strong>截图发送题目</strong><small>框选屏幕上的题，解析后写入对话</small></span></button>
      <button type="button" data-welcome="connect"><span class="task-suggestion-text"><strong>API 接入</strong><small>填写网关地址、密钥，确认当前模型</small></span></button>
    </div>
  </div>`;
}

function appendEvent(title, body, tone = "") {
  const host = liveFeed || document.querySelector("#settingsLog");
  if (!host) return;
  if (host.querySelector(".chat-welcome, .empty")) host.innerHTML = "";
  const node = document.createElement("article");
  const kind = conversationKind(title);
  node.className = `event transcript-entry chat-message ${kind} ${tone}`.trim();
  const bubbleClass = kind === "user" ? "userBubble" : "assistantText";
  node.innerHTML = `
    <div class="event-top messageMeta"><strong>${escapeHtml(title)}</strong></div>
    <p class="${bubbleClass}">${body}</p>
  `;
  host.append(node);
  host.scrollTop = host.scrollHeight;
  if (host === liveFeed) trimLiveFeedEvents();
}

function conversationKind(title) {
  return ["截图问题", "当前问题", "下一问", "回答已发送"].includes(title) ? "user" : "assistant";
}

function formatLiveTimer(elapsedMs) {
  const total = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function tickLiveTimer() {
  const node = document.querySelector("#liveTimer");
  if (!node) return;
  node.textContent = state.startedAt ? formatLiveTimer(Date.now() - state.startedAt) : "00:00";
}

if (!window.__liveTimerStarted) {
  window.__liveTimerStarted = true;
  setInterval(tickLiveTimer, 1000);
}

function trimLiveFeedEvents() {
  const events = liveFeed.querySelectorAll(".event");
  events.forEach((event, index) => {
    if (index < events.length - maxLiveFeedEvents) event.remove();
  });
}


export {
  appendEvent,
  applyDebugTextVisibility,
  controlHintText,
  controlHintTone,
  emptyFeedMarkup,
  escapeHtml,
  liveChannelUnavailableReason,
  optionKindLabel,
  pickQuestionOption,
  renderCurrentQuestionOption,
  renderExtractionTags,
  pickQuestionOptionAt,
  renderAnswerEcho,
  renderNextOptions,
  resetAnswerEcho,
  sendSteeringFocus,
  setButtonBusy,
  setControlHints,
  setControls,
  setCurrentSpeaker,
  setPill,
  setSteeringFocus,
  steeringLabel,
  syncSpeakerControls,
  textTurnReady,
  trimLiveFeedEvents,
  tickLiveTimer,
  updateTextCounters,
};

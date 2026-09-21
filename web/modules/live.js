import { answerText, credibilityBox, credibilityLevel, currentQuestion, currentQuestionMeta, currentQuestionText, endInterview, liveStatus, metricTurns } from './dom.js';
import { discoverGateway, errorText, websocketProtocols, wsUrl } from './gateway.js';
import { stopMicCapture } from './mic.js';
import { renderMemoryHits, renderProbeCards, renderProbeChains } from './panels.js';
import { markReportReady, renderQueuedReportState, renderReport, reportTotalScoreText } from './report.js';
import { state } from './state.js';
import { appendEvent, escapeHtml, renderAnswerEcho, renderCurrentQuestionOption, renderNextOptions, setControls, setPill, updateTextCounters } from './ui.js';

async function openSocketWithLatestGateway(interviewId, stillCurrent = () => true) {
  try {
    await discoverGateway();
  } catch (error) {
    if (!stillCurrent()) return;
    appendEvent(
      "实时通道",
      `连接前无法确认本地 gateway：${escapeHtml(errorText(error))}`,
      "red"
    );
  }
  if (!stillCurrent()) return;
  openSocket(interviewId);
}

function openSocket(interviewId) {
  const socketUrl = wsUrl(`/ws/interview/${interviewId}`);
  const socketToken = state.socketToken + 1;
  state.socketToken = socketToken;
  try {
    state.socket = new WebSocket(socketUrl, websocketProtocols());
  } catch (error) {
    if (!socketStillCurrent(socketToken)) return;
    state.socket = null;
    setControls();
    appendEvent("实时通道", `WebSocket 初始化失败：${escapeHtml(errorText(error))}`, "red");
    return;
  }
  setControls();
  state.socket.addEventListener("open", () => {
    if (!socketStillCurrent(socketToken)) return;
    setControls();
    appendEvent("实时通道", "WebSocket 已打开。");
  });
  state.socket.addEventListener("close", () => {
    if (!socketStillCurrent(socketToken)) return;
    stopMicCapture();
    setControls();
    appendEvent("实时通道", "WebSocket 已关闭。可点击重连通道继续当前面试。");
  });
  state.socket.addEventListener("error", () => {
    if (!socketStillCurrent(socketToken)) return;
    setControls();
    appendEvent(
      "实时通道",
      "WebSocket 连接失败，请检查服务是否仍在运行；恢复后点击重连通道继续当前面试。",
      "red"
    );
  });
  state.socket.addEventListener("message", (event) => {
    if (!socketStillCurrent(socketToken)) return;
    handleSocketMessage(event);
  });
}

function socketStillCurrent(socketToken) {
  return socketToken === state.socketToken;
}

function handleSocketMessage(event) {
  try {
    const message = parseLiveSocketMessage(event.data);
    validateLiveMessage(message);
    renderLiveMessage(message);
  } catch (error) {
    appendEvent("实时通道", `实时消息格式异常：${escapeHtml(errorText(error))}`, "red");
  }
}

function parseLiveSocketMessage(data) {
  try {
    return JSON.parse(data);
  } catch (error) {
    throw new Error(`实时消息不是有效 JSON：${String(data || "").slice(0, 160)}`);
  }
}

function validateLiveMessage(message) {
  if (!message || typeof message !== "object") {
    throw new Error("实时消息结构异常：消息不是对象");
  }
  if (typeof message.type !== "string" || !message.type) {
    throw new Error("实时消息结构异常：缺少 type");
  }
  if (message.type !== "error" && (!message.payload || typeof message.payload !== "object")) {
    throw new Error(`实时消息结构异常：${message.type} 缺少 payload`);
  }
}

async function reconnectLiveChannel() {
  if (!state.interview) {
    appendEvent("实时通道", "请先创建实时面试。", "red");
    return;
  }
  if (state.interviewEnded) {
    appendEvent("实时通道", "面试已结束，请重置后创建新的面试。", "red");
    return;
  }
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    appendEvent("实时通道", "当前实时通道已经连接。");
    return;
  }
  if (state.socket && state.socket.readyState === WebSocket.CONNECTING) {
    appendEvent("实时通道", "实时通道正在连接中。");
    return;
  }
  stopMicCapture();
  const reconnectInterviewId = state.interview.id;
  const reconnectStillCurrent = () =>
    Boolean(state.interview) &&
    state.interview.id === reconnectInterviewId &&
    !state.interviewEnded;
  await openSocketWithLatestGateway(reconnectInterviewId, reconnectStillCurrent);
  if (!reconnectStillCurrent()) return;
  appendEvent("实时通道", "正在重新连接当前面试。");
}

function closeSocket() {
  state.socketToken += 1;
  if (
    state.socket &&
    (state.socket.readyState === WebSocket.OPEN ||
      state.socket.readyState === WebSocket.CONNECTING)
  ) {
    state.socket.close();
  }
  state.socket = null;
  setControls();
}

function turnTiming() {
  const start = Math.max(0, Date.now() - state.startedAt);
  const estimated = Math.max(1200, Math.min(30000, answerText.value.length * 220));
  return { start_ms: Math.round(start), end_ms: Math.round(start + estimated) };
}

function eventQuestionMeta() {
  return {
    question: currentQuestion.value.trim(),
    question_source: state.selectedQuestionSource,
    probe_target: state.selectedProbeTarget,
    chain_id: state.selectedProbeChainId,
  };
}

function liveChannelReadyForInput() {
  if (state.interviewEnded) {
    appendEvent("面试已结束", "请重置后创建新的面试。", "red");
    return false;
  }
  if (state.endingInterview) {
    appendEvent("评分中", "正在结束面试并生成评分报告，请等待结果。", "red");
    return false;
  }
  if (!state.interview) {
    appendEvent("实时通道", "请先创建实时面试。", "red");
    return false;
  }
  if (state.socket && state.socket.readyState === WebSocket.CONNECTING) {
    appendEvent("实时通道", "实时通道连接中，请稍候。", "red");
    return false;
  }
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    appendEvent("实时通道", "实时通道未连接，请点击重连通道。", "red");
    return false;
  }
  return true;
}

function sendLiveSocketPayload(payload, title = "实时通道") {
  try {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      throw new Error("实时通道未连接");
    }
    state.socket.send(JSON.stringify(payload));
    return true;
  } catch (error) {
    appendEvent(
      title,
      `发送失败：${escapeHtml(errorText(error))}。请点击重连通道后重试。`,
      "red"
    );
    setControls();
    return false;
  }
}

function sendScreenshotQuestion(solution) {
  const question = String((solution && solution.question_summary) || "").trim();
  const sourceLabel = solution && solution.source === "vision" ? "截图识题" : "截图 OCR";
  if (question) {
    currentQuestion.value = question;
    currentQuestionText.textContent = question;
    currentQuestionMeta.textContent = sourceLabel;
    state.currentQuestionOption = null;
    state.selectedQuestionSource = "interviewer";
    state.selectedProbeTarget = "截图出题";
    state.selectedProbeChainId = null;
    state.selectedCompetency = sourceLabel;
    updateTextCounters();
  }
  const body = formatExamConversation(solution, question);
  if (!state.interview || state.interviewEnded || state.endingInterview) {
    appendEvent("截图问题", `${body}<br><span class="small">已写入当前问题，创建实时面试后可发送到对话通道。</span>`, "blue");
    return;
  }
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    appendEvent("截图问题", `${body}<br><span class="small">实时通道未连接，题目已写入当前问题。</span>`, "amber");
    return;
  }
  if (!question) {
    appendEvent("截图问题", "解析结果没有题目摘要。", "amber");
    return;
  }
  const timing = turnTiming();
  const payload = {
    type: "text_turn",
    seq: state.seq,
    speaker: "interviewer",
    answer: question,
    confidence: 1,
    start_ms: timing.start_ms,
    end_ms: timing.start_ms + 800,
    ...eventQuestionMeta(),
  };
  if (!sendLiveSocketPayload(payload, "截图问题")) return;
  state.seq += 1;
  appendEvent(
    "截图问题",
    `${body}<br><span class="small">已作为面试官问题发送到对话通道。</span>`,
    "blue"
  );
}

function formatExamConversation(solution, question) {
  const keyPoints = Array.isArray(solution && solution.key_points) ? solution.key_points : [];
  const answer = String((solution && solution.reference_answer) || "").trim();
  const parts = [escapeHtml(question || "（无题目摘要）")];
  if (keyPoints.length) {
    parts.push(
      `<span class="small">评分要点：${keyPoints.map((point) => escapeHtml(point)).join("；")}</span>`
    );
  }
  if (answer) {
    parts.push(`<span class="small">参考：${escapeHtml(answer)}</span>`);
  }
  if (solution && solution.warning) {
    parts.push(`<span class="small">${escapeHtml(solution.warning)}</span>`);
  }
  return parts.join("<br>");
}

function sendTurn(manual = false) {
  if (!liveChannelReadyForInput()) return;
  const answer = answerText.value.trim();
  const question = currentQuestion.value.trim();
  if (!answer || !question) {
    appendEvent("输入缺失", "当前问题和候选人回答都需要填写。", "red");
    (question ? answerText : currentQuestion).focus();
    return;
  }
  const timing = turnTiming();
  if (!manual && state.currentQuestionOption) {
    const questionPayload = {
      type: "text_turn",
      seq: state.seq,
      speaker: "interviewer",
      answer: question,
      confidence: 1,
      start_ms: timing.start_ms,
      end_ms: timing.start_ms + 800,
    };
    if (!sendLiveSocketPayload(questionPayload, "问题发送失败")) return;
    state.seq += 1;
  }
  const payload = manual
    ? {
        type: "manual_probe",
        answer,
        confidence: 1,
        ...timing,
        ...eventQuestionMeta(),
      }
    : {
        type: "text_turn",
        seq: state.seq,
        speaker: "candidate",
        answer,
        confidence: 1,
        ...timing,
        ...eventQuestionMeta(),
      };
  if (!sendLiveSocketPayload(payload, manual ? "追问触发失败" : "回答发送失败")) return;
  if (!manual) state.seq += 1;
  appendEvent(
    manual ? "追问触发" : "回答已发送",
    `<span class="small">Q</span> ${escapeHtml(question)}<br><span class="small">A</span> ${escapeHtml(answer)}`
  );
  if (!manual) {
    answerText.value = "";
    updateTextCounters();
    answerText.focus();
  }
}

function requestEndInterview() {
  stopMicCapture();
  if (!liveChannelReadyForInput()) return;
  state.endingInterview = true;
  endInterview.disabled = true;
  endInterview.title = "正在结束面试并生成评分报告";
  setPill(liveStatus, "评分中", "live");
  setControls();
  if (!sendLiveSocketPayload({ type: "end" }, "结束面试失败")) {
    state.endingInterview = false;
    endInterview.disabled = false;
    endInterview.title = "结束面试并生成评分报告";
    setControls();
  }
}

function renderLiveMessage(message) {
  if (message.type === "transcript") {
    appendEvent(
      "转写",
      `${escapeHtml(message.payload.speaker)} · ${escapeHtml(message.payload.text)}`
    );
    if (message.payload.speaker === "candidate") {
      renderAnswerEcho(message.payload.text, { partial: message.payload.is_final === false });
    }
  } else if (message.type === "current_question") {
    renderCurrentQuestionOption(message.payload);
    appendEvent("当前问题", escapeHtml(message.payload.question), "blue");
  } else if (message.type === "next_options") {
    renderNextOptions(message.payload, "下一步选项");
  } else if (message.type === "next_options_update") {
    renderNextOptions(message.payload, "下一步选项更新");
  } else if (message.type === "question_matched") {
    appendEvent(
      "问题匹配",
      message.payload.matched_option_id
        ? `已匹配系统建议：${escapeHtml(message.payload.matched_option_id)}`
        : `自定义问题：${escapeHtml(message.payload.asked_text)}`,
      message.payload.matched_option_id ? "green" : "amber"
    );
	        } else if (message.type === "turn") {
	          state.turns += 1;
	          metricTurns.textContent = String(state.turns);
	          appendEvent(
	            "问答轮次",
	            `<span class="small">Q</span> ${escapeHtml(message.payload.question)}<br><span class="small">A</span> ${escapeHtml(message.payload.answer)}`
	          );
	          renderAnswerEcho(message.payload.answer);
	        } else if (message.type === "probe") {
	          renderProbeCards(message.payload.suggestions || []);
	          appendEvent("追问方向", "已生成新的专业问题候选。", "blue");
  } else if (message.type === "probe_update") {
    renderProbeCards(message.payload.suggestions || []);
    appendEvent("追问方向", "大模型追问已刷新。", "blue");
  } else if (message.type === "memory_hits") {
    renderMemoryHits((message.payload && message.payload.items) || []);
    appendEvent("记忆命中", "已召回本地项目库/历史面试线索，可用于对质追问。", "blue");
  } else if (message.type === "probe_chains") {
    renderProbeChains(message.payload || []);
  } else if (message.type === "credibility") {
    credibilityLevel.textContent = message.payload.level;
    credibilityBox.innerHTML = `
      <h3>${escapeHtml(message.payload.reason)}</h3>
      <p>${escapeHtml(message.payload.drill_down_hint)}</p>
    `;
  } else if (message.type === "signal") {
    appendEvent(
      "行为信号",
      `fluency ${escapeHtml(message.payload.fluency)} · hesitation ${escapeHtml(message.payload.hesitation)}`
    );
  } else if (message.type === "asr_warning") {
    appendEvent("ASR", formatAsrWarning(message.payload.reason), "red");
  } else if (message.type === "report") {
    stopMicCapture();
    state.endingInterview = false;
    state.interviewEnded = true;
    renderReport(message.payload);
    markReportReady();
    appendEvent("评分完成", `总分 ${escapeHtml(reportTotalScoreText(message.payload))}`, "green");
  } else if (message.type === "task_queued") {
    stopMicCapture();
    state.endingInterview = false;
    state.interviewEnded = true;
    renderQueuedReportState(state.interview.id);
    appendEvent(
      "任务已排队",
      `${escapeHtml(message.payload.task_name)} · ${escapeHtml(message.payload.task_id)}。请等待后台评分完成。`
    );
  } else if (message.type === "error") {
    state.endingInterview = false;
    appendEvent("错误", formatLiveError(message.detail), "red");
  } else {
    appendEvent("实时通道", `未知实时消息类型：${escapeHtml(message.type)}`, "red");
  }
  setControls();
}

function formatLiveError(detail) {
  const raw = String(detail || "unknown error");
  const normalized = raw.toLowerCase();
  let message = raw;
  if (normalized.includes("cannot finish interview without candidate turns")) {
    message = "还没有候选人回答，不能生成评分报告。请先发送至少一条候选人回答。";
  } else if (normalized.includes("cannot start interview from status reported")) {
    message = "这场面试已经生成报告，请重置后创建新的面试。";
  } else if (raw === "text_turn requires answer") {
    message = "候选人回答不能为空。";
  } else if (raw === "manual_probe requires answer") {
    message = "追问前需要先填写候选人回答。";
  } else if (raw === "invalid seq") {
    message = "实时消息序号无效，请重连通道后重试。";
  } else if (raw === "unsupported event type") {
    message = "实时消息类型不支持，请刷新页面后重试。";
  }
  return `${escapeHtml(message)}<br><span class="small">原始错误：${escapeHtml(raw)}</span>`;
}

function formatAsrWarning(reason) {
  const raw = String(reason || "unknown");
  const normalized = raw.toLowerCase();
  let message = "ASR 转写暂时不可用，请重试或改用文本回答。";
  if (normalized.includes("idle_timeout")) {
    message = "ASR 长时间没有收到有效语音：请点击停止麦克风后重新开始，并在开启后直接说话。";
  } else if (
    normalized.includes("40000002") ||
    normalized.includes("bad token") ||
    normalized.includes("invalid token")
  ) {
    message =
      "ASR Token 已失效或被拒绝：自动 Token 模式会尝试刷新；如果仍失败，请检查 ALIYUN_NLS_TOKEN 或阿里云 AccessKey 权限。";
  } else if (
    normalized.includes("invalidapikey") ||
    normalized.includes("invalid api key") ||
    normalized.includes("bad key")
  ) {
    message = "阿里云 ASR API Key 无效：请检查 ALIYUN_ASR_API_KEY 是否是百炼/DashScope API Key。";
  } else if (normalized.includes("createtoken failed")) {
    message = "NLS Token 创建失败：请检查 ALIYUN_AK_ID、ALIYUN_AK_SECRET 和账号权限。";
  } else if (raw === "aliyun_asr_disconnected") {
    message = "ASR 连接已断开：请停止麦克风后重新开始。";
  } else if (raw === "aliyun_asr_websockets_dependency_missing") {
    message = "ASR WebSocket 依赖缺失：请重新安装依赖后启动服务。";
  } else if (raw === "aliyun_asr_no_result") {
    message = "ASR 没有返回识别文本：请靠近麦克风重试，或先用文本框发送回答。";
  } else if (raw === "asr_transcription_failed") {
    message = "ASR 转写失败：请重新说一遍，或先用文本框发送回答。";
  } else if (raw === "invalid_audio_base64") {
    message = "音频数据无效：请重新开启麦克风。";
  } else if (raw === "unsupported_audio_format") {
    message = "音频格式不支持：浏览器应发送 16k PCM16 单声道音频。";
  } else if (raw === "unsupported_sample_rate") {
    message = "音频采样率不支持：需要 16000 Hz。";
  } else if (raw === "unsupported_channel_count") {
    message = "音频声道数不支持：需要单声道。";
  } else if (raw === "duplicate_final_segment") {
    message = "已忽略重复的最终转写片段。";
  } else if (raw === "session_id_mismatch") {
    message = "音频会话和当前面试不匹配：请重置后重新创建面试。";
  } else if (raw === "invalid_seq") {
    message = "音频序号无效：请重置会话后重试。";
  }
  return `${escapeHtml(message)}<br><span class="small">原始原因：${escapeHtml(raw)}</span>`;
}


export {
  closeSocket,
  eventQuestionMeta,
  formatAsrWarning,
  formatLiveError,
  handleSocketMessage,
  liveChannelReadyForInput,
  openSocket,
  openSocketWithLatestGateway,
  parseLiveSocketMessage,
  reconnectLiveChannel,
  renderLiveMessage,
  requestEndInterview,
  sendLiveSocketPayload,
  sendScreenshotQuestion,
  sendTurn,
  socketStillCurrent,
  turnTiming,
  validateLiveMessage,
};

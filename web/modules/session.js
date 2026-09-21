import { credibilityBox, credibilityLevel, liveFeed, longTermMemoryConsent, metricCandidate, metricJob, metricTurns, reportLinks, reportPanel, roleLinks, setupStatus } from './dom.js';
import { discoverGateway, errorText, fetchGatewayJson, postJson } from './gateway.js';
import { closeSocket, openSocketWithLatestGateway } from './live.js';
import { stopMicCapture } from './mic.js';
import { prepareSessionStillCurrent, renderCompetencies, renderProbeChains, syncMemoryActions } from './panels.js';
import { clearQueuedReportPolling } from './report.js';
import { prepareSessionTimeoutMs, state } from './state.js';
import { appendEvent, emptyFeedMarkup, escapeHtml, renderCurrentQuestionOption, renderExtractionTags, renderNextOptions, setControls, setCurrentSpeaker, setPill, setSteeringFocus } from './ui.js';

async function prepareSession(form) {
  if (state.preparingInterview) {
    appendEvent("面试创建", "正在创建实时面试，请稍候。");
    return;
  }
  if (state.interview) {
    appendEvent("面试创建", "当前已有面试，请重置后再创建新的面试。", "red");
    return;
  }
  if (state.documentParsingCount > 0) {
    appendEvent("面试创建", "资料正在解析，完成后再创建实时面试。", "red");
    return;
  }
  if (!validateSetupForm(form)) return;
  const prepareToken = state.prepareSessionToken + 1;
  state.prepareSessionToken = prepareToken;
  state.preparingInterview = true;
  clearQueuedReportPolling();
  closeSocket();
  stopMicCapture();
  state.interviewEnded = false;
  state.endingInterview = false;
  state.reportReady = false;
  state.seq = 1;
  state.turns = 0;
  state.startedAt = Date.now();
  metricTurns.textContent = "0";
  reportLinks.innerHTML = "";
  reportPanel.innerHTML = '<div class="empty">结束面试后生成综合评分</div>';
  credibilityLevel.textContent = "待观察";
  credibilityBox.innerHTML = "<p>等待候选人首个回答。</p>";
  liveFeed.innerHTML = emptyFeedMarkup();
  renderCurrentQuestionOption(null);
  renderNextOptions(null);
  setSteeringFocus("balanced");
  setPill(setupStatus, "创建中", "live");
  setControls();
  try {
    const setup = await postJson("/api/interviews/quick-setup", {
      jd_text: form.jd_text.value.trim(),
      resume_text: form.resume_text.value.trim(),
    }, {
      timeoutMs: prepareSessionTimeoutMs,
    });
    if (!prepareSessionStillCurrent(prepareToken)) return;
    const job = await fetchGatewayJson(`/api/jobs/${encodeURIComponent(setup.job_id)}`, {
      timeoutMs: prepareSessionTimeoutMs,
    });
    if (!prepareSessionStillCurrent(prepareToken)) return;
    const interview = await fetchGatewayJson(`/api/interviews/${encodeURIComponent(setup.interview_id)}`, {
      timeoutMs: prepareSessionTimeoutMs,
    });
    if (!prepareSessionStillCurrent(prepareToken)) return;
    const candidate = {
      id: setup.candidate_id,
      name: setup.candidate_name,
      resume_text: form.resume_text.value.trim(),
    };
    state.job = job;
    state.candidate = candidate;
    state.interview = interview;
    state.questionBank = setup.question_bank || null;
    form.job_title.value = setup.job_title;
    form.candidate_name.value = setup.candidate_name;
    metricJob.textContent = job.title;
    metricCandidate.textContent = candidate.name;
    renderExtractionTags(setup.job_title, setup.candidate_name, setup.extraction_confident);
    await recordLongTermMemoryConsent(setup.candidate_id);
    syncMemoryActions();
    renderRoleLinks();
    renderCompetencies(job);
    renderProbeChains((interview.context && interview.context.probe_chains) || []);
    await openSocketWithLatestGateway(interview.id, () =>
      prepareSessionStillCurrent(prepareToken)
    );
    if (!prepareSessionStillCurrent(prepareToken)) return;
    setPill(setupStatus, "已建面试", "ready");
    appendEvent("面试创建", `${escapeHtml(job.title)} · ${escapeHtml(candidate.name)}`);
    const briefing = document.querySelector("#briefingDrawer");
    if (briefing) briefing.open = false;
  } catch (error) {
    if (!prepareSessionStillCurrent(prepareToken)) return;
    setPill(setupStatus, "创建失败", "");
    appendEvent("错误", escapeHtml(errorText(error)), "red");
  } finally {
    if (prepareSessionStillCurrent(prepareToken)) {
      state.preparingInterview = false;
      setControls();
    }
  }
}

// distill_interview_memories() drops everything unless an active long_term_memory
// consent exists, so without this call the cross-interview memory is silently
// never written. A failure here must not fail the interview: the interview still
// works, it just leaves no long-term trace, which is the safe direction.
async function recordLongTermMemoryConsent(candidateId) {
  const granted = Boolean(longTermMemoryConsent && longTermMemoryConsent.checked);
  try {
    await postJson("/api/consents", {
      candidate_id: candidateId,
      consent_type: "long_term_memory",
      granted,
    });
    appendEvent(
      "长期记忆",
      granted
        ? "已记录候选人同意，本次面试结束后会沉淀跨面试记忆。"
        : "未获授权，本次面试不会写入跨面试记忆。",
      granted ? "green" : ""
    );
  } catch (error) {
    appendEvent(
      "长期记忆",
      `同意状态写入失败，本次面试不会沉淀跨面试记忆：${escapeHtml(errorText(error))}`,
      "amber"
    );
  }
}

function joinInterviewIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return (params.get("join") || params.get("interview_id") || "").trim();
}

function roleFromUrl() {
  const role = new URLSearchParams(window.location.search).get("role");
  return role === "interviewer" ? "interviewer" : "candidate";
}

// These links get handed to the other participant, so they must point at the
// gateway's own page. Under the desktop shell window.location is a file:// URL,
// which nobody else can open.
function roleJoinUrl(role) {
  const url = new URL(`${state.apiOrigin}/`);
  url.searchParams.set("join", state.interview.id);
  url.searchParams.set("role", role);
  return url.toString();
}

function renderRoleLinks() {
  if (!state.interview) {
    roleLinks.textContent = "待创建";
    return;
  }
  const interviewerUrl = roleJoinUrl("interviewer");
  const candidateUrl = roleJoinUrl("candidate");
  roleLinks.innerHTML = `
    <a href="${escapeHtml(interviewerUrl)}" target="_blank" rel="noreferrer">面试官</a>
    <a href="${escapeHtml(candidateUrl)}" target="_blank" rel="noreferrer">候选人</a>
  `;
}

async function joinExistingInterviewFromUrl() {
  const interviewId = joinInterviewIdFromUrl();
  if (!interviewId || state.interview) return;
  const prepareToken = state.prepareSessionToken + 1;
  state.prepareSessionToken = prepareToken;
  state.preparingInterview = true;
  state.startedAt = Date.now();
  setCurrentSpeaker(roleFromUrl());
  setPill(setupStatus, "加入中", "live");
  setControls();
  try {
    await discoverGateway();
    if (!prepareSessionStillCurrent(prepareToken)) return;
    const interview = await fetchGatewayJson(`/api/interviews/${encodeURIComponent(interviewId)}`, {
      timeoutMs: prepareSessionTimeoutMs,
    });
    if (!prepareSessionStillCurrent(prepareToken)) return;
    let job = {
      id: interview.job_id,
      title: `岗位 ${String(interview.job_id).slice(0, 8)}`,
      competency_model: interview.context && interview.context.competency_model,
    };
    try {
      job = await fetchGatewayJson(`/api/jobs/${encodeURIComponent(interview.job_id)}`, {
        timeoutMs: prepareSessionTimeoutMs,
      });
    } catch (error) {
      appendEvent("加入面试", "岗位详情暂未取回，使用面试上下文中的能力模型。");
    }
    if (!prepareSessionStillCurrent(prepareToken)) return;
    state.interview = interview;
    state.job = job;
    state.candidate = {
      id: interview.candidate_id,
      name: `候选人 ${String(interview.candidate_id).slice(0, 8)}`,
    };
    state.seq = 1;
    state.turns = Array.isArray(interview.context && interview.context.turns)
      ? interview.context.turns.length
      : 0;
    metricJob.textContent = job.title || "已加入";
    metricCandidate.textContent = state.candidate.name;
    metricTurns.textContent = String(state.turns);
    renderRoleLinks();
    renderCompetencies(job);
    renderProbeChains((interview.context && interview.context.probe_chains) || []);
    await openSocketWithLatestGateway(interview.id, () =>
      prepareSessionStillCurrent(prepareToken)
    );
    if (!prepareSessionStillCurrent(prepareToken)) return;
    setPill(setupStatus, "已加入面试", "ready");
    appendEvent("加入面试", `${escapeHtml(metricJob.textContent)} · ${escapeHtml(state.currentSpeaker)}`);
  } catch (error) {
    if (!prepareSessionStillCurrent(prepareToken)) return;
    setPill(setupStatus, "加入失败", "");
    appendEvent("加入面试失败", escapeHtml(errorText(error)), "red");
  } finally {
    if (prepareSessionStillCurrent(prepareToken)) {
      state.preparingInterview = false;
      setControls();
    }
  }
}

function validateSetupForm(form) {
  const fields = [
    [form.jd_text, "岗位 JD"],
    [form.resume_text, "简历摘要"],
  ];
  for (const [field, label] of fields) {
    if (!field.value.trim()) {
      appendEvent("面试创建失败", `${escapeHtml(label)}不能为空。`, "red");
      field.focus();
      return false;
    }
  }
  return true;
}


export {
  joinExistingInterviewFromUrl,
  joinInterviewIdFromUrl,
  prepareSession,
  renderRoleLinks,
  roleFromUrl,
  roleJoinUrl,
  validateSetupForm,
};

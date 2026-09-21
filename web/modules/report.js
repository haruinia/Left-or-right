import { liveStatus, reportLinks, reportPanel } from './dom.js';
import { errorText, fetchGateway, fetchGatewayJson } from './gateway.js';
import { gatewayAuthError, showGatewayKeyRequired } from './runtime.js';
import { queuedReportMaxPollAttempts, queuedReportPollIntervalMs, reportDownloadTimeoutMs, state } from './state.js';
import { appendEvent, escapeHtml, setButtonBusy, setPill, steeringLabel } from './ui.js';

function recommendationLabel(value) {
  return {
    strong_yes: "强烈推荐",
    yes: "推荐",
    hold: "待定",
    no: "不推荐",
  }[value] || value;
}

function renderReport(report) {
  const score = report.score || {};
  const reportId = reportInterviewId(report);
  const dimensions = Array.isArray(score.dimensions) ? score.dimensions : [];
  const riskNotes = Array.isArray(score.risk_notes) ? score.risk_notes : [];
  const transcriptTurns = Array.isArray(report.transcript) ? report.transcript : [];
  const probeChains = Array.isArray(report.probe_chains) ? report.probe_chains : [];
  const aigcResults = Array.isArray(report.aigc_results) ? report.aigc_results : [];
  const turnsById = new Map(transcriptTurns.map((turn) => [turn.turn_id, turn]));
  const analysisMode = report.analysis_mode || score.analysis_mode || "llm";
  const adoption = report.question_adoption || {};
  const adoptionRate =
    typeof adoption.adoption_rate === "number"
      ? `${(adoption.adoption_rate * 100).toFixed(1)}%`
      : "0.0%";
  reportLinks.innerHTML = `
    <button class="secondary" type="button" data-report-format="html" data-report-id="${escapeHtml(reportId)}" title="下载 HTML 报告" aria-label="下载 HTML 报告">HTML</button>
    <button class="secondary" type="button" data-report-format="pdf" data-report-id="${escapeHtml(reportId)}" title="下载 PDF 报告" aria-label="下载 PDF 报告">PDF</button>
    <button class="secondary" type="button" data-report-format="json" data-report-id="${escapeHtml(reportId)}" title="下载 JSON 报告" aria-label="下载 JSON 报告">JSON</button>
    <button class="secondary" type="button" data-report-format="transcript.json" data-report-id="${escapeHtml(reportId)}" title="下载转写记录" aria-label="下载转写记录">转写</button>
  `;
  reportLinks.querySelectorAll("[data-report-format]").forEach((button) => {
    button.addEventListener("click", () => {
      downloadReportArtifact(button.dataset.reportId, button.dataset.reportFormat);
    });
  });
  const rows = dimensions.length
    ? dimensions
    .map(
      (dimension) => `
        <tr>
          <td>${escapeHtml(dimension.dimension)}</td>
          <td>${escapeHtml(dimension.score)}</td>
          <td>${reportEvidenceRows(dimension.evidence)}</td>
        </tr>
      `
    )
    .join("")
    : '<tr><td colspan="3">暂无维度评分。</td></tr>';
  const risks = riskNotes.length
    ? riskNotes.map((note) => `<p class="risk">${escapeHtml(note)}</p>`).join("")
    : '<p class="success">暂无高置信风险点。</p>';
  const chains = probeChains.length
    ? probeChains
    .map((chain) => {
      const links = Array.isArray(chain.links) ? chain.links : [];
      const linkText = links.length
        ? links
          .map(
            (link, index) => {
              const answer = turnsById.get(link.answer_turn_id);
              return `${index + 1}. Q：${escapeHtml(link.probe_question)}<br>A：${escapeHtml(answer ? answer.answer : "未找到关联回答")}<br>判定：${escapeHtml(link.credibility_after)}`;
            }
          )
          .join("<br>")
        : "未进入下钻";
      return `
        <tr>
          <td>${escapeHtml(chain.topic)}</td>
          <td>${escapeHtml(chain.origin)}</td>
          <td>${links.length}</td>
          <td>${escapeHtml(chain.verdict)}${chain.crack_depth ? ` · 第 ${escapeHtml(chain.crack_depth)} 层` : ""}</td>
          <td>${linkText}</td>
        </tr>
      `;
    })
    .join("")
    : '<tr><td colspan="5">暂无追问链。</td></tr>';
  const transcript = transcriptTurns.length
    ? transcriptTurns
    .map(
      (turn, index) => `
        <tr>
          <td>${index + 1}</td>
          <td>${escapeHtml(turn.question)}</td>
          <td>${escapeHtml(turn.answer)}</td>
        </tr>
      `
    )
    .join("")
    : '<tr><td colspan="3">暂无转写记录。</td></tr>';
  const memoryReviewItems = Array.isArray(report.memory_review) ? report.memory_review : [];
  const memoryReviewVerdictLabels = {
    supported: "验证成立",
    conflicted: "存在冲突",
    unverified: "未验证",
  };
  const memoryReview = memoryReviewItems.length
    ? memoryReviewItems
      .map(
        (item) => `
          <tr>
            <td>${escapeHtml(item.turn_id)}</td>
            <td>${escapeHtml(item.memory_subject)}</td>
            <td>${item.verdict === "conflicted" ? `<span class="risk">${escapeHtml(memoryReviewVerdictLabels[item.verdict])}</span>` : escapeHtml(memoryReviewVerdictLabels[item.verdict] || item.verdict)}</td>
            <td>${escapeHtml(item.note)}</td>
          </tr>
        `
      )
      .join("")
    : '<tr><td colspan="4">本场没有记忆命中（记忆层未开启或没有相关项目/历史记录）。</td></tr>';
  const rehearsal = aigcResults.length
    ? aigcResults
      .map(
        (item) => `
          <tr>
            <td>${escapeHtml(item.turn_id)}</td>
            <td>${escapeHtml(item.mode || "voice")}</td>
            <td>${escapeHtml(item.rehearsal_score ?? 0)}</td>
            <td>${escapeHtml(item.template_similarity ?? 0)}</td>
            <td>${item.flagged ? '<span class="risk">疑似模板化</span>' : "未命中"}</td>
          </tr>
        `
      )
      .join("")
    : '<tr><td colspan="5">暂无背稿检测结果。</td></tr>';
  reportPanel.innerHTML = `
    <div class="report-box">
      ${
        analysisMode === "fallback"
          ? '<p class="risk">本报告由确定性规则生成（未启用大模型分析），分数仅供链路验证，不可用于招聘决策。</p>'
          : ""
      }
      <div class="score-line">
        <div class="score-main"><strong>${escapeHtml(reportTotalScoreText(report))}</strong><span>${escapeHtml(reportRecommendationText(report))}</span></div>
        <div class="stack">
          <h3>总评</h3>
          <p>${escapeHtml(reportSummaryText(report))}</p>
          ${report.candidate_resume_text ? `<p><strong>简历摘要：</strong>${escapeHtml(report.candidate_resume_text)}</p>` : ""}
        </div>
      </div>
      <div>${risks}</div>
      <div class="report-box">
        <h3>问题采纳统计</h3>
        <p>系统建议 ${escapeHtml(adoption.suggested_unique_count ?? 0)} 题 · 采纳 ${escapeHtml(adoption.adopted_suggested_count ?? 0)} 题 · 自定义 ${escapeHtml(adoption.custom_question_count ?? 0)} 题 · 采纳率 ${escapeHtml(adoptionRate)}</p>
        <p>当前策略：${escapeHtml(steeringLabel(adoption.steering_focus || "balanced"))}</p>
      </div>
      <table>
        <thead><tr><th>维度</th><th>分数</th><th>证据</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <table>
        <thead><tr><th>主题</th><th>来源</th><th>层数</th><th>判定</th><th>关键链路</th></tr></thead>
        <tbody>${chains}</tbody>
      </table>
      <div class="report-box">
        <h3>复盘：记忆对照</h3>
        <p>本场回答与本地项目库、历史面试记忆的逐轮对照，仅作复核线索。</p>
        <table>
          <thead><tr><th>轮次</th><th>命中记忆</th><th>对照结论</th><th>说明</th></tr></thead>
          <tbody>${memoryReview}</tbody>
        </table>
      </div>
      <table>
        <thead><tr><th>Turn ID</th><th>模式</th><th>背稿分</th><th>模板相似度</th><th>状态</th></tr></thead>
        <tbody>${rehearsal}</tbody>
      </table>
      <table>
        <thead><tr><th>#</th><th>问题</th><th>回答</th></tr></thead>
        <tbody>${transcript}</tbody>
      </table>
    </div>
  `;
}

function reportEvidenceRows(evidence) {
  const items = Array.isArray(evidence) ? evidence : [];
  return items.length
    ? items.map((item) => escapeHtml(item.excerpt || item)).join("<br>")
    : "暂无证据";
}

function reportTotalScoreText(report) {
  const value = report && report.score ? report.score.total_score : null;
  return value === null || value === undefined || value === "" ? "待确认" : value;
}

function reportRecommendationText(report) {
  const value = report && report.score ? report.score.recommendation : "";
  return value ? recommendationLabel(value) : "建议待确认";
}

function reportSummaryText(report) {
  return String(report && report.summary ? report.summary : "暂无总评。");
}

function reportInterviewId(report) {
  return String((report && report.interview_id) || (state.interview && state.interview.id) || "");
}

function renderQueuedReportState(interviewId) {
  clearQueuedReportPolling();
  const refreshEpoch = state.reportRefreshEpoch;
  reportLinks.innerHTML = `
    <button class="secondary" type="button" id="refreshReport" data-report-id="${escapeHtml(interviewId)}" title="手动刷新评分报告" aria-label="手动刷新评分报告">刷新报告</button>
  `;
  reportLinks.querySelector("#refreshReport").addEventListener("click", (event) => {
    refreshQueuedReport(event.currentTarget.dataset.reportId, { refreshEpoch });
  });
  reportPanel.innerHTML = '<div class="empty">后台评分任务已排队，系统会自动刷新报告。</div>';
  scheduleQueuedReportPolling(interviewId, refreshEpoch);
}

function clearQueuedReportPolling() {
  if (state.reportPollTimer) {
    window.clearTimeout(state.reportPollTimer);
    state.reportPollTimer = null;
  }
  state.reportPollAttempts = 0;
  state.reportRefreshEpoch += 1;
  state.reportRefreshInFlight = false;
}

function reportRefreshStillCurrent(refreshEpoch, interviewId) {
  return (
    refreshEpoch === state.reportRefreshEpoch &&
    state.interview &&
    state.interview.id === interviewId &&
    !state.reportReady
  );
}

function scheduleQueuedReportPolling(interviewId, refreshEpoch = state.reportRefreshEpoch) {
  if (!interviewId || state.reportReady || state.reportPollTimer) return;
  if (!reportRefreshStillCurrent(refreshEpoch, interviewId)) return;
  if (state.reportPollAttempts >= queuedReportMaxPollAttempts) {
    appendEvent("报告刷新", "后台评分仍未完成，请稍后手动刷新报告。");
    return;
  }
  state.reportPollAttempts += 1;
  state.reportPollTimer = window.setTimeout(() => {
    state.reportPollTimer = null;
    refreshQueuedReport(interviewId, { auto: true, refreshEpoch });
  }, queuedReportPollIntervalMs);
}

async function refreshQueuedReport(interviewId, options = {}) {
  const refreshEpoch = options.refreshEpoch ?? state.reportRefreshEpoch;
  if (!reportRefreshStillCurrent(refreshEpoch, interviewId)) return;
  const button = reportLinks.querySelector("#refreshReport");
  const originalLabel = button ? button.textContent : "";
  const autoRefresh = options.auto === true;
  if (state.reportRefreshInFlight) {
    if (!autoRefresh) appendEvent("报告刷新", "报告刷新正在进行中，请稍候。");
    return;
  }
  state.reportRefreshInFlight = true;
  if (button && !autoRefresh) {
    button.disabled = true;
    setButtonBusy(button, true);
    button.textContent = "刷新中";
  }
  try {
    const report = await fetchGatewayJson(`/api/interviews/${interviewId}/report`);
    if (!reportRefreshStillCurrent(refreshEpoch, interviewId)) return;
    renderReport(report);
    markReportReady();
    appendEvent("评分完成", `总分 ${escapeHtml(reportTotalScoreText(report))}`, "green");
  } catch (error) {
    if (!reportRefreshStillCurrent(refreshEpoch, interviewId)) return;
    if (gatewayAuthError(error)) {
      showGatewayKeyRequired("报告刷新");
    } else if (reportPendingError(error)) {
      if (!autoRefresh) appendEvent("报告刷新", "报告仍在生成中，请稍后再刷新。");
      scheduleQueuedReportPolling(interviewId, refreshEpoch);
    } else {
      appendEvent("报告刷新失败", escapeHtml(errorText(error)), "red");
    }
  } finally {
    if (refreshEpoch === state.reportRefreshEpoch) state.reportRefreshInFlight = false;
    if (
      reportRefreshStillCurrent(refreshEpoch, interviewId) &&
      button &&
      !autoRefresh &&
      reportLinks.contains(button)
    ) {
      button.disabled = false;
      setButtonBusy(button, false);
      button.textContent = originalLabel || "刷新报告";
    }
  }
}

function reportPendingError(error) {
  return errorText(error).toLowerCase().includes("report not found");
}

function markReportReady() {
  clearQueuedReportPolling();
  state.reportReady = true;
  setPill(liveStatus, "报告已生成", "ready");
}

function reportDownloadStillCurrent(interviewId) {
  return state.interview && state.interview.id === interviewId && state.reportReady;
}

async function downloadReportArtifact(interviewId, format) {
  if (!interviewId || !format) {
    appendEvent("报告下载失败", "报告 ID 或格式缺失，请刷新报告后重试。", "red");
    return;
  }
  const downloadKey = `${interviewId}:${format}`;
  if (state.reportDownloadInFlight.has(downloadKey)) {
    appendEvent("报告下载", `${escapeHtml(reportFormatLabel(format))} 正在下载中，请稍候。`);
    return;
  }
  state.reportDownloadInFlight.add(downloadKey);
  const button = reportLinks.querySelector(`[data-report-format="${format}"]`);
  const originalLabel = button ? button.textContent : "";
  const originalTitle = button ? button.title : "";
  if (button) {
    button.disabled = true;
    setButtonBusy(button, true);
    button.textContent = "下载中";
    button.title = `正在下载 ${reportFormatLabel(format)} 报告`;
  }
  try {
    const response = await fetchGateway(`/api/interviews/${interviewId}/report.${format}`, {
      timeoutMs: reportDownloadTimeoutMs,
    });
    if (!reportDownloadStillCurrent(interviewId)) return;
    const blob = await response.blob();
    if (!reportDownloadStillCurrent(interviewId)) return;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = reportFilename(interviewId, format);
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    appendEvent("报告下载", `${escapeHtml(reportFormatLabel(format))} 已开始下载。`, "green");
  } catch (error) {
    if (!reportDownloadStillCurrent(interviewId)) return;
    if (gatewayAuthError(error)) {
      showGatewayKeyRequired("报告下载");
    } else {
      appendEvent("报告下载失败", escapeHtml(errorText(error)), "red");
    }
  } finally {
    state.reportDownloadInFlight.delete(downloadKey);
    if (button && reportLinks.contains(button)) {
      button.disabled = false;
      setButtonBusy(button, false);
      button.textContent = originalLabel || reportFormatLabel(format);
      button.title = originalTitle;
    }
  }
}

function reportFilename(interviewId, format) {
  if (format === "pdf") return `${interviewId}.pdf`;
  if (format === "transcript.json") return `${interviewId}.transcript.json`;
  return `${interviewId}.report.${format}`;
}

function reportFormatLabel(format) {
  return {
    html: "HTML",
    pdf: "PDF",
    json: "JSON",
    "transcript.json": "转写",
  }[format] || format;
}


export {
  clearQueuedReportPolling,
  downloadReportArtifact,
  markReportReady,
  recommendationLabel,
  refreshQueuedReport,
  renderQueuedReportState,
  renderReport,
  reportDownloadStillCurrent,
  reportEvidenceRows,
  reportFilename,
  reportFormatLabel,
  reportInterviewId,
  reportPendingError,
  reportRecommendationText,
  reportRefreshStillCurrent,
  reportSummaryText,
  reportTotalScoreText,
  scheduleQueuedReportPolling,
};

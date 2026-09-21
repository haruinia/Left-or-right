import { answerText, chainCount, chainList, competencyList, currentQuestion, currentQuestionMeta, currentQuestionText, deleteCandidateMemory, examPanel, examStatus, memoryActionStatus, memoryCount, memoryList, probeCount, probeList, scanRepoMemory } from './dom.js';
import { errorText, fetchGateway, fetchGatewayJson } from './gateway.js';
import { state } from './state.js';
import { appendEvent, escapeHtml, setButtonBusy, updateTextCounters } from './ui.js';

function setMemoryActionStatus(text, tone = "") {
  if (!memoryActionStatus) return;
  memoryActionStatus.textContent = text;
  memoryActionStatus.classList.remove("warn", "success");
  if (tone) memoryActionStatus.classList.add(tone);
}

// The delete endpoint is keyed on the candidate, so it only makes sense once a
// session exists. Consent covers writing the memories; deleting them is always
// allowed.
function syncMemoryActions() {
  if (!deleteCandidateMemory || !scanRepoMemory) return;
  deleteCandidateMemory.disabled =
    state.scanningRepoMemory || state.deletingCandidateMemory || !state.candidate;
  scanRepoMemory.disabled = state.scanningRepoMemory || state.deletingCandidateMemory;
  setButtonBusy(scanRepoMemory, state.scanningRepoMemory);
  setButtonBusy(deleteCandidateMemory, state.deletingCandidateMemory);
}

// Scans only the roots the backend allows: resolve_repo_path() refuses anything
// outside MEMORY_REPO_ROOTS, and refuses everything when it is unset.
async function scanRepoMemories() {
  if (state.scanningRepoMemory) return;
  state.scanningRepoMemory = true;
  syncMemoryActions();
  setMemoryActionStatus("正在扫描本地项目库…");
  try {
    const result = await fetchGatewayJson("/api/memory/repos/scan", {
      method: "POST",
      timeoutMs: 60000,
    });
    const scanned = (result && result.scanned) || {};
    const entries = Object.entries(scanned);
    const total = entries.reduce((sum, [, count]) => sum + (Number(count) || 0), 0);
    if (!entries.length) {
      setMemoryActionStatus("没有可扫描的仓库：请先配置 MEMORY_REPO_ROOTS。", "warn");
      appendEvent("项目库记忆", "未配置 MEMORY_REPO_ROOTS，后端拒绝扫描任意路径。", "amber");
      return;
    }
    setMemoryActionStatus(`已扫描 ${entries.length} 个仓库，写入 ${total} 条记忆。`, "success");
    appendEvent(
      "项目库记忆",
      entries.map(([repo, count]) => `${escapeHtml(repo)}：${Number(count) || 0} 条`).join("<br>"),
      "green"
    );
  } catch (error) {
    const reason = errorText(error);
    setMemoryActionStatus(`扫描失败：${reason}`, "warn");
    appendEvent("项目库记忆", escapeHtml(reason), "red");
  } finally {
    state.scanningRepoMemory = false;
    syncMemoryActions();
  }
}

// interview_memories holds real-person data, so this has to be reachable from the
// UI rather than only over the API. It is irreversible, hence the confirmation.
async function deleteCurrentCandidateMemories() {
  if (state.deletingCandidateMemory || !state.candidate) return;
  const name = state.candidate.name || state.candidate.id;
  if (!window.confirm(`删除「${name}」的全部跨面试记忆？此操作不可恢复。`)) return;
  state.deletingCandidateMemory = true;
  syncMemoryActions();
  setMemoryActionStatus("正在删除该候选人的跨面试记忆…");
  try {
    const response = await fetchGateway(
      `/api/memory/candidates/${encodeURIComponent(state.candidate.id)}`,
      { method: "DELETE", timeoutMs: 15000 }
    );
    const result = await response.json();
    const deleted = Number(result && result.deleted) || 0;
    setMemoryActionStatus(`已删除 ${deleted} 条跨面试记忆。`, "success");
    appendEvent("长期记忆", `已删除「${escapeHtml(name)}」的 ${deleted} 条跨面试记忆。`, "green");
    renderMemoryHits([]);
  } catch (error) {
    const reason = errorText(error);
    setMemoryActionStatus(`删除失败：${reason}`, "warn");
    appendEvent("长期记忆", escapeHtml(reason), "red");
  } finally {
    state.deletingCandidateMemory = false;
    syncMemoryActions();
  }
}

function renderCompetencies(job) {
  const items = job.competency_model.items || [];
  if (!items.length) {
    competencyList.innerHTML = '<div class="empty">暂无能力维度</div>';
    return;
  }
  competencyList.innerHTML = items
    .map(
      (item, index) => `
        <div class="dimension">
          <div class="dimension-top">
            <h3>${escapeHtml(item.name)}</h3>
            <span class="tag">${Math.round(Number(item.weight || 0) * 100)}%</span>
          </div>
          <p>${escapeHtml(item.description)}</p>
          <button class="secondary" type="button" data-seed-question="${index}" title="把该能力维度生成当前面试问题" aria-label="生成${escapeHtml(item.name)}维度的面试问题">生成此维度问题</button>
        </div>
      `
    )
    .join("");
  competencyList.querySelectorAll("[data-seed-question]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = items[Number(button.dataset.seedQuestion)];
      const question = seedQuestionFor(item);
      selectQuestion(question, {
        questionSource: "interviewer",
        probeTarget: item.name,
        competency: item.name,
      });
    });
  });
  renderProbeCards(
    items.slice(0, 3).map((item, index) => ({
      priority: index + 1,
      question: seedQuestionFor(item),
      target: "建立候选方向",
      competency: item.name,
    }))
  );
}

function seedQuestionFor(item) {
  const pattern = item.probe_patterns && item.probe_patterns[0];
  return (
    pattern ||
    `围绕「${item.name}」，请候选人讲一个真实项目细节：本人负责哪一段、为什么这样设计、遇到什么异常、最后指标如何变化？`
  );
}

function renderProbeCards(suggestions = []) {
  probeCount.textContent = `${suggestions.length} 条`;
  if (!suggestions.length) {
    probeList.innerHTML = '<div class="empty">候选人回答后显示可点击的专业追问</div>';
    return;
  }
  probeList.innerHTML = suggestions
    .map(
      (item, index) => `
	              <div class="probe-card">
	                <div class="probe-top">
	                  <span class="tag amber">P${escapeHtml(item.priority || index + 1)}</span>
	                  <span class="tag blue">${escapeHtml(item.competency)}</span>
	                  ${item.chain_label ? `<span class="tag">${escapeHtml(item.chain_label)}</span>` : ""}
	                </div>
	                <h3>${escapeHtml(item.question)}</h3>
          <p>${escapeHtml(item.target)}</p>
          <button class="secondary" type="button" data-probe-index="${index}" title="将此追问填入当前面试问题" aria-label="将此追问设为下一问">设为下一问</button>
        </div>
      `
    )
    .join("");
  probeList.querySelectorAll("[data-probe-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = suggestions[Number(button.dataset.probeIndex)];
      selectQuestion(item.question, {
	              questionSource: "ai_probe",
	              probeTarget: item.target,
	              probeChainId: item.chain_id || null,
	              competency: item.competency,
	            });
    });
  });
}

function renderMemoryHits(items = []) {
  memoryCount.textContent = `${items.length} 条`;
  if (!items.length) {
    memoryList.innerHTML =
      '<div class="empty">开启记忆层后，这里显示本地项目库与历史面试的对照线索</div>';
    return;
  }
  memoryList.innerHTML = items
    .map((item) => {
      const score = Number(item.score || 0).toFixed(2);
      return `
        <div class="probe-card">
          <div class="probe-top">
            <span class="tag blue">${escapeHtml(item.kind)}</span>
            <span class="tag amber">相似度 ${escapeHtml(score)}</span>
          </div>
          <h3>${escapeHtml(item.subject)}</h3>
          <p>${escapeHtml(item.summary)}</p>
          ${item.detail ? `<p>${escapeHtml(item.detail)}</p>` : ""}
          ${item.origin ? `<p>来源：${escapeHtml(item.origin)}</p>` : ""}
        </div>
      `;
    })
    .join("");
}

const examDockStatus = document.querySelector("#examDockStatus");
const examDockPanel = document.querySelector("#examDockPanel");

function paintExam(statusText, html) {
  examStatus.textContent = statusText;
  examPanel.innerHTML = html;
  if (examDockStatus) examDockStatus.textContent = statusText;
  if (examDockPanel) examDockPanel.innerHTML = html;
}

function renderExamSolution(solution) {
  const keyPoints = Array.isArray(solution.key_points) ? solution.key_points : [];
  const pitfalls = Array.isArray(solution.pitfalls) ? solution.pitfalls : [];
  const sourceLabel = solution.source === "vision" ? "多模态识图" : "OCR 文本";
  paintExam(
    sourceLabel,
    `
    <div class="report-box">
      <h3>${escapeHtml(solution.question_summary)}</h3>
      ${
        keyPoints.length
          ? `<p><strong>评分要点</strong></p><ul>${keyPoints
              .map((point) => `<li>${escapeHtml(point)}</li>`)
              .join("")}</ul>`
          : ""
      }
      ${solution.reference_answer ? `<p><strong>参考答案</strong>：${escapeHtml(solution.reference_answer)}</p>` : ""}
      ${
        pitfalls.length
          ? `<p><strong>常见坑</strong></p><ul>${pitfalls
              .map((item) => `<li>${escapeHtml(item)}</li>`)
              .join("")}</ul>`
          : ""
      }
      ${solution.warning ? `<p>${escapeHtml(solution.warning)}</p>` : ""}
    </div>
  `
  );
}

function renderExamStatus(event) {
  if (event.status === "capturing") {
    paintExam("截图中", '<div class="empty">请在屏幕上框选要发送的问题</div>');
    appendEvent("截图", "请框选要发送的问题");
    return;
  }
  if (event.status === "solving") {
    paintExam("解析中", '<div class="empty">正在解析截图，请稍候</div>');
    appendEvent("截图", "正在解析截图，解析后会作为对话问题发送。");
    return;
  }
  if (event.status === "error") {
    paintExam("失败", `<div class="empty">${escapeHtml(event.detail || event.message || "截图出题失败")}</div>`);
    appendEvent("截图", escapeHtml(event.detail || event.message || "截图出题失败"), "red");
    return;
  }
  if (event.status === "ready" && event.solution) {
    renderExamSolution(event.solution);
  }
}

function renderProbeChains(chains = []) {
  chainCount.textContent = `${chains.length} 条`;
  if (!chains.length) {
    chainList.innerHTML = '<div class="empty">追问链会随回答实时更新</div>';
    return;
  }
  chainList.innerHTML = chains
    .map((chain, index) => {
      const links = Array.isArray(chain.links) ? chain.links : [];
      const tone =
        chain.verdict === "cracked" ? "red" : chain.verdict === "held_up" ? "blue" : "amber";
      return `
        <div class="probe-card">
          <div class="probe-top">
            <span class="tag blue">链 #${index + 1}</span>
            <span class="tag ${tone}">${escapeHtml(chain.verdict)}</span>
          </div>
          <h3>${escapeHtml(chain.topic)}</h3>
          <p>${escapeHtml(chain.origin)} · ${links.length} 层${chain.crack_depth ? ` · 第 ${escapeHtml(chain.crack_depth)} 层露馅` : ""}</p>
        </div>
      `;
    })
    .join("");
}

function selectQuestion(question, meta = {}) {
  currentQuestion.value = question;
  currentQuestionText.textContent = question;
  currentQuestionMeta.textContent = meta.competency || "自定义";
  state.currentQuestionOption = null;
  answerText.value = "";
  updateTextCounters();
  state.selectedQuestionSource = meta.questionSource || "interviewer";
  state.selectedProbeTarget = meta.probeTarget || null;
  state.selectedProbeChainId = meta.probeChainId || null;
  state.selectedCompetency = meta.competency || null;
  appendEvent(
    "下一问",
    `${escapeHtml(question)}<br><span class="small">${escapeHtml(meta.competency || "自定义问题")}</span>`
  );
  answerText.focus();
}

function resetQuestionMetaForManualEdit() {
  const hadProbeMeta =
    state.selectedQuestionSource !== "interviewer" ||
    state.selectedProbeTarget ||
    state.selectedProbeChainId ||
    state.selectedCompetency;
  state.selectedQuestionSource = "interviewer";
  state.selectedProbeTarget = null;
  state.selectedProbeChainId = null;
  state.selectedCompetency = null;
  state.currentQuestionOption = null;
  if (hadProbeMeta) {
    appendEvent("下一问", "已改为手动编辑问题，将按面试官自定义问题记录。");
  }
}

function prepareSessionStillCurrent(token) {
  return token === state.prepareSessionToken;
}


export {
  deleteCurrentCandidateMemories,
  prepareSessionStillCurrent,
  renderCompetencies,
  renderExamSolution,
  renderExamStatus,
  renderMemoryHits,
  renderProbeCards,
  renderProbeChains,
  resetQuestionMetaForManualEdit,
  scanRepoMemories,
  seedQuestionFor,
  selectQuestion,
  setMemoryActionStatus,
  syncMemoryActions,
};

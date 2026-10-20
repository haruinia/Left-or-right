// 学习资产管理：会话记录 / 知识库 / 回答反馈的查看、导入、导出。
// 数据全部来自 localStorage（桌面端写入），本模块只负责读取与操作。
import {
  listSessionRecords,
  deleteSessionRecord,
  exportSessionRecordsAsMarkdown,
} from "./session-store.js";
import {
  importSessionRecords,
  listKnowledgeItems,
  listTags,
  deleteKnowledgeItem,
  markReviewed,
  exportKnowledgeBaseAsMarkdown,
  getKBStats,
} from "./knowledge-base.js";
import {
  getFeedbackStats,
  exportFeedbackAsMarkdown,
} from "./feedback-store.js";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const tabs = document.querySelector("#assetTabs");
const panes = {
  records: document.querySelector("#assetRecords"),
  kb: document.querySelector("#assetKB"),
  feedback: document.querySelector("#assetFeedback"),
};
if (!tabs || !panes.records) {
  // 设置页没有资产板块时（旧版本），本模块静默退出。
} else {
  initAssets();
}

function initAssets() {
  // 页签切换
  tabs.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-asset-tab]");
    if (!tab) return;
    tabs.querySelectorAll(".asset-tab").forEach((t) => t.classList.toggle("is-active", t === tab));
    Object.entries(panes).forEach(([key, pane]) => { pane.hidden = key !== tab.dataset.assetTab; });
    renderAll();
  });

  initRecords();
  initKB();
  initFeedback();
  renderAll();
}

function renderAll() {
  renderRecords();
  renderKB();
  renderFeedback();
}

// ===== 会话记录 =====
const recordsList = document.querySelector("#recordsList");

function initRecords() {
  document.querySelector("#recordsExport")?.addEventListener("click", () => exportSessionRecordsAsMarkdown());
  recordsList?.addEventListener("click", (event) => {
    const deleteId = event.target.closest("[data-delete]")?.dataset.delete;
    const viewId = event.target.closest("[data-view]")?.dataset.view;
    if (deleteId && confirm("确定删除这条会话记录吗？")) {
      deleteSessionRecord(deleteId);
      renderRecords();
    }
    if (viewId) {
      const record = listSessionRecords().find((r) => r.id === viewId);
      if (record) renderRecordDetail(record);
    }
  });
}

function renderRecords() {
  if (!recordsList) return;
  const records = listSessionRecords();
  if (!records.length) {
    recordsList.innerHTML = '<p class="asset-empty">还没有保存的会话记录。在桌面端点「新对话」时会自动保存当前会话。</p>';
    return;
  }
  recordsList.innerHTML = records.map((record) => {
    const date = new Date(record.startedAt).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const preview = record.turns[0]?.text?.slice(0, 60) || record.note || "（截图题）";
    return `
      <article class="asset-item" data-id="${escapeHtml(record.id)}">
        <header>
          <time>${escapeHtml(date)}</time>
          <span class="asset-count">${record.turnCount} 轮</span>
        </header>
        <p class="asset-preview">${escapeHtml(preview)}${preview.length >= 60 ? "…" : ""}</p>
        <footer>
          <button type="button" class="secondary" data-view="${escapeHtml(record.id)}">查看</button>
          <button type="button" class="secondary" data-delete="${escapeHtml(record.id)}">删除</button>
        </footer>
      </article>
    `;
  }).join("");
}

function renderRecordDetail(record) {
  recordsList.innerHTML = `
    <article class="asset-detail">
      <header>
        <button type="button" class="secondary" id="assetBack">← 返回列表</button>
        <time>${new Date(record.startedAt).toLocaleString("zh-CN")}</time>
      </header>
      ${record.note ? `<p class="asset-note">备注：${escapeHtml(record.note)}</p>` : ""}
      <div class="asset-turns">
        ${record.turns.map((turn) => `
          <div class="asset-turn is-${turn.role}">
            <strong>${turn.role === "user" ? "问" : "答"}</strong>
            ${turn.images && turn.images.length ? `
              <div class="asset-gallery">
                ${turn.images.map((img) => `<img src="${escapeHtml(img)}" alt="截图" />`).join("")}
              </div>
            ` : ""}
            <p>${escapeHtml(turn.text)}</p>
            ${turn.imageCount ? `<span class="asset-images">（含 ${turn.imageCount} 张截图）</span>` : ""}
          </div>
        `).join("")}
      </div>
    </article>
  `;
  document.querySelector("#assetBack")?.addEventListener("click", renderRecords);
}

// ===== 知识库 =====
const kbList = document.querySelector("#kbList");
const kbTags = document.querySelector("#kbTags");
const kbStats = document.querySelector("#kbStats");
const kbSearch = document.querySelector("#kbSearch");
let currentKBTag = "";

function initKB() {
  document.querySelector("#kbExport")?.addEventListener("click", () => exportKnowledgeBaseAsMarkdown());
  document.querySelector("#kbImport")?.addEventListener("click", () => {
    const records = listSessionRecords();
    if (!records.length) {
      alert("没有可导入的会话记录。");
      return;
    }
    const imported = importSessionRecords(records);
    alert(`已从会话记录导入 ${imported} 条知识。`);
    renderKB();
  });
  kbTags?.addEventListener("click", (event) => {
    const tag = event.target.closest("[data-tag]")?.dataset.tag;
    if (tag !== undefined) {
      currentKBTag = tag;
      renderKB();
    }
  });
  kbSearch?.addEventListener("input", () => renderKBList());
  kbList?.addEventListener("click", (event) => {
    const reviewId = event.target.closest("[data-review]")?.dataset.review;
    const deleteId = event.target.closest("[data-delete-kb]")?.dataset.deleteKb;
    if (reviewId) {
      markReviewed(reviewId);
      renderKBStats();
    }
    if (deleteId && confirm("确定删除这条知识吗？")) {
      deleteKnowledgeItem(deleteId);
      renderKB();
    }
  });
}

function renderKB() {
  renderKBStats();
  renderKBTags();
  renderKBList();
}

function renderKBStats() {
  if (!kbStats) return;
  const stats = getKBStats();
  kbStats.innerHTML = `<span>共 ${stats.totalItems} 条</span><span>${stats.totalTags} 个标签</span><span>已复习 ${stats.reviewedItems} 条</span>`;
}

function renderKBTags() {
  if (!kbTags) return;
  const tags = listTags();
  kbTags.innerHTML = `
    <button type="button" class="asset-tag ${!currentKBTag ? "is-active" : ""}" data-tag="">全部</button>
    ${tags.map(({ tag, count }) => `
      <button type="button" class="asset-tag ${currentKBTag === tag ? "is-active" : ""}" data-tag="${escapeHtml(tag)}">
        ${escapeHtml(tag)} <span class="asset-tag-count">${count}</span>
      </button>
    `).join("")}
  `;
}

function renderKBList() {
  if (!kbList) return;
  const search = kbSearch?.value?.trim() || "";
  const items = listKnowledgeItems({ tag: currentKBTag || undefined, search });
  if (!items.length) {
    kbList.innerHTML = '<p class="asset-empty">知识库为空。点「从会话导入」把历史会话沉淀为可检索的知识。</p>';
    return;
  }
  kbList.innerHTML = items.map((item) => `
    <article class="asset-item" data-id="${escapeHtml(item.id)}">
      <header>
        <div class="asset-item-tags">
          ${item.tags.map((t) => `<span class="asset-tag-small">${escapeHtml(t)}</span>`).join("")}
        </div>
        <time>${new Date(item.createdAt).toLocaleDateString("zh-CN")}</time>
      </header>
      <p class="asset-question">${escapeHtml(item.question.slice(0, 120))}${item.question.length > 120 ? "…" : ""}</p>
      <details class="asset-answer">
        <summary>查看解答</summary>
        <p>${escapeHtml(item.answer.slice(0, 500))}${item.answer.length > 500 ? "…" : ""}</p>
      </details>
      <footer>
        <button type="button" class="secondary" data-review="${escapeHtml(item.id)}">复习 +1</button>
        <button type="button" class="secondary" data-delete-kb="${escapeHtml(item.id)}">删除</button>
      </footer>
    </article>
  `).join("");
}

// ===== 回答反馈 =====
const feedbackStats = document.querySelector("#feedbackStats");
const feedbackList = document.querySelector("#feedbackList");

function initFeedback() {
  document.querySelector("#feedbackExport")?.addEventListener("click", () => exportFeedbackAsMarkdown());
}

function renderFeedback() {
  if (!feedbackStats || !feedbackList) return;
  const stats = getFeedbackStats();
  feedbackStats.innerHTML = `
    <span>共 ${stats.total} 条反馈</span>
    <span>👍 ${stats.up}</span>
    <span>👎 ${stats.down}</span>
    <span>好评率 ${stats.upRate}%</span>
  `;
  if (!stats.total) {
    feedbackList.innerHTML = '<p class="asset-empty">还没有反馈记录。在桌面端对回答点 👍/👎 后会显示在这里。</p>';
    return;
  }
  // 简化展示：只显示负面反馈（用于改进），正面反馈体现在统计里
  import("./feedback-store.js").then(({ listRecentNegativeFeedback }) => {
    const negatives = listRecentNegativeFeedback(50);
    if (!negatives.length) {
      feedbackList.innerHTML = '<p class="asset-empty">没有负面反馈，回答质量良好。</p>';
      return;
    }
    feedbackList.innerHTML = negatives.map((item) => `
      <article class="asset-item">
        <header>
          <span class="asset-tag-small">👎 无用</span>
          <time>${new Date(item.timestamp).toLocaleString("zh-CN")}</time>
        </header>
        ${item.questionText ? `<p class="asset-question">${escapeHtml(item.questionText.slice(0, 120))}</p>` : ""}
        <details class="asset-answer">
          <summary>查看回答</summary>
          <p>${escapeHtml(item.answerText.slice(0, 500))}${item.answerText.length > 500 ? "…" : ""}</p>
        </details>
        ${item.model ? `<footer><span class="asset-tag-small">${escapeHtml(item.model)}</span></footer>` : ""}
      </article>
    `).join("");
  });
}

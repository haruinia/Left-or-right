// 学习记录与知识库的查看、导入、导出。
// 通过共享本地服务读取，桌面端与设置中心使用同一份持久化数据。
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
  listExamRecords,
  deleteExamRecord,
  exportExamRecordsAsMarkdown,
} from "./exam-store.js";

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
  exams: document.querySelector("#assetExams"),
};
function showError(target, error) {
  if (!target) return;
  let notice = target.querySelector(".asset-error");
  if (!notice) {
    notice = document.createElement("p");
    notice.className = "asset-error";
    notice.setAttribute("role", "alert");
    target.prepend(notice);
  }
  notice.textContent = error.message || "学习资产操作失败，请重试。";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "secondary";
  retry.textContent = "重新读取";
  retry.addEventListener("click", renderAll);
  notice.append(" ", retry);
}

function action(target, callback) {
  return async (event) => {
    try {
      target?.querySelector(".asset-error")?.remove();
      await callback(event);
    } catch (error) { showError(target, error); }
  };
}

function initAssets() {
  // 页签切换
  tabs.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-asset-tab]");
    if (!tab) return;
    tabs.querySelectorAll(".asset-tab").forEach((t) => {
      t.classList.toggle("is-active", t === tab);
      t.setAttribute("aria-pressed", String(t === tab));
    });
    Object.entries(panes).forEach(([key, pane]) => { pane.hidden = key !== tab.dataset.assetTab; });
    renderAll();
  });

  initRecords();
  initKB();
  initExams();
  renderAll();
}

function renderAll() {
  return Promise.all([
    action(panes.records, renderRecords)(),
    action(panes.kb, renderKB)(),
    action(panes.exams, renderExams)(),
  ]);
}

// ===== 会话记录 =====
const recordsList = document.querySelector("#recordsList");

function initRecords() {
  document.querySelector("#recordsExport")?.addEventListener("click", action(panes.records, exportSessionRecordsAsMarkdown));
  recordsList?.addEventListener("click", action(panes.records, async (event) => {
    const deleteId = event.target.closest("[data-delete]")?.dataset.delete;
    const viewId = event.target.closest("[data-view]")?.dataset.view;
    if (deleteId && confirm("确定删除这条会话记录吗？")) {
      await deleteSessionRecord(deleteId);
      await renderRecords();
    }
    if (viewId) {
      const record = (await listSessionRecords()).find((r) => r.id === viewId);
      if (record) renderRecordDetail(record);
    }
  }));
}

async function renderRecords() {
  if (!recordsList) return;
  const records = await listSessionRecords();
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
          <div class="asset-turn is-${turn.role === "user" ? "user" : "assistant"}">
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
  document.querySelector("#assetBack")?.addEventListener("click", action(panes.records, renderRecords));
}

// ===== 知识库 =====
const kbList = document.querySelector("#kbList");
const kbTags = document.querySelector("#kbTags");
const kbStats = document.querySelector("#kbStats");
const kbSearch = document.querySelector("#kbSearch");
let currentKBTag = "";
let kbListEpoch = 0;

function initKB() {
  document.querySelector("#kbExport")?.addEventListener("click", action(panes.kb, exportKnowledgeBaseAsMarkdown));
  document.querySelector("#kbImport")?.addEventListener("click", action(panes.kb, async () => {
    const records = await listSessionRecords();
    if (!records.length) {
      alert("没有可导入的会话记录。");
      return;
    }
    const imported = await importSessionRecords(records);
    alert(`已从会话记录导入 ${imported} 条知识。`);
    await renderKB();
  }));
  kbTags?.addEventListener("click", action(panes.kb, async (event) => {
    const tag = event.target.closest("[data-tag]")?.dataset.tag;
    if (tag !== undefined) {
      currentKBTag = tag;
      await renderKB();
    }
  }));
  kbSearch?.addEventListener("input", action(panes.kb, renderKBList));
  kbList?.addEventListener("click", action(panes.kb, async (event) => {
    const reviewId = event.target.closest("[data-review]")?.dataset.review;
    const deleteId = event.target.closest("[data-delete-kb]")?.dataset.deleteKb;
    if (reviewId) {
      await markReviewed(reviewId);
      await renderKBStats();
    }
    if (deleteId && confirm("确定删除这条知识吗？")) {
      await deleteKnowledgeItem(deleteId);
      await renderKB();
    }
  }));
}

async function renderKB() {
  await Promise.all([renderKBStats(), renderKBTags(), renderKBList()]);
}

async function renderKBStats() {
  if (!kbStats) return;
  const stats = await getKBStats();
  kbStats.innerHTML = `<span>共 ${stats.totalItems} 条</span><span>${stats.totalTags} 个标签</span><span>已复习 ${stats.reviewedItems} 条</span>`;
}

async function renderKBTags() {
  if (!kbTags) return;
  const tags = await listTags();
  kbTags.innerHTML = `
    <button type="button" class="asset-tag ${!currentKBTag ? "is-active" : ""}" data-tag="">全部</button>
    ${tags.map(({ tag, count }) => `
      <button type="button" class="asset-tag ${currentKBTag === tag ? "is-active" : ""}" data-tag="${escapeHtml(tag)}">
        ${escapeHtml(tag)} <span class="asset-tag-count">${count}</span>
      </button>
    `).join("")}
  `;
}

async function renderKBList() {
  if (!kbList) return;
  const epoch = ++kbListEpoch;
  const search = kbSearch?.value?.trim() || "";
  const items = await listKnowledgeItems({ tag: currentKBTag || undefined, search });
  if (epoch !== kbListEpoch) return;
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

// ===== 笔试记录 =====
const examsList = document.querySelector("#examsList");

function initExams() {
  document.querySelector("#examsExport")?.addEventListener("click", action(panes.exams, exportExamRecordsAsMarkdown));
  examsList?.addEventListener("click", action(panes.exams, async (event) => {
    const deleteId = event.target.closest("[data-delete-exam]")?.dataset.deleteExam;
    const viewId = event.target.closest("[data-view-exam]")?.dataset.viewExam;
    if (deleteId && confirm("确定删除这条笔试记录吗？")) {
      await deleteExamRecord(deleteId);
      await renderExams();
    }
    if (viewId) {
      const record = (await listExamRecords()).find((r) => r.id === viewId);
      if (record) renderExamDetail(record);
    }
  }));
}

async function renderExams() {
  if (!examsList) return;
  const records = await listExamRecords();
  if (!records.length) {
    examsList.innerHTML = '<p class="asset-empty">还没有笔试记录。桌面端每次截图提问都会自动保存题目和回答。</p>';
    return;
  }
  examsList.innerHTML = records.map((record) => {
    const date = new Date(record.createdAt).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const preview = record.answer.replace(/[#*`>]/g, "").slice(0, 80) || "（截图题）";
    return `
      <article class="asset-item" data-id="${escapeHtml(record.id)}">
        <header>
          <time>${escapeHtml(date)}</time>
          <span class="asset-count">${record.imageCount ? `${record.imageCount} 图` : ""}${record.partial ? " · 中断" : ""}</span>
        </header>
        <p class="asset-preview">${escapeHtml(preview)}${preview.length >= 80 ? "…" : ""}</p>
        <footer>
          <button type="button" class="secondary" data-view-exam="${escapeHtml(record.id)}">查看</button>
          <button type="button" class="secondary" data-delete-exam="${escapeHtml(record.id)}">删除</button>
        </footer>
      </article>
    `;
  }).join("");
}

function renderExamDetail(record) {
  examsList.innerHTML = `
    <article class="asset-detail">
      <header>
        <button type="button" class="secondary" id="examsBack">← 返回列表</button>
        <time>${new Date(record.createdAt).toLocaleString("zh-CN")}</time>
      </header>
      ${record.model ? `<p class="asset-note">模型：${escapeHtml(record.model)}${record.partial ? "（回答中断）" : ""}</p>` : ""}
      ${record.images && record.images.length ? `
        <div class="asset-gallery">
          ${record.images.map((img) => `<img src="${escapeHtml(img)}" alt="题图" />`).join("")}
        </div>
      ` : ""}
      <div class="asset-turns">
        ${record.query ? `<div class="asset-turn is-user"><strong>问</strong><p>${escapeHtml(record.query)}</p></div>` : ""}
        <div class="asset-turn is-assistant"><strong>答</strong><p>${escapeHtml(record.answer)}</p></div>
      </div>
    </article>
  `;
  document.querySelector("#examsBack")?.addEventListener("click", action(panes.exams, renderExams));
}

// Initialize after every DOM reference and state binding is ready (avoid TDZ on import).
if (tabs && panes.records) initAssets();

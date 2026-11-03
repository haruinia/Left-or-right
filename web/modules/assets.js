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
    const epoch = routeEpoch;
    try {
      target?.querySelector(".asset-error")?.remove();
      await callback(event);
    } catch (error) { if (epoch === routeEpoch) showError(target, error); }
  };
}

let routeEpoch = 0;
let renderedRoute = "";
let closeDialog = () => {};
let dialogRevision = 0;

function assetRoute() {
  const [section, tab, id] = location.hash.slice(1).split("/");
  let recordId = "";
  try { recordId = decodeURIComponent(id || ""); } catch { /* Invalid links fall back to the list. */ }
  return { section, tab: Object.hasOwn(panes, tab) ? tab : "exams", id: recordId };
}

function navigateAssets(tab, id = "", replace = false) {
  const target = `#assets/${tab}${id ? `/${encodeURIComponent(id)}` : ""}`;
  if (location.hash === target) return;
  history.replaceState({ ...history.state, assetScroll: window.scrollY, ...(id ? { assetFocus: id } : {}) }, "");
  history[replace ? "replaceState" : "pushState"]({ assetScroll: 0, assetParent: id ? location.hash : null }, "", target);
  window.dispatchEvent(new Event("settings:navigate"));
}

function backToList() {
  const { tab } = assetRoute();
  const parent = history.state?.assetParent;
  if (parent === `#assets/${tab}` || (tab === "exams" && parent === "#assets")) history.back();
  else navigateAssets(tab, "", true);
}

function initAssets() {
  history.scrollRestoration = "manual";
  tabs.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-asset-tab]");
    if (tab) navigateAssets(tab.dataset.assetTab);
  });
  document.querySelector("#assets").addEventListener("click", (event) => {
    const image = event.target.closest("[data-preview-image]");
    if (image) previewImages(image);
    if (event.target.closest("[data-asset-back]")) backToList();
  });
  for (const name of ["hashchange", "popstate", "settings:navigate"]) {
    window.addEventListener(name, renderAll);
  }
  window.addEventListener("scroll", () => {
    if (renderedRoute === location.hash && assetRoute().section === "assets") {
      history.replaceState({ ...history.state, assetScroll: window.scrollY }, "");
    }
  }, { passive: true });
  const dismiss = () => { dialogRevision += 1; closeDialog(); };
  window.addEventListener("app:privacy-hidden", dismiss);
  document.addEventListener("visibilitychange", () => { if (document.hidden) dismiss(); });
  initRecords();
  initKB();
  initExams();
  renderAll();
}

async function renderAll() {
  const epoch = ++routeEpoch;
  renderedRoute = "";
  dialogRevision += 1;
  closeDialog();
  const route = assetRoute();
  if (route.section !== "assets") return;
  tabs.querySelectorAll(".asset-tab").forEach((tab) => {
    const active = tab.dataset.assetTab === route.tab;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-pressed", String(active));
  });
  Object.entries(panes).forEach(([key, pane]) => { pane.hidden = key !== route.tab; });
  const scroll = history.state?.assetScroll || 0;
  await action(panes[route.tab], { records: renderRecords, exams: renderExams, kb: renderKB }[route.tab])();
  if (epoch !== routeEpoch) return;
  const back = panes[route.tab].querySelector("[data-asset-back]");
  const origin = [...panes[route.tab].querySelectorAll("[data-id]")].find(item => item.dataset.id === history.state?.assetFocus);
  (back || origin?.querySelector(".asset-preview-link"))?.focus({ preventScroll: true });
  window.scrollTo({ top: scroll, behavior: "instant" });
  renderedRoute = location.hash;
}

function gallery(images, label) {
  return `<div class="asset-gallery">${(images || []).filter(image => /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(image)).map((image, index) =>
    `<button type="button" class="asset-image" data-preview-image aria-label="放大${label} ${index + 1}"><img src="${escapeHtml(image)}" alt="${label} ${index + 1}" loading="lazy" /></button>`
  ).join("")}</div>`;
}

function openDialog(content, className = "") {
  closeDialog();
  const previous = document.activeElement;
  const dialog = document.createElement("dialog");
  dialog.className = `asset-dialog ${className}`;
  dialog.innerHTML = content;
  dialog.setAttribute("aria-labelledby", "assetDialogTitle");
  document.body.append(dialog);
  const close = () => {
    if (!dialog.isConnected) return;
    dialog.close();
    dialog.remove();
    if (previous?.isConnected) previous.focus({ preventScroll: true });
    if (closeDialog === close) closeDialog = () => {};
  };
  closeDialog = close;
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  dialog.addEventListener("click", event => {
    if (event.target === dialog || event.target.closest("[data-dialog-close]")) close();
  });
  dialog.showModal();
  return { dialog, close };
}

function confirmAction(message) {
  return new Promise(resolve => {
    const { dialog, close } = openDialog(`<h2 id="assetDialogTitle">${escapeHtml(message)}</h2><div class="asset-dialog-actions"><button type="button" class="secondary" data-dialog-close autofocus>取消</button><button type="button" data-confirm>确定删除</button></div>`);
    let accepted = false;
    dialog.addEventListener("close", () => resolve(accepted), { once: true });
    dialog.querySelector("[data-confirm]").addEventListener("click", () => { accepted = true; close(); });
  });
}

function showNotice(message) {
  openDialog(`<h2 id="assetDialogTitle">${escapeHtml(message)}</h2><div class="asset-dialog-actions"><button type="button" data-dialog-close autofocus>知道了</button></div>`);
}

function previewImages(button) {
  const buttons = [...button.closest(".asset-gallery").querySelectorAll("[data-preview-image]")];
  let index = buttons.indexOf(button);
  const { dialog } = openDialog(`<header><h2 id="assetDialogTitle">图片预览</h2><button type="button" class="secondary" data-dialog-close autofocus>关闭</button></header><div class="asset-image-stage"><img alt="" /></div><p class="asset-image-error" role="status" hidden>图片无法读取。</p><footer><button type="button" class="secondary" data-image-prev>上一张</button><span data-image-count></span><button type="button" class="secondary" data-image-next>下一张</button><button type="button" class="secondary" data-image-zoom aria-pressed="false">放大</button></footer>`, "asset-image-dialog");
  const image = dialog.querySelector(".asset-image-stage img");
  const zoom = dialog.querySelector("[data-image-zoom]");
  const render = () => {
    const original = buttons[index].querySelector("img");
    image.src = original.src;
    image.alt = original.alt;
    dialog.querySelector("[data-image-count]").textContent = `${index + 1} / ${buttons.length}`;
    dialog.querySelector("[data-image-prev]").disabled = index === 0;
    dialog.querySelector("[data-image-next]").disabled = index === buttons.length - 1;
    dialog.querySelector(".asset-image-error").hidden = true;
    dialog.classList.remove("is-zoomed");
    zoom.setAttribute("aria-pressed", "false");
    zoom.textContent = "放大";
  };
  image.addEventListener("error", () => { dialog.querySelector(".asset-image-error").hidden = false; });
  const step = delta => { index = Math.max(0, Math.min(buttons.length - 1, index + delta)); render(); };
  dialog.querySelector("[data-image-prev]").addEventListener("click", () => step(-1));
  dialog.querySelector("[data-image-next]").addEventListener("click", () => step(1));
  dialog.addEventListener("keydown", event => {
    if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); step(event.key === "ArrowLeft" ? -1 : 1); }
  });
  zoom.addEventListener("click", () => {
    const expanded = dialog.classList.toggle("is-zoomed");
    zoom.setAttribute("aria-pressed", String(expanded));
    zoom.textContent = expanded ? "适应窗口" : "放大";
  });
  render();
}

// ===== 会话记录 =====
const recordsList = document.querySelector("#recordsList");

function initRecords() {
  document.querySelector("#recordsExport")?.addEventListener("click", action(panes.records, exportSessionRecordsAsMarkdown));
  recordsList?.addEventListener("click", action(panes.records, async (event) => {
    const deleteId = event.target.closest("[data-delete]")?.dataset.delete;
    const viewId = event.target.closest("[data-view]")?.dataset.view;
    if (deleteId && await confirmAction("确定删除这条会话记录吗？")) {
      await deleteSessionRecord(deleteId);
      await renderRecords();
    }
    if (viewId) navigateAssets("records", viewId);
    const link = event.target.closest(".asset-preview-link");
    if (link && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      navigateAssets("records", link.closest("[data-id]").dataset.id);
    }
  }));
}

async function renderRecords() {
  if (!recordsList) return;
  const epoch = routeEpoch;
  const records = await listSessionRecords();
  if (epoch !== routeEpoch) return;
  const { id } = assetRoute();
  if (id) {
    const record = records.find(item => item.id === id);
    if (record) renderRecordDetail(record);
    else recordsList.innerHTML = '<button type="button" class="secondary" data-asset-back>返回列表</button><p class="asset-empty">这条会话记录已不存在。</p>';
    return;
  }
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
        <a class="asset-preview-link" href="#assets/records/${encodeURIComponent(record.id)}">${escapeHtml(preview)}${preview.length >= 60 ? "…" : ""}</a>
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
        <button type="button" class="secondary" id="assetBack" data-asset-back>← 返回列表</button>
        <time>${new Date(record.startedAt).toLocaleString("zh-CN")}</time>
      </header>
      ${record.note ? `<p class="asset-note">备注：${escapeHtml(record.note)}</p>` : ""}
      <div class="asset-turns">
        ${record.turns.map((turn) => `
          <div class="asset-turn is-${turn.role === "user" ? "user" : "assistant"}">
            <strong>${record.kind === 'transcription' ? `${turn.source === 'mic' ? '麦克风' : '系统声音'} · ${turn.speaker === 'interviewer' ? '面试官' : '候选人'}` : turn.role === "user" ? "问" : "答"}</strong>
            ${gallery(turn.images, "截图")}
            <p>${escapeHtml(turn.text)}</p>
            ${turn.role === 'assistant' && turn.partial ? '<span class="asset-note">回答已中断，内容不完整</span>' : ''}
            ${turn.imageCount ? `<span class="asset-images">（含 ${turn.imageCount} 张截图）</span>` : ""}
          </div>
        `).join("")}
      </div>
    </article>
  `;
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
    const revision = dialogRevision;
    const records = await listSessionRecords();
    if (revision !== dialogRevision) return;
    if (!records.length) {
      showNotice("没有可导入的会话记录。");
      return;
    }
    const imported = await importSessionRecords(records);
    if (revision === dialogRevision) showNotice(`已从会话记录导入 ${imported} 条知识。`);
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
    if (deleteId && await confirmAction("确定删除这条知识吗？")) {
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
    if (deleteId && await confirmAction("确定删除这条笔试记录吗？")) {
      await deleteExamRecord(deleteId);
      await renderExams();
    }
    if (viewId) navigateAssets("exams", viewId);
    const link = event.target.closest(".asset-preview-link");
    if (link && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      navigateAssets("exams", link.closest("[data-id]").dataset.id);
    }
  }));
}

async function renderExams() {
  if (!examsList) return;
  const epoch = routeEpoch;
  const records = await listExamRecords();
  if (epoch !== routeEpoch) return;
  const { id } = assetRoute();
  if (id) {
    const record = records.find(item => item.id === id);
    if (record) renderExamDetail(record);
    else examsList.innerHTML = '<button type="button" class="secondary" data-asset-back>返回列表</button><p class="asset-empty">这条笔试记录已不存在。</p>';
    return;
  }
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
        <a class="asset-preview-link" href="#assets/exams/${encodeURIComponent(record.id)}">${escapeHtml(preview)}${preview.length >= 80 ? "…" : ""}</a>
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
        <button type="button" class="secondary" id="examsBack" data-asset-back>← 返回列表</button>
        <time>${new Date(record.createdAt).toLocaleString("zh-CN")}</time>
      </header>
      ${record.model ? `<p class="asset-note">模型：${escapeHtml(record.model)}${record.partial ? "（回答中断）" : ""}</p>` : ""}
      ${gallery(record.images, "题图")}
      <div class="asset-turns">
        ${record.query ? `<div class="asset-turn is-user"><strong>问</strong><p>${escapeHtml(record.query)}</p></div>` : ""}
        <div class="asset-turn is-assistant"><strong>答</strong><p>${escapeHtml(record.answer)}</p></div>
      </div>
    </article>
  `;
}

// Initialize after every DOM reference and state binding is ready (avoid TDZ on import).
if (tabs && panes.records) initAssets();

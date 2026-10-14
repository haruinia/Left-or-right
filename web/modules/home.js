import { formatAccelerator } from "./shortcuts.js";
import { isExamSpecialty } from "./study-presets.js";
import { fallbackGatewayOrigins, state } from "./state.js";
import {
  saveSessionRecord,
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
import { saveFeedback } from "./feedback-store.js";
import { renderMarkdown } from "./markdown.js";

const thread = document.querySelector("#liuwaThread");
const idle = document.querySelector("#liuwaIdle");
const shots = document.querySelector("#liuwaShots");
const note = document.querySelector("#liuwaNote");
const statusNode = document.querySelector("#liuwaStatus");
const hintCapture = document.querySelector("#hintCapture");
const settingsLink = document.querySelector("#liuwaSettings");
const presetNode = document.querySelector("#liuwaPreset");
const modelNode = document.querySelector("#liuwaModel");
const stopBtn = document.querySelector("#liuwaStop");
const historyBtn = document.querySelector("#liuwaHistory");
const historyPanel = document.querySelector("#liuwaHistoryPanel");
const historyList = document.querySelector("#liuwaHistoryList");
const historyClose = document.querySelector("#liuwaHistoryClose");
const historyExport = document.querySelector("#liuwaHistoryExport");
const kbBtn = document.querySelector("#liuwaKB");
const kbPanel = document.querySelector("#liuwaKBPanel");
const kbList = document.querySelector("#liuwaKBList");
const kbClose = document.querySelector("#liuwaKBClose");
const kbExport = document.querySelector("#liuwaKBExport");
const kbImport = document.querySelector("#liuwaKBImport");
const kbTags = document.querySelector("#liuwaKBTags");
const kbSearch = document.querySelector("#liuwaKBSearch");
const kbStats = document.querySelector("#liuwaKBStats");

// Follow-tail: only auto-scroll while the user is already near the bottom. Once they
// scroll up to read, new tokens must not yank them back down (Gank's 24px rule).
let stickBottom = true;
thread?.addEventListener("scroll", () => {
  stickBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight <= 24;
});
function followTail() {
  if (stickBottom && thread) thread.scrollTop = thread.scrollHeight;
}

const pending = [];
const history = [];
let streaming = false;
let nextShotId = 1;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setStatus(text) {
  if (statusNode) statusNode.textContent = text || "";
}

function syncEmpty() {
  const hasTurns = Boolean(thread && thread.querySelector(".liuwa-turn"));
  const empty = pending.length === 0 && !hasTurns;
  document.body.classList.toggle("is-empty", empty);
  if (idle) idle.hidden = !empty;
}

function renderPending() {
  if (!shots) return;
  const held = pending.some((shot) => shot.sent);
  shots.hidden = pending.length === 0;
  const caption = held ? `<p class="liuwa-shot-note">本题附图，追问会继续带上</p>` : "";
  shots.innerHTML = caption + pending
    .map(
      (shot) =>
        `<figure class="liuwa-thumb" data-shot="${escapeHtml(shot.id)}">
          <img src="${escapeHtml(shot.dataUrl)}" alt="${shot.sent ? "本题截图" : "待发送截图"}" />
          <button type="button" data-remove="${escapeHtml(shot.id)}" aria-label="去掉这张图">×</button>
        </figure>`
    )
    .join("");
  syncEmpty();
}

function addShot(dataUrl) {
  // 仅当真正在流式生成时才禁止添加截图；历史残留的 is-busy/is-stopped 样式不再阻塞。
  if (streaming) {
    setStatus("请等当前回答结束后再添加截图。");
    return;
  }
  if (!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(dataUrl)) {
    setStatus("请选择 PNG、JPEG、WebP 或 GIF 图片。");
    return;
  }
  if (pending.length >= 8) {
    setStatus("一次最多带 8 张图。");
    return;
  }
  pending.push({ id: String(nextShotId), dataUrl });
  nextShotId += 1;
  renderPending();
  setStatus(`已放入 ${pending.length} 张，发送时会一起带上。`);
}

function addShotFromBase64(mime, data) {
  const type = mime || "image/png";
  addShot(`data:${type};base64,${data}`);
}

function removeShot(id) {
  const index = pending.findIndex((shot) => shot.id === id);
  if (index < 0) return;
  pending.splice(index, 1);
  renderPending();
}

function uniqueOrigins() {
  return [state.apiOrigin, ...fallbackGatewayOrigins].filter(
    (origin, index, origins) => origin && origins.indexOf(origin) === index
  );
}

async function ensureGateway() {
  const failures = [];
  for (const origin of uniqueOrigins()) {
    try {
      const response = await fetch(`${origin}/health`, { cache: "no-store", signal: AbortSignal.timeout(3500) });
      if (!response.ok) {
        failures.push(`${origin}: HTTP ${response.status}`);
        continue;
      }
      const payload = await response.json();
      if (payload.service !== "shuihuo-killer-gateway") {
        failures.push(`${origin}: 不是左右本地服务`);
        continue;
      }
      state.apiOrigin = new URL(response.url).origin;
      return;
    } catch (error) {
      failures.push(`${origin}: ${error && error.message ? error.message : error}`);
    }
  }
  throw new Error(failures.join("；") || "无法连接本地服务");
}

function authHeaders(headers = {}) {
  return state.gatewayApiKey ? { ...headers, "X-API-Key": state.gatewayApiKey } : headers;
}

function appendUserTurn(images, text, carriedCount = 0) {
  const article = document.createElement("article");
  article.className = "liuwa-turn is-user";
  const gallery = images
    .map((url) => `<img src="${escapeHtml(url)}" alt="截图" />`)
    .join("");
  const carried = carriedCount
    ? `<p class="liuwa-carried">附上本题 ${carriedCount} 张截图</p>`
    : "";
  article.innerHTML = `
    ${gallery ? `<div class="liuwa-gallery">${gallery}</div>` : ""}
    ${carried}
    ${text ? `<p>${escapeHtml(text)}</p>` : ""}
  `;
  thread.append(article);
  return article;
}

function appendAssistantTurn() {
  const article = document.createElement("article");
  article.className = "liuwa-turn is-assistant is-stream";
  const body = document.createElement("div");
  body.className = "liuwa-stream md";
  article.append(body);
  thread.append(article);
  return body;
}

// 为已完成的 AI 回答添加反馈按钮
function addFeedbackButtons(assistantTurn, replyText) {
  if (!assistantTurn || assistantTurn.querySelector(".liuwa-feedback")) return;
  const footer = document.createElement("footer");
  footer.className = "liuwa-feedback";
  footer.innerHTML = `
    <button type="button" class="liuwa-feedback-btn liuwa-feedback-up" data-feedback="up" aria-label="回答有用">👍 有用</button>
    <button type="button" class="liuwa-feedback-btn liuwa-feedback-down" data-feedback="down" aria-label="回答无用">👎 无用</button>
  `;
  assistantTurn.append(footer);
  footer.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-feedback]");
    if (!btn) return;
    const feedbackType = btn.dataset.feedback;
    const userTurn = assistantTurn.previousElementSibling;
    const questionText = userTurn?.querySelector("p")?.textContent || "";
    saveFeedback({
      answerText: replyText,
      feedbackType,
      questionText,
      model: modelNode?.textContent?.replace("当前模型 · ", "") || "",
      preset: presetNode?.textContent || "",
    });
    // 标记已反馈
    footer.classList.add("is-voted");
    footer.querySelectorAll(".liuwa-feedback-btn").forEach((b) => {
      b.disabled = true;
      if (b === btn) b.classList.add("is-active");
    });
    setStatus(feedbackType === "up" ? "感谢反馈！我们会继续保持。" : "感谢反馈！我们会改进回答质量。");
  });
}

async function readSse(response, onDelta, signal) {
  if (!response.body) {
    throw new Error("浏览器无法读取流式响应");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  try {
    while (!completed) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() || "";
      for (const chunk of chunks) {
        const line = chunk.split("\n").find((item) => item.startsWith("data:"));
        if (!line) continue;
        const payload = JSON.parse(line.slice(5).trim() || "{}");
        if (payload.error) throw new Error(payload.error);
        if (payload.delta) onDelta(payload.delta);
        if (payload.done) completed = true;
      }
    }
  } catch (error) {
    // An abort surfaces as an AbortError here; keep whatever was decoded so far and
    // let the caller decide whether to preserve it instead of dropping the turn.
    if (signal?.aborted || error?.name === "AbortError") return;
    throw error;
  }
  if (!completed) throw new Error("回答中断，请重新发送。");
}

let activeAbort = null;

// Preserve whatever the model produced before a stop/error and mark the turn, so the
// user can keep reading the partial answer and continue from it (Gank keeps partial
// responses instead of dropping the whole turn).
function finalizeStopped(streamNode, reply, assistantTurn) {
  streamNode.innerHTML = renderMarkdown(reply + (reply && !/\n$/.test(reply) ? "\n" : "") + "（已中断）");
  assistantTurn.classList.remove("is-stream");
  assistantTurn.classList.add("is-stopped");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 判断错误是否可重试：网络错误、5xx 服务器错误、超时、限流
function isRetryableError(error, status) {
  if (error?.name === "AbortError") return false;
  if (status === 401 || status === 403 || status === 413) return false;
  if (status >= 500 && status < 600) return true;
  if (status === 429) return true;
  // 网络错误（无 status）
  if (!status) return true;
  return false;
}

// 指数退避重试：最多 3 次，间隔 1s/2s/4s
async function fetchWithRetry(url, options, maxRetries = 3) {
  let lastError = null;
  let lastStatus = 0;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      lastStatus = response.status;
      const failure = await response.json().catch(() => ({}));
      const detail = typeof failure.detail === "string" ? failure.detail : "";
      // 客户端错误不重试
      if (response.status === 401 || response.status === 403) {
        throw new Error("服务验证失败，请打开设置检查访问密钥。");
      }
      if (detail.includes("larger than") || response.status === 413) {
        throw new Error("截图过大，请缩小截图范围或压缩图片后重试。");
      }
      // 服务器错误或限流，可重试
      if (attempt < maxRetries && (response.status >= 500 || response.status === 429)) {
        const delay = Math.pow(2, attempt) * 1000;
        setStatus(`服务暂时不可用，${delay / 1000} 秒后重试（${attempt + 1}/${maxRetries}）…`);
        await sleep(delay);
        continue;
      }
      throw new Error(detail || `发送失败，请检查服务后重试（${response.status}）。`);
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error, lastStatus)) throw error;
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        setStatus(`网络异常，${delay / 1000} 秒后重试（${attempt + 1}/${maxRetries}）…`);
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error("发送失败，请检查网络后重试。");
}

async function sendChat() {
  // 自愈：如果上一次流式状态残留（例如中断后 activeAbort 已置空），直接重置，避免「发送没动作」。
  if (streaming && !activeAbort) {
    streaming = false;
  }
  // 如果控制器已中止但标志未复位，也一并复位。
  if (streaming && activeAbort && activeAbort.signal.aborted) {
    streaming = false;
    activeAbort = null;
  }
  // 兜底：清掉可能残留的忙/停止样式，保证 addShot 不会被永久卡住。
  document.body.classList.remove("is-busy", "is-stopped");
  if (streaming) {
    setStatus("正在生成回答，请稍候或点击停止后再发送。");
    return;
  }
  const images = pending.map((shot) => shot.dataUrl);
  const unsent = pending.filter((shot) => !shot.sent).map((shot) => shot.dataUrl);
  const text = note ? note.value.trim() : "";
  renderPending();
  if (!unsent.length && !text) {
    setStatus(pending.length ? "写一句追问，或按新对话再截新的图。" : "先截一张屏，或写一句再发送。");
    return;
  }
  streaming = true;
  activeAbort = new AbortController();
  const timeoutGuard = setTimeout(() => activeAbort?.abort(), 180_000);
  document.body.classList.add("is-busy");
  setStatus("正在分析题目…");
  note.disabled = true;
  shots.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  if (stopBtn) stopBtn.hidden = false;
  const userTurn = appendUserTurn(unsent, text, images.length - unsent.length);
  const streamNode = appendAssistantTurn();
  const assistantTurn = streamNode.parentElement;
  syncEmpty();
  stickBottom = true;
  followTail();
  let reply = "";
  let flushTimer = null;
  const flush = () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    streamNode.innerHTML = renderMarkdown(reply);
    followTail();
  };
  const commitTurn = () => {
    pending.forEach((shot) => { shot.sent = true; });
    note.value = "";
    renderPending();
    history.push({
      role: "user",
      text: text || "请继续讲解上一道截图题目",
      images: unsent.slice(0, 3), // 保存前 3 张缩略图
      imageCount: unsent.length,
    });
    history.push({ role: "assistant", text: reply });
  };
  // Coalesce tokens: flush at a sentence boundary at once, otherwise on a 90ms timer.
  // This keeps the cursor responsive without re-laying-out the whole bubble per token.
  const onDelta = (delta) => {
    reply += delta;
    if (/[。！？!?；;]\s*$|\n$/.test(reply)) { flush(); return; }
    if (!flushTimer) flushTimer = setTimeout(flush, 90);
  };
  try {
    await ensureGateway();
    const response = await fetchWithRetry(`${state.apiOrigin}/api/chat/stream`, {
      method: "POST",
      signal: activeAbort.signal,
      headers: authHeaders({
        "content-type": "application/json",
        accept: "text/event-stream",
      }),
      body: JSON.stringify({
        text,
        images,
        history: history.slice(-16).map((turn) => ({ ...turn, text: turn.text.slice(0, 8000) })),
      }),
    });
    await readSse(response, onDelta, activeAbort.signal);
    flush();
    assistantTurn.classList.remove("is-stream");
    commitTurn();
    addFeedbackButtons(assistantTurn, reply);
    setStatus(pending.length ? "这些截图会附在后续追问里，新对话时清掉。" : "");
  } catch (error) {
    clearTimeout(flushTimer);
    flush();
    const aborted = activeAbort?.signal.aborted || error?.name === "AbortError";
    if (aborted && reply.trim()) {
      // Keep the partial answer; user stopped deliberately, the question was real.
      finalizeStopped(streamNode, reply, assistantTurn);
      commitTurn();
      addFeedbackButtons(assistantTurn, reply);
      setStatus("已停止，保留已生成的部分，可继续追问。");
    } else {
      // Nothing useful came back — drop the turn so it can be resent cleanly.
      userTurn.remove();
      assistantTurn.remove();
      syncEmpty();
      const message = aborted ? "已停止。" : (error && error.message ? error.message : String(error));
      setStatus(aborted ? message : `${message} 图片和问题已保留，可再次发送。`);
    }
  } finally {
    streaming = false;
    clearTimeout(timeoutGuard);
    activeAbort = null;
    document.body.classList.remove("is-busy", "is-stopped");
    if (assistantTurn.isConnected) assistantTurn.classList.remove("is-stream");
    if (stopBtn) stopBtn.hidden = true;
    note.disabled = false;
    renderPending();
  }
}

function stopChat() {
  if (streaming && activeAbort) activeAbort.abort();
}

function applyHotkeyHints(cfg) {
  const byAction = new Map((cfg.hotkeys || []).map((binding) => [binding.action, binding]));
  const apply = (node, action) => {
    const binding = byAction.get(action);
    if (node && binding && binding.display) node.textContent = binding.display;
  };
  apply(hintCapture, "captureRegion");
  document.querySelectorAll("[data-key-action]").forEach((node) => {
    apply(node, node.dataset.keyAction);
    node.classList.toggle("is-conflict", (cfg.failedHotkeys || []).includes(byAction.get(node.dataset.keyAction)?.accelerator));
  });
  const warning = document.querySelector("#liuwaHotkeyWarning");
  warning.hidden = !(cfg.failedHotkeys || []).length;
  warning.textContent = warning.hidden ? "" : "部分按键被系统或其他应用占用，请到设置更换。";
}

function cycleTheme() {
  const themes = ["light", "dark", "transparent-white", "transparent-black"];
  const current = document.documentElement.dataset.theme || "light";
  const nextIndex = (themes.indexOf(current) + 1) % themes.length;
  const nextTheme = themes[nextIndex];
  document.documentElement.dataset.theme = nextTheme;
  if (window.cockpit?.setConfig) window.cockpit.setConfig({ theme: nextTheme });
}

function applyTheme(cfg) {
  const theme = cfg.theme || "light";
  document.documentElement.dataset.theme = theme;
  const themeNode = document.querySelector("#liuwaTheme");
  if (!themeNode) return;
  themeNode.textContent = theme === "light" ? "浅色" :
    theme === "dark" ? "深色" :
    theme === "transparent-white" ? "透明白字" : "透明黑字";
}

function wireDesktop(cockpit) {
  document.documentElement.classList.add("liuwa-host");
  document.body.classList.add("liuwa-shell");
  document.querySelector("#liuwaShortcutNote").textContent = "连续截图会一起发送。按住操作键才能点面板。";
  cockpit.onHotkeys?.(applyHotkeyHints);
  cockpit.onNewQuestion?.(newQuestion);
  cockpit.onClearShots?.(clearShots);
  cockpit.onTheme?.(applyTheme);
  if (typeof cockpit.onCapture === "function") {
    cockpit.onCapture((payload) => {
      if (!payload || !payload.data) return;
      addShotFromBase64(payload.mime, payload.data);
    });
  }
  if (typeof cockpit.onCaptureError === "function") {
    cockpit.onCaptureError((payload) => {
      setStatus(payload && payload.detail ? payload.detail : "截图失败");
    });
  }
  if (typeof cockpit.onSend === "function") {
    cockpit.onSend(() => {
      sendChat();
    });
  }
  if (typeof cockpit.onCompact === "function") {
    cockpit.onCompact((value) => {
      document.body.classList.toggle("liuwa-compact", Boolean(value));
    });
  }
  if (typeof cockpit.onArmed === "function") {
    cockpit.onArmed((value) => {
      document.body.classList.toggle("liuwa-armed", Boolean(value));
    });
  }
  if (typeof cockpit.getConfig === "function") {
    cockpit.getConfig().then((cfg) => {
      applyHotkeyHints(cfg || {});
      applyTheme(cfg || {});
      if (cfg && cfg.gatewayApiKey) state.gatewayApiKey = cfg.gatewayApiKey;
    });
  }
}

window.cycleTheme = cycleTheme;

shots?.addEventListener("click", (event) => {
  const id = event.target.closest("[data-remove]")?.dataset.remove;
  if (id && !streaming) removeShot(id);
});

stopBtn?.addEventListener("click", stopChat);
stopBtn?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  stopChat();
});

note?.addEventListener("input", syncEmpty);

note?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  sendChat();
});

document.addEventListener("paste", (event) => {
  const items = event.clipboardData ? Array.from(event.clipboardData.items) : [];
  const images = items.filter((item) => item.type.startsWith("image/"));
  if (!images.length) return;
  event.preventDefault();
  images.forEach((item) => {
    const blob = item.getAsFile();
    if (!blob) return;
    const reader = new FileReader();
    reader.onload = () => addShot(String(reader.result || ""));
    reader.readAsDataURL(blob);
  });
});

document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", (event) => {
  event.preventDefault();
  Array.from(event.dataTransfer?.files || [])
    .filter((file) => file.type.startsWith("image/"))
    .forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => addShot(String(reader.result || ""));
      reader.readAsDataURL(file);
    });
});

if (typeof window.__GATEWAY_KEY__ === "string" && window.__GATEWAY_KEY__.trim()) {
  state.gatewayApiKey = window.__GATEWAY_KEY__.trim();
}
if (window.cockpit) wireDesktop(window.cockpit);

function updateSettingsLink() {
  settingsLink.href = `${state.apiOrigin}/settings`;
}

let refreshingContext = false;
async function refreshContext() {
  if (refreshingContext) return;
  refreshingContext = true;
  try {
    await ensureGateway();
    updateSettingsLink();
    if (window.cockpit?.getConfig) applyHotkeyHints(await window.cockpit.getConfig());
    const [settingsResponse, configResponse] = await Promise.all([
      fetch(`${state.apiOrigin}/api/ui/settings`, { headers: authHeaders(), cache: "no-store", signal: AbortSignal.timeout(3500) }),
      fetch(`${state.apiOrigin}/api/config/status`, { headers: authHeaders(), cache: "no-store", signal: AbortSignal.timeout(3500) }),
    ]);
    if (!settingsResponse.ok || !configResponse.ok) throw new Error("请在 Web 设置中检查服务连接与访问密钥。");
    const settings = await settingsResponse.json();
    if (!window.cockpit) applyHotkeyHints({ hotkeys: Object.entries(settings.hotkeys || {}).map(([action, accelerator]) => ({
      action, accelerator, display: formatAccelerator(accelerator, /Mac|iPhone|iPad/.test(navigator.platform)),
    })) });
    const config = await configResponse.json();
    const styles = { hints: "先给提示", walkthrough: "讲解思路", solution: "完整解答" };
    const specialty = settings.study_specialty || "通用学习";
    const language = isExamSpecialty(specialty) ? "" : settings.study_language?.trim();
    presetNode.textContent = [specialty, language, styles[settings.study_answer_style] || "讲解思路"].filter(Boolean).join(" · ");
    const mock = config.llm_provider === "mock" || !config.llm_api_key_configured || !config.llm_base_url_configured;
    modelNode.textContent = mock ? "演示模式 · 未连接真实 AI" : `当前模型 · ${config.llm_model}`;
  } catch (error) {
    presetNode.textContent = "复习预设未同步";
    modelNode.textContent = "连接待检查 · 打开设置";
    modelNode.title = error.message;
  } finally {
    refreshingContext = false;
  }
}

function clearShots() {
  if (streaming) {
    setStatus("请等本次回答结束后再清空截图。");
    return;
  }
  if (!pending.length) {
    setStatus("没有待发送的截图。");
    return;
  }
  pending.length = 0;
  renderPending();
  setStatus("已清空截图，对话还在。");
}

function newQuestion() {
  if (streaming) return;
  // 保存当前会话到历史记录（如果有内容）
  if (history.length > 0) {
    saveSessionRecord({
      turns: history,
      note: note.value.trim(),
      startedAt: new Date(Date.now() - 60000).toISOString(),
    }).then((record) => {
      if (record) {
        setStatus(`已保存到历史记录（${record.turnCount} 轮），开始新对话。`);
      }
    });
  }
  thread.querySelectorAll(".liuwa-turn").forEach((turn) => turn.remove());
  history.length = 0;
  pending.length = 0;
  note.value = "";
  renderPending();
}
window.addEventListener("focus", refreshContext);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshContext();
});

// 历史记录面板
function toggleHistoryPanel(show) {
  if (!historyPanel) return;
  const shouldShow = show !== undefined ? show : historyPanel.hidden;
  historyPanel.hidden = !shouldShow;
  if (shouldShow) {
    renderHistoryList();
  }
}

function renderHistoryList() {
  if (!historyList) return;
  const records = listSessionRecords();
  if (!records.length) {
    historyList.innerHTML = '<p class="liuwa-history-empty">还没有保存的会话记录。点击「新对话」时会自动保存当前会话。</p>';
    return;
  }
  historyList.innerHTML = records.map((record) => {
    const date = new Date(record.startedAt).toLocaleString("zh-CN", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    const preview = record.turns[0]?.text?.slice(0, 60) || record.note || "（无文字）";
    return `
      <article class="liuwa-history-item" data-id="${escapeHtml(record.id)}">
        <header>
          <time>${escapeHtml(date)}</time>
          <span class="liuwa-history-count">${record.turnCount} 轮</span>
        </header>
        <p class="liuwa-history-preview">${escapeHtml(preview)}${preview.length >= 60 ? "…" : ""}</p>
        <footer>
          <button type="button" class="liuwa-history-view" data-view="${escapeHtml(record.id)}">查看</button>
          <button type="button" class="liuwa-history-delete" data-delete="${escapeHtml(record.id)}">删除</button>
        </footer>
      </article>
    `;
  }).join("");
}

historyBtn?.addEventListener("click", () => toggleHistoryPanel());
historyClose?.addEventListener("click", () => toggleHistoryPanel(false));
historyExport?.addEventListener("click", () => exportSessionRecordsAsMarkdown());

historyList?.addEventListener("click", (event) => {
  const viewId = event.target.closest("[data-view]")?.dataset.view;
  const deleteId = event.target.closest("[data-delete]")?.dataset.delete;
  if (viewId) {
    const record = listSessionRecords().find((r) => r.id === viewId);
    if (record) {
      // 在面板内展示完整记录
      historyList.innerHTML = `
        <article class="liuwa-history-detail">
          <header>
            <button type="button" class="liuwa-history-back" id="liuwaHistoryBack">← 返回列表</button>
            <time>${new Date(record.startedAt).toLocaleString("zh-CN")}</time>
          </header>
          ${record.note ? `<p class="liuwa-history-note">备注：${escapeHtml(record.note)}</p>` : ""}
          <div class="liuwa-history-turns">
            ${record.turns.map((turn) => `
              <div class="liuwa-history-turn is-${turn.role}">
                <strong>${turn.role === "user" ? "问" : "答"}</strong>
                ${turn.images && turn.images.length ? `
                  <div class="liuwa-history-gallery">
                    ${turn.images.map((img) => `<img src="${escapeHtml(img)}" alt="截图" />`).join("")}
                  </div>
                ` : ""}
                <p>${escapeHtml(turn.text)}</p>
                ${turn.imageCount ? `<span class="liuwa-history-images">（含 ${turn.imageCount} 张截图）</span>` : ""}
              </div>
            `).join("")}
          </div>
        </article>
      `;
      document.getElementById("liuwaHistoryBack")?.addEventListener("click", renderHistoryList);
    }
  }
  if (deleteId) {
    if (confirm("确定删除这条会话记录吗？")) {
      deleteSessionRecord(deleteId);
      renderHistoryList();
      setStatus("已删除会话记录。");
    }
  }
});

// ===== 知识库面板 =====
let currentKBTag = "";

function toggleKBPanel(show) {
  if (!kbPanel) return;
  const shouldShow = show !== undefined ? show : kbPanel.hidden;
  kbPanel.hidden = !shouldShow;
  if (shouldShow) {
    renderKBPanel();
  }
}

function renderKBPanel() {
  renderKBStats();
  renderKBTags();
  renderKBList();
}

function renderKBStats() {
  if (!kbStats) return;
  const stats = getKBStats();
  kbStats.innerHTML = `
    <span>共 ${stats.totalItems} 条</span>
    <span>${stats.totalTags} 个标签</span>
    <span>已复习 ${stats.reviewedItems} 条</span>
  `;
}

function renderKBTags() {
  if (!kbTags) return;
  const tags = listTags();
  kbTags.innerHTML = `
    <button type="button" class="liuwa-kb-tag ${!currentKBTag ? "is-active" : ""}" data-tag="">全部</button>
    ${tags.map(({ tag, count }) => `
      <button type="button" class="liuwa-kb-tag ${currentKBTag === tag ? "is-active" : ""}" data-tag="${escapeHtml(tag)}">
        ${escapeHtml(tag)} <span class="liuwa-kb-tag-count">${count}</span>
      </button>
    `).join("")}
  `;
}

function renderKBList() {
  if (!kbList) return;
  const search = kbSearch?.value?.trim() || "";
  const items = listKnowledgeItems({ tag: currentKBTag || undefined, search });
  if (!items.length) {
    kbList.innerHTML = '<p class="liuwa-kb-empty">知识库为空。从会话记录导入，或继续刷题自动积累。</p>';
    return;
  }
  kbList.innerHTML = items.map((item) => `
    <article class="liuwa-kb-item" data-id="${escapeHtml(item.id)}">
      <header>
        <div class="liuwa-kb-item-tags">
          ${item.tags.map((t) => `<span class="liuwa-kb-tag-small">${escapeHtml(t)}</span>`).join("")}
        </div>
        <time>${new Date(item.createdAt).toLocaleDateString("zh-CN")}</time>
      </header>
      <p class="liuwa-kb-question">${escapeHtml(item.question.slice(0, 120))}${item.question.length > 120 ? "…" : ""}</p>
      <details class="liuwa-kb-answer">
        <summary>查看解答</summary>
        <p>${escapeHtml(item.answer.slice(0, 500))}${item.answer.length > 500 ? "…" : ""}</p>
      </details>
      <footer>
        <button type="button" class="liuwa-kb-review" data-review="${escapeHtml(item.id)}">复习 +1</button>
        <button type="button" class="liuwa-kb-delete" data-delete-kb="${escapeHtml(item.id)}">删除</button>
      </footer>
    </article>
  `).join("");
}

kbBtn?.addEventListener("click", () => toggleKBPanel());
kbClose?.addEventListener("click", () => toggleKBPanel(false));
kbExport?.addEventListener("click", () => exportKnowledgeBaseAsMarkdown());
kbImport?.addEventListener("click", () => {
  const records = listSessionRecords();
  if (!records.length) {
    setStatus("没有可导入的会话记录。");
    return;
  }
  const imported = importSessionRecords(records);
  setStatus(`已从会话记录导入 ${imported} 条知识。`);
  renderKBPanel();
});

kbTags?.addEventListener("click", (event) => {
  const tag = event.target.closest("[data-tag]")?.dataset.tag;
  if (tag !== undefined) {
    currentKBTag = tag;
    renderKBTags();
    renderKBList();
  }
});

kbSearch?.addEventListener("input", () => renderKBList());

kbList?.addEventListener("click", (event) => {
  const reviewId = event.target.closest("[data-review]")?.dataset.review;
  const deleteId = event.target.closest("[data-delete-kb]")?.dataset.deleteKb;
  if (reviewId) {
    markReviewed(reviewId);
    renderKBStats();
    setStatus("已标记复习。");
  }
  if (deleteId) {
    if (confirm("确定删除这条知识吗？")) {
      deleteKnowledgeItem(deleteId);
      renderKBPanel();
      setStatus("已删除知识条目。");
    }
  }
});

updateSettingsLink();
syncEmpty();
refreshContext();

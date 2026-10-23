import { formatAccelerator } from "./shortcuts.js";
import { fallbackGatewayOrigins, state } from "./state.js";
import { saveSessionRecord } from "./session-store.js";
import { renderAnswer } from "./answer-view.js";
import { closeLightbox, isLightboxOpen, openLightbox } from "./lightbox.js";
import { page, readingBox, resetReading } from "./reading.js";

const thread = document.querySelector("#liuwaThread");
const idle = document.querySelector("#liuwaIdle");
const shots = document.querySelector("#liuwaShots");
const statusNode = document.querySelector("#liuwaStatus");
const hintCapture = document.querySelector("#hintCapture");
const stopBtn = document.querySelector("#liuwaStop");

// Follow-tail: only auto-scroll while the user is already near the bottom. Once they
// scroll up to read, new tokens must not yank them back down (Gank's 24px rule).
let stickBottom = true;
thread?.addEventListener("scroll", () => {
  const box = readingBox();
  if (box) stickBottom = box.scrollHeight - box.scrollTop - box.clientHeight <= 24;
}, true);
function followTail() {
  if (!stickBottom || !thread) return;
  thread.scrollTop = thread.scrollHeight;
  const box = readingBox();
  if (box) box.scrollTop = box.scrollHeight;
}

const pending = [];
const history = [];
let streaming = false;
let savingSession = false;
let nextShotId = 1;
let currentModel = "";
let activeShotId = "";
let sessionStartedAt = new Date().toISOString();

function syncActiveShot() {
  if (pending.some((shot) => shot.id === activeShotId)) return;
  activeShotId = pending.length ? pending[pending.length - 1].id : "";
}

function stepActiveShot(delta) {
  if (pending.length < 2) return;
  syncActiveShot();
  const index = pending.findIndex((shot) => shot.id === activeShotId);
  const next = pending[(Math.max(index, 0) + delta + pending.length) % pending.length];
  activeShotId = next.id;
  renderPending();
  shots
    ?.querySelector(`[data-shot="${activeShotId}"]`)
    ?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

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
  // 只有「一条对话都没有」才算空。截了图但还没发送时，之前也算非空——
  // 结果 idle 被藏起来、thread 又是空的，整块区域一片空白，只剩 dock 里一张缩略图。
  const empty = !hasTurns;
  document.body.classList.toggle("is-empty", empty);
  if (idle) idle.hidden = !empty;
}

function renderPending() {
  if (!shots) return;
  syncActiveShot();
  shots.hidden = pending.length === 0;
  const chips =
    pending.length > 1
      ? `<div class="liuwa-shot-chips" aria-label="截图切换">${pending
          .map((shot, index) => {
            const classes = ["liuwa-shot-chip"];
            if (shot.sent) classes.push("is-sent");
            if (shot.id === activeShotId) classes.push("is-active");
            return `<button type="button" class="${classes.join(" ")}" data-shot-chip="${escapeHtml(shot.id)}" aria-label="查看第 ${index + 1} 张截图" aria-pressed="${shot.id === activeShotId}">${index + 1}</button>`;
          })
          .join("")}</div>`
      : "";
  shots.innerHTML =
    chips +
    pending
      .map((shot, index) => {
        const classes = ["liuwa-thumb"];
        if (shot.id === activeShotId) classes.push("is-active");
        return `<figure class="${classes.join(" ")}" data-shot="${escapeHtml(shot.id)}">
          <button type="button" class="liuwa-thumb-open" data-open="${escapeHtml(shot.id)}" aria-label="放大第 ${index + 1} 张截图">
            <img src="${escapeHtml(shot.dataUrl)}" alt="${shot.sent ? `本题截图 ${index + 1}` : `待发送截图 ${index + 1}`}" />
          </button>
          <button type="button" class="liuwa-thumb-x" data-remove="${escapeHtml(shot.id)}" aria-label="去掉第 ${index + 1} 张图">×</button>
        </figure>`;
      })
      .join("");
  syncEmpty();
}

function addShot(dataUrl) {
  if (savingSession) {
    setStatus("正在保存会话，请稍候。");
    return;
  }
  // 仅当真正在流式生成时才禁止添加截图；历史残留的 is-busy/is-stopped 样式不再阻塞。
  if (streaming) {
    setStatus("");
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
  setStatus("");
}

function addShotFromBase64(mime, data) {
  const type = mime || "image/png";
  addShot(`data:${type};base64,${data}`);
}

function removeShot(id) {
  const index = pending.findIndex((shot) => shot.id === id);
  if (index < 0) return;
  pending.splice(index, 1);
  if (activeShotId === id) activeShotId = "";
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

// 截图已经在底部 dock 的缩略图里看得到，对话流里不再重复贴图，
// 也不写「已发送截图」这类说明——用户刚按下发送，不需要再被告知一次。
// 纯截图轮没有文字，就整条不插：一个空 <article> 还要占 14px 外边距，
// 而正文区本来就靠这点高度吃饭。
function appendUserTurn(images, text, carriedCount = 0) {
  if (!text) return null;
  const article = document.createElement("article");
  article.className = "liuwa-turn is-user";
  article.innerHTML = `<p>${escapeHtml(text)}</p>`;
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
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
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
    // 用户主动停止时抛出 AbortError，让调用方走「保留已生成内容」的分支。
    // 之前这里静默 return，停止被当成正常完成，界面上看不出区别。
    if (signal?.aborted || error?.name === "AbortError") {
      throw new DOMException("aborted", "AbortError");
    }
    throw error;
  }
  if (!completed) throw new Error("回答中断，请重新发送。");
}

let activeAbort = null;

// Preserve whatever the model produced before a stop/error and mark the turn, so the
// user can keep reading the partial answer and continue from it (Gank keeps partial
// responses instead of dropping the whole turn).
function finalizeStopped(streamNode, reply, assistantTurn, marker = "（已中断）") {
  // 中断标记挂在卡片上，正文保留模型已经生成的内容。
  assistantTurn.classList.add("is-stopped");
  assistantTurn.dataset.stoppedLabel = marker;
  renderAnswer(reply, streamNode);
  assistantTurn.classList.remove("is-stream");
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
      if (response.status === 401 || response.status === 403) {
        throw new Error("服务验证失败，请在设置页检查访问密钥。");
      }
      if (detail.includes("larger than") || response.status === 413) {
        throw new Error("截图过大，请缩小截图范围后重试。");
      }
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
  if (savingSession) {
    setStatus("正在保存会话，请稍候。");
    return;
  }
  // 自愈：如果上一次流式状态残留（例如中断后 activeAbort 已置空），直接重置，避免「发送没动作」。
  if (streaming && !activeAbort) {
    streaming = false;
  }
  if (streaming && activeAbort && activeAbort.signal.aborted) {
    streaming = false;
    activeAbort = null;
  }
  document.body.classList.remove("is-busy", "is-stopped");
  if (streaming) {
    setStatus("");
    return;
  }
  const images = pending.map((shot) => shot.dataUrl);
  const unsent = pending.filter((shot) => !shot.sent).map((shot) => shot.dataUrl);
  renderPending();
  if (!unsent.length) {
    setStatus("先截一张屏。");
    return;
  }
  streaming = true;
  const controller = new AbortController();
  activeAbort = controller;
  const timeoutGuard = setTimeout(() => controller.abort(), 180_000);
  document.body.classList.add("is-busy");
  setStatus("正在分析题目…");
  shots.querySelectorAll("[data-remove]").forEach((button) => { button.disabled = true; });
  if (stopBtn) stopBtn.hidden = false;
  const userTurn = appendUserTurn(unsent, "", images.length - unsent.length);
  const streamNode = appendAssistantTurn();
  const assistantTurn = streamNode.parentElement;
  syncEmpty();
  stickBottom = true;
  followTail();
  let reply = "";
  let flushTimer = null;
  const flush = () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    renderAnswer(reply, streamNode);
    followTail();
  };
  const commitTurn = (complete = true) => {
    // 部分回答虽需保留，但不能把待处理截图标成完成，否则连接中断后再按处理键无效。
    if (complete) pending.forEach((shot) => { shot.sent = true; });
    renderPending();
    history.push({
      role: "user",
      text: "请讲解这道截图题目",
      images: unsent.slice(0, 3),
      imageCount: unsent.length,
    });
    history.push({ role: "assistant", text: reply });
  };
  // Coalesce tokens: flush at a sentence boundary at once, otherwise on a 90ms timer.
  const onDelta = (delta) => {
    reply += delta;
    if (/[。！？!?；;]\s*$|\n$/.test(reply)) { flush(); return; }
    if (!flushTimer) flushTimer = setTimeout(flush, 90);
  };
  try {
    await ensureGateway();
    const response = await fetchWithRetry(`${state.apiOrigin}/api/chat/stream`, {
      method: "POST",
      signal: controller.signal,
      headers: authHeaders({
        "content-type": "application/json",
        accept: "text/event-stream",
      }),
      body: JSON.stringify({
        text: "",
        images,
        history: history.slice(-16).map((turn) => ({ ...turn, text: turn.text.slice(0, 8000) })),
      }),
    });
    await readSse(response, onDelta, controller.signal);
    flush();
    assistantTurn.classList.remove("is-stream");
    commitTurn();
    setStatus("");
  } catch (error) {
    clearTimeout(flushTimer);
    flush();
    const aborted = controller.signal.aborted || error?.name === "AbortError";
    const rawMessage = error && error.message ? error.message : String(error);
    const message = /RemoteProtocolError|incomplete chunked read|peer closed connection/i.test(rawMessage)
      ? "模型连接中断，可重新处理当前截图。"
      : rawMessage;
    if (reply.trim()) {
      // 已经流出一大段内容：不管是主动停止还是中途报错，都保留下来。
      // 之前只有「主动停止」保留，报错会把用户眼看着生成的整段解析删掉。
      finalizeStopped(streamNode, reply, assistantTurn, aborted ? "（已中断）" : `（中断：${message}）`);
      commitTurn(false);
      setStatus(aborted ? "已停止。" : message);
    } else {
      userTurn?.remove();
      assistantTurn.remove();
      syncEmpty();
      setStatus(aborted ? "已停止。" : message);
    }
  } finally {
    clearTimeout(timeoutGuard);
    // 只有当前这轮还是「活跃请求」时才清全局状态。停止后立刻再发，
    // 旧请求的 finally 晚到会把新请求的 streaming/stopBtn 一起清掉，
    // 新回答看着像没在生成、也停不下来。
    if (activeAbort === controller) {
      streaming = false;
      activeAbort = null;
      if (stopBtn) stopBtn.hidden = true;
      document.body.classList.remove("is-busy");
    }
    if (assistantTurn.isConnected) assistantTurn.classList.remove("is-stream");
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
  warning.textContent = warning.hidden ? "" : "部分按键被系统或其他应用占用，请到设置页更换。";
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
}

function wireDesktop(cockpit) {
  document.documentElement.classList.add("liuwa-host");
  document.body.classList.add("liuwa-shell");
  cockpit.onHotkeys?.(applyHotkeyHints);
  cockpit.onNewQuestion?.(newQuestion);
  cockpit.onClearShots?.(clearShots);
  cockpit.onDeleteLastShot?.(deleteLastShot);
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
  if (typeof cockpit.onRead === "function") {
    cockpit.onRead((direction) => {
      if (isLightboxOpen()) return;
      page(direction === "prev" ? -1 : 1);
    });
  }
  if (typeof cockpit.onScroll === "function") {
    cockpit.onScroll((direction) => {
      if (isLightboxOpen()) return;
      page(direction);
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
// 暴露给预览/调试页（web/preview.html 的 ?live= 模式）：让浏览器环境也能触发完整发送闭环。
window.__liuwaSend = sendChat;
window.__liuwaState = state;

shots?.addEventListener("click", (event) => {
  const chipId = event.target.closest("[data-shot-chip]")?.dataset.shotChip;
  if (chipId) {
    const index = pending.findIndex((shot) => shot.id === chipId);
    if (index < 0) return;
    activeShotId = chipId;
    openLightbox(pending.map((shot) => shot.dataUrl), index);
    renderPending();
    return;
  }
  const openId = event.target.closest("[data-open]")?.dataset.open;
  if (openId) {
    const index = pending.findIndex((shot) => shot.id === openId);
    if (index < 0) return;
    activeShotId = openId;
    openLightbox(pending.map((shot) => shot.dataUrl), index);
    renderPending();
    return;
  }
  const id = event.target.closest("[data-remove]")?.dataset.remove;
  if (id && !streaming) removeShot(id);
});

// 只在焦点落在截图区时才接管方向键：正文是可滚动的，全局拦截会把翻读回答
// 的方向键一起吞掉。
shots?.addEventListener("keydown", (event) => {
  if (isLightboxOpen()) return;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  if (pending.length < 2) return;
  event.preventDefault();
  stepActiveShot(event.key === "ArrowRight" ? 1 : -1);
});

stopBtn?.addEventListener("click", stopChat);
stopBtn?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  stopChat();
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

let refreshingContext = false;
async function refreshContext() {
  if (refreshingContext) return;
  refreshingContext = true;
  try {
    await ensureGateway();
    if (window.cockpit?.getConfig) applyHotkeyHints(await window.cockpit.getConfig());
    const configResponse = await fetch(`${state.apiOrigin}/api/config/status`, { headers: authHeaders(), cache: "no-store", signal: AbortSignal.timeout(3500) });
    if (!configResponse.ok) throw new Error("请在设置页检查服务连接。");
    const config = await configResponse.json();
    const mock = config.llm_provider === "mock" || !config.llm_api_key_configured || !config.llm_base_url_configured;
    currentModel = mock ? "" : config.llm_model || "";
    if (mock) setStatus("演示模式：未连接真实 AI，请到设置页配置模型。");
  } catch (error) {
    setStatus("本地服务未连接，请启动网关。");
  } finally {
    refreshingContext = false;
  }
}

// Gank 的 ⌘L：只删最后一张截图，不是清空全部。截图发错了想换一张时，
// 清空会连前面几张一起丢掉。
function deleteLastShot() {
  if (streaming) {
    setStatus("");
    return;
  }
  if (!pending.length) {
    setStatus("");
    return;
  }
  removeShot(pending[pending.length - 1].id);
  setStatus("");
}

function clearShots() {
  if (streaming) {
    setStatus("");
    return;
  }
  if (!pending.length) {
    setStatus("");
    return;
  }
  pending.length = 0;
  activeShotId = "";
  // 历史轮次里的图片也要一起清掉，否则下一轮请求仍然会把这些 base64 发出去：
  // 界面说「已清空」、模型却还看得到，而且每轮请求体积越滚越大。
  history.forEach((turn) => {
    if (turn.images) delete turn.images;
    if (turn.imageCount) delete turn.imageCount;
  });
  renderPending();
  setStatus("");
}

async function newQuestion() {
  if (savingSession) return;
  if (streaming) {
    setStatus("正在生成，稍候。");
    return;
  }
  const hadHistory = history.length > 0;
  // 服务确认持久化之后再清空；离线或存储失败时原会话仍可阅读、重试。
  if (hadHistory) {
    savingSession = true;
    setStatus("正在保存会话…");
    try {
      await saveSessionRecord({ turns: history, note: "", startedAt: sessionStartedAt });
    } catch (error) {
      setStatus(`会话保存失败，已保留当前内容：${error.message || error}`);
      return;
    } finally {
      savingSession = false;
    }
  }
  closeLightbox();
  thread.querySelectorAll(".liuwa-turn").forEach((turn) => turn.remove());
  history.length = 0;
  pending.length = 0;
  activeShotId = "";
  nextShotId = 1;
  sessionStartedAt = new Date().toISOString();
  resetReading();
  renderPending();
  setStatus("");
}
window.addEventListener("focus", refreshContext);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshContext();
});

syncEmpty();
refreshContext();

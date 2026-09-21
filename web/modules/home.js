import { fallbackGatewayOrigins, state } from "./state.js";

const thread = document.querySelector("#liuwaThread");
const idle = document.querySelector("#liuwaIdle");
const shots = document.querySelector("#liuwaShots");
const note = document.querySelector("#liuwaNote");
const statusNode = document.querySelector("#liuwaStatus");
const fileInput = document.querySelector("#liuwaFiles");
const hintCapture = document.querySelector("#hintCapture");
const hintSend = document.querySelector("#hintSend");
const hintShow = document.querySelector("#hintShow");
const hintHide = document.querySelector("#hintHide");
const hintQuit = document.querySelector("#hintQuit");

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
  shots.hidden = pending.length === 0;
  shots.innerHTML = pending
    .map(
      (shot) =>
        `<figure class="liuwa-thumb" data-shot="${escapeHtml(shot.id)}">
          <img src="${escapeHtml(shot.dataUrl)}" alt="待发送截图" />
          <button type="button" data-remove="${escapeHtml(shot.id)}" aria-label="去掉这张图">×</button>
        </figure>`
    )
    .join("");
  syncEmpty();
}

function addShot(dataUrl) {
  if (pending.length >= 8) {
    setStatus("一次最多带 8 张图。");
    return;
  }
  pending.push({ id: String(nextShotId), dataUrl });
  nextShotId += 1;
  renderPending();
  setStatus(`已放入 ${pending.length} 张。`);
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
      const response = await fetch(`${origin}/health`, { cache: "no-store" });
      if (!response.ok) {
        failures.push(`${origin}: HTTP ${response.status}`);
        continue;
      }
      const payload = await response.json();
      if (payload.service !== "shuihuo-killer-gateway") {
        failures.push(`${origin}: 不是六娃 gateway`);
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

function appendUserTurn(images, text) {
  const article = document.createElement("article");
  article.className = "liuwa-turn is-user";
  const gallery = images
    .map((url) => `<img src="${escapeHtml(url)}" alt="截图" />`)
    .join("");
  article.innerHTML = `
    ${gallery ? `<div class="liuwa-gallery">${gallery}</div>` : ""}
    ${text ? `<p>${escapeHtml(text)}</p>` : ""}
  `;
  thread.append(article);
}

function appendAssistantTurn() {
  const article = document.createElement("article");
  article.className = "liuwa-turn is-assistant is-stream";
  const body = document.createElement("p");
  body.className = "liuwa-stream";
  article.append(body);
  thread.append(article);
  return body;
}

async function readSse(response, onDelta) {
  if (!response.body) {
    throw new Error("浏览器无法读取流式响应");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  while (!completed) {
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
}

async function sendChat() {
  if (streaming) return;
  const images = pending.splice(0, pending.length).map((shot) => shot.dataUrl);
  const text = note ? note.value.trim() : "";
  renderPending();
  if (!images.length && !text) {
    setStatus("先截一张屏，或写一句再发送。");
    return;
  }
  streaming = true;
  document.body.classList.add("is-busy");
  setStatus("六娃正在看…");
  appendUserTurn(images, text);
  const streamNode = appendAssistantTurn();
  syncEmpty();
  thread.scrollTop = thread.scrollHeight;
  if (note) note.value = "";
  let reply = "";
  try {
    await ensureGateway();
    const response = await fetch(`${state.apiOrigin}/api/chat/stream`, {
      method: "POST",
      headers: authHeaders({
        "content-type": "application/json",
        accept: "text/event-stream",
      }),
      body: JSON.stringify({
        text,
        images,
        history: history.slice(-16),
      }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(detail.slice(0, 240) || `HTTP ${response.status}`);
    }
    await readSse(response, (delta) => {
      reply += delta;
      streamNode.textContent = reply;
      thread.scrollTop = thread.scrollHeight;
    });
    streamNode.parentElement.classList.remove("is-stream");
    history.push({ role: "user", text: text || "（截图）" });
    history.push({ role: "assistant", text: reply });
    setStatus("");
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    streamNode.textContent = reply || `没发出去：${message}`;
    streamNode.parentElement.classList.add("is-error");
    setStatus(message);
  } finally {
    streaming = false;
    document.body.classList.remove("is-busy");
  }
}

function applyHotkeyHints(cfg) {
  const byAction = new Map((cfg.hotkeys || []).map((binding) => [binding.action, binding]));
  const apply = (node, action) => {
    const binding = byAction.get(action);
    if (node && binding && binding.display) node.textContent = binding.display;
  };
  apply(hintCapture, "captureScreen");
  apply(hintSend, "sendChat");
  apply(hintShow, "showWindow");
  apply(hintHide, "hideWindow");
  apply(hintQuit, "quitApp");
}

function wireDesktop(cockpit) {
  document.documentElement.classList.add("liuwa-host");
  document.body.classList.add("liuwa-shell");
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
      if (cfg && cfg.gatewayApiKey) state.gatewayApiKey = cfg.gatewayApiKey;
    });
  }
}

shots?.addEventListener("click", (event) => {
  const id = event.target.closest("[data-remove]")?.dataset.remove;
  if (id) removeShot(id);
});

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

fileInput?.addEventListener("change", (event) => {
  Array.from(event.target.files || []).forEach((file) => {
    const reader = new FileReader();
    reader.onload = () => addShot(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
  event.target.value = "";
});

if (typeof window.__GATEWAY_KEY__ === "string" && window.__GATEWAY_KEY__.trim()) {
  state.gatewayApiKey = window.__GATEWAY_KEY__.trim();
}
if (window.cockpit) wireDesktop(window.cockpit);
syncEmpty();
ensureGateway().catch((error) => setStatus(error.message || "未连上本地服务"));

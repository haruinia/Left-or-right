import "./protected-controls.js";
import { formatAccelerator, acceleratorFromEvent } from "./shortcuts.js";
import { fallbackGatewayOrigins, state } from "./state.js";
import { saveSessionRecord } from "./session-store.js";
import { saveExamRecord } from "./exam-store.js";
import { renderAnswer, stepAnswerTab, exportAnswerReadingState, restoreAnswerReadingState } from "./answer-view.js";
import { closeLightbox, isLightboxOpen, openLightbox } from "./lightbox.js";
import { page, resetReading } from "./reading.js";
import { syncSections, jumpToSection } from "./answer-navigation.js";
import { applyDisplay } from "./display.js";
import { mountInterviewOverlay } from './interview-overlay.js';
import { createInterviewRecording } from './interview-recording.js';
import './quick-settings.js';

const thread = document.querySelector("#liuwaThread");
const interviewStack = document.querySelector("#liuwaInterviewStack");
const idle = document.querySelector("#liuwaIdle");
const shots = document.querySelector("#liuwaShots");
const statusNode = document.querySelector("#liuwaStatus");
const hintCapture = document.querySelector("#hintCapture");
const pagination = document.querySelector("#liuwaPagination");
const readingPrev = document.querySelector("#liuwaReadingPrev");
const readingNext = document.querySelector("#liuwaReadingNext");
const sections = document.querySelector("#liuwaSections");
const questionSelect = document.querySelector("#liuwaQuestions");
const toggleShots = document.querySelector("#liuwaToggleShots");

// 当前会话里已经问过的题。回答区一次只渲染一道题，但可以直接切回上一题，
// 不必重新截图或重新请求模型。重置/新题时随会话一起清空。
const questions = [];
let viewedQuestionId = "";
let nextQuestionId = 1;

function rememberReadingPosition() {
  const entry = questions.find((question) => question.id === viewedQuestionId);
  const box = thread?.querySelector('.liuwa-stream');
  if (!entry || !box) return;
  entry.scrollTop = box.scrollTop || 0;
  entry.panel = box.dataset.answerPanel || '';
  entry.readingState = exportAnswerReadingState(box);
}

function syncQuestionSelector() {
  if (!questionSelect) return;
  questionSelect.hidden = questions.length < 2;
  const signature = questions.map((question) => question.id).join('|');
  if (questionSelect.dataset.questions !== signature) {
    questionSelect.replaceChildren(
      ...questions.map((question, index) => new Option(
        `第 ${index + 1} 题${question.partial ? '（已中断）' : ''}`,
        question.id,
      )),
    );
    questionSelect.dataset.questions = signature;
  }
  questionSelect.value = viewedQuestionId;
  // 生成中切题会把流式内容留在已移除的节点里，等这一轮结束再允许切换。
  questionSelect.disabled = streaming;
}

function showQuestion(entry, { restoreContext = false } = {}) {
  if (!entry) return;
  viewedQuestionId = entry.id;
  showQuestionText(entry.text || '');
  thread.querySelectorAll('.liuwa-turn').forEach((turn) => turn.remove());
  const body = appendAssistantTurn();
  renderAnswer(entry.markdown, body, {complete: true});
  // 分区按钮在上一步才建好；恢复用户上次看到的分区与位置。
  if (entry.panel) {
    document.querySelector(`#liuwaAnswerTabs [data-panel="${entry.panel}"]`)?.click();
  }
  const restoredScroll = entry.scrollTop || 0;
  // 顶部的题图属于当前这道题：切题时换成它当时的截图，避免图和答案对不上。
  // 只替换「已发送」的历史截图，用户还没发的新截图必须保留。
  if (!restoreContext) {
    const drafts = pending.filter((shot) => !shot.sent);
    pending.length = 0;
    (entry.shots || []).forEach((dataUrl) => pending.push({ id: String(nextShotId++), dataUrl, sent: true }));
    drafts.forEach((shot) => pending.push(shot));
    activeShotId = "";
    if (pending.length) shotsExpanded = true;
  }
  renderPending();
  syncQuestionSelector();
  syncReadingControls();
  syncEmpty();
  if (entry.readingState) restoreAnswerReadingState(body, entry.readingState);
  else body.scrollTop = restoredScroll;
}

// 截图题解固定在当前阅读位置；自动追尾只适用于实时语音面板。
function syncReadingControls() {
  if (chatMode === 'interview') {
    const hasAnswer = interviewEntries.some(entry => entry.body.dataset.hasAnswer === 'true');
    if (readingPrev) { readingPrev.disabled = !hasAnswer; readingPrev.title = '向上查看面试回答'; }
    if (readingNext) { readingNext.disabled = !hasAnswer; readingNext.title = '向下查看面试回答'; }
    return;
  }
  const hasAnswer = thread?.querySelector(".liuwa-stream")?.dataset.hasAnswer === 'true';
  const tabs = document.querySelector("#liuwaAnswerTabs");
  const tabButtons = tabs && !tabs.hidden ? Array.from(tabs.querySelectorAll("button[data-panel]")).filter(b => !b.hidden) : [];
  const hasTabs = tabButtons.length >= 2;
  if (readingPrev) {
    readingPrev.disabled = !hasAnswer;
    readingPrev.title = hasTabs ? "切换到上一小节 (⌘,)" : "向上翻页 (⌘,)";
  }
  if (readingNext) {
    readingNext.disabled = !hasAnswer;
    readingNext.title = hasTabs ? "切换到下一小节 (⌘.)" : "向下翻页 (⌘.)";
  }
  syncSections(thread?.querySelector('.liuwa-stream'), sections);
}

function stepReading(direction) {
  const delta = typeof direction === "string" ? (direction === "prev" ? -1 : 1) : (direction < 0 ? -1 : 1);
  if (chatMode !== 'interview' && stepAnswerTab(delta)) return;
  page(delta);
}

const pending = [];
const history = [];
let streaming = false;
let savingSession = false;
let nextShotId = 1;
let currentModel = "";
let activeShotId = "";
let shotsExpanded = true;
let surfaceSignature = '';
let resetAccelerator = 'CommandOrControl+R';
let sessionStartedAt = new Date().toISOString();
let chatMode = 'screenshot';
let sessionRecordId = '';
let interviewSaveTask = Promise.resolve();

function persistInterviewAnswer() {
  const id = sessionRecordId ||= `interview_qa_${crypto.randomUUID()}`;
  const turns = history.map(turn => ({ ...turn, ...(turn.images ? { images: turn.images.slice() } : {}) }));
  const startedAt = sessionStartedAt;
  interviewSaveTask = interviewSaveTask.then(() => saveSessionRecord({ id, turns, startedAt, note: '面试问答' })).catch(() => {
    if (chatMode === 'interview' && sessionRecordId === id) setStatus('问答保存失败，当前内容仍保留；重置时会重试保存。');
  });
}
let interviewOverlay = null;
let switchingMode = false;
let modeSwitchTask = Promise.resolve();
const modeContexts = new Map();
const captureGenerations = new Map();
const currentQuestion = document.querySelector('#liuwaCurrentQuestion');
let interviewRunId = '';
let activeResetTask = null;

function emptyModeContext() {
  return { history: [], questions: [], viewedQuestionId: '', nextQuestionId: 1, pending: [], nextShotId: 1, activeShotId: '', shotsExpanded: true, sessionStartedAt: new Date().toISOString(), sessionRecordId: '' };
}

function beginInterviewSession(conversationId) {
  interviewRunId = conversationId;
  return Promise.resolve(true);
}

function showQuestionText(text = '') {
  if (!currentQuestion) return;
  currentQuestion.textContent = text;
  currentQuestion.hidden = !text;
}

function setChatMode(next) {
  if (!['screenshot', 'interview'].includes(next)) return Promise.resolve(false);
  modeSwitchTask = modeSwitchTask.then(async () => {
    if (next === chatMode) { document.querySelector('#liuwaDisplay').open = false; return true; }
    if (savingSession || resetting) { document.querySelector('#quickMode').value = chatMode; return false; }
    switchingMode = true;
    document.querySelector('#quickMode').disabled = true;
    try {
      stopChat();
      if (activeSendTask) await activeSendTask;
      rememberReadingPosition();
      modeContexts.set(chatMode, { history: history.slice(), questions: questions.slice(), viewedQuestionId, nextQuestionId, pending: pending.slice(), nextShotId, activeShotId, shotsExpanded, sessionStartedAt, sessionRecordId, stack: snapshotInterviewStack() });
      const restored = modeContexts.get(next) || emptyModeContext();
      history.splice(0, history.length, ...restored.history);
      questions.splice(0, questions.length, ...restored.questions);
      pending.splice(0, pending.length, ...restored.pending);
      ({ viewedQuestionId, nextQuestionId, nextShotId, activeShotId, shotsExpanded, sessionStartedAt, sessionRecordId } = restored);
      chatMode = next;
      sessionGeneration += 1;
      captureGenerations.clear();
      closeLightbox();
      document.body.classList.toggle('interview-mode', next === 'interview');
      restoreInterviewStack(next === 'interview');
      document.querySelector('#quickMode').value = next;
      document.querySelector('#liuwaDisplay').open = false;
      document.querySelector('#liuwaSendLabel').textContent = next === 'interview' ? '回答' : '解题';
      document.querySelector('#liuwaInterviewViewLabel').textContent = next === 'interview' ? '笔试' : '面试';
      document.querySelector('#liuwaDelete').hidden = next === 'interview';
      interviewOverlay?.setMode(next);
      thread.querySelectorAll('.liuwa-turn').forEach(turn => turn.remove());
      const tabs = document.querySelector('#liuwaAnswerTabs');
      tabs.hidden = true; tabs.replaceChildren(); delete tabs.dataset.signature;
      delete questionSelect.dataset.questions;
      showQuestionText();
      const entry = questions.find(question => question.id === viewedQuestionId);
      if (next === 'interview') {
        showQuestionText(entry?.text || '');
        renderPending(); syncQuestionSelector(); syncEmpty();
        restoreInterviewStack(true);
      } else if (entry) showQuestion(entry, { restoreContext: true });
      else { renderPending(); syncQuestionSelector(); syncEmpty(); }
      setStatus('');
      return true;
    } finally {
      switchingMode = false;
      document.querySelector('#quickMode').disabled = false;
      interviewOverlay?.refresh();
    }
  }).catch(error => { setStatus(error.message || '工作模式未能切换。'); return false; });
  return modeSwitchTask;
}

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
  window.cockpit?.setSurface?.({notice:Boolean(text)}).then(applyDisplay).catch(()=>{});
}

function syncEmpty() {
  const hasTurns = Boolean(thread && thread.querySelector(".liuwa-turn"));
  // 面试的回答在堆叠容器里，不在单题 thread 里；漏掉它会让整页一直停留在空态。
  const hasStacked = chatMode === 'interview' && interviewEntries.length > 0;
  // 只有「一条对话都没有」才算空。截了图但还没发送时，之前也算非空——
  // 结果 idle 被藏起来、thread 又是空的，整块区域一片空白，只剩 dock 里一张缩略图。
  const empty = chatMode === 'interview' ? !hasStacked : !hasTurns;
  syncInterviewStackVisibility();
  document.body.classList.toggle("is-empty", empty);
  if (idle) idle.hidden = !empty;
  if (pagination) pagination.hidden = chatMode === 'interview' || empty;
  const answerCount = document.querySelector('#liuwaInterviewAnswerCount');
  if (answerCount) answerCount.textContent = interviewEntries.length ? String(interviewEntries.length) : '';
  if (empty) document.querySelector('#liuwaAnswerTabs').hidden = true;
  syncReadingControls();
  const surface = {answer:!empty,shotCount:shotsExpanded ? pending.length : 0,interview:chatMode === 'interview',transcriptOpen:chatMode === 'interview' && document.querySelector('#liuwaTranscript').open};
  const signature = JSON.stringify(surface);
  if(signature !== surfaceSignature) {
    const previous = surfaceSignature ? JSON.parse(surfaceSignature) : null;
    if(!previous || previous.answer !== surface.answer || previous.interview !== surface.interview) applyDisplay({compact:!(surface.answer || surface.interview),answer:surface.answer});
    surfaceSignature = signature;
    window.cockpit?.setSurface?.(surface).then(applyDisplay).catch(()=>setStatus('窗口显示状态未能更新。'));
  }
}

function renderPending() {
  if (!shots) return;
  syncActiveShot();
  shots.hidden = pending.length === 0 || !shotsExpanded;
  if (toggleShots) {
    toggleShots.hidden = pending.length === 0;
    toggleShots.textContent = `${shotsExpanded ? '收起' : '查看'}题图（${pending.length}）`;
    toggleShots.setAttribute('aria-expanded', String(shotsExpanded));
  }
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

function addShots(dataUrls, generation = sessionGeneration) {
  // 截图和文件读取是异步的：重置后到达的旧结果不能落进新会话。
  if (generation !== sessionGeneration || !dataUrls.length) return;
  if (savingSession) {
    setStatus("正在保存会话，请稍候。");
    return;
  }
  if (streaming) {
    setStatus("正在生成回答，请结束后重新截图。");
    return;
  }
  if (dataUrls.some(dataUrl=>!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(dataUrl))) {
    setStatus("请选择 PNG、JPEG、WebP 或 GIF 图片。");
    return;
  }
  if (pending.length + dataUrls.length > 8) {
    setStatus(`本次包含 ${dataUrls.length} 张图，当前已有 ${pending.length} 张；一次最多带 8 张图，请先删图后重新截图。`);
    return;
  }
  for(const dataUrl of dataUrls) pending.push({ id: String(nextShotId++), dataUrl });
  shotsExpanded = true;
  renderPending();
  setStatus("");
}

function addShot(dataUrl, generation = sessionGeneration) {
  addShots([dataUrl], generation);
}

function receiveCapture(payload, generation = sessionGeneration) {
  if(generation !== sessionGeneration)return;
  const images=Array.isArray(payload?.images) ? payload.images : payload?.data ? [payload] : [];
  if(images.some(image=>!image || typeof image.data !== 'string' || !image.data)) {
    setStatus('截图数据不完整，请重新截图。');return;
  }
  addShots(images.map(image=>`data:${image.mime || 'image/png'};base64,${image.data}`),generation);
}

function readImageFile(file) {
  const generation = sessionGeneration;
  const reader = new FileReader();
  reader.onload = () => addShot(String(reader.result || ""), generation);
  reader.readAsDataURL(file);
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

async function ensureGateway(signal) {
  const failures = [];
  for (const origin of uniqueOrigins()) {
    try {
      const timeout = AbortSignal.timeout(3500);
      const response = await fetch(`${origin}/health`, { cache: "no-store", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
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
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      failures.push(`${origin}: ${error && error.message ? error.message : error}`);
    }
  }
  throw new Error(failures.join("；") || "无法连接本地服务");
}


// ===== 面试回答堆叠 =====
// 面试与笔试分开：笔试一次只读一道题，面试把所有回答按时间倒序留在右侧，
// 方便边听边往回翻。流式生成的那一条固定在最上面，完成后变成普通条目。
const interviewEntries = [];


function stackEntryLabel(entry) {
  const time = entry.createdAt ? new Date(entry.createdAt) : null;
  const stamp = time && !Number.isNaN(time.valueOf())
    ? time.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : '';
  return stamp ? `回答 #${entry.number} · ${stamp}` : `回答 #${entry.number}`;
}

function paintStackLabels() {
  if (!interviewStack) return;
  for (const entry of interviewEntries) {
    const node = entry.node.querySelector('.liuwa-stack-head span');
    if (node) node.textContent = stackEntryLabel(entry);
    entry.node.classList.toggle('is-stopped', Boolean(entry.stoppedMarker));
    if (entry.stoppedMarker && entry.node.dataset.stoppedLabel !== entry.stoppedMarker) {
      entry.node.dataset.stoppedLabel = entry.stoppedMarker;
    }
  }
}

function appendInterviewAnswer({ generating = false, question = '' } = {}) {
  if (!interviewStack) return null;
  const entry = {
    number: interviewEntries.length + 1,
    createdAt: Date.now(),
    node: document.createElement('article'),
    stoppedMarker: '',
  };
  entry.node.className = `liuwa-stack-entry${generating ? ' is-stream' : ''}`;
  entry.node.id = `interview-answer-${entry.number}`;
  const head = document.createElement('header');
  head.className = 'liuwa-stack-head';
  const label = document.createElement('span');
  const tabs = document.createElement('div');
  tabs.className = 'liuwa-answer-tabs liuwa-stack-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.hidden = true;
  head.append(label, tabs);
  const body = document.createElement('div');
  body.className = 'liuwa-stream md';
  body.hidden = generating;
  entry.body = body;
  const prompt = document.createElement('p');
  prompt.className = 'liuwa-stack-question';
  prompt.textContent = question;
  prompt.hidden = !question;
  entry.node.append(head, prompt, body);
  if (generating) {
    // runChat 需要这个节点来收起等待提示；笔试的卡片里有，堆叠条目也要有。
    const waiting = document.createElement('div');
    waiting.className = 'liuwa-analysis-status';
    waiting.setAttribute('role', 'status');
    const spinner = document.createElement('span');
    spinner.className = 'liuwa-analysis-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = '正在分析题目…';
    waiting.append(spinner, label);
    entry.node.insertBefore(waiting, body);
  }
  const top = interviewStack.scrollTop, height = interviewStack.scrollHeight;
  interviewStack.prepend(entry.node);
  if (top > 0) interviewStack.scrollTop = top + interviewStack.scrollHeight - height;
  interviewEntries.push(entry);
  paintStackLabels();
  syncEmpty();
  return entry;
}


function snapshotInterviewStack() {
  return { scrollTop: interviewStack?.scrollTop || 0 };
}

function restoreInterviewStack(enabled) {
  syncInterviewStackVisibility();
  if (enabled && interviewStack) interviewStack.scrollTop = modeContexts.get('interview')?.stack?.scrollTop || 0;
}

function clearInterviewStack() {
  interviewEntries.length = 0;
  if (interviewStack) interviewStack.replaceChildren();
  syncEmpty();
}

// 切换到面试视图时显示堆叠、隐藏单题阅读区；回到笔试反之。
function syncInterviewStackVisibility() {
  if (!interviewStack) return;
  const stacking = chatMode === 'interview';
  interviewStack.hidden = !stacking;
  if (thread) thread.hidden = stacking && interviewEntries.length > 0;
  if (stacking && interviewEntries.length === 0 && thread) thread.hidden = false;
}

function authHeaders(headers = {}) {
  return state.gatewayApiKey ? { ...headers, "X-API-Key": state.gatewayApiKey } : headers;
}

function appendAssistantTurn({ generating = false } = {}) {
  if (sections) { sections.value = ''; delete sections.dataset.sections; }
  const tabs = document.querySelector('#liuwaAnswerTabs');
  if(tabs) { tabs.hidden = true; tabs.replaceChildren(); delete tabs.dataset.signature; }
  // 主面板只展示当前题解；历史保留在 history，不能挤占下一题的阅读高度。
  thread.querySelectorAll(".liuwa-turn").forEach((turn) => turn.remove());
  const article = document.createElement("article");
  article.className = `liuwa-turn is-assistant${generating ? " is-stream" : ""}`;
  if (generating) {
    const waiting = document.createElement("div");
    waiting.className = "liuwa-analysis-status";
    waiting.setAttribute("role", "status");
    const spinner = document.createElement("span");
    spinner.className = "liuwa-analysis-spinner";
    spinner.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = "正在分析题目…";
    waiting.append(spinner, label);
    article.append(waiting);
  }
  const body = document.createElement("div");
  body.className = "liuwa-stream md";
  body.hidden = generating;
  article.append(body);
  thread.append(article);
  resetReading();
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
      // 读完这一块后如果用户已经按下停止，立即退出，不再等待下一段。
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    }
  } catch (error) {
    // 用户主动停止时抛出 AbortError，让调用方走「保留已生成内容」的分支。
    // 之前这里静默 return，停止被当成正常完成，界面上看不出区别。
    if (signal?.aborted || error?.name === "AbortError") {
      throw new DOMException("aborted", "AbortError");
    }
    throw error;
  } finally {
    // 主动停止或出错时释放读取锁，避免连接一直挂在后台。
    reader.cancel().catch(() => {});
  }
  if (!completed) throw new Error("回答中断，请重新发送。");
}

let activeAbort = null;
// 会话世代：重置后递增，迟到完成的截图和文件读取结果据此丢弃。
let sessionGeneration = 0;

// 停止或出错时保留模型已经生成的内容，并标记这一轮，方便用户继续阅读。
function finalizeStopped(streamNode, reply, assistantTurn, marker = "（已中断）") {
  // 中断标记挂在卡片上，正文保留模型已经生成的内容。
  const stackEntry = interviewEntries.find(entry => entry.body === streamNode);
  if (stackEntry) {
    stackEntry.stoppedMarker = marker;
    stackEntry.node.classList.add('is-stopped');
    stackEntry.node.dataset.stoppedLabel = marker;
  }
  assistantTurn.classList.add("is-stopped");
  assistantTurn.dataset.stoppedLabel = marker;
  renderAnswer(reply, streamNode, {complete:true});
  assistantTurn.classList.remove("is-stream");
}

// 停止生成要能打断重试等待，否则最长还要再等 7 秒才退出。
function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
        await abortableSleep(delay, options?.signal);
        continue;
      }
      throw new Error(detail || `发送失败，请检查服务后重试（${response.status}）。`);
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error, lastStatus)) throw error;
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        setStatus(`网络异常，${delay / 1000} 秒后重试（${attempt + 1}/${maxRetries}）…`);
        await abortableSleep(delay, options?.signal);
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error("发送失败，请检查网络后重试。");
}

let activeSendTask = null;
let activeRequest = null;
let queuedInterviewRequest = null;
let replacingInterviewTask = null;
function sendChat(request = {}) {
  if (resetting || savingSession) return Promise.resolve(false);
  if (switchingMode) return modeSwitchTask.then(() => sendChat(request));
  if (request.context === 'interview' && chatMode !== 'interview') return Promise.resolve(false);
  if (chatMode === 'interview' && typeof request.text !== 'string') request = { ...interviewOverlay?.question(), interview_extra: interviewOverlay?.extra?.() || '' };
  const text = typeof request.text === 'string' ? request.text.trim() : '';
  if (text.length > 8000) { setStatus('问题较长，请在转录中选择具体一条。'); return Promise.resolve(false); }
  if (chatMode === 'interview' && request.run_id && request.run_id !== interviewRunId) return Promise.resolve(false);
  const transcript = request.interview_transcript || interviewOverlay?.transcript() || [];
  const snapshot = { ...request, text, interview_extra: typeof request.interview_extra === 'string' ? request.interview_extra : interviewOverlay?.extra?.() || '', context: chatMode === 'interview' ? 'interview' : 'study', interview_role: request.interview_role || interviewOverlay?.role() || 'candidate', interview_transcript: transcript.map(item => ({ source: item.source, speaker: item.speaker, text: item.text, segment_id: item.segment_id || '' })) };
  if (activeSendTask) {
    if (snapshot.context !== 'interview' || (activeRequest?.text === snapshot.text && activeRequest?.interview_role === snapshot.interview_role)) return activeSendTask;
    queuedInterviewRequest = snapshot;
    activeAbort?.abort();
    if (!replacingInterviewTask) replacingInterviewTask = (async () => {
      while (queuedInterviewRequest) {
        if (activeSendTask) await activeSendTask;
        const next = queuedInterviewRequest; queuedInterviewRequest = null;
        if (!next || chatMode !== 'interview' || switchingMode || resetting) break;
        await sendChat(next);
      }
    })().finally(() => { replacingInterviewTask = null; });
    return replacingInterviewTask;
  }
  activeRequest = snapshot;
  activeSendTask = runChat(snapshot).finally(() => { activeSendTask = null; activeRequest = null; interviewOverlay?.finished(snapshot); interviewOverlay?.refresh(); });
  return activeSendTask;
}

async function runChat(request) {
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
  // 只发送本次还没发过的截图。切回历史题只是为了查看，旧图不能混进新请求。
  const unsentShots = pending.filter((shot) => !shot.sent);
  const images = unsentShots.map((shot) => shot.dataUrl);
  const unsent = images;
  renderPending();
  if (!unsent.length && !request.text) {
    setStatus(request.context === 'interview' ? '尚无完整问题，可展开转录选择一句。' : "先截一张屏。");
    return;
  }
  const requestGeneration = sessionGeneration;
  const requestMode = chatMode;
  const previousQuestion = questions.find(question => question.id === viewedQuestionId);
  streaming = true;
  if (request.context === 'interview') interviewOverlay?.begin(request);
  interviewOverlay?.refresh();
  const controller = new AbortController();
  activeAbort = controller;
  // 长答案现在可以输出到 16k tokens，给足时间；超时和手动停止要区分开。
  let timedOut = false;
  const timeoutGuard = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 600_000);
  document.body.classList.add("is-busy");
  syncQuestionSelector();
  setStatus("");
  shots.querySelectorAll("[data-remove]").forEach((button) => { button.disabled = true; });
  rememberReadingPosition();
  showQuestionText(request.text);
  const stacked = request.context === 'interview' && Boolean(interviewStack);
  const stackEntry = stacked ? appendInterviewAnswer({ generating: true, question: request.text }) : null;
  const streamNode = stackEntry ? stackEntry.body : appendAssistantTurn({ generating: true });
  const assistantTurn = streamNode.parentElement;
  const waiting = assistantTurn.querySelector('.liuwa-analysis-status');
  syncEmpty();
  let reply = "";
  let hasBodyOutput = false;
  let flushTimer = null;
  const flush = (complete = false) => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    const answer = renderAnswer(reply, streamNode, {complete});
    const hasContent = Boolean(answer.full.replace(/^#{1,6}[^\n]*$/gm, '').trim());
    hasBodyOutput = hasBodyOutput || hasContent;
    waiting.hidden = hasBodyOutput || complete;
    streamNode.hidden = !hasBodyOutput && !complete;
    if (hasContent) streamNode.dataset.hasContent = 'true';
    if (!hasBodyOutput) document.querySelector('#liuwaAnswerTabs').hidden = true;
    if (pagination) pagination.hidden = request.context === 'interview' || !hasBodyOutput;
    syncReadingControls();
  };
  const commitTurn = (complete = true) => {
    // 部分回答虽需保留，但不能把待处理截图标成完成，否则连接中断后再按处理键无效。
    if (complete) unsentShots.forEach((shot) => { shot.sent = true; });
    // 每道题在本次会话里留一份完整 Markdown，题目选择器靠它切回旧题。
    const entry = {
      id: String(nextQuestionId++),
      markdown: reply,
      text: request.text,
      context: request.context,
      partial: !complete,
      scrollTop: 0,
      panel: '',
      shots: unsent.slice(),
    };
    renderPending();
    questions.push(entry);
    const stackedEntry = interviewEntries.find(item => item.body === streamNode);
    if (stackedEntry) { stackedEntry.markdown = reply; stackedEntry.node.classList.remove('is-stream'); }
    viewedQuestionId = entry.id;
    syncQuestionSelector();
    history.push({
      role: "user",
      text: request.text || (request.context === 'interview' ? '请回答这道面试题' : '请讲解这道截图题目'),
      images: unsent.slice(0, 3),
      imageCount: unsent.length,
    });
    history.push({ role: "assistant", text: reply, partial: !complete });
    // 每次问答独立存一条笔试记录：题目缩略图 + 发送内容 + 模型回答，
    // 失败静默（记录属于增值功能，不能影响主流程）。
    if (request.context === 'interview') {
      interviewOverlay?.committed(request);
      persistInterviewAnswer();
      return;
    }
    saveExamRecord({
      images: unsent.slice(0, 3),
      query: "请讲解这道截图题目",
      answer: reply,
      model: currentModel,
      partial: !complete,
      startedAt: sessionStartedAt,
    }).catch(() => {});
  };
  // Coalesce tokens: flush at a sentence boundary at once, otherwise on a 90ms timer.
  const onDelta = (delta) => {
    reply += delta;
    if (/[。！？!?；;]\s*$|\n$/.test(reply)) { flush(); return; }
    if (!flushTimer) flushTimer = setTimeout(flush, 90);
  };
  try {
    await ensureGateway(controller.signal);
    if (controller.signal.aborted) throw new DOMException("aborted", "AbortError");
    const response = await fetchWithRetry(`${state.apiOrigin}/api/chat/stream`, {
      method: "POST",
      signal: controller.signal,
      headers: authHeaders({
        "content-type": "application/json",
        accept: "text/event-stream",
      }),
      body: JSON.stringify({
        text: request.text,
        context: request.context,
        ...(request.context === 'interview' ? {
          interview_role: request.interview_role,
          interview_transcript: request.interview_transcript,
          ...(request.interview_target ? { interview_target: request.interview_target } : {}),
          ...(request.interview_task === 'solve' ? { interview_task: 'solve' } : {}),
          ...(request.interview_extra ? { interview_extra: request.interview_extra } : {}),
        } : {}),
        images,
        history: history.slice(-16).map((turn) => ({ role: turn.role, text: turn.text.slice(0, 8000) })),
      }),
    });
    await readSse(response, onDelta, controller.signal);
    flush(true);
    if (!hasBodyOutput) throw new Error("模型没有返回内容，请重试或检查模型接入配置。");
    assistantTurn.classList.remove("is-stream");
    commitTurn();
    setStatus("");
  } catch (error) {
    clearTimeout(flushTimer);
    flush(true);
    const aborted = (controller.signal.aborted || error?.name === "AbortError") && !timedOut;
    const rawMessage = error && error.message ? error.message : String(error);
    const message = timedOut
      ? "生成时间过长已停止，已生成的内容会保留。"
      : /RemoteProtocolError|incomplete chunked read|peer closed connection/i.test(rawMessage)
        ? "模型连接中断，可重新处理当前截图。"
        : rawMessage;
    if (hasBodyOutput) {
      // 已经流出一大段内容：不管是主动停止还是中途报错，都保留下来。
      // 之前只有「主动停止」保留，报错会把用户眼看着生成的整段解析删掉。
      finalizeStopped(streamNode, reply, assistantTurn, aborted ? "（已中断）" : `（中断：${message}）`);
      commitTurn(false);
      setStatus(aborted ? "已停止。" : message);
    } else {
      assistantTurn.remove();
      if (stackEntry) {
        interviewEntries.splice(interviewEntries.indexOf(stackEntry), 1);
        showQuestionText(previousQuestion?.text || '');
        syncEmpty();
      } else if (previousQuestion && requestGeneration === sessionGeneration && requestMode === chatMode && !switchingMode && !resetting && !queuedInterviewRequest) showQuestion(previousQuestion, { restoreContext: true });
      else syncEmpty();
      setStatus(aborted ? "已停止。" : message);
    }
  } finally {
    clearTimeout(timeoutGuard);
    // 旧请求的收尾不能清除新一轮生成状态。
    if (activeAbort === controller) {
      streaming = false;
      activeAbort = null;
      document.body.classList.remove("is-busy");
    }
    if (assistantTurn.isConnected) assistantTurn.classList.remove("is-stream");
    renderPending();
    syncQuestionSelector();
  }
}

function stopChat() {
  queuedInterviewRequest = null;
  if (streaming && activeAbort) activeAbort.abort();
}

function applyHotkeyHints(cfg) {
  const byAction = new Map((cfg.hotkeys || []).map((binding) => [binding.action, binding]));
  resetAccelerator = byAction.get('resetView')?.accelerator || 'CommandOrControl+R';
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
  document.body.classList.remove("liuwa-armed");
  document.body.inert = true;
  let receivedArmedState = false, receivedEditingState = false;
  let armed = false, textEditing = false, editVersion = 0;
  const editor = document.querySelector('#liuwaInterviewExtraText');
  const updateInteraction = () => {
    document.body.classList.toggle('liuwa-armed', armed);
    document.body.classList.toggle('liuwa-text-editing', textEditing);
    document.body.inert = !armed && !textEditing;
    const isolateEditor = textEditing && !armed;
    document.querySelectorAll('.liuwa-orb > :not(.liuwa-reader), .liuwa-reader > :not(#liuwaInterviewExtra)').forEach(node => { node.inert = isolateEditor; });
  };
  const finishEditing = () => {
    editVersion += 1;
    textEditing = false;
    updateInteraction();
    cockpit.setTextEditing?.(false).catch(() => {});
  };
  editor?.addEventListener('focus', async () => {
    if (!cockpit.setTextEditing) return;
    const version = ++editVersion;
    try {
      const accepted = await cockpit.setTextEditing(true);
      if (version !== editVersion || document.activeElement !== editor || document.hidden) {
        await cockpit.setTextEditing(false);
        return;
      }
      if (!accepted) {
        editor.blur();
        setStatus('请按住操作快捷键点入输入框后编辑。');
      }
    } catch {
      editor.blur();
      setStatus('文本编辑暂时无法启用，请重试。');
    }
  });
  editor?.addEventListener('blur', finishEditing);
  editor?.addEventListener('keydown', event => {
    if (event.isComposing || !['Escape', 'Tab'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    editor.blur();
    if (event.key === 'Escape') {
      document.querySelector('#liuwaInterviewExtra').hidden = true;
      document.querySelector('#liuwaInterviewExtraToggle').setAttribute('aria-expanded', 'false');
    }
  });
  cockpit.onTextEditing?.(value => {
    receivedEditingState = true;
    textEditing = Boolean(value) && document.activeElement === editor && !document.hidden;
    updateInteraction();
    if (value && !textEditing) cockpit.setTextEditing(false).catch(() => {});
  });
  window.addEventListener('app:privacy-hidden', () => { editor?.blur(); finishEditing(); });
  window.addEventListener('pagehide', finishEditing);
  document.addEventListener('visibilitychange', () => { if (document.hidden) { editor?.blur(); finishEditing(); } });
  document.documentElement.classList.add("liuwa-host");
  document.body.classList.add("liuwa-shell");
  cockpit.onHotkeys?.(applyHotkeyHints);
  cockpit.onNewQuestion?.(resetView);
  cockpit.onReset?.(resetView);
  cockpit.onInterviewControl?.(action => interviewOverlay?.control(action));
  cockpit.onClearShots?.(clearShots);
  cockpit.onDeleteLastShot?.(deleteLastShot);
  cockpit.onTheme?.(applyTheme);
  const taggedCaptures = typeof cockpit.onCaptureStart === 'function';
  cockpit.onCaptureStart?.(({ captureId }) => {
    captureGenerations.clear();
    if (typeof captureId === 'string') captureGenerations.set(captureId, sessionGeneration);
  });
  if (typeof cockpit.onCapture === "function") {
    cockpit.onCapture((payload) => {
      const generation = taggedCaptures ? captureGenerations.get(payload?.captureId) : sessionGeneration;
      if (taggedCaptures) captureGenerations.delete(payload?.captureId);
      if (generation === undefined) return;
      receiveCapture(payload, generation);
    });
  }
  if (typeof cockpit.onCaptureError === "function") {
    cockpit.onCaptureError((payload) => {
      if (taggedCaptures && payload?.captureId) {
        const generation = captureGenerations.get(payload.captureId);
        captureGenerations.delete(payload.captureId);
        if (generation !== sessionGeneration) return;
      }
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
      stepReading(direction);
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
      applyDisplay({compact: Boolean(value)});
    });
  }
  if (typeof cockpit.onArmed === "function") {
    cockpit.onArmed((value) => {
      receivedArmedState = true;
      armed = Boolean(value);
      updateInteraction();
    });
  }
  if (typeof cockpit.getConfig === "function") {
    cockpit.getConfig().then((cfg) => {
      if (!receivedArmedState) armed = Boolean(cfg?.armed);
      if (!receivedEditingState) textEditing = Boolean(cfg?.textEditing) && document.activeElement === editor;
      updateInteraction();
      applyHotkeyHints(cfg || {});
      applyTheme(cfg || {});
      applyDisplay(cfg.display || {});
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

readingPrev?.addEventListener("click", () => stepReading(-1));
readingNext?.addEventListener("click", () => stepReading(1));
document.querySelector('#liuwaSend')?.addEventListener('click',()=>sendChat());
document.querySelector('#liuwaInterviewView')?.addEventListener('click',()=>interviewOverlay?.control('view'));
document.querySelector('#liuwaDelete')?.addEventListener('click',deleteLastShot);
document.querySelector('#liuwaReset')?.addEventListener('click',resetView);
document.addEventListener('keydown',event=>{
  if (isLightboxOpen()) return;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const accel = acceleratorFromEvent(event, isMac);
  if(window.cockpit && accel === resetAccelerator) {
    event.preventDefault();resetView();
    return;
  }
  if (!window.cockpit) {
    if (accel === "CommandOrControl+K") {
      event.preventDefault(); interviewOverlay?.control('view');
    } else if (accel === "CommandOrControl+,") {
      event.preventDefault(); stepReading(-1);
    } else if (accel === "CommandOrControl+.") {
      event.preventDefault(); stepReading(1);
    } else if (accel === "CommandOrControl+;") {
      event.preventDefault(); page(-1);
    } else if (accel === "CommandOrControl+'") {
      event.preventDefault(); page(1);
    }
  }
});
document.querySelector('#liuwaCapture')?.addEventListener('click',()=>window.cockpit?.captureExam ? window.cockpit.captureExam() : document.querySelector('#liuwaImageImport').click());
document.querySelector('#liuwaImageImport')?.addEventListener('change',event=>{
  Array.from(event.target.files || []).filter(file=>file.type.startsWith('image/')).forEach(readImageFile);
  event.target.value='';
});
sections?.addEventListener('change', () => jumpToSection(thread?.querySelector('.liuwa-stream'), sections.value));
questionSelect?.addEventListener('change', () => {
  rememberReadingPosition();
  showQuestion(questions.find((question) => question.id === questionSelect.value));
});
// 堆叠条目各自切小节时，把选择记到对应条目上，恢复时才能回到同一小节。
interviewStack?.addEventListener('answer-panel-change', event => {
  const node = event.target?.closest?.('.liuwa-stack-entry');
  const entry = interviewEntries.find(item => item.node === node);
  const panel = event.target?.dataset?.answerPanel;
  if (entry && panel) entry.panel = panel;
});
thread?.addEventListener('answer-panel-change', () => {
  if(sections) { sections.value = ''; delete sections.dataset.sections; }
  // 手动切分区后记下选择，切回这道题时还停在同一个分区。
  const entry = questions.find((question) => question.id === viewedQuestionId);
  const panel = thread?.querySelector('.liuwa-stream')?.dataset.answerPanel;
  if (entry && panel) entry.panel = panel;
  syncReadingControls();
});
toggleShots?.addEventListener('click', () => {
  shotsExpanded = !shotsExpanded;
  renderPending();
});

document.addEventListener("paste", (event) => {
  const items = event.clipboardData ? Array.from(event.clipboardData.items) : [];
  const images = items.filter((item) => item.type.startsWith("image/"));
  if (!images.length) return;
  event.preventDefault();
  images.forEach((item) => {
    const blob = item.getAsFile();
    if (blob) readImageFile(blob);
  });
});

document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", (event) => {
  event.preventDefault();
  Array.from(event.dataTransfer?.files || [])
    .filter((file) => file.type.startsWith("image/"))
    .forEach(readImageFile);
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
    currentModel = config.llm_provider === "mock" ? "" : config.llm_model || "";
  } catch (error) {
    setStatus("本地服务未连接，请启动网关。");
  } finally {
    refreshingContext = false;
  }
}

// ⌘L 只删最后一张截图，不是清空全部。截图发错了想换一张时，
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
  // 切回旧题时顶部题图也跟着切，但不能让它重新变成「待发送」。
  questions.forEach((question) => { question.shots = []; });
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
  if (savingSession) return false;
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
      if (chatMode === 'interview') await interviewSaveTask;
      await saveSessionRecord({ id: sessionRecordId || undefined, turns: history, note: chatMode === 'interview' ? '面试问答' : '', startedAt: sessionStartedAt });
    } catch (error) {
      setStatus(`会话保存失败，已保留当前内容：${error.message || error}`);
      return false;
    } finally {
      savingSession = false;
    }
  }
  closeLightbox();
  // 清空之后才递增世代，让此前发起的截图/读图结果全部失效。
  thread.querySelectorAll(".liuwa-turn").forEach((turn) => turn.remove());
  history.length = 0;
  pending.length = 0;
  sessionGeneration += 1;
  captureGenerations.clear();
  sessionRecordId = '';
  showQuestionText();
  activeShotId = "";
  nextShotId = 1;
  // 题目选择器只覆盖当前这次会话；会话保存后新题从空列表重新开始。
  questions.length = 0;
  if (chatMode === 'interview') clearInterviewStack();
  viewedQuestionId = "";
  nextQuestionId = 1;
  syncQuestionSelector();
  sessionStartedAt = new Date().toISOString();
  resetReading();
  renderPending();
  setStatus("");
  return true;
}
let resetting = false;
function resetView() {
  if (activeResetTask) return activeResetTask;
  activeResetTask = runResetView().finally(() => { activeResetTask = null; });
  return activeResetTask;
}
async function runResetView() {
  if(resetting)return;
  if(switchingMode)await modeSwitchTask;
  resetting=true;
  const resetRunId = interviewOverlay?.runId();
  try {
    stopChat();
    if(activeSendTask)await activeSendTask;
    if(chatMode === 'interview' && !await interviewOverlay.stopForReset(resetRunId)) { setStatus('音频会话尚未结束，当前内容已保留，请稍后重试。'); return; }
    const cleared = await newQuestion();
    if(cleared && chatMode === 'interview') {
      await interviewOverlay.clear(resetRunId);
      interviewRunId = '';
    }
    if(document.body.classList.contains('is-empty')) document.querySelector('#liuwaDisplay').open=false;
  } finally {resetting=false;interviewOverlay?.refresh();}
}
window.addEventListener("focus", refreshContext);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshContext();
});

const interviewRecording = window.cockpit?.publishInterview ? createInterviewRecording({ bridge: window.cockpit, gatewayUrl: () => state.apiOrigin, gatewayKey: () => state.gatewayApiKey, onNotice: text => interviewOverlay?.notice(text) }) : null;
window.addEventListener('pagehide', () => interviewRecording?.dispose());
interviewOverlay = mountInterviewOverlay({ startRecording: () => interviewRecording?.start(), setMode: setChatMode, answer: sendChat, setStatus, onNewSession: beginInterviewSession, isBlocked: () => switchingMode || resetting });
document.querySelector('#quickMode')?.addEventListener('change', event => setChatMode(event.target.value));
document.querySelector('#liuwaTranscript')?.addEventListener('toggle', syncEmpty);
syncEmpty();
refreshContext();

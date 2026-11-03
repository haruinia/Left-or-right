import { findEchoSegments } from './echo-suppression.js';

export function interviewTranscriptSnapshot(snapshot) {
  // 被判定为回声的麦克风片段不进上下文，否则会变成「候选人说过的话」。
  const echo = findEchoSegments(snapshot.transcripts || []);
  const finals = (snapshot.transcripts || []).filter(item => item.is_final && ['mic', 'system'].includes(item.source) && ['candidate', 'interviewer'].includes(item.speaker) && !echo.has(String(item.segment_id || '')) && typeof item.text === 'string' && item.text.trim());
  const recent = finals.slice().sort((left, right) => (left.start_ms || 0) - (right.start_ms || 0)).slice(-12);
  const result = [];
  let remaining = 8000;
  for (const item of recent.reverse()) {
    if (remaining < 2) break;
    const original = item.text.trim(), limit = Math.min(2000, remaining);
    const text = original.length > limit ? `${original.slice(0, limit - 1)}…` : original;
    // 带上 segment_id，后端才能把「本轮目标」标到具体某一句。
    result.push(Object.freeze({ source: item.source, speaker: item.speaker, text, segment_id: String(item.segment_id || '') }));
    remaining -= text.length;
  }
  return Object.freeze(result.reverse());
}

const AUTO_SETTLE_MS = 900;
const AUTO_MIN_CHARS = 2;
const AUTO_MAX_WAIT_MS = 6000;

// 只有对方的定稿发言会成为自动回答的题目；本人发言、识别中的文本都不参与。
export function autoAnswerCandidate(snapshot, consumed = new Set()) {
  const finals = (snapshot.transcripts || [])
    .filter(item => item.source === 'system' && item.is_final && !consumed.has(item.segment_id) && typeof item.text === 'string' && item.text.trim().length >= AUTO_MIN_CHARS)
    .sort((left, right) => (left.start_ms || 0) - (right.start_ms || 0) || String(left.segment_id).localeCompare(String(right.segment_id)));
  if (!finals.length) return null;
  return {
    text: finals.map(item => item.text.trim()).join('\n'),
    segmentIds: finals.map(item => item.segment_id),
    latest: finals.at(-1),
  };
}

export function selectInterviewQuestion(snapshot, consumed = new Set(), previous = null) {
  const fresh = (snapshot.transcripts || []).filter(item => item.source === 'system' && item.is_final && !consumed.has(item.segment_id));
  if (!fresh.length) return previous;
  const transcript = interviewTranscriptSnapshot(snapshot);
  const segmentIds = fresh.map(item => item.segment_id);
  // 只说了一句时直接标记为目标；多句一起回答时不必猜，留给模型按最新未答处理。
  const target = fresh.length === 1 && transcript.some(item => item.segment_id === segmentIds[0]) ? segmentIds[0] : '';
  return { text: fresh.map(item => item.text).join('\n').trim(), interview_role: snapshot.role, interview_transcript: transcript, segmentIds, interview_target: target, run_id: snapshot.run_id };
}

export function mountInterviewOverlay({ setMode, answer, setStatus, isBlocked, onNewSession = () => true }) {
  const byId = id => document.getElementById(id);
  const root = byId('liuwaInterview');
  if (!root) return null;
  const transcript = byId('liuwaTranscriptBody');
  const details = byId('liuwaTranscript');
  const recordButton = byId('liuwaInterviewRecord');
  const count = byId('liuwaTranscriptCount');
  const status = byId('liuwaInterviewStatus');
  const consumed = new Set();
  const transcriptRows = new Map();
  let snapshot = { revision: -1, phase: 'idle', role: 'candidate', sources: [], transcripts: [], partials: {}, muted: {} };
  let previousQuestion = null;
  let inFlightQuestion = null;
  let ignoredRun = '';
  let autoOpenedRun = '';
  let mode = 'screenshot';
  let signature = '';
  let preparedRun = '';
  let sessionPreparationError = false;
  let transcriptPosition = 0;
  let followingTranscript = true;
  let autoAnswer = false;
  let autoTimer = 0;
  let autoFirstSeenAt = 0;
  transcript.addEventListener('scroll', () => {
    if (!details.open) return;
    transcriptPosition = transcript.scrollTop;
    followingTranscript = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <= 24;
  });
  details.addEventListener('toggle', () => {
    if (details.open) transcript.scrollTop = followingTranscript ? transcript.scrollHeight : transcriptPosition;
  });
  const idleWaiters = new Set();
  const bridge = window.cockpit;
  const roleName = role => role === 'interviewer' ? '面试官' : '候选人';
  const active = () => ['acquiring', 'connecting', 'recording', 'stopping'].includes(snapshot.phase);
  const visibleMessages = () => snapshot.run_id === ignoredRun ? [] : snapshot.transcripts || [];

  function controls() {
    root.hidden = mode !== 'interview';
    recordButton.hidden = mode !== 'interview' && !active();
    recordButton.textContent = active() ? '停止面试' : '开始面试';
    recordButton.disabled = snapshot.phase === 'stopping' || !bridge?.openSettings;
    for (const source of ['mic', 'system']) {
      const button = byId(source === 'mic' ? 'liuwaInterviewMic' : 'liuwaInterviewSystem');
      button.hidden = !active() || !snapshot.sources?.includes(source);
      button.disabled = snapshot.phase !== 'recording' || !snapshot.sources?.includes(source);
      button.setAttribute('aria-pressed', String(Boolean(snapshot.muted?.[source])));
      const name = source === 'mic' ? '麦克风' : '系统声';
      button.textContent = snapshot.muted?.[source] ? `${name}已静音` : name;
      button.title = `${snapshot.muted?.[source] ? '取消静音' : '静音'}${name}`;
    }
    const autoButton = byId('liuwaInterviewAuto');
    if (autoButton) {
      autoButton.hidden = mode !== 'interview';
      autoButton.disabled = snapshot.phase === 'stopping';
      autoButton.setAttribute('aria-pressed', String(autoAnswer));
      autoButton.textContent = autoAnswer ? '自动回答 · 开' : '自动回答';
    }
    const phase = { acquiring: '等待授权', connecting: '连接中', recording: '转写中', stopping: '收尾中' }[snapshot.phase];
    status.textContent = snapshot.error || phase || (snapshot.run_id ? '已停止' : '');
    status.hidden = !status.textContent;
    status.dataset.kind = snapshot.error ? 'error' : '';
    transcript.querySelectorAll('[data-answer-segment]').forEach(button => { button.disabled = isBlocked() || Boolean(snapshot.run_id && preparedRun !== snapshot.run_id); });
  }

  function paint() {
    const messages = visibleMessages();
    const echoIds = findEchoSegments(messages);
    const partials = snapshot.run_id === ignoredRun ? [] : Object.values(snapshot.partials || {}).filter(Boolean);
    const nextSignature = JSON.stringify([messages, partials, active(), [...echoIds]]);
    count.textContent = messages.length ? String(messages.length) : '';
    if (nextSignature !== signature) {
      signature = nextSignature;
      if (details.open) {
        followingTranscript = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <= 24;
        transcriptPosition = transcript.scrollTop;
      }
      const keys = new Set();
      const rows = [...messages, ...partials].map(item => {
        const key = `${snapshot.run_id}:${item.is_final ? item.segment_id : `partial:${item.source}`}`;
        keys.add(key);
        let cached = transcriptRows.get(key);
        if (!cached) {
          const row = document.createElement('article');
          row.className = `liuwa-transcript-turn is-${item.source}${item.is_final ? '' : ' is-partial'}`;
          const heading = document.createElement('header'), label = document.createElement('span'), text = document.createElement('p');
          heading.append(label); row.append(heading, text);
          cached = { row, label, text, item };
          if (item.is_final) {
            const runId = snapshot.run_id;
            const button = document.createElement('button');
            button.type = 'button'; button.textContent = '回答此条'; button.dataset.answerSegment = item.segment_id;
            button.addEventListener('click', () => {
              if (runId !== snapshot.run_id) return;
              if (findEchoSegments(visibleMessages()).has(String(cached.item.segment_id || ''))) return;
              submit({ text: cached.item.text, interview_role: snapshot.role, interview_transcript: interviewTranscriptSnapshot(snapshot), segmentIds: [cached.item.segment_id], interview_target: String(cached.item.segment_id || ''), run_id: runId });
            });
            heading.append(button);
          }
          transcriptRows.set(key, cached);
        }
        cached.item = item;
        const echo = echoIds.has(String(item.segment_id || ''));
        cached.row.classList.toggle('is-echo', echo);
        const answerButton = cached.row.querySelector('[data-answer-segment]');
        if (answerButton) answerButton.hidden = echo;
        const label = echo
          ? `回声（已忽略，不计入我的发言）`
          : `${item.source === 'mic' ? '我' : '对方'}（${roleName(item.speaker)}）${item.is_final ? '' : active() ? ' · 识别中' : ' · 未完成'}`;
        if (cached.label.textContent !== label) cached.label.textContent = label;
        if (cached.text.textContent !== item.text) cached.text.textContent = item.text;
        return cached.row;
      });
      for (const [key, cached] of transcriptRows) {
        if (!keys.has(key)) { cached.row.remove(); transcriptRows.delete(key); }
      }
      rows.forEach((row, index) => { if (transcript.children[index] !== row) transcript.insertBefore(row, transcript.children[index] || null); });
      for (const child of [...transcript.children]) if (!rows.includes(child)) child.remove();
      if (!rows.length) {
        const empty = document.createElement('p'); empty.className = 'liuwa-transcript-empty'; empty.textContent = '尚无转写内容'; transcript.append(empty);
      }
      if (details.open) transcript.scrollTop = followingTranscript ? transcript.scrollHeight : transcriptPosition;
    }
    controls();
  }

  function openRecordingMode() {
    if (preparedRun !== snapshot.run_id || sessionPreparationError) return;
    if (snapshot.phase === 'recording' && snapshot.run_id !== autoOpenedRun && snapshot.run_id !== ignoredRun) {
      autoOpenedRun = snapshot.run_id;
      Promise.resolve(setMode('interview')).catch(error => setStatus(error.message));
    }
  }

  function receive(value) {
    if (!value || !Number.isFinite(value.revision) || value.revision <= snapshot.revision) return;
    const changedRun = value.run_id && value.run_id !== snapshot.run_id;
    if (changedRun) {
      consumed.clear(); previousQuestion = null; inFlightQuestion = null; transcriptPosition = 0; followingTranscript = true;
      preparedRun = ''; sessionPreparationError = false;
      if (value.run_id !== ignoredRun) ignoredRun = '';
    }
    snapshot = value;
    if (changedRun) {
      const runId = snapshot.run_id;
      Promise.resolve(onNewSession(runId)).then(ready => {
        if (snapshot.run_id !== runId) return;
        if (ready === false) sessionPreparationError = true;
        else preparedRun = runId;
        openRecordingMode(); paint();
      }).catch(error => {
        if (snapshot.run_id !== runId) return;
        sessionPreparationError = true; setStatus(error.message || '上一场问答尚未保存，当前内容已保留。'); paint();
      });
    }
    if (!active()) { for (const done of idleWaiters) done(); idleWaiters.clear(); }
    if (!active() || snapshot.phase !== 'recording') cancelAuto();
    openRecordingMode();
    paint();
    scheduleAuto();
  }

  async function command(action, extra = {}) {
    if (!bridge?.interviewCommand || !snapshot.run_id) return false;
    const accepted = await bridge.interviewCommand({ run_id: snapshot.run_id, action, ...extra });
    if (!accepted) setStatus('音频会话已变化，请重新打开音频设置。');
    return accepted;
  }

  function autoQuestion() {
    const candidate = autoAnswerCandidate(snapshot, new Set([
      ...consumed,
      ...(inFlightQuestion?.run_id === snapshot.run_id ? inFlightQuestion.segmentIds || [] : []),
    ]));
    if (!candidate) return null;
    return {
      text: candidate.text,
      interview_role: snapshot.role,
      interview_transcript: interviewTranscriptSnapshot(snapshot),
      segmentIds: candidate.segmentIds,
      interview_target: String(candidate.latest.segment_id || ''),
      run_id: snapshot.run_id,
    };
  }

  // 页面与 API 同源时直接用当前 origin；桌面外壳由 __GATEWAY_URL__ 注入。
  function gatewayOrigin() {
    const injected = typeof window.__GATEWAY_URL__ === 'string' ? window.__GATEWAY_URL__.trim() : '';
    try { if (injected) return new URL(injected).origin; } catch { /* 交给页面 origin */ }
    const page = window.location.origin;
    return page && page !== 'null' ? page : 'http://127.0.0.1:9958';
  }

  function gatewayKey() {
    try { return sessionStorage.getItem('gatewayApiKey') || ''; } catch { return ''; }
  }

  function saveAutoAnswer(value) {
    const origin = gatewayOrigin();
    const key = gatewayKey();
    fetch(`${origin}/api/ui/settings`, {
      method: 'PATCH', cache: 'no-store',
      headers: { 'content-type': 'application/json', ...(key ? { 'X-API-Key': key } : {}) },
      body: JSON.stringify({ interview_auto_answer: Boolean(value) }),
      signal: AbortSignal.timeout(9000),
    }).catch(() => setStatus('自动回答已在本场生效，但偏好未能保存。'));
  }

  async function loadAutoAnswer() {
    try {
      const key = gatewayKey();
      const response = await fetch(`${gatewayOrigin()}/api/ui/settings`, {
        cache: 'no-store', headers: key ? { 'X-API-Key': key } : {}, signal: AbortSignal.timeout(9000),
      });
      if (!response.ok) return;
      const data = await response.json();
      setAutoAnswer(Boolean(data.interview_auto_answer));
    } catch { /* 读取失败时保持手动，不静默打开自动回答 */ }
  }

  function cancelAuto() {
    clearTimeout(autoTimer);
    autoTimer = 0;
    autoFirstSeenAt = 0;
  }

  // 等对方说完再发：新定稿会重置计时，避免把一句话拆成多次请求。
  function scheduleAuto() {
    if (!autoAnswer) return;
    const blocked = isBlocked() || !active() || snapshot.phase !== 'recording'
      || Boolean(snapshot.run_id && preparedRun !== snapshot.run_id) || Boolean(inFlightQuestion);
    if (blocked) return;
    if (!autoQuestion()) { cancelAuto(); return; }
    const now = Date.now();
    if (!autoFirstSeenAt) autoFirstSeenAt = now;
    clearTimeout(autoTimer);
    const wait = Math.max(0, Math.min(AUTO_SETTLE_MS, AUTO_MAX_WAIT_MS - (now - autoFirstSeenAt)));
    autoTimer = setTimeout(() => {
      autoTimer = 0;
      autoFirstSeenAt = 0;
      if (!autoAnswer || isBlocked() || !active() || snapshot.phase !== 'recording' || inFlightQuestion) return;
      const question = autoQuestion();
      if (!question) return;
      // 立刻占用这一批发言，避免等待 setMode 期间又被下一次仲裁挑中。
      inFlightQuestion = question;
      Promise.resolve(setMode('interview'))
        .then(ready => {
          if (!ready) {
            if (inFlightQuestion === question) inFlightQuestion = null;
            return false;
          }
          return answer({ ...question, context: 'interview' });
        })
        .catch(error => setStatus(error?.message || '自动回答未能开始。'));
    }, wait);
  }

  function setAutoAnswer(value) {
    autoAnswer = Boolean(value);
    if (!autoAnswer) cancelAuto(); else scheduleAuto();
    controls();
  }

  async function submit(question) {
    if (isBlocked() || Boolean(snapshot.run_id && preparedRun !== snapshot.run_id)) return;
    if (!question?.text) { setStatus('尚无对方的完整转写，可展开转录选择问题。'); return; }
    if (question.text.length > 8000) { setStatus('问题较长，请在转录中选择具体一条。'); return; }
    if (!await setMode('interview')) return;
    return answer({ ...question, context: 'interview' });
  }

  recordButton.addEventListener('click', () => {
    if (!active()) byId('liuwaDisplay').open = false;
    const request = active() ? command('stop') : bridge?.openSettings?.('interview');
    Promise.resolve(request).catch(error => setStatus(error.message || '音频设置无法打开。'));
  });
  for (const source of ['mic', 'system']) byId(source === 'mic' ? 'liuwaInterviewMic' : 'liuwaInterviewSystem').addEventListener('click', () => {
    command('mute', { source, muted: !snapshot.muted?.[source] }).catch(error => setStatus(error.message));
  });
  byId('liuwaInterviewAuto')?.addEventListener('click', () => {
    setAutoAnswer(!autoAnswer);
    saveAutoAnswer(autoAnswer);
  });
  loadAutoAnswer();
  bridge?.onInterviewState?.(receive);
  bridge?.getInterviewState?.().then(receive).catch(() => setStatus('面试状态暂时无法读取。'));
  paint();
  return {
    setMode(value) { mode = value; controls(); scheduleAuto(); },
    control(action) {
      const button = action === 'toggle' ? recordButton : action === 'mic' ? byId('liuwaInterviewMic') : action === 'system' ? byId('liuwaInterviewSystem') : null;
      if (button && !button.disabled) button.click();
    },
    transcript() { return interviewTranscriptSnapshot(snapshot); },
    question() {
      if (snapshot.run_id && preparedRun !== snapshot.run_id) return null;
      const claimed = new Set(consumed);
      if (inFlightQuestion?.run_id === snapshot.run_id) for (const id of inFlightQuestion.segmentIds || []) claimed.add(id);
      return selectInterviewQuestion(snapshot, claimed, inFlightQuestion?.run_id === snapshot.run_id ? inFlightQuestion : previousQuestion);
    },
    begin(question) { inFlightQuestion = question; cancelAuto(); },
    finished(question) { if (inFlightQuestion === question) inFlightQuestion = null; scheduleAuto(); },
    role() { return snapshot.run_id && snapshot.run_id !== ignoredRun ? snapshot.role : byId('quickIdentity')?.value || 'candidate'; },
    runId() { return snapshot.run_id; },
    committed(question) {
      if (question?.run_id !== snapshot.run_id) return;
      for (const id of question.segmentIds || []) consumed.add(id);
      previousQuestion = question;
    },
    refresh: controls,
    async stopForReset(runId = snapshot.run_id) {
      if (bridge?.getInterviewState) {
        try { receive(await bridge.getInterviewState()); } catch { return false; }
      }
      if (runId !== snapshot.run_id || !active()) return true;
      let timer, done;
      const stopped = new Promise(resolve => {
        done = () => { clearTimeout(timer); resolve(true); };
        idleWaiters.add(done);
        timer = setTimeout(() => { idleWaiters.delete(done); resolve(false); }, 30000);
      });
      try {
        if (!await command('stop')) { clearTimeout(timer); idleWaiters.delete(done); return false; }
        return await stopped;
      } catch { clearTimeout(timer); idleWaiters.delete(done); return false; }
    },
    clear(runId = snapshot.run_id) { if (runId !== snapshot.run_id) return; cancelAuto(); ignoredRun = snapshot.run_id || ''; consumed.clear(); previousQuestion = null; inFlightQuestion = null; transcriptPosition = 0; followingTranscript = true; details.open = false; paint(); },
  };
}

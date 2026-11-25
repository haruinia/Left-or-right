import { findEchoSegments } from './echo-suppression.js';

const conversationId = snapshot => snapshot.conversation_id || snapshot.run_id || '';

export function interviewTranscriptSnapshot(snapshot) {
  const echo = findEchoSegments(snapshot.transcripts || []);
  const finals = (snapshot.transcripts || []).filter(item => item.is_final && ['mic', 'system'].includes(item.source) && ['candidate', 'interviewer'].includes(item.speaker) && !echo.has(String(item.segment_id || '')) && typeof item.text === 'string' && item.text.trim());
  const recent = finals.slice().sort((left, right) => (left.start_ms || 0) - (right.start_ms || 0)).slice(-12);
  const result = [];
  let remaining = 8000;
  for (const item of recent.reverse()) {
    if (remaining < 2) break;
    const original = item.text.trim(), limit = Math.min(2000, remaining);
    const text = original.length > limit ? `${original.slice(0, limit - 1)}…` : original;
    result.push(Object.freeze({ source: item.source, speaker: item.speaker, text, segment_id: String(item.segment_id || '') }));
    remaining -= text.length;
  }
  return Object.freeze(result.reverse());
}

const AUTO_SETTLE_MS = 900;
const AUTO_MIN_CHARS = 2;
const AUTO_MAX_WAIT_MS = 6000;

export function autoAnswerCandidate(snapshot, consumed = new Set()) {
  const finals = (snapshot.transcripts || [])
    .filter(item => item.source === 'system' && item.is_final && !consumed.has(item.segment_id) && typeof item.text === 'string' && item.text.trim().length >= AUTO_MIN_CHARS)
    .sort((left, right) => (left.start_ms || 0) - (right.start_ms || 0) || String(left.segment_id).localeCompare(String(right.segment_id)));
  if (!finals.length) return null;
  return { text: finals.map(item => item.text.trim()).join('\n'), segmentIds: finals.map(item => item.segment_id), latest: finals.at(-1) };
}

export function selectInterviewQuestion(snapshot, consumed = new Set(), previous = null) {
  const fresh = (snapshot.transcripts || []).filter(item => item.source === 'system' && item.is_final && !consumed.has(item.segment_id));
  if (!fresh.length) return previous;
  const transcript = interviewTranscriptSnapshot(snapshot);
  const segmentIds = fresh.map(item => item.segment_id);
  const target = fresh.length === 1 && transcript.some(item => item.segment_id === segmentIds[0]) ? segmentIds[0] : '';
  return { text: fresh.map(item => item.text).join('\n').trim(), interview_role: snapshot.role, interview_transcript: transcript, segmentIds, interview_target: target, run_id: conversationId(snapshot) };
}

export function mountInterviewOverlay({ setMode, answer, setStatus, isBlocked, onNewSession = () => true, startRecording }) {
  const byId = id => document.getElementById(id);
  const root = byId('liuwaInterview');
  if (!root) return null;
  const transcript = byId('liuwaTranscriptBody'), details = byId('liuwaTranscript');
  const recordButton = byId('liuwaInterviewRecord'), recordLabel = byId('liuwaInterviewRecordLabel');
  const count = byId('liuwaTranscriptCount'), status = byId('liuwaInterviewStatus');
  const consumed = new Set(), autoAttempted = new Set(), transcriptRows = new Map(), idleWaiters = new Set();
  const bridge = window.cockpit;
  let snapshot = { revision: -1, run_id: '', phase: 'idle', role: 'candidate', sources: [], transcripts: [], partials: {}, muted: {} };
  let previousQuestion = null, inFlightQuestion = null;
  let ignoredRun = '', autoOpenedRun = '', mode = 'screenshot', signature = '', preparedConversation = '';
  let sessionPreparationError = false, preparing = false, localNotice = '';
  let transcriptPosition = 0, followingTranscript = true;
  let autoAnswer = false, autoTimer = 0, autoFirstSeenAt = 0, clockTimer = 0;
  const roleName = role => role === 'interviewer' ? '面试官' : '候选人';
  const active = () => ['acquiring', 'connecting', 'recording', 'stopping'].includes(snapshot.phase);
  const visibleMessages = () => snapshot.run_id === ignoredRun ? [] : snapshot.transcripts || [];
  const prepared = () => !conversationId(snapshot) || preparedConversation === conversationId(snapshot);
  const opponentSpeaking = () => Boolean(snapshot.partials?.system?.text?.trim());
  transcript.addEventListener('scroll', () => {
    if (!details.open) return;
    transcriptPosition = transcript.scrollTop;
    followingTranscript = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <= 24;
  });
  details.addEventListener('toggle', () => {
    if (details.open) transcript.scrollTop = followingTranscript ? transcript.scrollHeight : transcriptPosition;
  });

  function clock() {
    const timer = byId('liuwaInterviewTimer');
    if (!timer) return;
    const elapsed = (snapshot.elapsed_ms || 0) + (snapshot.phase === 'recording' && snapshot.recording_started_at ? Math.max(0, Date.now() - snapshot.recording_started_at) : 0);
    const seconds = Math.floor(elapsed / 1000);
    timer.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function controls() {
    const blocked = isBlocked();
    root.hidden = mode !== 'interview';
    byId('liuwaInterviewVoice').hidden = mode !== 'interview' && !active();
    byId('liuwaInterviewHeading').hidden = mode !== 'interview';
    byId('liuwaInterviewModes').hidden = mode !== 'interview';
    const pending = preparing && !active();
    const labels = { acquiring: '取消', connecting: '取消', recording: '结束面试', stopping: '结束中…' };
    recordLabel.textContent = pending ? '准备中…' : labels[snapshot.phase] || (conversationId(snapshot) && snapshot.run_id !== ignoredRun ? '继续面试' : '开始面试');
    recordButton.disabled = pending || snapshot.phase === 'stopping' || blocked || !startRecording;
    byId('liuwaInterviewVoice').dataset.phase = pending ? 'preparing' : snapshot.phase;
    const running = snapshot.phase === 'recording' || snapshot.phase === 'stopping';
    byId('liuwaInterviewTimer').hidden = !running;
    clock();
    if (snapshot.phase === 'recording' && !clockTimer) clockTimer = setInterval(clock, 1000);
    if (snapshot.phase !== 'recording' && clockTimer) { clearInterval(clockTimer); clockTimer = 0; }
    for (const source of ['mic', 'system']) {
      const button = byId(source === 'mic' ? 'liuwaInterviewMic' : 'liuwaInterviewSystem');
      button.hidden = !running || !snapshot.sources?.includes(source);
      button.disabled = snapshot.phase !== 'recording' || blocked;
      button.setAttribute('aria-pressed', String(Boolean(snapshot.muted?.[source])));
      const name = source === 'mic' ? '麦克风' : '系统声音';
      const label = `${snapshot.muted?.[source] ? '取消静音' : '静音'}${name}`;
      button.setAttribute('aria-label', label);
      button.title = label;
    }
    for (const [id, selected] of [['liuwaInterviewManual', !autoAnswer], ['liuwaInterviewAuto', autoAnswer]]) {
      byId(id).setAttribute('aria-pressed', String(selected));
      byId(id).disabled = snapshot.phase === 'stopping';
    }
    const phase = { acquiring: '等待授权', connecting: '连接中', recording: '实时', stopping: '收尾中' }[snapshot.phase];
    status.textContent = localNotice || snapshot.error || phase || (conversationId(snapshot) && snapshot.run_id !== ignoredRun ? '已停止' : '');
    status.hidden = !status.textContent;
    status.dataset.kind = localNotice || snapshot.error ? 'error' : '';
    transcript.querySelectorAll('[data-answer-segment]').forEach(button => { button.disabled = blocked || !prepared(); });
  }

  function paint() {
    const messages = visibleMessages(), echoIds = findEchoSegments(messages);
    const partials = snapshot.run_id === ignoredRun ? [] : Object.values(snapshot.partials || {}).filter(Boolean);
    const nextSignature = JSON.stringify([messages, partials, active(), [...echoIds], inFlightQuestion?.segmentIds]);
    count.textContent = messages.length ? String(messages.length) : '';
    if (nextSignature !== signature) {
      signature = nextSignature;
      if (details.open) {
        followingTranscript = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <= 24;
        transcriptPosition = transcript.scrollTop;
      }
      const keys = new Set();
      const rows = [...messages, ...partials].map(item => {
        const key = `${conversationId(snapshot)}:${item.is_final ? item.segment_id : `partial:${item.source}`}`;
        keys.add(key);
        let cached = transcriptRows.get(key);
        if (!cached) {
          const row = document.createElement('article');
          row.className = `liuwa-transcript-turn is-${item.source}${item.is_final ? '' : ' is-partial'}`;
          const heading = document.createElement('header'), label = document.createElement('span'), text = document.createElement('p');
          heading.append(label); row.append(heading, text);
          cached = { row, label, text, item };
          if (item.is_final) {
            const session = conversationId(snapshot), button = document.createElement('button');
            button.type = 'button'; button.textContent = '回答'; button.title = '回答此条'; button.dataset.answerSegment = item.segment_id;
            button.addEventListener('click', () => {
              if (session !== conversationId(snapshot) || findEchoSegments(visibleMessages()).has(String(cached.item.segment_id || ''))) return;
              submit({ text: cached.item.text, interview_role: snapshot.role, interview_transcript: interviewTranscriptSnapshot(snapshot), segmentIds: [cached.item.segment_id], interview_target: String(cached.item.segment_id || ''), run_id: session });
            });
            heading.append(button);
          }
          transcriptRows.set(key, cached);
        }
        cached.item = item;
        const echo = echoIds.has(String(item.segment_id || ''));
        cached.row.classList.toggle('is-echo', echo);
        cached.row.classList.toggle('is-current', Boolean(inFlightQuestion?.segmentIds?.includes(item.segment_id)));
        const answerButton = cached.row.querySelector('[data-answer-segment]');
        if (answerButton) answerButton.hidden = echo;
        const label = echo ? '回声（已忽略，不计入我的发言）' : `${item.source === 'mic' ? '我' : '对方'} · ${roleName(item.speaker)}${item.is_final ? '' : active() ? ' · 识别中' : ' · 未完成'}`;
        if (cached.label.textContent !== label) cached.label.textContent = label;
        if (cached.text.textContent !== item.text) cached.text.textContent = item.text;
        return cached.row;
      });
      for (const [key, cached] of transcriptRows) if (!keys.has(key)) { cached.row.remove(); transcriptRows.delete(key); }
      rows.forEach((row, index) => { if (transcript.children[index] !== row) transcript.insertBefore(row, transcript.children[index] || null); });
      for (const child of [...transcript.children]) if (!rows.includes(child)) child.remove();
      if (!rows.length) { const empty = document.createElement('p'); empty.className = 'liuwa-transcript-empty'; empty.textContent = '尚无转写内容'; transcript.append(empty); }
      if (details.open) transcript.scrollTop = followingTranscript ? transcript.scrollHeight : transcriptPosition;
    }
    controls();
  }

  function openRecordingMode() {
    if (!prepared() || sessionPreparationError) return;
    if (snapshot.phase === 'recording' && snapshot.run_id !== autoOpenedRun && snapshot.run_id !== ignoredRun) {
      autoOpenedRun = snapshot.run_id;
      Promise.resolve(setMode('interview')).catch(error => setStatus(error.message));
    }
  }

  function receive(value) {
    if (!value || !Number.isFinite(value.revision) || value.revision <= snapshot.revision) return;
    const changedConversation = conversationId(value) !== conversationId(snapshot);
    if (changedConversation) {
      consumed.clear(); autoAttempted.clear(); previousQuestion = null; inFlightQuestion = null;
      transcriptPosition = 0; followingTranscript = true; preparedConversation = ''; sessionPreparationError = false;
    }
    if (value.run_id !== snapshot.run_id) { ignoredRun = ''; localNotice = ''; }
    snapshot = value;
    if (changedConversation && conversationId(snapshot)) {
      const session = conversationId(snapshot);
      Promise.resolve(onNewSession(session)).then(ready => {
        if (conversationId(snapshot) !== session) return;
        if (ready === false) sessionPreparationError = true;
        else preparedConversation = session;
        openRecordingMode(); paint(); scheduleAuto();
      }).catch(error => { if (conversationId(snapshot) === session) { sessionPreparationError = true; setStatus(error.message || '面试会话暂时无法准备。'); paint(); } });
    }
    if (!active()) { for (const done of idleWaiters) done(); idleWaiters.clear(); }
    if (!active() || snapshot.phase !== 'recording' || opponentSpeaking()) cancelAuto();
    openRecordingMode(); paint(); scheduleAuto();
  }

  async function command(action, extra = {}) {
    if (!bridge?.interviewCommand || !snapshot.run_id) return false;
    const accepted = await bridge.interviewCommand({ run_id: snapshot.run_id, action, ...extra });
    if (!accepted) { localNotice = '语音会话已变化，请重试。'; controls(); }
    return accepted;
  }

  function autoQuestion() {
    const session = conversationId(snapshot);
    const candidate = autoAnswerCandidate(snapshot, new Set([...consumed, ...autoAttempted, ...(inFlightQuestion?.run_id === session ? inFlightQuestion.segmentIds || [] : [])]));
    if (!candidate) return null;
    return { text: candidate.text, interview_role: snapshot.role, interview_transcript: interviewTranscriptSnapshot(snapshot), segmentIds: candidate.segmentIds, interview_target: String(candidate.latest.segment_id || ''), run_id: session };
  }

  function gatewayOrigin() {
    const injected = typeof window.__GATEWAY_URL__ === 'string' ? window.__GATEWAY_URL__.trim() : '';
    try { if (injected) return new URL(injected).origin; } catch { /* Invalid injected URL falls through to the page origin. */ }
    const page = window.location.origin;
    return page && page !== 'null' ? page : 'http://127.0.0.1:9958';
  }
  function gatewayKey() { try { return sessionStorage.getItem('gatewayApiKey') || ''; } catch { return ''; } }
  async function saveAutoAnswer(value) {
    try {
      const key = gatewayKey();
      const response = await fetch(`${gatewayOrigin()}/api/ui/settings`, { method: 'PATCH', cache: 'no-store', headers: { 'content-type': 'application/json', ...(key ? { 'X-API-Key': key } : {}) }, body: JSON.stringify({ interview_auto_answer: Boolean(value) }), signal: AbortSignal.timeout(9000) });
      if (!response.ok) throw Error();
    } catch { setStatus('回答模式已在本场生效，但偏好未能保存。'); }
  }
  async function loadAutoAnswer() {
    try {
      const key = gatewayKey();
      const response = await fetch(`${gatewayOrigin()}/api/ui/settings`, { cache: 'no-store', headers: key ? { 'X-API-Key': key } : {}, signal: AbortSignal.timeout(9000) });
      if (response.ok) setAutoAnswer(Boolean((await response.json()).interview_auto_answer));
    } catch { /* A failed settings read must not turn on automatic requests. */ }
  }
  function cancelAuto() { clearTimeout(autoTimer); autoTimer = 0; autoFirstSeenAt = 0; }
  function scheduleAuto() {
    if (!autoAnswer || mode !== 'interview') return;
    if (isBlocked() || snapshot.phase !== 'recording' || !prepared() || inFlightQuestion || opponentSpeaking()) { cancelAuto(); return; }
    if (!autoQuestion()) { cancelAuto(); return; }
    const now = Date.now();
    if (!autoFirstSeenAt) autoFirstSeenAt = now;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
      autoTimer = 0; autoFirstSeenAt = 0;
      if (!autoAnswer || mode !== 'interview' || isBlocked() || snapshot.phase !== 'recording' || inFlightQuestion || opponentSpeaking() || !prepared()) return;
      const question = autoQuestion();
      if (!question) return;
      for (const id of question.segmentIds) autoAttempted.add(id);
      inFlightQuestion = question;
      Promise.resolve(setMode('interview')).then(ready => ready && answer({ ...question, context: 'interview' }))
        .finally(() => { if (inFlightQuestion === question) inFlightQuestion = null; })
        .catch(error => setStatus(error?.message || '自动回答未能开始。'));
    }, Math.max(0, Math.min(AUTO_SETTLE_MS, AUTO_MAX_WAIT_MS - (now - autoFirstSeenAt))));
  }
  function setAutoAnswer(value) { autoAnswer = Boolean(value); if (!autoAnswer) cancelAuto(); else scheduleAuto(); controls(); }
  async function submit(question) {
    if (isBlocked() || !prepared()) return;
    if (!question?.text) { setStatus('尚无对方的完整转写。'); return; }
    if (question.text.length > 8000) { setStatus('问题较长，请在转录中选择具体一条。'); return; }
    if (await setMode('interview')) return answer({ ...question, context: 'interview' });
  }

  recordButton.addEventListener('click', async () => {
    if (isBlocked() || (preparing && !active())) return;
    if (active()) { await command('stop').catch(error => { localNotice = error.message; controls(); }); return; }
    preparing = true; localNotice = ''; controls();
    byId('liuwaDisplay').open = false;
    try { if (await setMode('interview')) await startRecording?.(); }
    catch (error) { localNotice = error.message || '语音未能开始，请重试。'; }
    finally { preparing = false; controls(); }
  });
  for (const source of ['mic', 'system']) byId(source === 'mic' ? 'liuwaInterviewMic' : 'liuwaInterviewSystem').addEventListener('click', () => {
    command('mute', { source, muted: !snapshot.muted?.[source] }).catch(error => { localNotice = error.message; controls(); });
  });
  const extraToggle = byId('liuwaInterviewExtraToggle'), extraPanel = byId('liuwaInterviewExtra');
  extraToggle.addEventListener('click', () => {
    const open = extraPanel.hidden;
    if (!open) byId('liuwaInterviewExtraText').blur();
    extraPanel.hidden = !open; extraToggle.setAttribute('aria-expanded', String(open));
    if (open) byId('liuwaInterviewExtraText').focus();
  });
  byId('liuwaInterviewManual').addEventListener('click', () => { setAutoAnswer(false); saveAutoAnswer(false); });
  byId('liuwaInterviewAuto').addEventListener('click', () => { setAutoAnswer(true); saveAutoAnswer(true); });
  loadAutoAnswer();
  bridge?.onInterviewState?.(receive);
  bridge?.getInterviewState?.().then(receive).catch(() => { localNotice = '面试状态暂时无法读取。'; controls(); });
  window.addEventListener('pagehide', () => { clearInterval(clockTimer); cancelAuto(); });
  paint();
  return {
    setMode(value) {
      if (value === 'interview' && mode !== 'interview') details.open = true;
      mode = value;
      if (value !== 'interview') { cancelAuto(); byId('liuwaInterviewExtraText').blur(); extraPanel.hidden = true; extraToggle.setAttribute('aria-expanded', 'false'); }
      controls(); scheduleAuto();
    },
    control(action) {
      if (action === 'view') return Promise.resolve(setMode(mode === 'interview' ? 'screenshot' : 'interview')).catch(error => setStatus(error.message));
      const button = action === 'toggle' ? recordButton : action === 'mic' ? byId('liuwaInterviewMic') : action === 'system' ? byId('liuwaInterviewSystem') : null;
      if (button && !button.disabled) button.click();
    },
    notice(text) { localNotice = text || ''; controls(); },
    transcript() { return interviewTranscriptSnapshot(snapshot); },
    extra() { return (byId('liuwaInterviewExtraText')?.value || '').trim().slice(0, 500); },
    question() {
      if (!prepared()) return null;
      const claimed = new Set(consumed), session = conversationId(snapshot);
      if (inFlightQuestion?.run_id === session) for (const id of inFlightQuestion.segmentIds || []) claimed.add(id);
      return selectInterviewQuestion(snapshot, claimed, inFlightQuestion?.run_id === session ? inFlightQuestion : previousQuestion);
    },
    begin(question) { inFlightQuestion = question; cancelAuto(); paint(); },
    finished(question) { if (inFlightQuestion === question) inFlightQuestion = null; paint(); scheduleAuto(); },
    role() { return conversationId(snapshot) && snapshot.run_id !== ignoredRun ? snapshot.role : byId('quickIdentity')?.value || 'candidate'; },
    runId() { return snapshot.run_id; },
    committed(question) {
      if (question?.run_id !== conversationId(snapshot)) return;
      for (const id of question.segmentIds || []) consumed.add(id);
      previousQuestion = question;
    },
    refresh: controls,
    async stopForReset(runId = snapshot.run_id) {
      if (bridge?.getInterviewState) { try { receive(await bridge.getInterviewState()); } catch { return false; } }
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
    async clear(runId = snapshot.run_id) {
      if (runId !== snapshot.run_id) return false;
      if (bridge?.interviewCommand && !await bridge.interviewCommand({ run_id: runId, action: 'reset' })) { localNotice = '语音会话尚未重置，请重试。'; controls(); return false; }
      ignoredRun = runId; cancelAuto(); consumed.clear(); autoAttempted.clear(); previousQuestion = null; inFlightQuestion = null;
      preparedConversation = ''; localNotice = ''; transcriptPosition = 0; followingTranscript = true;
      byId('liuwaInterviewExtraText').blur(); extraPanel.hidden = true; extraToggle.setAttribute('aria-expanded', 'false');
      if (bridge?.getInterviewState) receive(await bridge.getInterviewState());
      details.open = mode === 'interview'; paint(); return true;
    },
  };
}

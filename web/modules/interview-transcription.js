import { asrRequest, transcriptionGateway, transcriptionGatewayKey } from './asr-api.js';
import { createAssetStore } from './asset-storage.js';
import { DualSourceTranscription } from './transcription-capture.js';

const $ = selector => document.querySelector(selector);
const records = createAssetStore('sessions', 'liuwa_session_records');
const roleName = role => role === 'interviewer' ? '面试官' : '候选人';
const sourceName = source => source === 'mic' ? '麦克风' : '系统声音';
let initialized = false, loading = false, stale = false, disposing = false, controller;
let setup = { role: 'candidate', configured: false };
let finalSegments = new Map(), partialSegments = new Map(), pendingRecord = null, session = null, saved = true, lastError = '';
let runId = '', runRole = 'candidate';

export function interviewAudioSetup(profiles, preferences) {
  const active = profiles.profiles?.find(profile => profile.id === profiles.active_profile_id);
  return { role: preferences.assistant_role === 'interviewer' ? 'interviewer' : 'candidate', configured: Boolean(active?.configured ?? active?.api_key_configured) };
}

function publish(event) {
  if (runId) window.interviewBridge?.publish({ ...event, run_id: runId });
}

function status(text, error = false) {
  $('#interviewStatus').textContent = text;
  $('#interviewStatus').dataset.kind = error ? 'error' : '';
}

function controls() {
  const active = controller.state !== 'idle';
  const supported = Boolean(window.__AUDIO_CAPTURE__?.systemAudioSupported);
  $('#interviewStart').hidden = active;
  $('#interviewStart').disabled = loading || !setup.configured || !supported || !saved;
  $('#interviewStop').hidden = !active;
  $('#interviewStop').disabled = controller.state === 'stopping';
  $('#interviewConnectionLink').hidden = active || setup.configured;
  $('#interviewPermissions').hidden = active || !window.interviewBridge?.openAudioPermissions || window.__AUDIO_CAPTURE__?.platform !== 'darwin' || !/采集|音频|麦克风|系统声音|录音权限/.test(lastError);
  $('#interviewIdentity').textContent = `我（${roleName(active ? runRole : setup.role)}） · 对方（${roleName((active ? runRole : setup.role) === 'candidate' ? 'interviewer' : 'candidate')}）`;
  const recovery = !window.interviewBridge || Boolean(lastError || (!saved && pendingRecord) || (!active && partialSegments.size));
  $('#interviewRecovery').hidden = !recovery;
  $('#interviewExport').disabled = !finalSegments.size && !partialSegments.size;
  $('#interviewRetrySave').hidden = saved || !pendingRecord;
  const badge = $('#interviewRecordingBadge');
  if (badge) {
    badge.hidden = !active;
    badge.textContent = { acquiring: '等待授权', connecting: '连接中', recording: '转写中', stopping: '收尾中' }[controller.state] || '';
  }
}

function renderTranscript() {
  const list = $('#interviewTranscript');
  list.replaceChildren();
  for (const segment of [...finalSegments.values()].sort((a, b) => a.start_ms - b.start_ms || a.order - b.order)) {
    const item = document.createElement('article'); item.className = 'transcription-turn'; item.dataset.source = segment.source;
    const heading = document.createElement('header'), label = document.createElement('strong'), text = document.createElement('p');
    label.textContent = `${sourceName(segment.source)} · ${roleName(segment.speaker)}`;
    text.textContent = segment.text;
    heading.append(label); item.append(heading, text); list.append(item);
  }
  $('#interviewEmpty').hidden = finalSegments.size > 0 || partialSegments.size > 0;
  for (const source of ['mic', 'system']) {
    const node = $(`#interview${source === 'mic' ? 'Mic' : 'System'}Partial`), segment = partialSegments.get(source);
    node.textContent = segment ? `${controller.state === 'idle' ? '未完成：' : ''}${segment.text}` : '';
    node.hidden = !segment;
  }
  controls();
}

function transcript(segment) {
  if (typeof segment.text !== 'string' || !segment.text.trim()) return;
  const id = String(segment.segment_id || `${segment.source}:${segment.start_ms}`);
  if (segment.is_final) {
    finalSegments.set(id, { ...segment, order: finalSegments.get(id)?.order ?? finalSegments.size });
    if (partialSegments.get(segment.source)?.segment_id === segment.segment_id) partialSegments.delete(segment.source);
  } else if (!finalSegments.has(id)) partialSegments.set(segment.source, segment);
  const { source, speaker, text, start_ms, end_ms, is_final, segment_id } = segment;
  publish({ type: 'transcript', source, speaker, text, start_ms, end_ms, is_final, segment_id });
  renderTranscript();
}

function recoveryRecord() {
  if (!session || !finalSegments.size) return null;
  return { id: `recovered_${session.session_id}`, kind: 'transcription', startedAt: session.startedAt, endedAt: new Date().toISOString(), note: '连接中断时保留的转写', turnCount: finalSegments.size, turns: [...finalSegments.values()].map(segment => ({ role: 'user', source: segment.source, speaker: segment.speaker, text: segment.text })) };
}

async function loadSetup() {
  if (controller.state !== 'idle' || loading) { stale = true; return; }
  stale = false; loading = true; controls();
  try {
    const [profiles, preferences] = await Promise.all([asrRequest('/api/config/asr/profiles'), asrRequest('/api/ui/settings')]);
    setup = interviewAudioSetup(profiles, preferences);
    if (!lastError) {
      if (!setup.configured) status('请先添加并启用语音接入。');
      else if (!window.__AUDIO_CAPTURE__?.systemAudioSupported) status('系统声音采集需要支持该功能的桌面 App。', true);
      else status('');
    }
  } catch { setup.configured = false; status('读取面试配置失败，请返回后重试。', true); }
  finally { loading = false; controls(); if (stale && !disposing) loadSetup(); }
}

function start() {
  if (controller.state !== 'idle' || loading || !saved || !setup.configured || !window.__AUDIO_CAPTURE__?.systemAudioSupported) return;
  runId = crypto.randomUUID(); runRole = setup.role;
  finalSegments = new Map(); partialSegments = new Map(); pendingRecord = null; session = null; saved = true; lastError = '';
  renderTranscript();
  controller.start({ sources: ['mic', 'system'], role: runRole, deviceId: 'default', gatewayUrl: transcriptionGateway(), gatewayKey: transcriptionGatewayKey() }).catch(error => status(error.message, true));
}

function exportText() {
  const lines = ['# 面试转写', ''];
  for (const segment of [...finalSegments.values()].sort((a, b) => a.start_ms - b.start_ms || a.order - b.order)) lines.push(`## ${sourceName(segment.source)} · ${roleName(segment.speaker)}`, '', segment.text, '');
  for (const segment of partialSegments.values()) lines.push(`## ${sourceName(segment.source)} · 未完成`, '', segment.text, '');
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `zuoyou-transcript-${new Date().toISOString().slice(0, 10)}.md`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function init() {
  controller = new DualSourceTranscription({
    onState(value) {
      publish({ type: 'state', state: value, role: runRole, sources: ['mic', 'system'] });
      const label = { acquiring: '正在申请音频权限…', connecting: '正在连接语音服务…', recording: '正在转写', stopping: '正在接收最后的转写…' }[value];
      if (label) status(label);
      if (value === 'idle') {
        if (lastError) {
          if (finalSegments.size && !pendingRecord) { pendingRecord = recoveryRecord(); saved = false; }
          if (!finalSegments.size) saved = true;
          status(lastError, true);
        }
        renderTranscript();
        if (initialized && !disposing) loadSetup();
      } else controls();
    },
    onError(message) { lastError = message; publish({ type: 'error', detail: message }); status(message, true); },
    onReady(value) {
      session = { ...value, startedAt: new Date().toISOString() }; saved = false;
      publish({ type: 'ready', session_id: value.session_id, role: value.role, sources: value.sources }); controls();
    },
    onTranscript: transcript,
    onStopped(value) {
      pendingRecord = value.record || recoveryRecord(); saved = Boolean(value.saved) || !pendingRecord;
      publish({ type: 'stopped', saved: Boolean(value.saved) });
      const savedText = partialSegments.size ? '完整句子已保存，未完成文字可导出。' : '文字已保存到会话记录。';
      if (!saved) lastError = '文字记录保存失败，请重试保存。';
      else if (lastError && value.saved) lastError = `${lastError} ${savedText}`;
      if (lastError) status(lastError, true);
      else status(value.saved ? `已停止，${savedText}` : '已停止，尚未收到完整转写。');
      renderTranscript();
    },
  });
  $('#interviewStart').addEventListener('click', start);
  $('#interviewStop').addEventListener('click', () => controller.stop());
  $('#interviewPermissions').addEventListener('click', () => {
    const kind = lastError.includes('麦克风') ? 'mic' : 'system';
    Promise.resolve(window.interviewBridge?.openAudioPermissions?.(kind)).catch(() => status('无法打开系统隐私设置，请在系统设置中检查录音权限。', true));
  });
  $('#interviewExport').addEventListener('click', exportText);
  $('#interviewRetrySave').addEventListener('click', async () => {
    if (!pendingRecord) return;
    const button = $('#interviewRetrySave'); button.disabled = true;
    try { await records.put(pendingRecord); saved = true; lastError = ''; publish({ type: 'error', detail: '' }); publish({ type: 'stopped', saved: true }); status('文字已保存到会话记录。'); }
    catch { status('保存失败，当前文字仍保留，也可以导出文字。', true); }
    finally { button.disabled = false; controls(); }
  });
  window.interviewBridge?.onCommand(command => {
    if (command.run_id !== runId) return;
    if (command.action === 'stop') controller.stop();
    if (command.action === 'mute' && controller.state === 'recording' && ['mic', 'system'].includes(command.source) && typeof command.muted === 'boolean') {
      controller.mute(command.source, command.muted);
      publish({ type: 'mute', source: command.source, muted: command.muted });
    }
  });
  const ensure = () => {
    if (location.hash.split('/')[0] !== '#interview') return;
    initialized = true; loadSetup();
  };
  for (const event of ['hashchange', 'popstate', 'settings:navigate']) window.addEventListener(event, ensure);
  for (const event of ['asr:profiles-changed', 'settings:saved']) window.addEventListener(event, () => { if (initialized) loadSetup(); });
  window.addEventListener('focus', () => { if (initialized && location.hash.split('/')[0] === '#interview') loadSetup(); });
  const dispose = () => { disposing = true; controller.dispose(); };
  window.addEventListener('beforeunload', dispose); window.addEventListener('pagehide', dispose);
  controls(); ensure();
}

if ($('#interviewStart')) init();

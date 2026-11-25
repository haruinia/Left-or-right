import { DualSourceTranscription } from './transcription-capture.js';

export function interviewSocketClass(bridge) {
  return class InterviewSocket extends EventTarget {
    constructor() {
      super();
      this.id = crypto.randomUUID();
      this.readyState = 0;
      this.bufferedAmount = 0;
      this.release = bridge.onInterviewSocketEvent(event => {
        if (event.id !== this.id || this.readyState === 3) return;
        if (event.type === 'open') {
          if (this.readyState === 2) { bridge.closeInterviewSocket(this.id); return; }
          this.readyState = 1;
        }
        if (event.type === 'close') { this.readyState = 3; this.release?.(); }
        this.dispatchEvent(event.type === 'message' ? new MessageEvent('message', { data: event.data }) : new Event(event.type));
      });
      Promise.resolve(bridge.openInterviewSocket(this.id)).then(accepted => {
        if (!accepted) this.failed();
      }).catch(() => this.failed());
    }
    failed() {
      if (this.readyState === 3) return;
      this.dispatchEvent(new Event('error'));
      this.readyState = 3;
      this.release?.();
    }
    send(data) {
      if (this.readyState !== 1) throw new Error('语音连接未就绪。');
      bridge.sendInterviewSocket(this.id, data);
    }
    close() {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      bridge.closeInterviewSocket(this.id);
    }
  };
}

export function createInterviewRecording({ bridge, gatewayUrl, gatewayKey, onNotice, request = fetch, CaptureClass = DualSourceTranscription, capabilities = window.__AUDIO_CAPTURE__ }) {
  let run = null;
  let starting = false;
  let disposed = false;
  let pendingRecord = null;
  const publish = data => { if (run && !disposed) bridge.publishInterview({ ...data, run_id: run.id }); };
  const fetchJson = async (path, body) => {
    const key = gatewayKey();
    const response = await request(`${gatewayUrl()}${path}`, {
      method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
      headers: { ...(key ? { 'X-API-Key': key } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(9000),
    });
    if (!response.ok) throw new Error('读取语音配置失败，请检查本地服务。');
    return response.json();
  };
  const controller = new CaptureClass({
    SocketClass: interviewSocketClass(bridge),
    onState(state) { if (run) publish({ type: 'state', state, role: run.role, sources: ['mic', 'system'] }); },
    onReady(value) { run.sessionId = value.session_id; publish({ type: 'ready', session_id: value.session_id, role: run.role, sources: ['mic', 'system'] }); },
    onTranscript(value) {
      if (value.is_final) {
        run.finals.set(value.segment_id, value);
        while (run.finals.size > 80) run.finals.delete(run.finals.keys().next().value);
      }
      publish({ type: 'transcript', ...value });
    },
    onError(detail) {
      if (run?.sessionId && run.finals.size) pendingRecord = {
        id: run.sessionId, kind: 'transcription', startedAt: run.startedAt, endedAt: new Date().toISOString(),
        note: '连接中断时保留的转写', turns: [...run.finals.values()].map(turn => ({role:'user',source:turn.source,speaker:turn.speaker,text:turn.text})),
      };
      publish({ type: 'error', detail });
    },
    onStopped(value) {
      pendingRecord = value.saved ? null : value.record || pendingRecord;
      publish({ type: 'stopped', saved: Boolean(value.saved) });
      if (pendingRecord) publish({ type: 'error', detail: '文字保存失败；再次开始前会重试保存。' });
    },
  });
  const start = async () => {
    if (disposed || starting || controller.state !== 'idle') return false;
    if (!capabilities?.systemAudioSupported) { onNotice('当前环境不支持双音源采集，请使用桌面 App。'); return false; }
    starting = true;
    onNotice('正在准备录音…');
    try {
      if (pendingRecord) { await fetchJson('/api/learning-assets/sessions/upsert', { item: pendingRecord }); pendingRecord = null; }
      const [profiles, settings] = await Promise.all([fetchJson('/api/config/asr/profiles'), fetchJson('/api/ui/settings')]);
      if (disposed) return false;
      const profile = profiles.profiles?.find(item => item.id === profiles.active_profile_id);
      if (!profile?.configured) { onNotice('请先在接入设置中启用有效的语音配置。'); return false; }
      const current = await bridge.getInterviewState?.();
      if (disposed) return false;
      const role = current?.conversation_id ? current.role : settings.assistant_role;
      run = { id: crypto.randomUUID(), finals: new Map(), startedAt: new Date().toISOString(), role: role === 'interviewer' ? 'interviewer' : 'candidate' };
      onNotice('');
      return await controller.start({ sources: ['mic', 'system'], role: run.role, deviceId: 'default', gatewayUrl: gatewayUrl(), gatewayKey: gatewayKey() });
    } catch (error) {
      onNotice(error.message || '录音未能开始，请重试。');
      return false;
    } finally { starting = false; }
  };
  bridge.onInterviewCommand(command => {
    if (!run || command.run_id !== run.id) return;
    if (command.action === 'stop') controller.stop();
    if (command.action === 'mute' && controller.state === 'recording' && ['mic', 'system'].includes(command.source) && typeof command.muted === 'boolean') {
      controller.mute(command.source, command.muted);
      publish({ type: 'mute', source: command.source, muted: command.muted });
    }
  });
  return { start, dispose() { disposed = true; controller.dispose(); } };
}

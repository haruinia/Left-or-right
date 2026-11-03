'use strict';

const PHASES = new Set(['acquiring', 'connecting', 'recording', 'stopping', 'idle']);
const SOURCES = new Set(['mic', 'system']);
const ROLES = new Set(['candidate', 'interviewer']);
const validId = value => typeof value === 'string' && /^[\w-]{1,100}$/.test(value);
const sourcesValid = values => Array.isArray(values) && values.length > 0 && values.length <= 2 && new Set(values).size === values.length && values.every(source => SOURCES.has(source));

function registerInterviewRelay({ ipcMain, getMainWindow, getSettingsWindow, gatewayUrl, visibility }) {
  const origin = new URL(gatewayUrl).origin;
  let state = { revision: 0, run_id: '', session_id: '', phase: 'idle', role: 'candidate', sources: [], transcripts: [], partials: { mic: null, system: null }, muted: { mic: false, system: false }, error: '', saved: false };
  let sourceWindow = null;
  let startVersion = 0;
  const retired = new Set();
  const alive = window => window && !window.isDestroyed();
  function owned(event, window) {
    return alive(window) && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
  }
  function fromSettings(event) {
    const window = getSettingsWindow();
    if (!owned(event, window)) return false;
    try {
      const url = new URL(window.webContents.getURL());
      return url.origin === origin && ['/settings', '/settings.html'].includes(url.pathname);
    } catch { return false; }
  }
  const snapshot = () => JSON.parse(JSON.stringify(state));
  function publish() {
    state.revision += 1;
    const main = getMainWindow();
    if (alive(main)) main.webContents.send('interview:state', snapshot());
  }
  function retire() {
    if (state.run_id) retired.add(state.run_id);
    if (retired.size > 100) retired.delete(retired.values().next().value);
  }
  function invalidate(window) {
    if (window !== sourceWindow) return;
    retire();
    if (state.phase !== 'idle') state.error = '录音窗口已关闭，转写已停止。';
    state.phase = 'idle';
    state.partials = { mic: null, system: null };
    publish();
  }
  function watch(window) {
    if (sourceWindow === window) return;
    sourceWindow = window;
    window.once('closed', () => invalidate(window));
    window.webContents.on('did-navigate', () => invalidate(window));
    window.webContents.on('render-process-gone', () => invalidate(window));
  }
  function trimHistory() {
    let length = state.transcripts.reduce((count, item) => count + item.text.length, 0);
    while (state.transcripts.length > 80 || length > 32000) length -= state.transcripts.shift().text.length;
  }
  ipcMain.on('interview:publish', (event, data) => {
    if (!fromSettings(event) || !data || !validId(data.run_id) || retired.has(data.run_id)) return;
    const window = getSettingsWindow();
    watch(window);
    if (data.type === 'state' && data.state === 'acquiring' && data.run_id !== state.run_id) {
      if (state.phase !== 'idle' || !ROLES.has(data.role) || !sourcesValid(data.sources)) return;
      retire();
      state = { ...state, run_id: data.run_id, session_id: '', phase: 'acquiring', role: data.role, sources: [...data.sources], transcripts: [], partials: { mic: null, system: null }, muted: { mic: false, system: false }, error: '', saved: false };
      startVersion = visibility.version();
      publish();
      return;
    }
    if (data.run_id !== state.run_id) return;
    switch (data.type) {
      case 'state':
        if (!PHASES.has(data.state)) return;
        if (state.phase === 'idle' && data.state !== 'idle') return;
        state.phase = data.state;
        if (data.state === 'recording' && visibility.canShow(startVersion) && alive(getMainWindow()) && getMainWindow().isVisible() && window.isVisible()) {
          window.webContents.send('app:privacy-hidden');
          window.hide();
        }
        break;
      case 'ready':
        if (state.phase === 'idle' || !validId(data.session_id) || data.role !== state.role || !sourcesValid(data.sources) || data.sources.length !== state.sources.length || data.sources.some(source => !state.sources.includes(source))) return;
        state.session_id = data.session_id;
        break;
      case 'transcript': {
        if (state.phase === 'idle' || !state.session_id || !state.sources.includes(data.source) || typeof data.text !== 'string' || !data.text.trim() || typeof data.is_final !== 'boolean') return;
        if (!Number.isSafeInteger(data.start_ms) || data.start_ms < 0 || !Number.isSafeInteger(data.end_ms) || data.end_ms < data.start_ms) return;
        const text = data.text.length > 8000 ? `${data.text.slice(0, 7999)}…` : data.text;
        const speaker = data.source === 'mic' ? state.role : state.role === 'candidate' ? 'interviewer' : 'candidate';
        const item = { source: data.source, speaker, text, start_ms: data.start_ms, end_ms: data.end_ms, is_final: data.is_final, segment_id: `${data.source}:${data.start_ms}` };
        const index = state.transcripts.findIndex(entry => entry.segment_id === item.segment_id);
        if (item.is_final) {
          if (index >= 0) state.transcripts[index] = item;
          else state.transcripts.push(item);
          if (state.partials[data.source]?.segment_id === item.segment_id) state.partials[data.source] = null;
          state.transcripts.sort((left, right) => left.start_ms - right.start_ms || left.source.localeCompare(right.source) || left.segment_id.localeCompare(right.segment_id));
          trimHistory();
        } else if (index < 0) state.partials[data.source] = item;
        break;
      }
      case 'mute':
        if (!state.sources.includes(data.source) || typeof data.muted !== 'boolean') return;
        state.muted[data.source] = data.muted;
        break;
      case 'error':
        if (typeof data.detail !== 'string') return;
        state.error = data.detail.slice(0, 500);
        break;
      case 'stopped':
        if (typeof data.saved !== 'boolean') return;
        state.phase = 'idle';
        state.saved = data.saved;
        break;
      default: return;
    }
    publish();
  });
  ipcMain.handle('interview:getState', event => owned(event, getMainWindow()) ? snapshot() : null);
  ipcMain.handle('interview:command', (event, command) => {
    const settings = getSettingsWindow();
    if (!owned(event, getMainWindow()) || !alive(settings) || !command || command.run_id !== state.run_id || state.phase === 'idle') return false;
    let safe;
    if (command.action === 'stop') safe = { run_id: state.run_id, action: 'stop' };
    else if (command.action === 'mute' && state.phase === 'recording' && state.sources.includes(command.source) && typeof command.muted === 'boolean') safe = { run_id: state.run_id, action: 'mute', source: command.source, muted: command.muted };
    else return false;
    settings.webContents.send('interview:command', safe);
    return true;
  });
}

module.exports = { registerInterviewRelay };

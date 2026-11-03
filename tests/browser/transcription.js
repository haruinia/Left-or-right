async (page, { base = new URL(page.url()).origin } = {}) => {
  const errors = [], savedPayloads = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  const profile = { id: 'test-asr', name: '测试语音接入', provider: 'aliyun_ws', endpoint: 'wss://asr.example.test/inference', model: 'test-streaming-model', language_hints: 'zh,en', vocabulary_id: '', api_key_configured: true };
  await page.route('**/api/config/asr/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/key')) return route.fulfill({ json: { api_key: 'test-secret-not-real' } });
    if (url.pathname.endsWith('/check')) return route.fulfill({ json: { ok: true, detail: '连接验证通过；未进行语音识别。' } });
    if (route.request().method() === 'POST' && url.pathname.endsWith('/profiles')) { const body = route.request().postDataJSON(); savedPayloads.push(body); Object.assign(profile, body); delete profile.api_key; }
    return route.fulfill({ json: { profiles: [profile], active_profile_id: profile.id } });
  });
  await page.route('**/api/learning-assets/**', route => {
    if (route.request().method() === 'POST') { const body = route.request().postDataJSON(); writes.push(body); return route.fulfill({ json: { item: body.item } }); }
    return route.fulfill({ json: { items: [] } });
  });
  await page.route('**/api/ui/settings', route => route.fulfill({ json: { assistant_role: 'candidate', study_specialty: '', study_language: '', study_answer_style: 'solution', answer_language: 'zh-CN', study_goal: '', study_instructions: '', jd_text: '', resume_text: '', long_term_memory_consent: false } }));
  await page.route('**/api/config/llm/profiles', route => route.fulfill({ json: { profiles: [], presets: [], active_profile_id: '' } }));
  await page.addInitScript(() => {
    if (!window.__APP_SETTINGS__) window.__APP_SETTINGS__ = true;
    if (!window.__AUDIO_CAPTURE__) window.__AUDIO_CAPTURE__ = { platform: 'darwin', systemAudioSupported: true };
    const state = window.__testTranscription = { tracks: [], sockets: [], contexts: [], delaySystem: false, failSave: false, messages: [] };
    class Track extends EventTarget {
      constructor(kind, source) { super(); this.kind = kind; this.source = source; this.enabled = true; this.readyState = 'live'; state.tracks.push(this); }
      stop() { this.readyState = 'ended'; }
    }
    class Stream {
      constructor(tracks) { this.tracks = tracks; }
      getTracks() { return this.tracks; }
      getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
      getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
    }
    const system = () => new Stream([new Track('audio', 'system'), new Track('video', 'system')]);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      enumerateDevices: async () => [{ kind: 'audioinput', deviceId: 'test-mic', label: '测试麦克风' }],
      getUserMedia: async () => new Stream([new Track('audio', 'mic')]),
      getDisplayMedia: () => state.delaySystem ? new Promise(resolve => { state.resolveSystem = () => resolve(system()); }) : Promise.resolve(system()),
    } });
    window.MediaStream = Stream;
    window.AudioContext = class {
      constructor(options) { this.sampleRate = options.sampleRate; this.state = 'suspended'; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; state.contexts.push(this); }
      async resume() { this.state = 'running'; }
      async close() { this.state = 'closed'; }
      createMediaStreamSource(stream) { return { connect(node) { node.track = stream.getAudioTracks()[0]; }, disconnect() {} }; }
      createGain() { return { gain: {}, connect() {}, disconnect() {} }; }
    };
    window.AudioWorkletNode = class {
      constructor() { this.port = { close() {}, onmessage: null, postMessage: data => { this.chunk(); this.port.onmessage?.({ data: { type: 'flushed', id: data.id } }); } }; }
      chunk() { this.port.onmessage?.({ data: { type: 'chunk', buffer: new ArrayBuffer(3200), rms: this.track?.enabled ? .2 : 0 } }); }
      connect() { this.timer = setInterval(() => this.chunk(), 100); }
      disconnect() { clearInterval(this.timer); }
    };
    window.WebSocket = class extends EventTarget {
      static OPEN = 1;
      constructor(url) { super(); this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.finals = []; state.sockets.push(this); setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }, 0); }
      event(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
      send(raw) {
        const data = JSON.parse(raw); state.messages.push(data);
        if (data.type === 'start') {
          this.start = data;
          setTimeout(() => this.event({ type: 'ready', session_id: `test-${state.sockets.length}`, role: data.role, sources: data.sources, profile: { id: 'test-asr', name: '测试语音接入', model: 'test-streaming-model' } }), 0);
        }
        if (data.type === 'audio' && data.seq < 2 && !(data.seq === 1 && state.onlyPartial)) {
          const segment = { type: 'transcript', source: data.source, speaker: 'unknown', text: `${data.source === 'mic' ? '麦克风' : '系统声音'}测试文字`, start_ms: 0, end_ms: 200, is_final: data.seq === 1, segment_id: `${data.source}:0` };
          if (segment.is_final) this.finals.push(segment);
          this.event(segment);
        }
        if (data.type === 'stop') {
          if (state.errorOnStop || state.failSave) this.event({ type: 'error', code: state.failSave ? 'save_failed' : 'provider_failed', detail: state.failSave ? '测试保存失败' : '测试语音服务中断' });
          state.errorOnStop = false;
          const turns = this.finals.map(segment => ({ role: 'user', text: segment.text, source: segment.source, speaker: segment.source === 'mic' ? this.start.role : this.start.role === 'candidate' ? 'interviewer' : 'candidate' }));
          setTimeout(() => this.event({ type: 'stopped', saved: !state.failSave, record_id: 'record-test', record: { id: 'record-test', kind: 'transcription', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), turns, turnCount: turns.length } }), 0);
        }
      }
      close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
    };
  });
  const check = (ok, message) => { if (!ok) throw Error(message); };
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${base}/settings?transcription-test#asr`);
  await page.waitForFunction(() => document.querySelector('#asrApiKey').value === '************');
  check(await page.locator('#asrApiKey').getAttribute('type') === 'password', 'Saved key not masked');
  await page.locator('#asrToggleKey').click();
  await page.waitForFunction(() => document.querySelector('#asrApiKey').type === 'text');
  check(await page.locator('#asrApiKey').inputValue() === 'test-secret-not-real', 'Explicit reveal failed');
  await page.locator('#asrToggleKey').click();
  await page.locator('#asrSave').click();
  await page.waitForFunction(() => !document.querySelector('#asrSave').disabled);
  check(savedPayloads.length === 1 && !Object.hasOwn(savedPayloads[0], 'api_key'), 'Unchanged key was sent');
  await page.locator('#asrCheck').click();
  await page.getByText('连接验证通过；未进行语音识别。').waitFor();
  await page.locator('.settings-nav a[href="#interview"]').click();
  await page.waitForFunction(() => !document.querySelector('#interviewStart').disabled);
  check(await page.evaluate(() => window.__testTranscription.sockets.length === 0), 'Audio started without an explicit action');
  await page.locator('#interviewStart').click();
  await page.waitForFunction(() => !document.querySelector('#interviewMicMute').disabled);
  await page.waitForFunction(() => document.querySelectorAll('#interviewTranscript .transcription-turn').length === 2);
  check(await page.locator('#interviewRole').isDisabled(), 'Role can change during a session');
  check((await page.locator('.transcription-turn[data-source="mic"] strong').textContent()).includes('候选人'), 'Microphone role reversed');
  check((await page.locator('.transcription-turn[data-source="system"] strong').textContent()).includes('面试官'), 'System role reversed');
  await page.locator('#interviewMicMute').click();
  check(await page.evaluate(() => window.__testTranscription.tracks.find(track => track.source === 'mic').enabled === false && window.__testTranscription.tracks.find(track => track.source === 'system' && track.kind === 'audio').enabled === true), 'Muting mixed the channels');
  await page.evaluate(() => window.dispatchEvent(new Event('app:privacy-hidden')));
  check(await page.evaluate(() => window.__testTranscription.tracks.some(track => track.readyState === 'live')), 'Hiding the window silently stopped recording');
  profile.id = 'next-asr'; profile.name = '下一场语音';
  await page.evaluate(() => window.dispatchEvent(new Event('asr:profiles-changed')));
  check(await page.locator('#interviewProfile').inputValue() === 'test-asr', 'Running profile snapshot changed');
  await page.evaluate(() => { window.__testTranscription.errorOnStop = true; });
  await page.locator('#interviewStop').click();
  await page.waitForFunction(() => !document.querySelector('#interviewStart').disabled);
  check(await page.locator('#interviewProfile').inputValue() === 'next-asr', 'Next-session profile did not refresh');
  check((await page.locator('#interviewStatus').textContent()).includes('测试语音服务中断') && (await page.locator('#interviewStatus').textContent()).includes('已保存'), 'Saving erased the provider error');
  check(await page.evaluate(() => window.__testTranscription.tracks.every(track => track.readyState === 'ended') && window.__testTranscription.contexts.every(context => context.state === 'closed')), 'Stop leaked audio resources');
  const frames = await page.evaluate(() => window.__testTranscription.messages.filter(message => message.type === 'audio').map(message => ({ source: message.source, seq: message.seq })));
  check(frames.some(frame => frame.source === 'mic' && frame.seq === 0) && frames.some(frame => frame.source === 'system' && frame.seq === 0), 'Sources do not use independent sequence spaces');
  await page.locator('#interviewRole').selectOption('interviewer');
  await page.evaluate(() => { window.__testTranscription.failSave = true; });
  await page.locator('#interviewStart').click();
  await page.waitForFunction(() => document.querySelectorAll('#interviewTranscript .transcription-turn').length === 2);
  check((await page.locator('.transcription-turn[data-source="mic"] strong').textContent()).includes('面试官'), 'Reverse identity microphone mapping failed');
  check((await page.locator('.transcription-turn[data-source="system"] strong').textContent()).includes('候选人'), 'Reverse identity system mapping failed');
  await page.locator('#interviewStop').click();
  await page.locator('#interviewRetrySave').waitFor();
  check(await page.locator('#interviewStart').isDisabled(), 'Failed-save text can be discarded by starting again');
  await page.locator('#interviewRetrySave').click();
  await page.waitForFunction(() => !document.querySelector('#interviewStart').disabled);
  check(writes.length === 1 && writes[0].item.turns.length === 2 && !JSON.stringify(writes).includes('api_key'), 'Text-only retry save failed');
  await page.evaluate(() => { window.__testTranscription.failSave = false; window.__testTranscription.onlyPartial = true; });
  await page.locator('#interviewStart').click();
  await page.waitForFunction(() => !document.querySelector('#interviewMicPartial').hidden);
  await page.evaluate(() => {
    const socket = window.__testTranscription.sockets.at(-1);
    socket.event({ type: 'error', code: 'provider_failed', detail: '测试服务中断，仅收到未完成文字' });
    socket.event({ type: 'stopped', saved: false, record: null });
  });
  await page.waitForFunction(() => !document.querySelector('#interviewStart').disabled);
  check((await page.locator('#interviewMicPartial').textContent()).includes('未完成'), 'Partial-only failure lost its text');
  check(!await page.locator('#interviewExport').isDisabled(), 'Partial-only text cannot be exported');
  await page.evaluate(() => { window.__testTranscription.onlyPartial = false; window.__testTranscription.delaySystem = true; });
  const socketCount = await page.evaluate(() => window.__testTranscription.sockets.length);
  await page.locator('#interviewStart').click();
  await page.waitForFunction(() => typeof window.__testTranscription.resolveSystem === 'function');
  await page.locator('#interviewStop').click();
  await page.evaluate(() => window.__testTranscription.resolveSystem());
  await page.waitForFunction(() => !document.querySelector('#interviewStart').disabled);
  check(await page.evaluate(count => window.__testTranscription.sockets.length === count && window.__testTranscription.tracks.every(track => track.readyState === 'ended'), socketCount), 'Late permission cancellation leaked a stream or started ASR');
  await page.setViewportSize({ width: 375, height: 812 });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Transcription page overflows on mobile');
  check(errors.length === 0, errors.join('\n'));
  return { passed: true, mockedAudioOnly: true, separateSources: true, bothRoleMappings: true, independentMute: true, explicitStartStop: true, flushAndRelease: true, cancelledPermission: true, maskedAsrCredentials: true, retryTextSave: true, noAutorecord: true, mobile: true };
}

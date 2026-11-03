export function speakerForSource(source, role) {
  return source === 'mic' ? role : role === 'candidate' ? 'interviewer' : 'candidate';
}

export function pcmBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let value = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) value += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(value);
}

function stopStream(stream) {
  stream?.getTracks().forEach(track => track.stop());
}

function captureError(error, source) {
  const name = source === 'mic' ? '麦克风' : '系统声音';
  if (error?.name === 'NotAllowedError') return `${name}权限未允许，请检查系统隐私设置后重试。`;
  if (error?.name === 'NotFoundError') return `未找到可用的${name}设备。`;
  return `${name}无法采集，请检查设备与录音权限。`;
}

export class DualSourceTranscription {
  constructor({ onState = () => {}, onError = () => {}, onTranscript = () => {}, onStopped = () => {}, onReady = () => {}, onLevel = () => {}, mediaDevices = navigator.mediaDevices, AudioContextClass = window.AudioContext, WorkletClass = window.AudioWorkletNode, SocketClass = window.WebSocket, MediaStreamClass = window.MediaStream } = {}) {
    Object.assign(this, { onState, onError, onTranscript, onStopped, onReady, onLevel, mediaDevices, AudioContextClass, WorkletClass, SocketClass, MediaStreamClass });
    this.run = null;
    this.state = 'idle';
  }

  phase(state) {
    this.state = state;
    this.onState(state);
  }

  start(options) {
    if (this.run) return Promise.reject(new Error('请先停止当前转写。'));
    if (!options.sources.length || new Set(options.sources).size !== options.sources.length || options.sources.some(source => !['mic', 'system'].includes(source))) return Promise.reject(new Error('请选择有效的音源。'));
    if (!['candidate', 'interviewer'].includes(options.role)) return Promise.reject(new Error('请选择我的身份。'));
    const run = { options: { ...options, sources: [...options.sources] }, streams: new Map(), channels: new Map(), cancelled: false, stopping: false, ready: false, error: '', finished: false };
    run.acquisitionCancelled = new Promise(resolve => { run.cancelAcquisition = resolve; });
    const acquisitionFailed = message => {
      if (run.cancelled || run.finished) return;
      run.error = message;
      run.cancelled = true;
      run.cancelAcquisition();
      this.releaseAudio(run);
    };
    this.run = run;
    this.phase('acquiring');
    const pending = [];
    try {
      run.context = new this.AudioContextClass({ sampleRate: 16000 });
      pending.push(Promise.resolve(run.context.resume()).catch(() => acquisitionFailed('音频处理器未能启动，请检查录音权限后重试。')));
      pending.push(Promise.resolve(run.context.audioWorklet.addModule(new URL('./transcription-worklet.js', import.meta.url))).catch(() => acquisitionFailed('音频处理器未能启动，请检查录音权限后重试。')));
      for (const source of options.sources) {
        let request;
        try {
          request = source === 'mic'
            ? this.mediaDevices.getUserMedia({ audio: { ...(options.deviceId && options.deviceId !== 'default' ? { deviceId: { exact: options.deviceId } } : {}), channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
            : this.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false }, systemAudio: 'include' });
        } catch (error) { request = Promise.reject(error); }
        pending.push(Promise.resolve(request).then(stream => {
          if (run.cancelled) { stopStream(stream); return; }
          run.streams.set(source, stream);
          const audio = stream.getAudioTracks();
          if (!audio.length || audio.some(track => track.readyState === 'ended')) throw new Error('Audio track unavailable');
          stream.getVideoTracks().forEach(track => { track.enabled = false; });
          for (const track of audio) track.addEventListener('ended', () => {
            if (!run.cancelled && !run.stopping) this.fail(run, `${source === 'mic' ? '麦克风' : '系统声音'}已断开，转写已停止。`);
          });
        }).catch(error => acquisitionFailed(captureError(error, source))));
      }
    } catch {
      acquisitionFailed('当前环境无法初始化音频采集。请在新版 App 中打开。');
    }
    run.startTask = this.connect(run, pending).catch(async error => {
      if (run.finished) return false;
      if (!run.cancelled) run.error = error.message || '转写启动失败。';
      if (run.error && !run.errorReported) this.onError(run.error);
      await this.finish(run);
      return false;
    });
    return run.startTask;
  }

  async connect(run, pending) {
    const results = await Promise.race([Promise.allSettled(pending), run.acquisitionCancelled]);
    if (run.cancelled) { if (run.error) throw Error(run.error); await this.finish(run); return false; }
    if (results.some(result => result.status === 'rejected') || run.context.sampleRate !== 16000 || run.context.state !== 'running') throw Error('音频处理器未能启动，请检查录音权限后重试。');
    this.phase('connecting');
    const url = new URL('/ws/transcription', run.options.gatewayUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    run.socket = new this.SocketClass(url.href);
    run.stopped = new Promise(resolve => { run.resolveStopped = resolve; });
    await new Promise((resolve, reject) => {
      run.rejectReady = reject;
      run.readyTimer = setTimeout(() => reject(Error('语音服务连接超时。')), 20000);
      run.socket.addEventListener('open', () => {
        if (run.cancelled) { reject(Error('启动已取消。')); return; }
        run.socket.send(JSON.stringify({ type: 'start', role: run.options.role, sources: run.options.sources, api_key: run.options.gatewayKey || '' }));
      });
      run.socket.addEventListener('message', event => {
        if (run.finished) return;
        let data;
        try { data = JSON.parse(event.data); } catch { this.fail(run, '转写服务返回了无效数据。'); return; }
        if (data.type === 'ready') {
          clearTimeout(run.readyTimer);
          if (run.cancelled) return;
          run.ready = true; run.rejectReady = null; this.onReady(data); resolve();
        } else if (data.type === 'transcript' && run.options.sources.includes(data.source)) {
          this.onTranscript({ ...data, speaker: speakerForSource(data.source, run.options.role) });
        } else if (data.type === 'stopped') {
          run.receivedStopped = true;
          this.onStopped(data); run.resolveStopped(data);
          if (!run.stopTask) this.finish(run);
        } else if (data.type === 'error') {
          if (run.ready) this.serverError(run, data.detail || '语音识别服务异常，转写已停止。');
          else this.fail(run, data.detail || '语音识别服务异常，转写已停止。');
        }
      });
      run.socket.addEventListener('error', () => this.fail(run, '无法连接语音转写服务。'));
      run.socket.addEventListener('close', () => {
        if (!run.finished && !run.cancelled && !run.receivedStopped) this.fail(run, '转写连接已断开，已收到的文字仍保留，可导出文字。');
      });
    });
    if (run.cancelled || run.finished) return false;
    const firstChunks = [];
    for (const [source, stream] of run.streams) {
      const node = new this.WorkletClass(run.context, 'dual-source-pcm', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const input = run.context.createMediaStreamSource(new this.MediaStreamClass(stream.getAudioTracks()));
      const silent = run.context.createGain(); silent.gain.value = 0;
      const channel = { node, input, silent, seq: 0, lastChunk: Date.now(), flushes: new Map() };
      firstChunks.push(new Promise(resolve => { channel.firstChunk = resolve; }));
      run.channels.set(source, channel);
      node.port.onmessage = event => {
        if (event.data?.type === 'flushed') { channel.flushes.get(event.data.id)?.(); channel.flushes.delete(event.data.id); return; }
        if (event.data?.type !== 'chunk' || run.cancelled || run.serverEnding) return;
        channel.firstChunk(); channel.lastChunk = Date.now();
        this.onLevel(source, event.data.rms);
        if (run.socket.readyState !== 1 || run.socket.bufferedAmount > 512 * 1024) { this.fail(run, '音频发送积压或连接中断，转写已停止，请检查网络。'); return; }
        run.socket.send(JSON.stringify({ type: 'audio', source, seq: channel.seq++, audio: pcmBase64(event.data.buffer) }));
      };
      input.connect(node); node.connect(silent); silent.connect(run.context.destination);
    }
    let timeout;
    try {
      await Promise.race([Promise.all(firstChunks), new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('没有收到有效音频帧，请检查系统音频与麦克风权限。')), 7000); })]);
    } finally { clearTimeout(timeout); }
    if (run.cancelled || run.finished || run.stopping) return false;
    this.phase('recording');
    run.watchdog = setInterval(() => {
      if ([...run.channels.values()].some(channel => Date.now() - channel.lastChunk > 7000)) this.fail(run, '音源停止提供音频，转写已停止，请检查设备。');
    }, 1000);
    return true;
  }

  mute(source, muted) {
    this.run?.streams.get(source)?.getAudioTracks().forEach(track => { track.enabled = !muted; });
  }

  stop() {
    const run = this.run;
    if (!run) return Promise.resolve();
    if (run.stopTask) return run.stopTask;
    run.stopping = true;
    this.phase('stopping');
    run.stopTask = (async () => {
      clearInterval(run.watchdog);
      if (!run.ready) {
        run.cancelled = true;
        run.cancelAcquisition();
        run.rejectReady?.(Error('启动已取消。'));
        await this.finish(run);
        return;
      }
      try {
        await Promise.all([...run.channels.values()].map(channel => new Promise((resolve, reject) => {
          const id = `${Date.now()}-${channel.seq}`;
          const timer = setTimeout(() => { channel.flushes.delete(id); reject(Error('音频收尾超时。')); }, 1500);
          channel.flushes.set(id, () => { clearTimeout(timer); resolve(); });
          channel.node.port.postMessage({ type: 'flush', id });
        })));
        if (run.cancelled || run.finished) return;
        await this.releaseAudio(run);
        if (run.socket.readyState !== 1) throw Error('连接已断开，已收到的文字仍保留。');
        if (!run.serverEnding) run.socket.send(JSON.stringify({ type: 'stop' }));
        await this.waitForStopped(run);
      } catch (error) { if (!run.finished) this.onError(error.message); }
      finally { await this.finish(run); }
    })();
    return run.stopTask;
  }

  waitForStopped(run) {
    if (!run.waitTask) {
      run.waitTask = Promise.race([run.stopped, new Promise((_, reject) => {
        run.stopTimer = setTimeout(() => reject(Error('转写收尾超时，已收到的文字仍保留，可导出文字。')), 25000);
      })]).finally(() => clearTimeout(run.stopTimer));
    }
    return run.waitTask;
  }

  serverError(run, message) {
    if (run.finished || run.cancelled) return;
    run.serverEnding = true; run.stopping = true;
    run.error = message; run.errorReported = true;
    clearInterval(run.watchdog);
    this.phase('stopping');
    this.onError(message);
    this.releaseAudio(run);
    if (!run.stopTask) {
      run.stopTask = (async () => {
        try { await this.waitForStopped(run); }
        catch (error) { if (!run.finished) this.onError(error.message); }
        finally { await this.finish(run); }
      })();
    }
  }

  releaseAudio(run) {
    for (const stream of run.streams.values()) stopStream(stream);
    for (const channel of run.channels.values()) {
      channel.firstChunk();
      if (channel.disconnected) continue;
      channel.disconnected = true;
      for (const resolve of channel.flushes.values()) resolve();
      channel.flushes.clear();
      channel.input.disconnect(); channel.node.disconnect(); channel.silent.disconnect();
      channel.node.port.onmessage = null;
      channel.node.port.close();
    }
    if (!run.closingAudio) run.closingAudio = run.context && run.context.state !== 'closed' ? run.context.close().catch(() => {}) : Promise.resolve();
    return run.closingAudio;
  }

  fail(run, message) {
    if (run.finished || run.cancelled) return;
    run.error = message;
    run.cancelled = true;
    run.rejectReady?.(Error(message));
    run.resolveStopped?.(null);
    run.errorReported = true;
    this.onError(message);
    this.finish(run);
  }

  async finish(run) {
    if (run.finished) return;
    run.finished = true; run.cancelled = true;
    run.cancelAcquisition();
    run.rejectReady?.(Error('启动已取消。'));
    run.rejectReady = null;
    clearTimeout(run.readyTimer); clearTimeout(run.stopTimer); clearInterval(run.watchdog);
    run.resolveStopped?.(null);
    run.socket?.close();
    await this.releaseAudio(run);
    for (const source of run.options.sources) this.onLevel(source, 0);
    if (this.run === run) { this.run = null; this.phase('idle'); }
  }

  dispose() {
    if (this.run) this.finish(this.run);
  }
}

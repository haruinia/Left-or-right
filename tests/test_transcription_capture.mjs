import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { DualSourceTranscription, speakerForSource, pcmBase64 } from '../web/modules/transcription-capture.js';

function processor() {
  let Processor;
  const messages = [];
  class AudioWorkletProcessor { constructor() { this.port = { postMessage: (message, transfer) => messages.push({ message, transfer }) }; } }
  vm.runInNewContext(fs.readFileSync(new URL('../web/modules/transcription-worklet.js', import.meta.url), 'utf8'), { AudioWorkletProcessor, registerProcessor: (_name, value) => { Processor = value; }, Float32Array, ArrayBuffer, DataView, Math });
  return { node: new Processor(), messages };
}

test('PCM worklet averages channels, emits 100ms little-endian frames and never monitors audio', () => {
  const { node, messages } = processor();
  const output = new Float32Array(1600).fill(1);
  node.process([[new Float32Array(1600).fill(1), new Float32Array(1600).fill(0)]], [[output]]);
  assert.ok(output.every(value => value === 0));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].message.buffer.byteLength, 3200);
  assert.equal(new DataView(messages[0].message.buffer).getInt16(0, true), 16383);
  assert.equal(messages[0].message.rms, .5);
  assert.equal(messages[0].transfer[0], messages[0].message.buffer);
});

test('worklet preserves remainder across callbacks and flushes once before acknowledgement', () => {
  const { node, messages } = processor();
  node.process([[new Float32Array(1000).fill(-1)]], []);
  node.process([[new Float32Array(800).fill(.25)]], []);
  assert.equal(messages.length, 1);
  assert.equal(new DataView(messages[0].message.buffer).getInt16(0, true), -32768);
  node.port.onmessage({ data: { type: 'flush', id: 'finish' } });
  assert.equal(messages[1].message.buffer.byteLength, 400);
  assert.equal(messages[2].message.type, 'flushed');
  assert.equal(messages[2].message.id, 'finish');
  node.port.onmessage({ data: { type: 'flush', id: 'again' } });
  assert.equal(messages[3].message.type, 'flushed');
});

test('source roles map in both directions without depending on old interviewer defaults', () => {
  assert.equal(speakerForSource('mic', 'candidate'), 'candidate');
  assert.equal(speakerForSource('system', 'candidate'), 'interviewer');
  assert.equal(speakerForSource('mic', 'interviewer'), 'interviewer');
  assert.equal(speakerForSource('system', 'interviewer'), 'candidate');
  assert.deepEqual(Buffer.from(pcmBase64(new Uint8Array([0, 128, 255, 127]).buffer), 'base64'), Buffer.from([0, 128, 255, 127]));
});

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ delayedSystem = false, failSystem = false, autoStop = true } = {}) {
  const tracks = [], sockets = [], contexts = [], nodes = [], phases = [], errors = [], transcript = [], stopped = [];
  let resolveSystem;
  class Track extends EventTarget {
    constructor(kind) { super(); this.kind = kind; this.enabled = true; this.readyState = 'live'; tracks.push(this); }
    stop() { this.readyState = 'ended'; }
  }
  class Stream { constructor(items) { this.items = items || [new Track('audio')]; } getTracks() { return this.items; } getAudioTracks() { return this.items.filter(item => item.kind === 'audio'); } getVideoTracks() { return this.items.filter(item => item.kind === 'video'); } }
  const mediaDevices = {
    getUserMedia() { return Promise.resolve(new Stream()); },
    getDisplayMedia() {
      if (failSystem) return Promise.reject(Object.assign(Error('denied'), { name: 'NotAllowedError' }));
      if (delayedSystem) return new Promise(resolve => { resolveSystem = () => resolve(new Stream([new Track('audio'), new Track('video')])); });
      return Promise.resolve(new Stream([new Track('audio'), new Track('video')]));
    },
  };
  class Context {
    constructor(options) { this.sampleRate = options.sampleRate; this.state = 'suspended'; this.audioWorklet = { addModule: async () => {} }; this.destination = {}; contexts.push(this); }
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: {}, connect() {}, disconnect() {} }; }
  }
  class Worklet {
    constructor() {
      this.port = { onmessage: null, close() {}, postMessage: data => {
        if (data.type === 'flush') { this.chunk(); this.port.onmessage?.({ data: { type: 'flushed', id: data.id } }); }
      } };
      nodes.push(this);
    }
    chunk() { this.port.onmessage?.({ data: { type: 'chunk', buffer: new Uint8Array(3200).buffer, rms: .2 } }); }
    connect() { queueMicrotask(() => this.chunk()); }
    disconnect() {}
  }
  class Socket extends EventTarget {
    constructor(url) { super(); this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.sent = []; sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
    message(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
    send(raw) {
      const data = JSON.parse(raw); this.sent.push(data);
      if (data.type === 'start') queueMicrotask(() => this.message({ type: 'ready', session_id: 'test-session' }));
      if (data.type === 'stop' && autoStop) queueMicrotask(() => {
        this.message({ type: 'transcript', source: 'system', speaker: 'wrong', text: '最后一句', start_ms: 0, end_ms: 100, is_final: true, segment_id: 'system:0' });
        this.message({ type: 'stopped', saved: true, record: { id: 'test-session' } });
      });
    }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const client = new DualSourceTranscription({ mediaDevices, AudioContextClass: Context, WorkletClass: Worklet, SocketClass: Socket, MediaStreamClass: Stream, onState: value => phases.push(value), onError: value => errors.push(value), onTranscript: value => transcript.push(value), onStopped: value => stopped.push(value) });
  const options = { gatewayUrl: 'http://127.0.0.1:9958', gatewayKey: 'local-test', sources: ['mic', 'system'], role: 'candidate' };
  return { client, options, tracks, sockets, contexts, nodes, phases, errors, transcript, stopped, mediaDevices, Track, Stream, resolveSystem: () => resolveSystem() };
}

test('dual channels keep independent sequence spaces, flush before stop and release every track', async () => {
  const f = fixture();
  assert.equal(await f.client.start(f.options), true);
  assert.equal(f.client.state, 'recording');
  assert.equal(f.nodes.length, 2);
  const socket = f.sockets[0];
  assert.equal(socket.url, 'ws://127.0.0.1:9958/ws/transcription');
  assert.equal(socket.sent[0].api_key, 'local-test');
  const chunks = socket.sent.filter(item => item.type === 'audio');
  assert.deepEqual(chunks.map(item => [item.source, item.seq]), [['mic', 0], ['system', 0]]);
  assert.equal(f.tracks.find(track => track.kind === 'video').enabled, false);
  f.client.mute('mic', true);
  assert.equal(f.tracks[0].enabled, false);
  assert.equal(f.tracks[1].enabled, true);
  await f.client.stop();
  assert.equal(socket.sent.at(-1).type, 'stop');
  assert.equal(socket.sent.filter(item => item.type === 'audio').length, 4);
  assert.equal(f.transcript[0].speaker, 'interviewer');
  assert.equal(f.client.state, 'idle');
  assert.ok(f.tracks.every(track => track.readyState === 'ended'));
  assert.equal(f.contexts[0].state, 'closed');
  assert.equal(f.errors.length, 0);
});

test('cancel during system permission prompt releases mic immediately and closes late system tracks', async () => {
  const f = fixture({ delayedSystem: true });
  const start = f.client.start(f.options);
  await tick();
  const stop = f.client.stop();
  assert.equal(f.tracks[0].readyState, 'ended');
  f.resolveSystem();
  await Promise.all([start, stop]);
  assert.ok(f.tracks.every(track => track.readyState === 'ended'));
  assert.equal(f.sockets.length, 0);
  assert.equal(f.client.state, 'idle');
  assert.equal(f.errors.length, 0);
});

async function promptly(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Operation waited for an unresolved permission request')), 100);
    })]);
  } finally { clearTimeout(timer); }
}

test('stop and start settle without waiting for an unanswered permission prompt', async () => {
  const f = fixture({ delayedSystem: true });
  const starting = f.client.start(f.options);
  await tick();
  await promptly(f.client.stop());
  assert.equal(await promptly(starting), false);
  assert.equal(f.client.state, 'idle');
  assert.equal(f.client.run, null);
  assert.equal(f.tracks[0].readyState, 'ended');
  assert.equal(f.contexts[0].state, 'closed');
  assert.equal(f.sockets.length, 0);
  assert.equal(f.errors.length, 0);
});

test('late old permissions are released without stopping or reporting errors against a new run', async () => {
  const f = fixture({ delayedSystem: true });
  const first = f.client.start(f.options);
  await tick();
  await promptly(f.client.stop());
  assert.equal(await promptly(first), false);
  f.mediaDevices.getDisplayMedia = async () => new f.Stream([new f.Track('audio'), new f.Track('video')]);
  assert.equal(await promptly(f.client.start(f.options)), true);
  const current = f.client.run;
  const phaseCount = f.phases.length;
  f.resolveSystem(); await tick();
  assert.ok(f.tracks.slice(-2).every(track => track.readyState === 'ended'));
  assert.equal(f.client.run, current);
  assert.equal(f.client.state, 'recording');
  assert.equal(f.phases.length, phaseCount);
  assert.equal(f.errors.length, 0);
  assert.ok(f.tracks.slice(1, 4).every(track => track.readyState === 'live'));
  await f.client.stop();
});

test('one rejected permission ends acquisition even when the other prompt is unanswered', async () => {
  const f = fixture({ failSystem: true });
  let grantMicrophone;
  f.mediaDevices.getUserMedia = () => new Promise(resolve => { grantMicrophone = resolve; });
  assert.equal(await promptly(f.client.start(f.options)), false);
  assert.equal(f.client.state, 'idle');
  assert.equal(f.client.run, null);
  assert.equal(f.contexts[0].state, 'closed');
  assert.match(f.errors[0], /系统声音权限/);
  assert.equal(f.sockets.length, 0);
  grantMicrophone(new f.Stream()); await tick();
  assert.ok(f.tracks.every(track => track.readyState === 'ended'));
  assert.equal(f.errors.length, 1);
  assert.equal(f.client.state, 'idle');
});

test('audio processor rejection ends acquisition without waiting for a pending permission', async () => {
  const f = fixture({ delayedSystem: true });
  class BrokenContext {
    constructor() { this.state = 'suspended'; this.sampleRate = 16000; this.audioWorklet = { addModule: () => Promise.reject(Error('processor unavailable')) }; }
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; }
  }
  f.client.AudioContextClass = BrokenContext;
  assert.equal(await promptly(f.client.start(f.options)), false);
  assert.equal(f.client.state, 'idle');
  assert.match(f.errors[0], /音频处理器/);
  f.resolveSystem(); await tick();
  assert.ok(f.tracks.every(track => track.readyState === 'ended'));
  assert.equal(f.errors.length, 1);
});

test('disposing pending acquisition settles its start promise and releases late tracks', async () => {
  const f = fixture({ delayedSystem: true });
  const starting = f.client.start(f.options); await tick();
  f.client.dispose();
  assert.equal(await promptly(starting), false);
  await tick();
  assert.equal(f.client.state, 'idle');
  f.resolveSystem(); await tick();
  assert.ok(f.tracks.every(track => track.readyState === 'ended'));
  assert.equal(f.errors.length, 0);
});

test('system permission failure does not silently fall back to microphone recording', async () => {
  const f = fixture({ failSystem: true });
  assert.equal(await f.client.start(f.options), false);
  assert.equal(f.sockets.length, 0);
  assert.ok(f.tracks.every(track => track.readyState === 'ended'));
  assert.match(f.errors[0], /系统声音权限/);
});

test('send backpressure and device loss fail closed instead of dropping audio silently', async () => {
  const f = fixture(); await f.client.start(f.options);
  f.sockets[0].bufferedAmount = 600000;
  f.nodes[0].chunk(); await tick();
  assert.equal(f.client.state, 'idle');
  assert.ok(f.tracks.every(track => track.readyState === 'ended'));
  assert.match(f.errors[0], /积压/);
  const g = fixture(); await g.client.start(g.options);
  g.tracks[0].dispatchEvent(new Event('ended')); await tick();
  assert.equal(g.client.state, 'idle');
  assert.match(g.errors[0], /已断开/);
});

for (const saved of [false, true]) {
  test(`provider error drains tail text and delivers the ${saved ? 'saved' : 'retryable'} record before closing`, async () => {
    const f = fixture({ autoStop: false }); await f.client.start(f.options);
    const socket = f.sockets[0];
    socket.message({ type: 'transcript', source: 'mic', text: '尚未结束', start_ms: 0, is_final: false, segment_id: 'mic:0' });
    socket.message({ type: 'error', code: saved ? 'provider_failed' : 'save_failed', detail: '测试识别失败' });
    assert.ok(f.tracks.every(track => track.readyState === 'ended'));
    assert.equal(socket.readyState, 1);
    assert.equal(f.client.state, 'stopping');
    socket.message({ type: 'transcript', source: 'mic', text: '收尾完整文字', start_ms: 0, is_final: true, segment_id: 'mic:0' });
    const record = { id: 'test-session', turns: [{ text: '收尾完整文字' }] };
    socket.message({ type: 'stopped', saved, record_id: record.id, record });
    await tick();
    assert.equal(f.client.state, 'idle');
    assert.equal(f.transcript.at(-1).text, '收尾完整文字');
    assert.deepEqual(f.stopped[0].record, record);
    assert.equal(f.stopped[0].saved, saved);
    assert.equal(f.errors.length, 1);
    assert.equal(socket.readyState, 3);
  });
}

test('server error arriving during user stop shares the drain and unexpected close still releases resources', async () => {
  const f = fixture({ autoStop: false }); await f.client.start(f.options);
  const stopping = f.client.stop(); await tick();
  f.sockets[0].message({ type: 'error', code: 'save_failed', detail: '保存失败' });
  f.sockets[0].message({ type: 'stopped', saved: false, record: { id: 'retry' } });
  await stopping;
  assert.equal(f.stopped[0].record.id, 'retry');
  assert.equal(f.client.state, 'idle');
  const g = fixture({ autoStop: false }); await g.client.start(g.options);
  g.sockets[0].message({ type: 'error', code: 'provider_failed', detail: '识别失败' });
  g.sockets[0].close(); await tick();
  assert.equal(g.client.state, 'idle');
  assert.ok(g.tracks.every(track => track.readyState === 'ended'));
});

test('late events from a disposed socket do not pollute a new session', async () => {
  const f = fixture(); await f.client.start(f.options);
  const old = f.sockets[0]; f.client.dispose(); await tick();
  await f.client.start({ ...f.options, role: 'interviewer' });
  old.message({ type: 'transcript', source: 'mic', text: 'old', is_final: true });
  assert.equal(f.transcript.length, 0);
  f.sockets[1].message({ type: 'transcript', source: 'system', speaker: 'interviewer', text: 'new', is_final: true });
  assert.equal(f.transcript[0].speaker, 'candidate');
  await f.client.stop();
});

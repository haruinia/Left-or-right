import { micStatus } from './dom.js';
import { eventQuestionMeta, sendLiveSocketPayload } from './live.js';
import { micChunkSamples, micSampleRate, micVoiceRmsThreshold, state } from './state.js';
import { appendEvent, escapeHtml, setControls, setPill } from './ui.js';

function downsampleBuffer(buffer, inputRate, outputRate) {
  if (inputRate === outputRate) return buffer;
  const ratio = inputRate / outputRate;
  const length = Math.floor(buffer.length / ratio);
  const result = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const sourceIndex = index * ratio;
    const before = Math.floor(sourceIndex);
    const after = Math.min(before + 1, buffer.length - 1);
    const weight = sourceIndex - before;
    result[index] = buffer[before] * (1 - weight) + buffer[after] * weight;
  }
  return result;
}

function samplesToBase64Pcm16(samples) {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    const chunk = bytes.subarray(offset, offset + 0x8000);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function appendMicSamples(samples) {
  for (let index = 0; index < samples.length; index += 1) {
    state.micSamples.push(samples[index]);
  }
  while (state.micSamples.length >= micChunkSamples) {
    sendMicSamples(state.micSamples.splice(0, micChunkSamples));
  }
}

function sendMicSamples(samples) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN || samples.length === 0) return;
  if (!state.micSpeechStarted) {
    if (!hasVoiceEnergy(samples)) {
      if (!state.micWaitingForVoiceNotice) {
	              appendEvent(
	                "麦克风",
	                "已开启采集，等待检测到当前角色声音；期间会每 250ms 发送低音量保活音频，避免 ASR 空闲断开。"
	              );
        setPill(micStatus, "等待声音输入", "live");
        state.micWaitingForVoiceNotice = true;
      }
    } else {
      state.micSpeechStarted = true;
      state.micWaitingForVoiceNotice = false;
      appendEvent("麦克风", "检测到声音，开始发送 ASR 音频。");
    }
  }
  const startMs = Math.round((state.micSentSamples / micSampleRate) * 1000);
  const endMs = Math.round(((state.micSentSamples + samples.length) / micSampleRate) * 1000);
  const payload = {
    type: "audio_chunk",
	          session_id: state.interview.id,
	          seq: state.seq,
	          audio: samplesToBase64Pcm16(samples),
	          speaker: state.currentSpeaker,
	          channel: state.currentSpeaker,
	          format: "pcm16",
    sample_rate_hz: micSampleRate,
    channels: 1,
    start_ms: startMs,
    end_ms: endMs,
    is_final: true,
    confidence: 0.95,
    ...eventQuestionMeta(),
  };
  if (!sendLiveSocketPayload(payload, "麦克风")) {
    stopMicCapture({ flush: false });
    return;
  }
  state.seq += 1;
  state.micSentSamples += samples.length;
}

function hasVoiceEnergy(samples) {
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    sum += samples[index] * samples[index];
  }
  return Math.sqrt(sum / samples.length) >= micVoiceRmsThreshold;
}

function audioContextConstructor() {
  return window.AudioContext || window.webkitAudioContext;
}

function nextMicStartToken() {
  state.micStartToken += 1;
  return state.micStartToken;
}

function micStartStillCurrent(token) {
  return (
    token === state.micStartToken &&
    !state.interviewEnded &&
    state.socket &&
    state.socket.readyState === WebSocket.OPEN
  );
}

function stopMediaStream(stream) {
  if (stream) stream.getTracks().forEach((track) => track.stop());
}

async function startMicCapture() {
  if (state.interviewEnded) {
    appendEvent("麦克风", "面试已结束，请重置后创建新的面试。", "red");
    return;
  }
  if (
    state.micStarting ||
    state.micRecording ||
    !state.socket ||
    state.socket.readyState !== WebSocket.OPEN
  ) {
    return;
  }
  const micStartToken = nextMicStartToken();
  state.micStarting = true;
  state.micError = "";
  setControls();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    state.micError = "麦克风不可用";
    appendEvent("麦克风", "当前浏览器不支持麦克风采集。", "red");
    state.micStarting = false;
    setControls();
    return;
  }
  const AudioContextCtor = audioContextConstructor();
  if (!AudioContextCtor) {
    state.micError = "音频采集不可用";
    appendEvent("麦克风", "当前浏览器不支持 Web Audio，无法采集和转换麦克风音频。", "red");
    state.micStarting = false;
    setControls();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    if (!micStartStillCurrent(micStartToken)) {
      stopMediaStream(stream);
      appendEvent("麦克风", "麦克风启动已取消：实时通道已断开或面试已重置。", "red");
      return;
    }
    state.micStream = stream;
    state.micContext = new AudioContextCtor();
    state.micSource = state.micContext.createMediaStreamSource(state.micStream);
    state.micProcessor = state.micContext.createScriptProcessor(4096, 1, 1);
    state.micSamples = [];
    state.micSentSamples = 0;
    state.micSpeechStarted = false;
    state.micWaitingForVoiceNotice = false;
    state.micError = "";
    state.micStarting = false;
    state.micRecording = true;
    state.micProcessor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const output = event.outputBuffer.getChannelData(0);
      output.fill(0);
      appendMicSamples(downsampleBuffer(input, state.micContext.sampleRate, micSampleRate));
    };
    state.micSource.connect(state.micProcessor);
    state.micProcessor.connect(state.micContext.destination);
    // Labelling is a manual switch, and mislabelling silently poisons the
    // transcript, the probe trigger and the report, so it is stated every time
    // capture starts rather than left to the small pill in the toolbar.
    appendEvent(
      "麦克风",
      state.currentSpeaker === "interviewer"
        ? "麦克风已开启，当前音频会标记为<strong>面试官</strong>发言；候选人开口前请切回候选人。"
        : "麦克风已开启，当前音频会标记为<strong>候选人</strong>发言；自己提问时请切到面试官。"
    );
    setControls();
  } catch (error) {
    if (!micStartStillCurrent(micStartToken)) return;
    const reason = micErrorMessage(error);
    state.micError = reason;
    appendEvent("麦克风", escapeHtml(reason), "red");
    stopMicCapture();
  } finally {
    if (micStartToken === state.micStartToken && state.micStarting) {
      state.micStarting = false;
      setControls();
    }
  }
}

function micErrorMessage(error) {
  const name = error && error.name ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "麦克风权限被拒绝：请在浏览器站点权限和 macOS 系统设置中允许当前浏览器使用麦克风。";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "未找到可用麦克风：请确认系统已连接输入设备。";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "麦克风被其他程序占用，或系统暂时无法读取。";
  }
  return `麦克风启动失败：${error}`;
}

function stopMicCapture(options = {}) {
  if (state.micStarting) {
    nextMicStartToken();
    state.micStarting = false;
  }
  if (!state.micRecording && !state.micStream && !state.micContext) {
    setControls();
    return;
  }
  if (options.flush !== false && state.micSamples.length > 0) {
    sendMicSamples(state.micSamples.splice(0, state.micSamples.length));
  }
  state.micRecording = false;
  if (state.micProcessor) {
    state.micProcessor.disconnect();
    state.micProcessor.onaudioprocess = null;
  }
  if (state.micSource) state.micSource.disconnect();
  if (state.micStream) stopMediaStream(state.micStream);
  if (state.micContext && state.micContext.state !== "closed") {
    state.micContext.close().catch(() => {});
  }
  state.micStream = null;
  state.micContext = null;
  state.micSource = null;
  state.micProcessor = null;
  state.micSamples = [];
  state.micSpeechStarted = false;
  state.micWaitingForVoiceNotice = false;
  setControls();
}


export {
  appendMicSamples,
  audioContextConstructor,
  downsampleBuffer,
  hasVoiceEnergy,
  micErrorMessage,
  micStartStillCurrent,
  nextMicStartToken,
  samplesToBase64Pcm16,
  sendMicSamples,
  startMicCapture,
  stopMediaStream,
  stopMicCapture,
};

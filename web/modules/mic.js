import { micStatus } from './dom.js';
import { eventQuestionMeta, sendLiveSocketPayload } from './live.js';
import { loopbackDeviceHints, micChunkSamples, micSampleRate, micVoiceRmsThreshold, state } from './state.js';
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

function normalizeDeviceLabel(label) {
  return String(label || "").trim().toLowerCase();
}

function isLoopbackDevice(device) {
  const label = normalizeDeviceLabel(device && device.label);
  if (!label) return false;
  return loopbackDeviceHints.some((hint) => label.includes(hint));
}

async function findLoopbackDevice() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return null;
  // A short permission prompt makes device labels available on Chromium.
  let probe = null;
  try {
    probe = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    probe = null;
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.find((device) => device.kind === "audioinput" && isLoopbackDevice(device)) || null;
  } finally {
    stopMediaStream(probe);
  }
}

async function openMicStream() {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
}

async function openLoopbackStream(device) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: device.deviceId },
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
}

async function openDisplaySystemAudioStream() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    return null;
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        suppressLocalAudioPlayback: true,
      },
      systemAudio: "include",
      preferCurrentTab: false,
    });
    const audioTracks = stream.getAudioTracks();
    stream.getVideoTracks().forEach((track) => track.stop());
    if (!audioTracks.length) {
      stopMediaStream(stream);
      return null;
    }
    return new MediaStream(audioTracks);
  } catch {
    return null;
  }
}

function appendChannelSamples(channel, samples) {
  for (let index = 0; index < samples.length; index += 1) {
    channel.samples.push(samples[index]);
  }
  while (channel.samples.length >= micChunkSamples) {
    sendChannelSamples(channel, channel.samples.splice(0, micChunkSamples));
  }
}

function sendChannelSamples(channel, samples) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN || samples.length === 0) return;
  if (!channel.speechStarted) {
    if (!hasVoiceEnergy(samples)) {
      if (!channel.waitingNotice) {
        appendEvent(
          channel.key === "loopback" ? "会议声" : "麦克风",
          channel.key === "loopback"
            ? "会议声通道已开启，等待对方说话；期间会发送低音量保活。"
            : "麦克风已开启，等待你说话；期间会发送低音量保活。"
        );
        channel.waitingNotice = true;
      }
    } else {
      channel.speechStarted = true;
      channel.waitingNotice = false;
      appendEvent(
        channel.key === "loopback" ? "会议声" : "麦克风",
        channel.key === "loopback" ? "检测到会议声音，开始转写对方发言。" : "检测到你的声音，开始转写。"
      );
    }
  }
  const startMs = Math.round((channel.sentSamples / micSampleRate) * 1000);
  const endMs = Math.round(((channel.sentSamples + samples.length) / micSampleRate) * 1000);
  const speaker = state.micDualCapture ? channel.speaker : state.currentSpeaker;
  const payload = {
    type: "audio_chunk",
    session_id: state.interview.id,
    seq: state.seq,
    audio: samplesToBase64Pcm16(samples),
    speaker,
    channel: state.micDualCapture ? channel.key : speaker,
    format: "pcm16",
    sample_rate_hz: micSampleRate,
    channels: 1,
    start_ms: startMs,
    end_ms: endMs,
    is_final: true,
    confidence: 0.95,
    ...eventQuestionMeta(),
  };
  if (!sendLiveSocketPayload(payload, channel.key === "loopback" ? "会议声" : "麦克风")) {
    stopMicCapture({ flush: false });
    return;
  }
  state.seq += 1;
  channel.sentSamples += samples.length;
}

function wireCaptureChannel({ key, speaker, stream }) {
  const AudioContextCtor = audioContextConstructor();
  const context = new AudioContextCtor();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const channel = {
    key,
    speaker,
    stream,
    context,
    source,
    processor,
    samples: [],
    sentSamples: 0,
    speechStarted: false,
    waitingNotice: false,
  };
  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const output = event.outputBuffer.getChannelData(0);
    output.fill(0);
    appendChannelSamples(channel, downsampleBuffer(input, context.sampleRate, micSampleRate));
  };
  source.connect(processor);
  processor.connect(context.destination);
  state.micChannels.push(channel);
  return channel;
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
  state.micDualCapture = false;
  setControls();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    state.micError = "麦克风不可用";
    appendEvent("麦克风", "当前浏览器不支持麦克风采集。", "red");
    state.micStarting = false;
    setControls();
    return;
  }
  if (!audioContextConstructor()) {
    state.micError = "音频采集不可用";
    appendEvent("麦克风", "当前浏览器不支持 Web Audio，无法采集和转换音频。", "red");
    state.micStarting = false;
    setControls();
    return;
  }
  let micStream = null;
  let meetingStream = null;
  try {
    micStream = await openMicStream();
    if (!micStartStillCurrent(micStartToken)) {
      stopMediaStream(micStream);
      appendEvent("麦克风", "麦克风启动已取消：实时通道已断开或面试已重置。", "red");
      return;
    }
    const loopback = await findLoopbackDevice();
    if (loopback) {
      meetingStream = await openLoopbackStream(loopback);
      appendEvent(
        "双声道",
        `已接上虚拟声卡「${escapeHtml(loopback.label || "loopback")}」：麦克风=你，会议声=对方。`
      );
    } else {
      meetingStream = await openDisplaySystemAudioStream();
      if (meetingStream) {
        appendEvent("双声道", "已用屏幕共享采集系统音频：麦克风=你，会议声=对方。");
      }
    }
    if (!micStartStillCurrent(micStartToken)) {
      stopMediaStream(micStream);
      stopMediaStream(meetingStream);
      appendEvent("麦克风", "麦克风启动已取消：实时通道已断开或面试已重置。", "red");
      return;
    }

    state.micChannels = [];
    wireCaptureChannel({ key: "mic", speaker: "interviewer", stream: micStream });
    if (meetingStream) {
      wireCaptureChannel({ key: "loopback", speaker: "candidate", stream: meetingStream });
      state.micDualCapture = true;
      state.currentSpeaker = "interviewer";
    } else {
      state.micDualCapture = false;
      appendEvent(
        "双声道",
        "未找到会议声输入。macOS 可装 BlackHole/Loopback，把会议输出打到虚拟声卡后再点开始；当前仍可用手动切换说话人。"
      );
    }

    // Keep legacy single-path fields in sync for status helpers that still check them.
    state.micStream = micStream;
    state.micContext = state.micChannels[0]?.context || null;
    state.micSource = state.micChannels[0]?.source || null;
    state.micProcessor = state.micChannels[0]?.processor || null;
    state.micSamples = [];
    state.micSentSamples = 0;
    state.micSpeechStarted = false;
    state.micWaitingForVoiceNotice = false;
    state.micError = "";
    state.micStarting = false;
    state.micRecording = true;

    if (state.micDualCapture) {
      appendEvent(
        "麦克风",
        "双声道已开启：你的麦克风记为<strong>面试官</strong>，会议扬声器记为<strong>候选人</strong>。"
      );
    } else {
      appendEvent(
        "麦克风",
        state.currentSpeaker === "interviewer"
          ? "麦克风已开启，当前音频会标记为<strong>面试官</strong>发言；候选人开口前请切回候选人。"
          : "麦克风已开启，当前音频会标记为<strong>候选人</strong>发言；自己提问时请切到面试官。"
      );
    }
    setControls();
  } catch (error) {
    if (!micStartStillCurrent(micStartToken)) return;
    stopMediaStream(micStream);
    stopMediaStream(meetingStream);
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
  if (name === "OverconstrainedError") {
    return "虚拟声卡不可用：请确认 BlackHole/Loopback 仍在线，或改用屏幕共享系统声音。";
  }
  return `麦克风启动失败：${error}`;
}

function stopMicCapture(options = {}) {
  if (state.micStarting) {
    nextMicStartToken();
    state.micStarting = false;
  }
  const channels = state.micChannels || [];
  if (!state.micRecording && !channels.length && !state.micStream && !state.micContext) {
    setControls();
    return;
  }
  for (const channel of channels) {
    if (options.flush !== false && channel.samples.length > 0) {
      sendChannelSamples(channel, channel.samples.splice(0, channel.samples.length));
    }
    if (channel.processor) {
      channel.processor.disconnect();
      channel.processor.onaudioprocess = null;
    }
    if (channel.source) channel.source.disconnect();
    stopMediaStream(channel.stream);
    if (channel.context && channel.context.state !== "closed") {
      channel.context.close().catch(() => {});
    }
  }
  state.micChannels = [];
  state.micDualCapture = false;
  state.micRecording = false;
  state.micStream = null;
  state.micContext = null;
  state.micSource = null;
  state.micProcessor = null;
  state.micSamples = [];
  state.micSpeechStarted = false;
  state.micWaitingForVoiceNotice = false;
  setControls();
}

// Compatibility wrappers used by older single-path helpers/tests.
function appendMicSamples(samples) {
  const channel = state.micChannels[0];
  if (!channel) return;
  appendChannelSamples(channel, samples);
}

function sendMicSamples(samples) {
  const channel = state.micChannels[0];
  if (!channel) return;
  sendChannelSamples(channel, samples);
}


export {
  appendMicSamples,
  audioContextConstructor,
  downsampleBuffer,
  findLoopbackDevice,
  hasVoiceEnergy,
  isLoopbackDevice,
  micErrorMessage,
  micStartStillCurrent,
  nextMicStartToken,
  samplesToBase64Pcm16,
  sendMicSamples,
  startMicCapture,
  stopMediaStream,
  stopMicCapture,
};

class DualSourcePCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(1600);
    this.length = 0;
    this.port.onmessage = event => {
      if (event.data?.type === 'flush') {
        this.emit();
        this.port.postMessage({ type: 'flushed', id: event.data.id });
      }
    };
  }

  emit() {
    if (!this.length) return;
    const buffer = new ArrayBuffer(this.length * 2);
    const view = new DataView(buffer);
    let sum = 0;
    for (let i = 0; i < this.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, this.samples[i]));
      view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / this.length);
    this.length = 0;
    this.port.postMessage({ type: 'chunk', buffer, rms }, [buffer]);
  }

  process(inputs, outputs) {
    for (const output of outputs) for (const channel of output) channel.fill(0);
    const channels = inputs[0];
    if (!channels?.length || !channels[0]?.length) return true;
    for (let i = 0; i < channels[0].length; i += 1) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] || 0;
      this.samples[this.length++] = sample / channels.length;
      if (this.length === this.samples.length) this.emit();
    }
    return true;
  }
}

registerProcessor('dual-source-pcm', DualSourcePCM);

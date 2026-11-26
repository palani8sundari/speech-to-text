// Converts microphone audio (any sample rate, float32) into 16 kHz mono PCM16
// chunks of ~100 ms, which is what the Gemini Live API expects.
class PcmWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.chunkSize = 1600; // 100 ms @ 16 kHz
    this.buffer = new Int16Array(this.chunkSize);
    this.offset = 0;
    this.pos = 0; // fractional read position for resampling
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;

    let level = 0;
    while (this.pos < input.length) {
      const s = Math.max(-1, Math.min(1, input[Math.floor(this.pos)]));
      level = Math.max(level, Math.abs(s));
      this.buffer[this.offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.offset === this.chunkSize) {
        this.port.postMessage(this.buffer.buffer.slice(0));
        this.offset = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= input.length;
    this.port.postMessage({ level });
    return true;
  }
}

registerProcessor("pcm-worklet", PcmWorklet);

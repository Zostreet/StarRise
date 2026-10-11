/* Capture mono PCM without sending live microphone sound to the speakers. */
class StarRiseRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = false;
    this.startFrame = 0;
    this.buffer = new Float32Array(8192);
    this.used = 0;
    this.port.onmessage = event => {
      if (event.data?.type === "start") { this.used = 0; this.startFrame = event.data.startFrame; this.enabled = true; }
      if (event.data?.type === "stop") { this.enabled = false; this.flush(); this.port.postMessage({type:"done"}); }
    };
  }
  flush() {
    if (!this.used) return;
    const chunk = this.buffer.slice(0,this.used);
    this.port.postMessage({type:"samples",samples:chunk},[chunk.buffer]); this.used = 0;
  }
  process(inputs, outputs) {
    for (const output of outputs) for (const channel of output) channel.fill(0);
    const channels = inputs[0];
    if (!this.enabled || !channels?.[0]) return true;
    for (let i=0;i<channels[0].length;i++) {
      if (currentFrame+i < this.startFrame) continue;
      let sample = 0;
      for (const channel of channels) sample += channel[i] || 0;
      this.buffer[this.used++] = sample/channels.length;
      if (this.used === this.buffer.length) this.flush();
    }
    return true;
  }
}
registerProcessor("starrise-recorder",StarRiseRecorder);

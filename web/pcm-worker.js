// AudioWorklet: 把浏览器原生采样率的 Float32 麦克风数据
// 线性插值重采样到 16kHz、转 Int16 PCM，按 ~100ms(1600 samples) 分帧 postMessage 回主线程。
//
// 状态：this.pos 为"下一个输出样本在当前输入块中的位置"（浮点，单位=输入样本）。
// 每个输出样本对应的输入步进 step = inRate / targetRate。
// 边界处的轻微不连续对语音识别可忽略。

class PcmPump extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = options.processorOptions?.targetRate || 16000;
    this.inRate = sampleRate; // AudioWorkletGlobalScope 全局
    this.step = this.inRate / this.targetRate;
    this.pos = 0;
    this.stopRequested = false;

    this.frameSize = Math.round(this.targetRate * 0.1); // 100ms
    this.accum = [];

    this.port.onmessage = (ev) => {
      if (ev.data?.cmd === "stop") this.stopRequested = true;
    };
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch || ch.length === 0) return !this.stopRequested;
    const n = ch.length;

    // 只在能取到 idx+1 时插值（保证不越界）
    while (this.pos < n - 1) {
      const idx = Math.floor(this.pos);
      const frac = this.pos - idx;
      let s = ch[idx] * (1 - frac) + ch[idx + 1] * frac;
      // 钳位并转 Int16
      if (s > 1) s = 1; else if (s < -1) s = -1;
      this.accum.push(s < 0 ? s * 0x8000 : s * 0x7fff);
      this.pos += this.step;

      // 攒满一帧就发走
      while (this.accum.length >= this.frameSize) {
        const frame = new Int16Array(this.frameSize);
        for (let i = 0; i < this.frameSize; i++) frame[i] = this.accum[i];
        this.accum.splice(0, this.frameSize);
        this.port.postMessage(frame, [frame.buffer]);
      }
    }

    // 平移到下一块的相对坐标
    this.pos -= n;
    return !this.stopRequested;
  }
}

registerProcessor("pcm-pump", PcmPump);

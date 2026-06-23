// AudioWorklet: 把浏览器原生采样率的 Float32 麦克风数据线性重采样到 16kHz、
// 转 Int16 PCM、按 ~100ms 分帧 postMessage 回主线程。并周期上报诊断（帧数/峰值/采样率）。
//
// iOS Safari 纪律：
//  - process() 在输入为空（预热期）时必须 return true 保活，否则节点被回收、再也不被调用。
//  - 全局 sampleRate 偶发为 0，兜底 48000。

class PcmPump extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = options.processorOptions?.targetRate || 16000;
    this.inRate = sampleRate > 0 ? sampleRate : 48000; // AudioWorkletGlobalScope 全局；防 0
    this.step = this.inRate / this.targetRate;
    this.pos = 0;
    this.stopRequested = false;

    this.frameSize = Math.round(this.targetRate * 0.1); // 100ms
    this.accum = [];

    // 诊断
    this.dbgFrames = 0;
    this.dbgPeak = 0;
    this.dbgLast = 0;

    this.port.onmessage = (ev) => {
      if (ev.data?.cmd === "stop") this.stopRequested = true;
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true; // iOS 预热：无输入也要保活
    const ch = input[0];
    if (!ch || ch.length === 0) return true;
    const n = ch.length;

    while (this.pos < n - 1) {
      const idx = Math.floor(this.pos);
      const frac = this.pos - idx;
      let s = ch[idx] * (1 - frac) + ch[idx + 1] * frac;
      s *= 3; // 软件增益：补偿 iOS 偏低的麦克风电平（配合 AGC）；下面再钳位防爆。
      if (s > 1) s = 1; else if (s < -1) s = -1;
      const a = s < 0 ? -s : s;
      if (a > this.dbgPeak) this.dbgPeak = a;
      this.accum.push(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff));
      this.pos += this.step;

      while (this.accum.length >= this.frameSize) {
        const frame = new Int16Array(this.frameSize);
        for (let i = 0; i < this.frameSize; i++) frame[i] = this.accum[i];
        this.accum.splice(0, this.frameSize);
        this.port.postMessage(frame, [frame.buffer]);
        this.dbgFrames++;
      }
    }
    this.pos -= n;
    // 跨缓冲区进位若落到负值（退出时 pos∈[n-1,n) 时会发生），下一帧 Math.floor 会读 ch[-1]
    // 得 NaN→0，在每个缓冲区边界注入伪零样本。钳到 0，避免越界毛刺。
    if (this.pos < 0) this.pos = 0;

    // 每 ~0.4s 上报一次诊断
    if (currentTime - this.dbgLast > 0.4) {
      this.port.postMessage({ dbg: true, frames: this.dbgFrames, peak: this.dbgPeak, inRate: this.inRate });
      this.dbgLast = currentTime;
      this.dbgPeak = 0;
    }

    // 收到停止且尾帧已发完才真正结束，避免丢尾音
    if (this.stopRequested && this.accum.length === 0) return false;
    return true;
  }
}

registerProcessor("pcm-pump", PcmPump);

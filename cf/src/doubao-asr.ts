// 豆包「大模型流式语音识别」上游客户端 —— Cloudflare Workers 版。
//
// 与 Node 版（relay/src/doubao-asr.ts）协议完全一致，差异仅在运行时 API：
//   - 出站 WebSocket：Node 用 `ws` 库 + 自定义 header；Workers 用 fetch(Upgrade) 拿 resp.webSocket。
//     （浏览器 WebSocket 不能设 header，但 Workers 的 fetch 可以——正好满足豆包的鉴权 header 需求。）
//   - gzip：Node 用 zlib.gzipSync/gunzipSync；Workers 用 CompressionStream/DecompressionStream（异步）。
//   - 字节操作：Buffer → Uint8Array + DataView。
//
// 协议同 Node 版注释：4B header + (4B seq, 视 flags) + 4B payloadSize + gzip(payload)，整数 big-endian。

const PROTOCOL_VERSION = 0x1;
const HEADER_SIZE = 0x1; // 单位 4 字节
const MSG_FULL_CLIENT_REQUEST = 0x1;
const MSG_AUDIO_ONLY_REQUEST = 0x2;
const MSG_FULL_SERVER_RESPONSE = 0x9;
const MSG_ERROR_SERVER_RESPONSE = 0xf;

const FLAG_NONE = 0x0;
const FLAG_POS_SEQ = 0x1;
const FLAG_NEG_WITHOUT_SEQ = 0x2;
const FLAG_NEG_SEQ = 0x3;

const SERIAL_JSON = 0x1;
const SERIAL_NONE = 0x0;
const COMPRESS_GZIP = 0x1;

const MAX_PENDING_FRAMES = 200;

export interface AsrConfig {
  appId: string;
  accessToken: string;
  resourceId: string;
  wssUrl: string;
}

export interface AsrFormat {
  sampleRate: number;
  channels: number;
  bits: number;
}

export interface AsrCallbacks {
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
}

// ---- 字节工具 ----
function headerBytes(msgType: number, flags: number, serial: number, compression: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = ((PROTOCOL_VERSION & 0xf) << 4) | (HEADER_SIZE & 0xf);
  b[1] = ((msgType & 0xf) << 4) | (flags & 0xf);
  b[2] = ((serial & 0xf) << 4) | (compression & 0xf);
  b[3] = 0x00;
  return b;
}
function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}
function i32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n | 0, false);
  return b;
}
function concat(arrs: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}
async function pump(data: Uint8Array, ts: TransformStream): Promise<Uint8Array> {
  const writer = ts.writable.getWriter();
  void writer.write(data);
  void writer.close();
  const reader = ts.readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as Uint8Array);
  }
  return concat(chunks);
}
const gzip = (d: Uint8Array) => pump(d, new CompressionStream("gzip"));
const gunzip = (d: Uint8Array) => pump(d, new DecompressionStream("gzip"));

export class DoubaoAsrSession {
  private ws: WebSocket | null = null;
  private closed = false;
  private seq = 1; // full client request 隐式占 seq=1，音频从 2 起
  private lastText = "";
  private finalEmitted = false;
  private opened = false;
  private pending: Uint8Array[] = [];
  private finishPending = false;
  // gzip 是异步的：用一条 promise 链把所有发送串行化，保证 sequence 严格递增、不乱序。
  private sendChain: Promise<void> = Promise.resolve();

  constructor(private cfg: AsrConfig, private format: AsrFormat, private cb: AsrCallbacks) {}

  /** 建立到豆包的出站 WebSocket 并发送 full client request。 */
  async startAudio(): Promise<void> {
    // Workers 的 fetch 不接受 ws/wss scheme，出站 WebSocket 必须用 http/https + Upgrade header。
    const httpUrl = this.cfg.wssUrl.replace(/^ws(s?):\/\//i, "http$1://");
    const resp = await fetch(httpUrl, {
      headers: {
        Upgrade: "websocket",
        "X-Api-App-Key": this.cfg.appId,
        "X-Api-Access-Key": this.cfg.accessToken,
        "X-Api-Resource-Id": this.cfg.resourceId,
        "X-Api-Connect-Id": crypto.randomUUID(),
      },
    });
    const ws = (resp as unknown as { webSocket: WebSocket | null }).webSocket;
    if (!ws) {
      throw new Error(`上游未升级为 WebSocket（HTTP ${resp.status}）`);
    }
    ws.accept();
    this.ws = ws;

    ws.addEventListener("message", (ev: MessageEvent) => {
      void this.handleUpstream(ev.data);
    });
    ws.addEventListener("close", () => {
      if (!this.finalEmitted && this.lastText) this.cb.onFinal?.(this.lastText);
      this.finalEmitted = true;
      this.closed = true;
      this.cb.onClose?.();
    });
    ws.addEventListener("error", () => {
      if (!this.closed) this.cb.onError?.(new Error("上游 WS 错误"));
    });

    // 出站 WS 在 fetch 返回时已完成 101 升级，accept 后即可发送。
    await this.sendFullClientRequest();
    this.opened = true;
    for (const f of this.pending) this.enqueueAudio(f);
    this.pending = [];
    if (this.finishPending) this.enqueueFinish();
  }

  feedAudio(pcm: Uint8Array): void {
    if (this.closed) return;
    if (!this.opened) {
      if (this.pending.length < MAX_PENDING_FRAMES) this.pending.push(pcm);
      return;
    }
    this.enqueueAudio(pcm);
  }

  finishAudio(): void {
    if (this.closed) return;
    if (!this.opened) {
      this.finishPending = true;
      return;
    }
    this.enqueueFinish();
  }

  close(): void {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }

  // ---- 发送（全部经 sendChain 串行化） ----
  private enqueueAudio(pcm: Uint8Array): void {
    this.sendChain = this.sendChain.then(() => this.sendAudioFrame(pcm)).catch(() => {});
  }
  private enqueueFinish(): void {
    this.sendChain = this.sendChain.then(() => this.sendFinishFrame()).catch(() => {});
  }

  private async sendFullClientRequest(): Promise<void> {
    const payload = {
      user: { uid: "remotevoice-relay" },
      audio: {
        format: "pcm",
        codec: "raw",
        rate: this.format.sampleRate,
        bits: this.format.bits,
        channel: this.format.channels,
      },
      request: {
        model_name: "bigmodel",
        enable_itn: true,
        enable_punc: true,
        result_type: "full",
        show_utterances: true,
      },
    };
    const gz = await gzip(new TextEncoder().encode(JSON.stringify(payload)));
    const frame = concat([headerBytes(MSG_FULL_CLIENT_REQUEST, FLAG_NONE, SERIAL_JSON, COMPRESS_GZIP), u32be(gz.length), gz]);
    this.ws?.send(frame);
  }

  private async sendAudioFrame(pcm: Uint8Array): Promise<void> {
    if (!this.ws || this.closed) return;
    this.seq += 1;
    const gz = await gzip(pcm);
    const frame = concat([
      headerBytes(MSG_AUDIO_ONLY_REQUEST, FLAG_POS_SEQ, SERIAL_NONE, COMPRESS_GZIP),
      i32be(this.seq),
      u32be(gz.length),
      gz,
    ]);
    this.ws.send(frame);
  }

  private async sendFinishFrame(): Promise<void> {
    if (!this.ws || this.closed) return;
    this.seq += 1;
    const gz = await gzip(new Uint8Array(0));
    const frame = concat([
      headerBytes(MSG_AUDIO_ONLY_REQUEST, FLAG_NEG_SEQ, SERIAL_NONE, COMPRESS_GZIP),
      i32be(-this.seq),
      u32be(gz.length),
      gz,
    ]);
    this.ws.send(frame);
  }

  // ---- 解析服务端响应 ----
  private async handleUpstream(data: ArrayBuffer | string): Promise<void> {
    if (typeof data === "string") return;
    const bytes = new Uint8Array(data);
    if (bytes.length < 4) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const b1 = bytes[1];
    const b2 = bytes[2];
    const msgType = b1 >> 4;
    const flags = b1 & 0xf;
    const serialization = b2 >> 4;
    const compression = b2 & 0xf;

    if (msgType === MSG_ERROR_SERVER_RESPONSE) {
      if (bytes.length < 12) return;
      const errCode = view.getUint32(4, false);
      const errMsgSize = view.getUint32(8, false);
      const errMsg = new TextDecoder().decode(bytes.subarray(12, 12 + errMsgSize));
      this.cb.onError?.(new Error(`ASR 错误 [${errCode}]: ${errMsg || "未知"}`));
      return;
    }
    if (msgType !== MSG_FULL_SERVER_RESPONSE) return;

    let off = 4;
    if (flags === FLAG_POS_SEQ || flags === FLAG_NEG_SEQ) off += 4;
    if (bytes.length < off + 4) return;
    const payloadSize = view.getUint32(off, false);
    off += 4;
    const raw = bytes.subarray(off, off + payloadSize);

    let jsonBytes: Uint8Array;
    if (compression === COMPRESS_GZIP) {
      try {
        jsonBytes = await gunzip(raw);
      } catch {
        this.cb.onError?.(new Error("ASR gzip 解压失败"));
        return;
      }
    } else {
      jsonBytes = raw;
    }
    if (serialization !== SERIAL_JSON) return;

    let payload: any;
    try {
      payload = JSON.parse(new TextDecoder().decode(jsonBytes));
    } catch {
      return;
    }

    if (payload?.code !== undefined && payload.code !== 20000000 && payload.code !== 0) {
      this.cb.onError?.(new Error(`ASR 业务错误 [${payload.code}]: ${payload.message ?? ""}`));
      return;
    }

    const isLast = flags === FLAG_NEG_SEQ || flags === FLAG_NEG_WITHOUT_SEQ;
    const utterances = payload?.result?.utterances;
    let best = "";
    if (Array.isArray(utterances) && utterances.length > 0) {
      best = utterances
        .filter((u: any) => u?.definite)
        .map((u: any) => u.text)
        .join("");
    }
    if (!best) best = payload?.result?.text ?? "";
    if (!best) {
      // 即便本帧无文本，负包仍代表整段结束，需要兜底 final 让会话收尾。
      if (isLast && !this.finalEmitted) {
        this.finalEmitted = true;
        this.cb.onFinal?.(this.lastText);
      }
      return;
    }

    this.lastText = best;
    if (isLast) {
      this.finalEmitted = true;
      this.cb.onFinal?.(best);
    } else {
      this.cb.onPartial?.(best);
    }
  }
}

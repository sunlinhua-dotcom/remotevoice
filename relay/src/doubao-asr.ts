import { randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import WebSocket from "ws";
import type { AppConfig } from "./config.js";

/**
 * 豆包「大模型流式语音识别」上游客户端（中继 → 豆包）。
 *
 * 协议（核实自官方文档 6561/1354869）：
 *  - 接口：wss://openspeech.bytedance.com/api/v3/sauc/bigmodel （双向流式）
 *  - 鉴权 header：X-Api-App-Key / X-Api-Access-Key / X-Api-Resource-Id / X-Api-Connect-Id
 *  - 二进制 framing：每帧 = 4B header + (4B sequence, 视 flags) + 4B payloadSize + payload
 *  - 所有整数 BIG-ENDIAN；payload 用 gzip 压缩；JSON 序列化。
 *
 *  Header 各 4-bit 半字节（从高位到低位）：
 *    byte0: protocolVersion(0x1) | headerSize(0x1 = 4 字节)
 *    byte1: messageType(0x1 full req | 0x2 audio | 0x9 resp | 0xF err) | flags(0x0 none | 0x1 posSeq | 0x2 负包无seq | 0x3 负包带seq)
 *    byte2: serialization(0x0 none | 0x1 json) | compression(0x0 none | 0x1 gzip)
 *    byte3: reserved(0x00)
 *
 *  发送：
 *    - 握手后第一个包：full client request（flags=0x0 不带 seq, json+gzip）
 *    - 音频包：audio only（flags=0x1 正 seq, gzip）
 *    - 结束包：audio only（flags=0x3 负 seq, gzip）
 */

const PROTOCOL_VERSION = 0x1;
const HEADER_SIZE = 0x1; // 单位 4 字节 → 实际 4B
const MSG_FULL_CLIENT_REQUEST = 0x1;
const MSG_AUDIO_ONLY_REQUEST = 0x2;
const MSG_FULL_SERVER_RESPONSE = 0x9;
const MSG_ERROR_SERVER_RESPONSE = 0xf;

const FLAG_NONE = 0x0; // 不带 sequence
const FLAG_POS_SEQ = 0x1; // header 后跟正 sequence
const FLAG_NEG_WITHOUT_SEQ = 0x2; // 负包（最后一包），不带 sequence
const FLAG_NEG_SEQ = 0x3; // 负包，带负 sequence

const SERIAL_NONE = 0x0;
const SERIAL_JSON = 0x1;
const COMPRESS_GZIP = 0x1;

// 上游 WS 建立前最多缓存多少帧音频（~100ms/帧），兜底防止上游一直连不上时内存膨胀。
const MAX_PENDING_FRAMES = 200;

export interface AsrCallbacks {
  /** 增量（句中）结果，可实时回显。 */
  onPartial?: (text: string) => void;
  /** 最终结果（definite 分句 或 负包返回）。 */
  onFinal?: (text: string) => void;
  /** 链路/鉴权/解析异常。 */
  onError?: (err: Error) => void;
  /** ASR 上游已关闭。 */
  onClose?: () => void;
}

function headerBytes(msgType: number, flags: number, serial: number, compression: number): Buffer {
  const buf = Buffer.alloc(4);
  buf[0] = ((PROTOCOL_VERSION & 0xf) << 4) | (HEADER_SIZE & 0xf);
  buf[1] = ((msgType & 0xf) << 4) | (flags & 0xf);
  buf[2] = ((serial & 0xf) << 4) | (compression & 0xf);
  buf[3] = 0x00;
  return buf;
}

export class DoubaoAsrSession {
  private ws: WebSocket | null = null;
  private closed = false;
  // full client request 隐式占用 sequence=1，故音频包从 2 起递增。
  private seq = 1;
  private lastText = "";
  // 本次会话是否已发出过 final（防止 close 时重复发 final）。
  private finalEmitted = false;
  // 上游 WS 是否已 open。open 之前到达的音频/结束包先缓存，open 时按序补发。
  private opened = false;
  private pending: Buffer[] = [];
  private finishPending = false;

  constructor(
    private cfg: AppConfig["doubaoAsr"],
    private format: { sampleRate: number; channels: number; bits: number },
    private cb: AsrCallbacks,
  ) {}

  /** 建立到豆包的上游连接并发送 full client request。 */
  startAudio(): Promise<void> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {
        "X-Api-App-Key": this.cfg.appId,
        "X-Api-Access-Key": this.cfg.accessToken,
        "X-Api-Resource-Id": this.cfg.resourceId,
        "X-Api-Connect-Id": randomUUID(),
      };
      const ws = new WebSocket(this.cfg.wssUrl, { headers, perMessageDeflate: false });
      this.ws = ws;

      ws.once("open", () => {
        try {
          this.sendFullClientRequest();
          this.opened = true;
          // 补发 open 之前缓存的音频帧（按序），再补发结束包（若手机已松手）。
          for (const f of this.pending) this.sendAudioFrame(f);
          this.pending = [];
          if (this.finishPending) this.sendFinishFrame();
          resolve();
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          this.cb.onError?.(err);
          reject(err);
        }
      });

      ws.on("message", (data) => this.handleUpstream(data as Buffer));

      ws.once("error", (err) => {
        if (!this.closed) this.cb.onError?.(err);
        reject(err);
      });

      ws.once("close", () => {
        // 仅当整段从未敲定（如未收到负包就断线）才用 lastText 兜底补发一次 final。
        if (!this.finalEmitted && this.lastText) this.cb.onFinal?.(this.lastText);
        this.finalEmitted = true;
        this.closed = true;
        this.cb.onClose?.();
      });
    });
  }

  /** 发送 full client request（握手后的第一个包，含音频元数据）。 */
  private sendFullClientRequest() {
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
    const gz = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
    const header = headerBytes(MSG_FULL_CLIENT_REQUEST, FLAG_NONE, SERIAL_JSON, COMPRESS_GZIP);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(gz.length, 0);
    this.ws!.send(Buffer.concat([header, size, gz]));
  }

  /**
   * 转发一帧裸 PCM（Buffer）。带递增正 sequence。
   * 上游 WS 尚未 open 时先缓存，open 时按序补发，避免说话开头几帧被丢。
   */
  feedAudio(pcm: Buffer): void {
    if (this.closed) return;
    if (!this.opened) {
      if (this.pending.length < MAX_PENDING_FRAMES) this.pending.push(pcm);
      return;
    }
    this.sendAudioFrame(pcm);
  }

  /**
   * 标记本次说话结束（phone 松手）。发一个负包（最后一包，空音频）。
   * 若上游尚未 open，则置位 finishPending，open 后补发，避免短语音的“end”丢失导致会话泄漏。
   */
  finishAudio(): void {
    if (this.closed) return;
    if (!this.opened) {
      this.finishPending = true;
      return;
    }
    this.sendFinishFrame();
  }

  /** 实际发送一帧音频（仅在上游已 open 时调用）。 */
  private sendAudioFrame(pcm: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.seq += 1;
    const gz = gzipSync(pcm);
    const header = headerBytes(MSG_AUDIO_ONLY_REQUEST, FLAG_POS_SEQ, SERIAL_NONE, COMPRESS_GZIP);
    const seqBuf = Buffer.alloc(4);
    seqBuf.writeInt32BE(this.seq, 0);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(gz.length, 0);
    this.ws.send(Buffer.concat([header, seqBuf, size, gz]));
  }

  /** 实际发送结束负包（仅在上游已 open 时调用）。 */
  private sendFinishFrame(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.seq += 1;
    const empty = gzipSync(Buffer.alloc(0));
    const header = headerBytes(MSG_AUDIO_ONLY_REQUEST, FLAG_NEG_SEQ, SERIAL_NONE, COMPRESS_GZIP);
    const seqBuf = Buffer.alloc(4);
    seqBuf.writeInt32BE(-this.seq, 0);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(empty.length, 0);
    this.ws.send(Buffer.concat([header, seqBuf, size, empty]));
  }

  /** 主动关闭上游。 */
  close(): void {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }

  // ---- 解析服务端响应 ----
  private handleUpstream(data: Buffer) {
    if (data.length < 4) return;
    const b1 = data[1];
    const b2 = data[2];
    const msgType = b1 >> 4;
    const flags = b1 & 0xf;
    const serialization = b2 >> 4;
    const compression = b2 & 0xf;

    if (msgType === MSG_ERROR_SERVER_RESPONSE) {
      // 错误帧：4B header + 4B errCode + 4B errMsgSize + errMsg
      if (data.length < 12) return;
      const errCode = data.readUInt32BE(4);
      const errMsgSize = data.readUInt32BE(8);
      const errMsg = data.subarray(12, 12 + errMsgSize).toString("utf8");
      this.cb.onError?.(new Error(`ASR 错误 [${errCode}]: ${errMsg || "未知"}`));
      return;
    }

    if (msgType !== MSG_FULL_SERVER_RESPONSE) return;

    // full server response: 4B header + (4B sequence if flags∈{1,3}) + 4B payloadSize + payload
    let off = 4;
    if (flags === FLAG_POS_SEQ || flags === FLAG_NEG_SEQ) off += 4;
    if (data.length < off + 4) return;
    const payloadSize = data.readUInt32BE(off);
    off += 4;
    const raw = data.subarray(off, off + payloadSize);

    let jsonBuf: Buffer;
    if (compression === COMPRESS_GZIP) {
      try {
        jsonBuf = gunzipSync(raw);
      } catch {
        this.cb.onError?.(new Error("ASR gzip 解压失败"));
        return;
      }
    } else {
      // 无压缩（COMPRESS_NONE）：直接使用原始字节
      jsonBuf = raw;
    }
    if (serialization !== SERIAL_JSON) return;

    let payload: any;
    try {
      payload = JSON.parse(jsonBuf.toString("utf8"));
    } catch {
      return;
    }

    if (payload?.code !== undefined && payload.code !== 20000000 && payload.code !== 0) {
      this.cb.onError?.(new Error(`ASR 业务错误 [${payload.code}]: ${payload.message ?? ""}`));
      return;
    }

    const isLast = flags === FLAG_NEG_SEQ || flags === FLAG_NEG_WITHOUT_SEQ;

    // definite 标记“某分句已敲定”，不是“整段说话结束”；整段结束以负包(isLast)为准。
    // result_type=full 时 utterances 为累计全量列表，直接 join 即得当前完整敲定文本。
    const utterances = payload?.result?.utterances;
    let best = "";
    if (Array.isArray(utterances) && utterances.length > 0) {
      best = utterances
        .filter((u: any) => u?.definite)
        .map((u: any) => u.text)
        .join("");
    }
    if (!best) best = payload?.result?.text ?? "";
    if (!best) return;

    this.lastText = best;
    if (isLast) {
      this.finalEmitted = true;
      this.cb.onFinal?.(best);
    } else {
      this.cb.onPartial?.(best);
    }
  }
}

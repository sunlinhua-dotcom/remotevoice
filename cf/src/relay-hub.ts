// RelayHub —— 单例 Durable Object：把 Node 版 server.ts + rooms.ts 的全部中继逻辑搬到
// 一个 DO 里。所有 /ws 连接（mac 与 phone）都路由到同一个 DO 实例，因此配对所需的共享
// 状态（pending 码、房间、ASR 会话）天然在同一处内存里，无需跨 isolate 通信。
//
// 用普通（非 hibernation）WebSocket：server.accept() + addEventListener。只要还有连接打开，
// DO 就驻留内存——正是中继需要的。个人自用并发极低，单例 DO 足够。

import { DoubaoAsrSession, type AsrConfig } from "./doubao-asr";
import { DoubaoLlm, type ArkConfig } from "./doubao-llm";

export interface Env {
  DOUBAO_ASR_APP_ID: string;
  DOUBAO_ASR_ACCESS_TOKEN: string;
  DOUBAO_ASR_RESOURCE_ID?: string;
  DOUBAO_ASR_WSS_URL?: string;
  ARK_API_KEY?: string;
  ARK_BASE_URL?: string;
  ARK_MODEL?: string;
  PAIR_CODE_TTL_MS?: string;
  MAX_SESSION_MS?: string;
}

interface ClientState {
  ws: WebSocket;
  id: string;
  ip: string;
  role?: "mac" | "phone";
  code?: string;
  roomCode?: string;
  failedPairs: number;
  macId?: string;        // 设备信任模型：房间 = 这台 Mac
  deviceToken?: string;  // 手机的长期凭证（首次配对后下发，可单独吊销）
}

interface Room {
  code: string;
  macWs?: WebSocket;
  phoneWs?: WebSocket;
  llmPostprocess: boolean;
  asr?: DoubaoAsrSession;
  sessionTimer?: ReturnType<typeof setTimeout>;
}

// ---- 配对码暴力破解限流（同 Node 版） ----
const PAIR_FAIL_WINDOW_MS = 60_000;
const PAIR_FAIL_MAX_PER_IP = 20;
const PAIR_FAIL_MAX_PER_CONN = 5;

export class RelayHub {
  private clients = new Map<WebSocket, ClientState>();
  private pendingByCode = new Map<string, { macWs: WebSocket; expiresAt: number; timer: ReturnType<typeof setTimeout> }>();
  private rooms = new Map<string, Room>();
  private pairFailsByIp = new Map<string, number[]>();
  // 一次性扫码令牌存 SQLite（见 pair_tokens 表）；手机离线等待队列（macId → 手机连接）。
  private waitingPhones = new Map<string, Set<WebSocket>>();
  private llm: DoubaoLlm;

  constructor(private state: DurableObjectState, private env: Env) {
    this.llm = new DoubaoLlm(this.arkConfig());
    // 已配对设备持久化在 DO 的 SQLite（重启/驱逐都不丢）。一台 Mac(mac_id) 下多台手机(token)。
    try {
      this.sql.exec(
        "CREATE TABLE IF NOT EXISTS devices (mac_id TEXT NOT NULL, token TEXT NOT NULL, name TEXT, created_at INTEGER, last_seen INTEGER, PRIMARY KEY (mac_id, token))",
      );
      // 扫码令牌也持久化：否则每次部署/DO 驱逐都会清空内存里的待用二维码令牌，导致已展示的二维码失效。
      this.sql.exec(
        "CREATE TABLE IF NOT EXISTS pair_tokens (token TEXT PRIMARY KEY, mac_id TEXT NOT NULL, expires_at INTEGER NOT NULL)",
      );
    } catch { /* sql 理论上必有；缺失则设备信任降级，不影响旧随机码流程 */ }
  }

  private get sql(): SqlStorage {
    return this.state.storage.sql;
  }

  private asrConfig(): AsrConfig {
    return {
      appId: this.env.DOUBAO_ASR_APP_ID,
      accessToken: this.env.DOUBAO_ASR_ACCESS_TOKEN,
      resourceId: this.env.DOUBAO_ASR_RESOURCE_ID || "volc.bigasr.sauc.duration",
      wssUrl: this.env.DOUBAO_ASR_WSS_URL || "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel",
    };
  }
  private arkConfig(): ArkConfig {
    return {
      apiKey: this.env.ARK_API_KEY || "",
      baseUrl: this.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3",
      model: this.env.ARK_MODEL || "doubao-seed-2-0-lite-260215",
    };
  }
  private get pairCodeTtlMs(): number {
    const n = Number(this.env.PAIR_CODE_TTL_MS);
    return Number.isFinite(n) && n > 0 ? n : 5 * 60_000;
  }
  private get maxSessionMs(): number {
    const n = Number(this.env.MAX_SESSION_MS);
    return Number.isFinite(n) && n > 0 ? n : 2 * 60_000;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, rooms: this.rooms.size, llm: this.llm.enabled });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const ip = request.headers.get("CF-Connecting-IP") ?? "";
    this.acceptClient(server, ip);
    return new Response(null, { status: 101, webSocket: client });
  }

  private acceptClient(ws: WebSocket, ip: string): void {
    ws.accept();
    const id = `${ip.slice(-7)}-${crypto.randomUUID().slice(0, 4)}`;
    this.clients.set(ws, { ws, id, ip, failedPairs: 0 });
    console.log("[relay] connect", id);
    ws.addEventListener("message", (ev: MessageEvent) => {
      if (typeof ev.data === "string") {
        this.handleText(ws, ev.data).catch(() => {});
      } else {
        this.handleBinary(ws, ev.data as ArrayBuffer);
      }
    });
    ws.addEventListener("close", () => this.onClose(ws));
    ws.addEventListener("error", () => this.onClose(ws));
  }

  // ---------- 文本信令 ----------
  private async handleText(ws: WebSocket, text: string): Promise<void> {
    const client = this.clients.get(ws);
    if (!client) return;
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return this.send(ws, { type: "error", code: "bad_json", message: "非合法 JSON" });
    }

    if (msg.type === "ping") return this.send(ws, { type: "pong" });
    if (msg.type === "pong") return;
    if (msg.type === "hello") return this.handleHello(client, msg);

    if (!client.roomCode || !client.role) {
      return this.send(ws, { type: "error", code: "not_paired", message: "请先完成配对" });
    }
    switch (msg.type) {
      case "start":
        if (client.role !== "phone") return this.send(ws, { type: "error", code: "bad_role", message: "仅手机端可 start" });
        return this.handleStart(client, msg);
      case "end":
        if (client.role !== "phone") return;
        return this.handleEnd(client);
      case "config":
        if (client.role !== "mac") return;
        return this.handleConfig(client, msg);
      case "new_pair_code":
        if (client.role !== "mac" || !client.macId) return;
        return this.handleNewPairCode(client);
      case "list_devices":
        if (client.role !== "mac" || !client.macId) return;
        return this.send(ws, { type: "devices", list: this.listDevices(client.macId) });
      case "revoke_device":
        if (client.role !== "mac" || !client.macId) return;
        return this.handleRevokeDevice(client, msg);
      default:
        return this.send(ws, { type: "error", code: "bad_type", message: `未知 type: ${msg.type}` });
    }
  }

  private handleHello(client: ClientState, msg: any): void {
    const role = msg.role;
    if (role === "mac") {
      // 新模型：Mac 自带稳定 macId（房间），走设备信任流程。
      if (typeof msg.macId === "string" && msg.macId) return this.handleMacHelloV2(client, String(msg.macId));
      this.detach(client);
      const code = this.generateCode();
      client.role = "mac";
      client.code = code;
      const timer = setTimeout(() => {
        if (this.pendingByCode.get(code)?.macWs === client.ws) {
          this.pendingByCode.delete(code);
          this.send(client.ws, { type: "error", code: "code_expired", message: "配对码已过期，请重启配对" });
        }
      }, this.pairCodeTtlMs);
      this.pendingByCode.set(code, { macWs: client.ws, expiresAt: Date.now() + this.pairCodeTtlMs, timer });
      this.send(client.ws, { type: "assign", code });
      console.log("[relay] mac registered", client.id, "code=", code);
      this.pushStatus(client);
      return;
    }
    if (role === "phone") {
      if (this.ipPairBlocked(client.ip)) {
        this.send(client.ws, { type: "error", code: "rate_limited", message: "尝试过于频繁，请稍后再试" });
        try { client.ws.close(1008, "rate limited"); } catch { /* ignore */ }
        return;
      }
      // 新模型：手机带 macId + (pairToken 首次 / deviceToken 复用)。
      if (typeof msg.macId === "string" && msg.macId) return this.handlePhoneHelloV2(client, msg);
      const code = String(msg.code ?? "");
      const room = this.pairPhone(client, code);
      if (!room) {
        client.failedPairs += 1;
        const ipFails = this.recordPairFail(client.ip);
        this.send(client.ws, { type: "error", code: "bad_code", message: "配对码无效或已过期" });
        if (client.failedPairs >= PAIR_FAIL_MAX_PER_CONN || ipFails >= PAIR_FAIL_MAX_PER_IP) {
          try { client.ws.close(1008, "too many attempts"); } catch { /* ignore */ }
        }
        return;
      }
      console.log("[relay] paired", room.code);
      if (room.macWs) this.send(room.macWs, { type: "paired", peer: "phone" });
      this.send(client.ws, { type: "paired", peer: "mac" });
      this.send(client.ws, { type: "config", llm_postprocess: room.llmPostprocess });
      if (room.macWs) this.pushStatusFor(room.macWs);
      this.pushStatus(client);
      return;
    }
    this.send(client.ws, { type: "error", code: "bad_role", message: "role 必须是 mac 或 phone" });
  }

  /** phone 提交配对码：校验 + 绑房。返回 room 或 null。 */
  private pairPhone(client: ClientState, code: string): Room | null {
    client.role = "phone";
    const entry = this.pendingByCode.get(code);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      clearTimeout(entry.timer);
      this.pendingByCode.delete(code);
      return null;
    }
    const macWs = entry.macWs;
    if (macWs.readyState !== WebSocket.READY_STATE_OPEN && macWs.readyState !== 1) {
      clearTimeout(entry.timer);
      this.pendingByCode.delete(code);
      return null;
    }
    clearTimeout(entry.timer);
    this.pendingByCode.delete(code);
    const room: Room = { code, macWs, phoneWs: client.ws, llmPostprocess: true };
    this.rooms.set(code, room);
    const macState = this.clients.get(macWs);
    if (macState) macState.roomCode = code;
    client.roomCode = code;
    client.code = code;
    return room;
  }

  private handleStart(client: ClientState, msg: any): void {
    const room = this.rooms.get(client.roomCode!);
    if (!room) return;
    if (room.asr) this.teardownSession(room);

    const format = {
      sampleRate: msg?.format?.sampleRate ?? 16000,
      channels: msg?.format?.channels ?? 1,
      bits: msg?.format?.bits ?? 16,
    };
    const asr = new DoubaoAsrSession(this.asrConfig(), format, {
      onPartial: (t) => this.broadcast(room, { type: "partial", text: t }),
      onFinal: async (rawText) => {
        let text = rawText;
        let usedLlm = false;
        if (room.llmPostprocess && this.llm.enabled && rawText.trim()) {
          const r = await this.llm.postprocess(rawText);
          text = r.text;
          usedLlm = r.ok;
        }
        this.broadcast(room, { type: "final", text, raw: rawText, llm: usedLlm });
        this.teardownSession(room);
      },
      onError: (e) => this.broadcast(room, { type: "asr_error", message: e.message }),
      onClose: () => {
        if (room.asr === asr) {
          if (room.sessionTimer) clearTimeout(room.sessionTimer);
          room.asr = undefined;
          room.sessionTimer = undefined;
        }
      },
    });
    room.asr = asr;
    room.sessionTimer = setTimeout(() => {
      if (room.macWs) this.send(room.macWs, { type: "asr_error", message: "会话超时已自动结束" });
      this.teardownSession(room);
    }, this.maxSessionMs);

    asr.startAudio().then(
      () => {},
      (e) => {
        if (room.asr === asr) {
          if (room.sessionTimer) clearTimeout(room.sessionTimer);
          room.asr = undefined;
          room.sessionTimer = undefined;
        }
        this.broadcast(room, { type: "asr_error", message: `ASR 建立失败：${e?.message ?? e}` });
      },
    );
  }

  private handleEnd(client: ClientState): void {
    const room = this.rooms.get(client.roomCode!);
    room?.asr?.finishAudio();
  }

  private handleConfig(client: ClientState, msg: any): void {
    const room = this.rooms.get(client.roomCode!);
    if (!room) return;
    if (typeof msg.llm_postprocess === "boolean") room.llmPostprocess = msg.llm_postprocess;
    if (room.phoneWs) this.send(room.phoneWs, { type: "config", llm_postprocess: room.llmPostprocess });
    this.pushStatus(client);
  }

  // ---------- 二进制音频 ----------
  private handleBinary(ws: WebSocket, data: ArrayBuffer): void {
    const client = this.clients.get(ws);
    if (!client || client.role !== "phone" || !client.roomCode) return;
    const room = this.rooms.get(client.roomCode);
    room?.asr?.feedAudio(new Uint8Array(data));
  }

  // ---------- 连接关闭 ----------
  private onClose(ws: WebSocket): void {
    const client = this.clients.get(ws);
    if (!client) return;
    this.removeWaitingPhone(ws);
    this.detach(client);
    this.clients.delete(ws);
  }

  /** 从 pending / room 摘除，通知对端 peer_gone，必要时回收房间与会话。 */
  private detach(client: ClientState): void {
    if (client.code && client.role === "mac") {
      const entry = this.pendingByCode.get(client.code);
      if (entry?.macWs === client.ws) {
        clearTimeout(entry.timer);
        this.pendingByCode.delete(client.code);
      }
    }
    const roomCode = client.roomCode;
    client.role = undefined;
    client.code = undefined;
    client.roomCode = undefined;
    if (!roomCode) return;
    const room = this.rooms.get(roomCode);
    if (!room) return;

    let peerGoneFor: "mac" | "phone" | undefined;
    let peerWs: WebSocket | undefined;
    if (room.macWs === client.ws) {
      room.macWs = undefined;
      peerGoneFor = "phone";
      peerWs = room.phoneWs;
    } else if (room.phoneWs === client.ws) {
      room.phoneWs = undefined;
      peerGoneFor = "mac";
      peerWs = room.macWs;
    }
    if (!room.macWs && !room.phoneWs) {
      this.teardownSession(room);
      this.rooms.delete(room.code);
    } else if (peerGoneFor && peerWs) {
      // 一端走了，正在进行的会话也收掉，避免悬空 ASR 上游。
      this.teardownSession(room);
      this.send(peerWs, { type: "peer_gone", peer: peerGoneFor });
    }
  }

  private teardownSession(room: Room): void {
    if (room.sessionTimer) {
      clearTimeout(room.sessionTimer);
      room.sessionTimer = undefined;
    }
    if (room.asr) {
      try { room.asr.close(); } catch { /* ignore */ }
      room.asr = undefined;
    }
  }

  // ---------- 限流 ----------
  private recordPairFail(ip: string): number {
    const now = Date.now();
    const arr = (this.pairFailsByIp.get(ip) ?? []).filter((t) => now - t < PAIR_FAIL_WINDOW_MS);
    arr.push(now);
    this.pairFailsByIp.set(ip, arr);
    return arr.length;
  }
  private ipPairBlocked(ip: string): boolean {
    const now = Date.now();
    const arr = (this.pairFailsByIp.get(ip) ?? []).filter((t) => now - t < PAIR_FAIL_WINDOW_MS);
    if (arr.length === 0) this.pairFailsByIp.delete(ip);
    else this.pairFailsByIp.set(ip, arr);
    return arr.length >= PAIR_FAIL_MAX_PER_IP;
  }

  // ---------- 辅助 ----------
  private send(ws: WebSocket | undefined, obj: Record<string, unknown>): void {
    if (!ws) return;
    try {
      ws.send(JSON.stringify(obj));
    } catch { /* ignore */ }
  }
  private broadcast(room: Room, obj: Record<string, unknown>): void {
    const s = JSON.stringify(obj);
    try { room.macWs?.send(s); } catch { /* ignore */ }
    try { room.phoneWs?.send(s); } catch { /* ignore */ }
  }
  private pushStatus(client: ClientState): void {
    this.pushStatusFor(client.ws);
  }
  private pushStatusFor(ws: WebSocket): void {
    const client = this.clients.get(ws);
    if (!client) return;
    const room = client.roomCode ? this.rooms.get(client.roomCode) : undefined;
    let peer = "";
    if (room) {
      if (client.role === "mac") peer = room.phoneWs ? "phone" : "";
      else peer = room.macWs ? "mac" : "";
    }
    this.send(ws, {
      type: "status",
      relay_connected: true,
      peer,
      asr_ok: room ? !!room.asr : false,
    });
  }

  // ========== 设备信任模型（macId 房间 + 持久化已配对设备） ==========

  private handleMacHelloV2(client: ClientState, macId: string): void {
    this.detach(client);
    client.role = "mac";
    client.macId = macId;
    client.roomCode = macId;
    let room = this.rooms.get(macId);
    if (!room) { room = { code: macId, llmPostprocess: true }; this.rooms.set(macId, room); }
    room.macWs = client.ws;
    console.log("[relay] mac online", client.id, "devices=", this.listDevices(macId).length);
    this.send(client.ws, { type: "mac_ready", mac_id: macId });
    this.send(client.ws, { type: "devices", list: this.listDevices(macId) });
    // mac 离线期间先连上的可信手机，在 mac 上线时补配对
    this.pairWaitingPhones(macId, room);
    // 若房间里已有手机（mac 重连场景），双方重新确认
    if (room.phoneWs) {
      this.send(client.ws, { type: "paired", peer: "phone" });
      this.send(room.phoneWs, { type: "paired", peer: "mac", mac_id: macId });
    }
    this.pushStatus(client);
  }

  private handlePhoneHelloV2(client: ClientState, msg: any): void {
    client.role = "phone";
    const macId = String(msg.macId);
    const pairToken = msg.pairToken ? String(msg.pairToken) : "";
    const deviceToken = msg.deviceToken ? String(msg.deviceToken) : "";
    const name = (typeof msg.name === "string" && msg.name.trim()) ? msg.name.trim().slice(0, 40) : "手机";

    let token = "";
    let issued = false;
    if (pairToken) {
      // 首次配对：校验一次性扫码令牌（持久化在 SQLite，部署/驱逐都不丢）
      const tokenMacId = this.takePairToken(pairToken);
      if (!tokenMacId || tokenMacId !== macId) {
        return this.phonePairFail(client, "bad_pair", "二维码无效或已过期，请在 Mac 上重新生成");
      }
      token = crypto.randomUUID().replace(/-/g, "");
      this.trustDevice(macId, token, name);
      issued = true;
    } else if (deviceToken) {
      // 复用：核对长期设备凭证
      if (!this.isTrusted(macId, deviceToken)) {
        return this.phonePairFail(client, "untrusted", "此设备未授权，请重新扫码配对");
      }
      token = deviceToken;
      this.touchDevice(macId, token);
    } else {
      return this.phonePairFail(client, "bad_args", "缺少配对令牌");
    }

    client.macId = macId;
    client.deviceToken = token;
    client.roomCode = macId;
    client.failedPairs = 0;

    let room = this.rooms.get(macId);
    if (!room) { room = { code: macId, llmPostprocess: true }; this.rooms.set(macId, room); }
    room.phoneWs = client.ws;

    const reply: Record<string, unknown> = { type: "paired", peer: "mac", mac_id: macId };
    if (issued) reply.device_token = token; // 仅首次下发，手机存本地，以后免扫码
    this.send(client.ws, reply);
    this.send(client.ws, { type: "config", llm_postprocess: room.llmPostprocess });

    if (room.macWs) {
      console.log("[relay] paired", macId, issued ? "(new)" : "(known)");
      this.send(room.macWs, { type: "paired", peer: "phone" });
      this.send(room.macWs, { type: "devices", list: this.listDevices(macId) });
      this.pushStatusFor(room.macWs);
    } else {
      // Mac 暂时离线：手机进等待队列，mac 上线即自动配上
      this.addWaitingPhone(macId, client.ws);
      this.send(client.ws, { type: "status", relay_connected: true, peer: "", asr_ok: false });
    }
    this.pushStatus(client);
  }

  private phonePairFail(client: ClientState, code: string, message: string): void {
    client.failedPairs += 1;
    const ipFails = this.recordPairFail(client.ip);
    this.send(client.ws, { type: "error", code, message });
    if (client.failedPairs >= PAIR_FAIL_MAX_PER_CONN || ipFails >= PAIR_FAIL_MAX_PER_IP) {
      try { client.ws.close(1008, "too many attempts"); } catch { /* ignore */ }
    }
  }

  private handleNewPairCode(client: ClientState): void {
    const macId = client.macId!;
    const now = Date.now();
    this.sql.exec("DELETE FROM pair_tokens WHERE expires_at < ?", now);   // 顺手清过期
    const token = crypto.randomUUID().replace(/-/g, "");
    this.sql.exec("INSERT OR REPLACE INTO pair_tokens (token, mac_id, expires_at) VALUES (?, ?, ?)", token, macId, now + this.pairCodeTtlMs);
    this.send(client.ws, { type: "pair_code", token, ttl_ms: this.pairCodeTtlMs });
  }

  /** 取一次性扫码令牌：命中即删除（一次性），过期/不存在返回 null。 */
  private takePairToken(token: string): string | null {
    const rows = this.sql.exec("SELECT mac_id, expires_at FROM pair_tokens WHERE token = ?", token).toArray();
    this.sql.exec("DELETE FROM pair_tokens WHERE token = ?", token);
    if (!rows.length) return null;
    const r: any = rows[0];
    if (Number(r.expires_at) < Date.now()) return null;
    return String(r.mac_id);
  }

  private handleRevokeDevice(client: ClientState, msg: any): void {
    const macId = client.macId!;
    const token = String(msg.token ?? msg.id ?? "");
    if (!token) return;
    this.untrustDevice(macId, token);
    // 踢掉当前在线的该设备
    for (const [ws, st] of this.clients) {
      if (st.role === "phone" && st.macId === macId && st.deviceToken === token) {
        this.send(ws, { type: "unpaired", reason: "revoked", message: "已被移除授权" });
        try { ws.close(1008, "revoked"); } catch { /* ignore */ }
      }
    }
    this.send(client.ws, { type: "devices", list: this.listDevices(macId) });
  }

  private addWaitingPhone(macId: string, ws: WebSocket): void {
    let s = this.waitingPhones.get(macId);
    if (!s) { s = new Set(); this.waitingPhones.set(macId, s); }
    s.add(ws);
  }
  private pairWaitingPhones(macId: string, room: Room): void {
    const s = this.waitingPhones.get(macId);
    if (!s) return;
    for (const ws of s) {
      const st = this.clients.get(ws);
      if (st && st.role === "phone" && ws.readyState === 1) {
        room.phoneWs = ws;
        this.send(ws, { type: "paired", peer: "mac", mac_id: macId });
        this.send(ws, { type: "config", llm_postprocess: room.llmPostprocess });
        if (room.macWs) this.send(room.macWs, { type: "paired", peer: "phone" });
      }
    }
    this.waitingPhones.delete(macId);
  }
  private removeWaitingPhone(ws: WebSocket): void {
    for (const [k, s] of this.waitingPhones) {
      if (s.delete(ws) && s.size === 0) this.waitingPhones.delete(k);
    }
  }

  // ---- SQLite 设备存储 ----
  private trustDevice(macId: string, token: string, name: string): void {
    const now = Date.now();
    this.sql.exec(
      "INSERT OR REPLACE INTO devices (mac_id, token, name, created_at, last_seen) VALUES (?, ?, ?, ?, ?)",
      macId, token, name, now, now,
    );
  }
  private isTrusted(macId: string, token: string): boolean {
    return this.sql.exec("SELECT 1 FROM devices WHERE mac_id = ? AND token = ? LIMIT 1", macId, token).toArray().length > 0;
  }
  private touchDevice(macId: string, token: string): void {
    this.sql.exec("UPDATE devices SET last_seen = ? WHERE mac_id = ? AND token = ?", Date.now(), macId, token);
  }
  private untrustDevice(macId: string, token: string): void {
    this.sql.exec("DELETE FROM devices WHERE mac_id = ? AND token = ?", macId, token);
  }
  private listDevices(macId: string): Array<{ id: string; name: string; createdAt: number; lastSeen: number }> {
    return this.sql.exec("SELECT token, name, created_at, last_seen FROM devices WHERE mac_id = ? ORDER BY created_at", macId)
      .toArray()
      .map((r: any) => ({ id: String(r.token), name: String(r.name ?? "手机"), createdAt: Number(r.created_at), lastSeen: Number(r.last_seen) }));
  }

  private generateCode(): string {
    for (let i = 0; i < 50; i++) {
      const a = new Uint32Array(1);
      crypto.getRandomValues(a);
      const code = String(a[0] % 1_000_000).padStart(6, "0");
      if (!this.pendingByCode.has(code) && !this.rooms.has(code)) return code;
    }
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return String(a[0] % 1_000_000).padStart(6, "0");
  }
}

import { randomInt } from "node:crypto";
import WebSocket from "ws";
import type { AppConfig } from "./config.js";

/** 一个 client 连接（mac 或 phone，未配对前 role 未知） */
export interface Client {
  ws: WebSocket;
  id: string;          // 短 id，仅用于日志
  ip?: string;         // 远端地址（配对码暴力破解限流用）
  role?: "mac" | "phone";
  code?: string;       // mac 持有的配对码 / phone 提交的配对码
  room?: Room;         // 配对后所属房间
  failedPairs?: number; // 本连接累计配对失败次数（超阈值即断开）
}

/** 房间 = 一对 mac + phone */
export interface Room {
  code: string;
  mac?: Client;
  phone?: Client;
  // 运行期：phone 是否开启 LLM 后处理（mac 可下发开关）
  llmPostprocess: boolean;
}

/**
 * 房间表。
 * 维护两条索引：按配对码、按已配对的房间。
 * 配对码有 TTL，到期回收。
 */
export class RoomRegistry {
  private pendingByCode = new Map<string, { mac: Client; expiresAt: number }>();
  private roomsByCode = new Map<string, Room>();
  private cleanupTimer: NodeJS.Timeout;

  constructor(private cfg: AppConfig) {
    // 每 30s 清一次过期配对码
    this.cleanupTimer = setInterval(() => this.gc(), 30_000);
    this.cleanupTimer.unref?.();
  }

  /** mac 入网：生成配对码，挂到 pending。 */
  registerMac(mac: Client): string {
    // 同一 mac 重复 hello：先清掉它之前的码/房
    this.detach(mac);
    const code = this.generateCode();
    const expiresAt = Date.now() + this.cfg.pairCodeTtlMs;
    this.pendingByCode.set(code, { mac, expiresAt });
    mac.role = "mac";
    mac.code = code;
    return code;
  }

  /** phone 提交配对码：校验、绑入房间、返回 room。 */
  pairPhone(phone: Client, code: string): { ok: true; room: Room } | { ok: false; reason: "bad_code" } {
    phone.role = "phone";
    const entry = this.pendingByCode.get(code);
    if (!entry) return { ok: false, reason: "bad_code" };
    if (entry.expiresAt < Date.now()) {
      this.pendingByCode.delete(code);
      return { ok: false, reason: "bad_code" };
    }
    const mac = entry.mac;
    if (mac.ws.readyState !== WebSocket.OPEN) {
      this.pendingByCode.delete(code);
      return { ok: false, reason: "bad_code" };
    }
    // 单次绑定：从 pending 移除
    this.pendingByCode.delete(code);

    const room: Room = { code, mac, phone, llmPostprocess: true };
    mac.room = room;
    phone.room = room;
    phone.code = code;
    this.roomsByCode.set(code, room);
    return { ok: true, room };
  }

  /** 连接断开：从 pending / room 中摘除，通知对端。 */
  detach(client: Client): Room | undefined {
    // 从 pending 摘除（mac 持有的码）
    if (client.code && client.role === "mac" && this.pendingByCode.has(client.code)) {
      this.pendingByCode.delete(client.code);
    }
    const room = client.room;
    if (!room) {
      // 清掉 client 自身引用，避免泄漏
      client.role = undefined;
      client.code = undefined;
      client.room = undefined;
      return undefined;
    }
    let peerGoneFor: "mac" | "phone" | undefined;
    if (room.mac === client) {
      room.mac = undefined;
      peerGoneFor = "phone";
    } else if (room.phone === client) {
      room.phone = undefined;
      peerGoneFor = "mac";
    }
    client.role = undefined;
    client.code = undefined;
    client.room = undefined;

    // 房间空了就回收；否则通知对端
    if (!room.mac && !room.phone) {
      this.roomsByCode.delete(room.code);
    } else if (peerGoneFor) {
      const peer = room.mac ?? room.phone;
      peer?.ws.send(JSON.stringify({ type: "peer_gone", peer: peerGoneFor }));
    }
    return room;
  }

  getRoomByCode(code: string): Room | undefined {
    return this.roomsByCode.get(code);
  }

  /** 当前活跃房间数（健康检查用）。 */
  get roomCount(): number {
    return this.roomsByCode.size;
  }

  findRoomOf(client: Client): Room | undefined {
    return client.room;
  }

  /** 生成 6 位数字配对码（CSPRNG，避免与现存冲突）。 */
  private generateCode(): string {
    for (let i = 0; i < 50; i++) {
      // randomInt 用 CSPRNG，配对码不可从历史输出预测（Math.random / Date.now 都可预测）。
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      if (!this.pendingByCode.has(code) && !this.roomsByCode.has(code)) return code;
    }
    // 极端情况兜底：仍用 CSPRNG，绝不退回可预测的 Date.now()。
    return String(randomInt(0, 1_000_000)).padStart(6, "0");
  }

  private gc(): void {
    const now = Date.now();
    for (const [code, entry] of this.pendingByCode) {
      if (entry.expiresAt < now) {
        this.pendingByCode.delete(code);
        entry.mac.ws.send(JSON.stringify({ type: "error", code: "code_expired", message: "配对码已过期，请重启配对" }));
      }
    }
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
  }
}

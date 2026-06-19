import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { config } from "./config.js";
import { RoomRegistry, type Client, type Room } from "./rooms.js";
import { DoubaoAsrSession } from "./doubao-asr.js";
import { DoubaoLlm } from "./doubao-llm.js";

const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[relay]", ...a);

const registry = new RoomRegistry(config);
const llm = new DoubaoLlm(config.ark);

/** 每个正在进行的语音会话（room → asr + 超时定时器）。同一 room 同时只允许一个会话。 */
const activeSessions = new Map<string, { session: DoubaoAsrSession; timer: NodeJS.Timeout }>();

// ---------- 配对码暴力破解限流 ----------
// 6 位数字配对码空间只有 10^6，必须对失败尝试限流，否则可在线穷举劫持房间。
const PAIR_FAIL_WINDOW_MS = 60_000; // 滑动窗口
const PAIR_FAIL_MAX_PER_IP = 20; // 单 IP 每分钟失败上限
const PAIR_FAIL_MAX_PER_CONN = 5; // 单连接失败上限（超出即断）
const pairFailsByIp = new Map<string, number[]>();

/** 记录一次配对失败，返回该 IP 当前窗口内的失败次数。 */
function recordPairFail(ip: string): number {
  const now = Date.now();
  const arr = (pairFailsByIp.get(ip) ?? []).filter((t) => now - t < PAIR_FAIL_WINDOW_MS);
  arr.push(now);
  pairFailsByIp.set(ip, arr);
  return arr.length;
}

/** 该 IP 是否已超过窗口失败上限（顺带清理过期项，避免 Map 无限膨胀）。 */
function ipPairBlocked(ip: string): boolean {
  const now = Date.now();
  const arr = (pairFailsByIp.get(ip) ?? []).filter((t) => now - t < PAIR_FAIL_WINDOW_MS);
  if (arr.length === 0) pairFailsByIp.delete(ip);
  else pairFailsByIp.set(ip, arr);
  return arr.length >= PAIR_FAIL_MAX_PER_IP;
}

const server = http.createServer((req, res) => {
  // 健康检查
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: registry.roomCount }));
    return;
  }

  // 可选：托管手机 PWA 静态站（相对进程 cwd 解析；dev 时 cwd=relay/）
  const webRoot = config.webDir ? path.resolve(process.cwd(), config.webDir) : "";
  if (webRoot && req.url) {
    serveStatic(req, res, webRoot);
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const ip = req.socket.remoteAddress ?? "";
  const client: Client = { ws, ip, id: `${ip.slice(-7)}-${Math.random().toString(36).slice(2, 6)}` };
  log("connect", client.id);

  ws.on("message", (raw, isBinary) => {
    if (isBinary) {
      handleBinary(client, raw as Buffer);
      return;
    }
    handleText(client, raw.toString()).catch((e) => log("msg error", client.id, e));
  });

  ws.on("close", () => {
    log("disconnect", client.id, client.role ?? "?", client.code ?? "-");
    teardownRoom(client);
    registry.detach(client);
  });

  ws.on("error", (e) => log("ws error", client.id, e));
});

// ---------- 文本信令 ----------
async function handleText(client: Client, text: string) {
  let msg: any;
  try {
    msg = JSON.parse(text);
  } catch {
    return send(client, { type: "error", code: "bad_json", message: "非合法 JSON" });
  }

  // 任何消息都先处理心跳
  if (msg.type === "ping") return send(client, { type: "pong" });
  if (msg.type === "pong") return;

  // hello 必须是第一条
  if (msg.type === "hello") return handleHello(client, msg);

  // 其余信令要求已配对
  if (!client.room || !client.role) {
    return send(client, { type: "error", code: "not_paired", message: "请先完成配对" });
  }

  switch (msg.type) {
    case "start":
      if (client.role !== "phone") return send(client, { type: "error", code: "bad_role", message: "仅手机端可 start" });
      return handleStart(client, msg);
    case "end":
      if (client.role !== "phone") return;
      return handleEnd(client);
    case "config":
      if (client.role !== "mac") return;
      return handleConfig(client, msg);
    default:
      return send(client, { type: "error", code: "bad_type", message: `未知 type: ${msg.type}` });
  }
}

function handleHello(client: Client, msg: any) {
  const role: string = msg.role;
  if (role === "mac") {
    const code = registry.registerMac(client);
    log("mac registered", client.id, "code=", code);
    send(client, { type: "assign", code });
    pushStatus(client);
    return;
  }
  if (role === "phone") {
    const ip = client.ip ?? "";
    // IP 级闸门：窗口内失败过多直接拒绝并断开（防止换连接继续穷举）。
    if (ipPairBlocked(ip)) {
      send(client, { type: "error", code: "rate_limited", message: "尝试过于频繁，请稍后再试" });
      try { client.ws.close(1008, "rate limited"); } catch { /* ignore */ }
      return;
    }
    const code: string = String(msg.code ?? "");
    const res = registry.pairPhone(client, code);
    if (!res.ok) {
      client.failedPairs = (client.failedPairs ?? 0) + 1;
      const ipFails = recordPairFail(ip);
      send(client, { type: "error", code: "bad_code", message: "配对码无效或已过期" });
      // 单连接或单 IP 失败超阈值即断开，把在线穷举速率压到可忽略。
      if (client.failedPairs >= PAIR_FAIL_MAX_PER_CONN || ipFails >= PAIR_FAIL_MAX_PER_IP) {
        try { client.ws.close(1008, "too many attempts"); } catch { /* ignore */ }
      }
      return;
    }
    const { room } = res;
    log("paired", room.code);
    send(room.mac!, { type: "paired", peer: "phone" });
    send(room.phone!, { type: "paired", peer: "mac" });
    // 把 mac 当前 LLM 开关同步给手机（便于 UI 显示）
    send(room.phone!, { type: "config", llm_postprocess: room.llmPostprocess });
    // 给双方都推一次状态：手机端据此把“等待 Mac”点亮为“Mac 已就绪”。
    pushStatus(room.mac!);
    pushStatus(room.phone!);
    return;
  }
  send(client, { type: "error", code: "bad_role", message: "role 必须是 mac 或 phone" });
}

function handleStart(client: Client, msg: any) {
  const room = client.room!;
  if (activeSessions.has(room.code)) {
    teardownSession(room.code);
  }
  const format = {
    sampleRate: msg?.format?.sampleRate ?? 16000,
    channels: msg?.format?.channels ?? 1,
    bits: msg?.format?.bits ?? 16,
  };
  const session = new DoubaoAsrSession(config.doubaoAsr, format, {
    onPartial: (t) => {
      // 实时回显给 mac 与 phone（手机端 UI 靠它显示“正在聆听”的增量文本）。
      broadcast(room, { type: "partial", text: t });
    },
    onFinal: async (rawText) => {
      log("asr final", room.code, JSON.stringify(rawText));
      let text = rawText;
      let usedLlm = false;
      if (room.llmPostprocess && llm.enabled && rawText.trim()) {
        const r = await llm.postprocess(rawText);
        text = r.text;
        usedLlm = r.ok;
      }
      broadcast(room, { type: "final", text, raw: rawText, llm: usedLlm });
      teardownSession(room.code);
    },
    onError: (e) => {
      log("asr error", room.code, e.message);
      broadcast(room, { type: "asr_error", message: e.message });
    },
    onClose: () => {
      const cur = activeSessions.get(room.code);
      if (cur && cur.session === session) {
        clearTimeout(cur.timer);
        activeSessions.delete(room.code);
      }
    },
  });

  // 单次会话时长上限：到点强制结束并通知 mac，避免半开连接泄漏上游 ASR 连接/配额。
  const timer = setTimeout(() => {
    log("session timeout", room.code);
    room.mac?.ws.readyState === WebSocket.OPEN &&
      room.mac.ws.send(JSON.stringify({ type: "asr_error", message: "会话超时已自动结束" }));
    teardownSession(room.code);
  }, config.maxSessionMs);
  timer.unref?.();

  // 同步登记 session：紧随 start 之后到达的二进制音频帧与 end 才能找到它。
  // open 之前的音频帧在 session 内部缓存，open 时按序补发（见 DoubaoAsrSession）。
  activeSessions.set(room.code, { session, timer });

  session.startAudio().then(
    () => {
      log("asr started", room.code, format);
    },
    (e) => {
      log("asr start failed", room.code, e.message);
      const cur = activeSessions.get(room.code);
      if (cur && cur.session === session) {
        clearTimeout(cur.timer);
        activeSessions.delete(room.code);
      }
      broadcast(room, { type: "asr_error", message: `ASR 建立失败：${e.message}` });
    },
  );
}

function handleEnd(client: Client) {
  const room = client.room!;
  activeSessions.get(room.code)?.session.finishAudio();
  log("phone end", room.code);
}

function handleConfig(client: Client, msg: any) {
  const room = client.room!;
  if (typeof msg.llm_postprocess === "boolean") {
    room.llmPostprocess = msg.llm_postprocess;
  }
  room.phone?.ws.readyState === WebSocket.OPEN &&
    room.phone.ws.send(JSON.stringify({ type: "config", llm_postprocess: room.llmPostprocess }));
  pushStatus(client);
}

// ---------- 二进制音频 ----------
function handleBinary(client: Client, pcm: Buffer) {
  if (!client.room || client.role !== "phone") {
    // 未配对收到音频，直接忽略（phone start 前的噪声）
    return;
  }
  const entry = activeSessions.get(client.room.code);
  if (entry) entry.session.feedAudio(pcm);
}

// ---------- 辅助 ----------
function send(client: Client, obj: Record<string, unknown>) {
  if (client.ws.readyState !== WebSocket.OPEN) return;
  client.ws.send(JSON.stringify(obj));
}

/** 向房间内的 mac 和 phone 双方广播同一消息（ASR 结果两端都要看到）。 */
function broadcast(room: Room, obj: Record<string, unknown>) {
  const s = JSON.stringify(obj);
  if (room.mac?.ws.readyState === WebSocket.OPEN) room.mac.ws.send(s);
  if (room.phone?.ws.readyState === WebSocket.OPEN) room.phone.ws.send(s);
}

function pushStatus(client: Client) {
  const room = client.room;
  send(client, {
    type: "status",
    relay_connected: true,
    peer: room ? (client.role === "mac" ? (room.phone ? "phone" : "") : room.mac ? "mac" : "") : "",
    asr_ok: room ? activeSessions.has(room.code) : false,
  });
}

function teardownSession(code: string) {
  const entry = activeSessions.get(code);
  if (entry) {
    clearTimeout(entry.timer);
    entry.session.close();
    activeSessions.delete(code);
  }
}

function teardownRoom(client: Client) {
  const room = client.room;
  if (room) teardownSession(room.code);
}

// ---------- 静态托管 ----------
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, root: string) {
  let urlPath = (req.url ?? "/").split("?")[0];
  if (urlPath === "/") urlPath = "/index.html";
  // 防目录穿越
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(root, safe);
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    // sw.js / 入口 HTML 必须每次校验，否则浏览器拿不到新版 Service Worker / 应用壳。
    const headers: Record<string, string> = {
      "content-type": MIME[path.extname(filePath)] ?? "application/octet-stream",
    };
    if (safe === "/sw.js" || safe === "/index.html" || urlPath === "/index.html") {
      headers["cache-control"] = "no-cache";
    }
    res.writeHead(200, headers);
    res.end(buf);
  });
}

// ---------- 启动 ----------
server.listen(config.port, () => {
  log(`listening :${config.port}`);
  log(`ASR upstream: ${config.doubaoAsr.wssUrl}`);
  log(`LLM postprocess: ${llm.enabled ? "enabled" : "disabled (ARK_API_KEY 未配置)"}`);
  if (config.webDir) log(`web root: ${path.resolve(process.cwd(), config.webDir)}`);
});

process.on("SIGINT", () => {
  log("shutting down...");
  registry.dispose();
  server.close(() => process.exit(0));
});

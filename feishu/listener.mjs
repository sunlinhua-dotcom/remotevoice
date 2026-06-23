// 飞书机器人「远程语音」监听器
// ─────────────────────────────────────────────────────────────────────────────
// 链路：用户在飞书私聊机器人发文字 / 语音
//   → 长连接收到 im.message.receive_v1
//   → 文字直接用；语音先 ffmpeg 转 PCM 再走飞书 speech_to_text 转写
//   → 作为 phone 角色连云中继，发 {type:"inject_text", id, text, postprocess}
//   → 中继当作 final 广播给 Mac，Mac 注入到当前窗口；中继回 inject_result 做送达确认
//
// 这条通道完全不碰实时音频，靠飞书自己的稳定多模态做转写，比 PWA 实时链路更省心。
// 只需在本机长跑这一个 Node 进程（pm2 托管）。

import "dotenv/config";
import { readFile, unlink } from "node:fs/promises";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import * as lark from "@larksuiteoapi/node-sdk";

// ---- 配置 ----
const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const RELAY_URL = process.env.RELAY_URL;
const MAC_ID = process.env.MAC_ID;
const DEVICE_NAME = process.env.DEVICE_NAME || "飞书远程语音";

for (const [k, v] of Object.entries({ FEISHU_APP_ID: APP_ID, FEISHU_APP_SECRET: APP_SECRET, RELAY_URL, MAC_ID })) {
  if (!v) {
    console.error(`[feishu] 缺少环境变量 ${k}。请在 feishu/.env 里填好后重试。`);
    process.exit(1);
  }
}

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);

// 中继的 HTTP 基址（图片临时中转用）：wss://host/ws → https://host
const HTTP_BASE = RELAY_URL.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:").replace(/\/ws$/i, "");

// device_token 持久化（按 macId 区分），避免每次重启都在中继 devices 表新增一条可信设备。
const TOKEN_FILE = join(import.meta.dirname, `.device_token.${MAC_ID}`);
const loadToken = () => { try { return readFileSync(TOKEN_FILE, "utf8").trim() || null; } catch { return null; } };
const saveToken = (t) => { try { writeFileSync(TOKEN_FILE, t); } catch (e) { log("device_token 落盘失败", e.message); } };
const dropToken = () => { try { unlinkSync(TOKEN_FILE); } catch {} };

// ─────────────────────────────────────────────────────────────────────────────
// 1) 云中继客户端：以 phone 角色长连，保持配对，发 inject_text 并等送达确认
// ─────────────────────────────────────────────────────────────────────────────
class RelayClient {
  constructor(url, macId, name) {
    this.url = url;
    this.macId = macId;
    this.name = name;
    this.ws = null;
    this.paired = false;
    this.deviceToken = loadToken();   // 复用上次中继签发的长期凭证
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.lastSeen = 0;                 // 最近一次收到任何入站消息的时刻（心跳看门狗用）
    this.pending = new Map();          // id → {resolve, timer}，等 inject_result
    this.connect();
  }

  connect() {
    clearTimeout(this.reconnectTimer);
    log("relay 连接中…", this.url);
    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.paired = false;
    this.lastSeen = Date.now();

    ws.on("open", () => {
      this.lastSeen = Date.now();
      const hello = { type: "hello", role: "phone", macId: this.macId, name: this.name };
      if (this.deviceToken) hello.deviceToken = this.deviceToken;
      ws.send(JSON.stringify(hello));
    });

    ws.on("message", (buf) => {
      this.lastSeen = Date.now(); // 任何入站消息都证明连接活着
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      switch (msg.type) {
        case "paired":
          this.paired = true;
          if (msg.device_token) { this.deviceToken = msg.device_token; saveToken(msg.device_token); }
          log("relay 已配对 ✅  Mac 房间", this.macId.slice(0, 8) + "…");
          break;
        case "inject_result": {
          const pend = this.pending.get(msg.id);
          if (pend) { clearTimeout(pend.timer); this.pending.delete(msg.id); pend.resolve(msg); }
          break;
        }
        case "error":
          log("relay 错误", msg.code, msg.message);
          // 失效凭证（换了 macId / 被吊销）→ 清掉本地 token，下次重连按 macId 重新配对。
          if (msg.code === "untrusted" || msg.code === "bad_pair") {
            this.deviceToken = null; dropToken();
            log("已清除失效 device_token，将以 macId 重新配对");
          }
          break;
      }
    });

    ws.on("close", () => {
      this.paired = false;
      clearInterval(this.pingTimer);
      // 连接断了，挂起的注入请求一律按失败处理，别让调用方干等。
      for (const [, pend] of this.pending) { clearTimeout(pend.timer); pend.reject(new Error("relay disconnected")); }
      this.pending.clear();
      log("relay 断开，3s 后重连");
      this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    });
    ws.on("error", (e) => log("relay 连接异常", e.message));

    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      // 心跳看门狗：70s 没有任何入站消息 → 判半开死连，主动 terminate 触发重连。
      if (Date.now() - this.lastSeen > 70000) {
        log("relay 心跳超时，主动断开重连");
        try { ws.terminate(); } catch {}
        return;
      }
      ws.send(JSON.stringify({ type: "ping" }));
    }, 25000);
  }

  /** 等配对就绪后发 inject_text，并等中继的 inject_result 送达确认。
   *  返回 {ok, reason, text}；超时 / 断线则 reject。 */
  async injectText(text, { postprocess = true, waitMs = 8000, ackMs = 9000 } = {}) {
    const deadline = Date.now() + waitMs;
    while (!(this.ws && this.ws.readyState === WebSocket.OPEN && this.paired)) {
      if (Date.now() > deadline) throw new Error("中继未就绪（未配对/连接断开）");
      await new Promise((r) => setTimeout(r, 150));
    }
    const id = randomUUID();
    const result = new Promise((resolve, reject) => {
      // 超时按「已发出但未收到确认」软处理（中继多半已送达，只是 Mac 没回 ack）。
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: true, unconfirmed: true }); }, ackMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.ws.send(JSON.stringify({ type: "inject_text", id, text, postprocess }));
    return result;
  }

  /** 注入一个按键（如 enter）到 Mac 当前窗口，并等 inject_result 确认。 */
  async injectKey(key, { waitMs = 8000, ackMs = 9000 } = {}) {
    const deadline = Date.now() + waitMs;
    while (!(this.ws && this.ws.readyState === WebSocket.OPEN && this.paired)) {
      if (Date.now() > deadline) throw new Error("中继未就绪（未配对/连接断开）");
      await new Promise((r) => setTimeout(r, 150));
    }
    const id = randomUUID();
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: true, unconfirmed: true }); }, ackMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.ws.send(JSON.stringify({ type: "inject_key", id, key }));
    return result;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) 飞书客户端：下载语音 + 转写
// ─────────────────────────────────────────────────────────────────────────────
const client = new lark.Client({
  appId: APP_ID,
  appSecret: APP_SECRET,
  domain: lark.Domain.Feishu,
});

// 下载一条 audio 消息里的语音文件，返回 Buffer（飞书是 ogg/opus）。临时文件名随机，用完必删。
async function downloadAudio(messageId, fileKey) {
  const resp = await client.im.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type: "file" },
  });
  const tmp = join(tmpdir(), `rv-${randomUUID()}.opus`);
  try {
    await resp.writeFile(tmp); // SDK 的文件响应封装
    return await readFile(tmp);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

// ffmpeg 把 ogg/opus 解码成 16kHz/单声道/s16le 裸 PCM（飞书 STT file_recognize 只吃裸 PCM）。
function opusToPcm(opusBuf) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0",
      "-f", "s16le", "-ar", "16000", "-ac", "1", "pipe:1"]);
    const out = [], err = [];
    ff.stdout.on("data", (d) => out.push(d));
    ff.stderr.on("data", (d) => err.push(d));
    ff.on("error", (e) => reject(new Error(`ffmpeg 启动失败：${e.message}`)));
    ff.on("close", (code) => code === 0
      ? resolve(Buffer.concat(out))
      : reject(new Error(`ffmpeg 退出码 ${code}: ${Buffer.concat(err).toString().slice(0, 200)}`)));
    ff.stdin.on("error", () => {}); // 防 EPIPE
    ff.stdin.end(opusBuf);
  });
}

// 调飞书 speech_to_text 把裸 PCM 转成文字。业务级错误（code!=0）如实抛出，不吞成空串。
async function transcribe(pcmBuf) {
  const resp = await client.speech_to_text.speech.fileRecognize({
    data: {
      speech: { speech: pcmBuf.toString("base64") },
      config: { file_id: randomUUID(), format: "pcm", engine_type: "16k_auto" },
    },
  });
  if (resp && resp.code != null && resp.code !== 0) {
    throw new Error(`飞书 STT ${resp.code}: ${resp.msg || "unknown"}`);
  }
  const text = resp?.data?.recognition_text ?? resp?.recognition_text ?? "";
  return (text || "").trim();
}

// 纯文字回复（提示类用）。
async function reply(messageId, text) {
  try {
    await client.im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: "text", content: JSON.stringify({ text }) },
    });
  } catch (e) {
    log("回复失败（不影响注入）", e.message);
  }
}

// 交互卡片：标题(带颜色) + 正文 + 可选「⏎ 回车」按钮。点按钮触发 card.action.trigger → 注入回车键。
function buildStatusCard({ title, template, lines, showEnter }) {
  const elements = [{ tag: "markdown", content: lines }];
  if (showEnter) {
    elements.push({
      tag: "button",
      text: { tag: "plain_text", content: "⏎ 回车（提交）" },
      type: "primary",
      behaviors: [{ type: "callback", value: { action: "enter" } }],
    });
  }
  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: title }, template },
    body: { elements },
  };
}

async function replyCard(messageId, card) {
  try {
    await client.im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: "interactive", content: JSON.stringify(card) },
    });
  } catch (e) {
    log("卡片回复失败", e.message);
  }
}

// 把一段文字经中继注入到 Mac，并用卡片回执（含「回车」按钮）。
//   postprocess=false：用户手打的成文文字，中继不再 LLM 改写。
async function deliver(messageId, text, { postprocess = true } = {}) {
  let card;
  try {
    const res = await relay.injectText(text, { postprocess });
    if (res.ok && res.mode === "type") {
      log("已打字 ✅", text);
      card = buildStatusCard({ title: "✅ 已注入到电脑输入框", template: "green", lines: `**你说的**\n${text}`, showEnter: true });
    } else if (res.ok && res.mode === "clipboard") {
      log("进剪贴板", text);
      card = buildStatusCard({ title: "📋 已放到剪贴板", template: "blue", lines: `电脑当前没有输入框焦点，文字已放剪贴板，可直接粘贴：\n**${text}**`, showEnter: false });
    } else if (res.ok && res.unconfirmed) {
      log("已送达但未收到注入确认");
      card = buildStatusCard({ title: "✅ 已送达电脑", template: "green", lines: `**你说的**\n${text}\n\n（没收到注入结果确认，可能网络略慢）`, showEnter: true });
    } else if (res.ok) {
      card = buildStatusCard({ title: "✅ 已送达电脑", template: "green", lines: `**你说的**\n${text}`, showEnter: true });
    } else if (res.mode === "failed") {
      log("Mac 注入失败");
      card = buildStatusCard({ title: "⚠️ 电脑端注入失败", template: "red", lines: "可能缺辅助功能授权。去 系统设置 → 隐私与安全性 → 辅助功能 打开 RemoteVoiceInput。", showEnter: false });
    } else if (res.reason === "mac_offline") {
      log("Mac 不在线，未送达");
      card = buildStatusCard({ title: "⚠️ 电脑端没在线", template: "red", lines: "没送达。请确认 Mac 上 RemoteVoiceInput 在运行。", showEnter: false });
    } else {
      log("未送达", res.reason);
      card = buildStatusCard({ title: "⚠️ 未送达", template: "red", lines: `原因：${res.reason || "未知"}`, showEnter: false });
    }
  } catch (e) {
    log("注入失败", e.message);
    card = buildStatusCard({ title: "⚠️ 处理失败", template: "red", lines: String(e.message), showEnter: false });
  }
  await replyCard(messageId, card);
}

// 把图片文件写进 Mac 剪贴板（本地操作——监听器就在这台 Mac 上）。
// 用 AppKit NSImage→NSPasteboard：自动提供 TIFF/PNG/JPEG 等多种表示，目标 App 各取所需，
// 比单一 «class PNGf» 兼容性好得多。NSImage 原生支持 jpg/png/heic/gif，无需先转码。
function setClipboardImage(filePath) {
  return new Promise((resolve, reject) => {
    const script = [
      'use framework "AppKit"',
      'use scripting additions',
      `set theImage to current application's NSImage's alloc()'s initWithContentsOfFile:${JSON.stringify(filePath)}`,
      'if theImage is missing value then error "NSImage 加载失败（图片格式不支持？）"',
      "set pb to current application's NSPasteboard's generalPasteboard()",
      "pb's clearContents()",
      "pb's writeObjects:{theImage}",
    ].join("\n");
    const p = spawn("osascript", ["-e", script]);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject(new Error(`osascript 启动失败：${e.message}`)));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`写剪贴板失败：${err.slice(0, 160)}`))));
  });
}

// 按文件头嗅探图片 mime（给中转 URL 正确的 Content-Type，浏览器才能直接显示）。
function sniffMime(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return "image/webp";
  return "application/octet-stream";
}

// 把图片上传到中继的临时中转，返回可公网打开的短链 URL（给被控主机用）。
async function uploadImageToRelay(bytes) {
  const r = await fetch(`${HTTP_BASE}/i`, { method: "POST", headers: { "Content-Type": sniffMime(bytes) }, body: bytes });
  if (!r.ok) throw new Error(`中转上传失败 ${r.status}`);
  const j = await r.json();
  if (!j.id) throw new Error("中转无返回 id");
  return `${HTTP_BASE}/i/${j.id}`;
}

// 图片消息：本地下载 → ①写 Mac 剪贴板 + 自动 Cmd+V（贴进当前窗口，本机/被控-若UU同步图片均可）
//                      ②上传中继拿短链 URL，放进回执卡片（被控主机的兜底通道：UU 图片剪贴板不行时用 URL）。
async function deliverImage(messageId, imageKey) {
  const file = join(tmpdir(), `rv-img-${randomUUID()}`);
  let card;
  try {
    log("收到图片，下载中…");
    const resp = await client.im.messageResource.get({
      path: { message_id: messageId, file_key: imageKey },
      params: { type: "image" },
    });
    await resp.writeFile(file);
    const bytes = await readFile(file);

    // ② 上传中转拿 URL（失败不影响本地粘贴）
    let imgUrl = "";
    try { imgUrl = await uploadImageToRelay(bytes); } catch (e) { log("图片中转上传失败（不影响本地粘贴）", e.message); }
    const urlLine = imgUrl ? `\n\n🔗 被控/远端打开此链接即可拿到图片：\n${imgUrl}` : "";

    // ① 本地剪贴板 + 自动粘贴
    await setClipboardImage(file);
    log("图片已写入剪贴板，触发粘贴");
    const res = await relay.injectKey("paste");

    if (res.ok && (res.mode === "key" || res.mode === "type")) {
      card = buildStatusCard({ title: "🖼 图片已粘贴到电脑", template: "green", lines: `已复制到剪贴板并在当前窗口粘贴。${urlLine}`, showEnter: false });
    } else if (res.ok && res.unconfirmed) {
      card = buildStatusCard({ title: "🖼 图片已复制到剪贴板", template: "green", lines: `粘贴结果未确认，必要时手动 Cmd+V。${urlLine}`, showEnter: false });
    } else if (res.reason === "mac_offline") {
      card = buildStatusCard({ title: "📋 图片已复制到剪贴板", template: "blue", lines: `电脑端 App 没在线、没自动粘贴。${urlLine}`, showEnter: false });
    } else {
      card = buildStatusCard({ title: "📋 图片已复制到剪贴板", template: "blue", lines: `自动粘贴没成功（可能缺辅助功能授权），可手动 Cmd+V。${urlLine}`, showEnter: false });
    }
  } catch (e) {
    log("图片处理失败", e.message);
    card = buildStatusCard({ title: "⚠️ 图片处理失败", template: "red", lines: String(e.message), showEnter: false });
  } finally {
    unlink(file).catch(() => {});
  }
  await replyCard(messageId, card);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) 事件分发 + 长连接
// ─────────────────────────────────────────────────────────────────────────────
const relay = new RelayClient(RELAY_URL, MAC_ID, DEVICE_NAME);

const seen = new Set(); // message_id 去重（飞书可能重投）
const remember = (id) => {
  seen.add(id);
  if (seen.size > 500) seen.delete(seen.values().next().value);
};

const dispatcher = new lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (data) => {
    const message = data?.message;
    log("📨 收到事件", JSON.stringify({
      type: message?.message_type,
      chat: message?.chat_type,
      id: message?.message_id?.slice(-8),
    }));
    if (!message) return;
    const { message_id, message_type, content } = message;
    if (!message_id || seen.has(message_id)) return;
    remember(message_id);

    // 文字消息：直接注入（首选）。手打的成文文字，明确请求中继不要 LLM 改写。
    if (message_type === "text") {
      let txt = "";
      try { txt = (JSON.parse(content || "{}").text || "").trim(); } catch {}
      if (!txt) return;
      log("文字:", txt);
      return deliver(message_id, txt, { postprocess: false });
    }

    // 语音消息：ffmpeg 转 PCM → 飞书 STT 转写后注入（转写结果允许补标点）。
    if (message_type === "audio") {
      let fileKey = "";
      try { fileKey = JSON.parse(content || "{}").file_key; } catch {}
      if (!fileKey) return;
      try {
        log("收到语音，下载转码转写中…");
        const opus = await downloadAudio(message_id, fileKey);
        const pcm = await opusToPcm(opus);
        log(`opus ${opus.length}B → pcm ${pcm.length}B`);
        const text = await transcribe(pcm);
        if (!text) {
          await reply(message_id, "没识别出内容，再说一遍试试？");
          return;
        }
        log("识别:", text);
        return deliver(message_id, text, { postprocess: true });
      } catch (e) {
        log("语音处理失败", e.message);
        await reply(message_id, `语音处理失败：${e.message}`);
      }
      return;
    }

    // 图片消息：复制到 Mac 剪贴板并在当前窗口自动粘贴。
    if (message_type === "image") {
      let imageKey = "";
      try { imageKey = JSON.parse(content || "{}").image_key; } catch {}
      if (!imageKey) return;
      log("图片:", imageKey.slice(-10));
      return deliverImage(message_id, imageKey);
    }

    await reply(message_id, "发我文字、语音或图片——文字/语音会注入到电脑当前窗口，图片会复制并粘贴。");
  },

  // 卡片按钮回调：点「⏎ 回车」→ 给 Mac 当前窗口注入一个回车键（提交）。
  // 返回值会作为卡片回调响应发回飞书（toast 提示）。
  "card.action.trigger": async (data) => {
    let value = data?.action?.value;
    if (typeof value === "string") { try { value = JSON.parse(value); } catch {} }
    value = value || {};
    log("🔘 卡片动作", JSON.stringify(value));
    if (value.action === "enter") {
      try {
        const res = await relay.injectKey("enter");
        if (res.ok) { log("已回车 ✅"); return { toast: { type: "success", content: "⏎ 已回车" } }; }
        if (res.reason === "mac_offline") return { toast: { type: "error", content: "电脑没在线" } };
        return { toast: { type: "error", content: "回车失败" } };
      } catch (e) {
        log("回车失败", e.message);
        return { toast: { type: "error", content: `回车失败：${e.message}` } };
      }
    }
    return { toast: { type: "info", content: "未知操作" } };
  },
});

const wsClient = new lark.WSClient({
  appId: APP_ID,
  appSecret: APP_SECRET,
  domain: lark.Domain.Feishu,
});

wsClient.start({ eventDispatcher: dispatcher });
log("飞书长连接已启动，等待消息…  (Mac:", MAC_ID.slice(0, 8) + "…)");

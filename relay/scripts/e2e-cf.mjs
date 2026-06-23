// 临时：对部署在 Cloudflare 的统一中继做端到端联调（mac+phone 配对 → phone 推音频 → 看 ASR 生命周期）。
// 合成音无法产出可读中文，成功标准 = 无鉴权/framing 错误、能收到 final（空文本也算链路通）。
import WebSocket from "ws";
const URL = process.env.WS_URL || "wss://YOUR-WORKER-SUBDOMAIN.workers.dev/ws";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const recv = (ws, type, ms = 8000) =>
  new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`等 ${type} 超时`)), ms);
    const on = (data) => {
      const m = JSON.parse(data.toString());
      if (!type || m.type === type) { clearTimeout(to); ws.off("message", on); resolve(m); }
    };
    ws.on("message", on);
  });

function pcmTone(ms, rate = 16000, freq = 220) {
  const n = Math.round((ms / 1000) * rate);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    let v = 0.12 * Math.sin((2 * Math.PI * freq * i) / rate) + 0.02 * (Math.random() * 2 - 1);
    v = Math.max(-1, Math.min(1, v));
    buf.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return buf;
}

const mac = new WebSocket(URL);
await new Promise((r) => mac.on("open", r));
mac.send(JSON.stringify({ type: "hello", role: "mac" }));
const assign = await recv(mac, "assign");
console.log("[mac] code =", assign.code);

const phone = new WebSocket(URL);
await new Promise((r) => phone.on("open", r));
phone.send(JSON.stringify({ type: "hello", role: "phone", code: assign.code }));
await recv(phone, "paired");
console.log("[phone] paired");

// 收集 mac 端的 partial/final/asr_error
const events = [];
mac.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (["partial", "final", "asr_error"].includes(m.type)) {
    events.push(m);
    console.log("[mac] <-", JSON.stringify(m));
  }
});

phone.send(JSON.stringify({ type: "start", format: { sampleRate: 16000, channels: 1, bits: 16 } }));
const chunk = pcmTone(100);
for (let i = 0; i < 15; i++) { phone.send(chunk); await wait(60); }
phone.send(JSON.stringify({ type: "end" }));
await wait(5000);

const hadFinal = events.some((e) => e.type === "final");
const authErr = events.find((e) => e.type === "asr_error" && /鉴权|auth|错误 \[4|framing|解压/.test(e.message || ""));
console.log("\n结果：", hadFinal ? "✅ 收到 final（ASR 链路打通）" : "⚠️ 未收到 final");
if (authErr) console.log("❌ 出现鉴权/framing 错误：", authErr.message);
mac.close(); phone.close();
process.exit(hadFinal && !authErr ? 0 : 1);

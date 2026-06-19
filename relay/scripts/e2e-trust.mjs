// 设备信任模型联调：扫码首配 → 下发 device_token → 复用免扫码 → 吊销 → 旧 token 被拒。
// 用法：在 REMOTEVOICE 下 `npx wrangler dev`（本地起统一 Worker），再 `node relay/scripts/e2e-trust.mjs`。
import WebSocket from "ws";

const URL = process.env.WS_URL || "ws://localhost:8787/ws";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (ws, o) => ws.send(JSON.stringify(o));
function open() {
  const ws = new WebSocket(URL);
  return new Promise((res, rej) => { ws.on("open", () => res(ws)); ws.on("error", rej); });
}
function recv(ws, type, ms = 5000) {
  return new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error(`等 ${type} 超时`)), ms);
    const on = (d) => { const m = JSON.parse(d.toString()); if (!type || m.type === type) { clearTimeout(to); ws.off("message", on); res(m); } };
    ws.on("message", on);
  });
}
// 等到第一条满足 pred 的消息（mac 会多次收到 devices，需挑出反映删除的那条）。
function recvUntil(ws, pred, ms = 5000) {
  return new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error("recvUntil 超时")), ms);
    const on = (d) => { const m = JSON.parse(d.toString()); if (pred(m)) { clearTimeout(to); ws.off("message", on); res(m); } };
    ws.on("message", on);
  });
}

let pass = true;
const ok = (c, m) => { console.log((c ? "✅" : "❌") + " " + m); if (!c) pass = false; };
const MAC = "mac-" + Math.random().toString(36).slice(2, 10);

// 1) mac 上线
const mac = await open();
send(mac, { type: "hello", role: "mac", macId: MAC });
const ready = await recv(mac, "mac_ready"); ok(ready.mac_id === MAC, "mac 上线 → mac_ready");
const dev0 = await recv(mac, "devices"); ok(Array.isArray(dev0.list) && dev0.list.length === 0, "初始已配对设备为空");

// 2) mac 申请一次性扫码令牌
send(mac, { type: "new_pair_code" });
const pc = await recv(mac, "pair_code"); ok(!!pc.token && pc.ttl_ms > 0, "拿到一次性 pair_code");

// 3) 手机首次扫码配对 → 拿到长期 device_token
const phone = await open();
send(phone, { type: "hello", role: "phone", macId: MAC, pairToken: pc.token, name: "iPhone 测试" });
const paired = await recv(phone, "paired");
ok(paired.peer === "mac" && !!paired.device_token, "手机首配成功并下发 device_token");
const dt = paired.device_token;
const macDev = await recv(mac, "devices");
ok(macDev.list.length === 1 && macDev.list[0].name === "iPhone 测试", "mac 设备列表出现该手机（带名字）");

// 3b) 同一个 pairToken 不能再用（一次性）
const evil = await open();
send(evil, { type: "hello", role: "phone", macId: MAC, pairToken: pc.token });
const evilErr = await recv(evil, "error").catch(() => null);
ok(evilErr && evilErr.code === "bad_pair", "重复使用扫码令牌被拒（bad_pair）");
evil.close();

// 4) 手机断开重连，用 device_token 免扫码
phone.close(); await wait(300);
const phone2 = await open();
send(phone2, { type: "hello", role: "phone", macId: MAC, deviceToken: dt });
const paired2 = await recv(phone2, "paired");
ok(paired2.peer === "mac" && !paired2.device_token, "已知设备复用 token 直接配对（不再下发新 token）");

// 5) mac 单独吊销该设备
const phoneKick = recv(phone2, "unpaired").then(() => true).catch(() => false);
const macList = recvUntil(mac, (m) => m.type === "devices" && m.list.length === 0);
send(mac, { type: "revoke_device", token: dt });
ok(await phoneKick, "吊销 → 在线手机收到 unpaired 被踢");
await macList; ok(true, "吊销后 mac 设备列表清空");
await wait(200);

// 6) 被吊销的 token 再连应被拒
const phone3 = await open();
send(phone3, { type: "hello", role: "phone", macId: MAC, deviceToken: dt });
const err = await recv(phone3, "error").catch(() => null);
ok(err && err.code === "untrusted", "吊销后旧 device_token 复用被拒（untrusted）");
phone3.close();

mac.close(); phone2.close();
console.log(pass ? "\n🎉 设备信任流程全部通过" : "\n⚠️ 有用例失败");
process.exit(pass ? 0 : 1);

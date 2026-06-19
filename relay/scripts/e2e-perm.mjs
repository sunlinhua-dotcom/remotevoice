// 永久二维码（macId-only）+ 4 位数字短码 + 复用 的联调。
// 用法：REMOTEVOICE 下 `npx wrangler dev`，再 `node relay/scripts/e2e-perm.mjs`。
import WebSocket from "ws";
const URL = process.env.WS_URL || "ws://localhost:8787/ws";
const send = (ws, o) => ws.send(JSON.stringify(o));
const open = () => new Promise((res, rej) => { const ws = new WebSocket(URL); ws.on("open", () => res(ws)); ws.on("error", rej); });
const recv = (ws, type, ms = 5000) => new Promise((res, rej) => {
  const to = setTimeout(() => rej(new Error(`等 ${type} 超时`)), ms);
  const on = (d) => { const m = JSON.parse(d.toString()); if (!type || m.type === type) { clearTimeout(to); ws.off("message", on); res(m); } };
  ws.on("message", on);
});
let pass = true;
const ok = (c, m) => { console.log((c ? "✅" : "❌") + " " + m); if (!c) pass = false; };
const MAC = "perm-" + Math.random().toString(36).slice(2, 10);

const mac = await open();
send(mac, { type: "hello", role: "mac", macId: MAC });
await recv(mac, "mac_ready");
await recv(mac, "devices");

// A) 永久二维码：手机只带 macId（无任何令牌）→ 应配对并下发 device_token
const p1 = await open();
send(p1, { type: "hello", role: "phone", macId: MAC, name: "永久码手机" });
const r1 = await recv(p1, "paired");
ok(r1.peer === "mac" && !!r1.device_token, "永久二维码(仅 macId)即可配对并下发 device_token");
const dt1 = r1.device_token;
p1.close();

// B) 4 位短码：mac 申请短码，另一台手机只带 code（不带 macId）→ 应配对
send(mac, { type: "new_short_code" });
const sc = await recv(mac, "short_code");
ok(/^\d{4}$/.test(sc.code), `拿到 4 位短码 ${sc.code}`);
const p2 = await open();
send(p2, { type: "hello", role: "phone", code: sc.code, name: "短码手机" });
const r2 = await recv(p2, "paired");
ok(r2.peer === "mac" && !!r2.device_token && r2.mac_id === MAC, "4 位短码(不带 macId)即可配对，并学到 mac_id");
p2.close();

// C) 错误短码被拒
const p3 = await open();
send(p3, { type: "hello", role: "phone", code: "0000", name: "x" });
const e3 = await recv(p3, "error").catch(() => null);
ok(e3 && e3.code === "bad_code", "错误数字码被拒（bad_code）");
p3.close();

// D) 永久码配过的手机，用 device_token 复用免扫码
await new Promise((r) => setTimeout(r, 200));
const p4 = await open();
send(p4, { type: "hello", role: "phone", macId: MAC, deviceToken: dt1 });
const r4 = await recv(p4, "paired");
ok(r4.peer === "mac" && !r4.device_token, "已知设备复用 device_token 直接配对");
p4.close();

mac.close();
console.log(pass ? "\n🎉 永久码 + 短码 流程全部通过" : "\n⚠️ 有用例失败");
process.exit(pass ? 0 : 1);

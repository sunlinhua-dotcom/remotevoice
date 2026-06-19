// 一次性联调脚本：模拟 mac + phone 两个 WS 客户端，验证配对流程。
// 用法：node scripts/e2e-pair.mjs  （中继需已在 :8787 运行）
import WebSocket from "ws";

const URL = process.env.WS_URL || "ws://localhost:8787/ws";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function mkClient(name) {
  const ws = new WebSocket(URL);
  ws.on("open", () => console.log(`[${name}] open`));
  ws.on("message", (data) => console.log(`[${name}] >>`, data.toString()));
  ws.on("error", (e) => console.log(`[${name}] error`, e.message));
  ws.on("close", () => console.log(`[${name}] closed`));
  return ws;
}
function recv(ws, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("recv timeout")), timeoutMs);
    ws.once("message", (data) => {
      clearTimeout(to);
      resolve(JSON.parse(data.toString()));
    });
  });
}

async function main() {
  // 1) mac 先连，hello，拿 assign code
  const mac = mkClient("mac");
  await new Promise((r) => mac.on("open", r));
  mac.send(JSON.stringify({ type: "hello", role: "mac" }));
  const assign = await recv(mac);
  console.log("[mac] <-", JSON.stringify(assign));
  if (assign.type !== "assign") throw new Error("期望 assign，实得 " + assign.type);
  const code = assign.code;

  // 2) phone 用该 code 配对（并行等两端 paired）
  const phone = mkClient("phone");
  await new Promise((r) => phone.on("open", r));
  const phoneP = recv(phone);
  const macP = recv(mac);
  phone.send(JSON.stringify({ type: "hello", role: "phone", code }));

  const phonePaired = await phoneP;
  console.log("[phone] <-", JSON.stringify(phonePaired));
  const macPaired = await macP;
  console.log("[mac]    <-", JSON.stringify(macPaired));

  // 3) 校验
  const ok =
    phonePaired.type === "paired" && phonePaired.peer === "mac" &&
    macPaired.type === "paired" && macPaired.peer === "phone";
  console.log(ok ? "\n✅ 配对联调通过" : "\n❌ 配对联调失败");

  // 4) 顺便验证：错误码（重复/错误码）
  const evil = mkClient("evil");
  await new Promise((r) => evil.on("open", r));
  evil.send(JSON.stringify({ type: "hello", role: "phone", code: "000000" }));
  const err = await recv(evil);
  console.log("[evil] <-", JSON.stringify(err));

  // 5) phone 下线，mac 应收 peer_gone
  phone.close();
  const gone = await recv(mac, 3000).catch(() => null);
  console.log("[mac] <- (phone gone)", gone ? JSON.stringify(gone) : "(无，超时)");

  mac.close();
  evil.close();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("联调异常：", e.message);
  process.exit(1);
});

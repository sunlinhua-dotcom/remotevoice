// ASR 协议联调脚本：直连豆包流式 ASR，发送 1.5s 合成 PCM，验证 framing 正确性。
// 用法：npm run e2e:asr   （等价于 node --import tsx scripts/e2e-asr.mjs）
//   本脚本直接引 ../src 的 .ts，需经 tsx 转译；用裸 node 会报 ERR_MODULE_NOT_FOUND。
//   期望：握手成功（不发错误帧），收到若干 partial / final 或"业务错误"（说明 framing 通了）。
//   若收到连接级 error（如鉴权失败），会明确报出，便于定位。
import "dotenv/config";
import { config } from "../src/config.js";
import { DoubaoAsrSession } from "../src/doubao-asr.js";

function makePcm(durationMs, sampleRate = 16000, freq = 220) {
  // 16-bit mono PCM：轻微正弦波 + 底噪（仅用于验证链路，识别结果不重要）
  const n = Math.round((durationMs / 1000) * sampleRate);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    let v = 0.12 * Math.sin((2 * Math.PI * freq * i) / sampleRate);
    v += 0.02 * (Math.random() * 2 - 1);
    v = Math.max(-1, Math.min(1, v));
    buf.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return buf;
}

async function main() {
  console.log("connecting", config.doubaoAsr.wssUrl);
  const session = new DoubaoAsrSession(
    config.doubaoAsr,
    { sampleRate: 16000, channels: 1, bits: 16 },
    {
      onPartial: (t) => console.log("[partial]", JSON.stringify(t)),
      onFinal: (t) => console.log("[final]", JSON.stringify(t)),
      onError: (e) => console.log("[error]", e.message),
      onClose: () => console.log("[closed]"),
    },
  );

  try {
    await session.startAudio();
    console.log("startAudio ok, streaming 1500ms PCM in 100ms chunks...");
    const chunk = makePcm(100);
    for (let i = 0; i < 15; i++) {
      session.feedAudio(chunk);
      await new Promise((r) => setTimeout(r, 60));
    }
    console.log("finishing...");
    session.finishAudio();
    // 等结果/关闭
    await new Promise((r) => setTimeout(r, 4000));
    session.close();
    console.log("done");
    process.exit(0);
  } catch (e) {
    console.error("ASR 联调失败：", e.message);
    process.exit(1);
  }
}

main();

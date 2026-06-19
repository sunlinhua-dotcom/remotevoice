// LLM 后处理联调脚本：
//   1) 未配置 ARK_API_KEY → 验证降级返回原文
//   2) 配置了 ARK_API_KEY → 真实调用 Ark，验证纠错/加标点
// 用法：npm run e2e:llm   （等价于 node --import tsx scripts/e2e-llm.mjs；本脚本引 ../src 的 .ts，需 tsx 转译）
//   验证真实调用：ARK_API_KEY=xxx npm run e2e:llm
import { config } from "../src/config.js";
import { DoubaoLlm } from "../src/doubao-llm.js";

const cases = [
  "你好世界",
  "我今天去超市买了苹果香蕉和橘子",   // 无标点
  "语音输入有时候会出现同音字错误比如认识成人次", // 含同音
];

async function main() {
  const llm = new DoubaoLlm(config.ark);
  console.log("ARK_API_KEY:", config.ark.apiKey ? "已配置" : "未配置（降级模式）");
  console.log("model:", config.ark.model);
  console.log("---");
  for (const raw of cases) {
    const r = await llm.postprocess(raw);
    console.log(`raw   : ${raw}`);
    console.log(`result: ${r.text}   (ok=${r.ok})`);
    console.log("---");
  }
  process.exit(0);
}
main();

import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") {
    throw new Error(`[config] 缺少环境变量 ${name}，请在 relay/.env 中设置`);
  }
  return v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`[config] ${name} 不是合法整数: ${v}`);
  return Math.trunc(n);
}

export const config = {
  port: int("PORT", 8787),
  webDir: process.env.WEB_DIR ?? "",

  doubaoAsr: {
    appId: required("DOUBAO_ASR_APP_ID"),
    accessToken: required("DOUBAO_ASR_ACCESS_TOKEN"),
    secretKey: process.env.DOUBAO_ASR_SECRET_KEY ?? "",
    wssUrl: process.env.DOUBAO_ASR_WSS_URL ?? "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel",
    // 大模型流式 ASR 资源 ID（1.0 时长模型）
    resourceId: process.env.DOUBAO_ASR_RESOURCE_ID ?? "volc.bigasr.sauc.duration",
  },

  ark: {
    apiKey: process.env.ARK_API_KEY ?? "",
    baseUrl: process.env.ARK_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3",
    model: process.env.ARK_MODEL ?? "doubao-seed-2-0-lite-260215",
  },

  pairCodeTtlMs: int("PAIR_CODE_TTL_MS", 5 * 60_000),
  maxSessionMs: int("MAX_SESSION_MS", 2 * 60_000),
};

export type AppConfig = typeof config;

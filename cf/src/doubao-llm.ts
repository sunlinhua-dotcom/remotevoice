// 火山方舟 Ark LLM 后处理（doubao-seed-2.0）—— Cloudflare Workers 版。
// 与 Node 版（relay/src/doubao-llm.ts）逻辑一致：补标点 + 纠错；未配 key 或失败则回退原文。
// 关键：doubao-seed-2.0 是推理模型，必须带 thinking:{type:"disabled"}，否则补标点也会
// 烧 2000+ reasoning tokens、延迟 30~50s，必撞超时回退（见 relay 版同处注释）。

export interface ArkConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export class DoubaoLlm {
  constructor(private cfg: ArkConfig) {}

  get enabled(): boolean {
    return (this.cfg.apiKey ?? "").trim().length > 0;
  }

  async postprocess(rawText: string): Promise<{ text: string; ok: boolean }> {
    if (!this.enabled) return { text: rawText, ok: false };
    const cleaned = rawText.trim();
    if (!cleaned) return { text: rawText, ok: true };

    const body = {
      model: this.cfg.model,
      messages: [
        {
          role: "system",
          content:
            "你是语音转写后处理助手。输入是语音识别的中文结果，可能缺标点或有同音错别字。" +
            "请：1) 补全合适的中文标点；2) 仅纠正明显错别字/同音误识，不要改写意思、不要增删内容；" +
            "3) 只输出处理后的纯文本，不要解释、不要引号。",
        },
        { role: "user", content: cleaned },
      ],
      temperature: 0.1,
      // 推理模型必须关思维链，否则延迟飙到 30~50s 必撞下面 8s 超时。
      thinking: { type: "disabled" },
      max_tokens: Math.max(64, cleaned.length * 2 + 64),
    };

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const resp = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) return { text: rawText, ok: false };
      const data = (await resp.json()) as any;
      const choice = data?.choices?.[0];
      const out: string = choice?.message?.content?.trim() ?? "";
      if (choice?.finish_reason === "length") return { text: rawText, ok: false };
      if (!out) return { text: rawText, ok: false };
      return { text: out, ok: true };
    } catch {
      return { text: rawText, ok: false };
    }
  }
}

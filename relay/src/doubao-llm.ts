import type { AppConfig } from "./config.js";

/**
 * 火山方舟 Ark LLM 后处理：doubao-seed-2-0-lite。
 * 用途：给 ASR 文本补全标点、纠正明显错别字/口误。
 *
 * 注意：Ark Key 与语音 Access Token 是两套凭证（见 .env.example）。
 * 若未配置 ARK_API_KEY 或调用失败，回退返回原文（不阻断主流程）。
 */
export class DoubaoLlm {
  constructor(private cfg: AppConfig["ark"]) {}

  get enabled(): boolean {
    return this.cfg.apiKey.trim().length > 0;
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
      // doubao-seed-2.0 是推理模型：默认开思维链，补标点这种琐事也会烧 1500~2400 reasoning
      // tokens、延迟飙到 30~50s（实测），必然撞上下面 8s 超时而回退原文。后处理是机械任务，
      // 关掉思维链：延迟降到 ~3s、reasoning_tokens=0，对实时注入是硬要求。
      thinking: { type: "disabled" },
      // 后处理会补中文标点（每个标点≈1 token），预算需留足，否则易触发 length 截断。
      max_tokens: Math.max(64, cleaned.length * 2 + 64),
    };

    try {
      const url = `${this.cfg.baseUrl}/chat/completions`;
      // 超时控制：避免 LLM 卡住阻塞文字注入（注入实时性优先于纠错）
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        return { text: rawText, ok: false };
      }
      const data = (await resp.json()) as any;
      const choice = data?.choices?.[0];
      const out: string = choice?.message?.content?.trim() ?? "";
      // 输出被 max_tokens 截断：宁可回退原文，也不注入半句。
      if (choice?.finish_reason === "length") return { text: rawText, ok: false };
      // 空输出（如 200 里带 error 体 / content 被过滤）：回退原文且标记 ok:false，
      // 让 server 下发给 mac 的 llm 标志真实反映“是否真做了后处理”。
      if (!out) return { text: rawText, ok: false };
      return { text: out, ok: true };
    } catch {
      // 超时/网络错误：降级返回原文
      return { text: rawText, ok: false };
    }
  }
}

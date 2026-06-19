// RemoteVoice 统一 Worker：同一个 origin 既托管手机 PWA（静态资产，自动服务），
// 又用 Durable Object 跑 WebSocket 中继（/ws）。因此 PWA 默认的同源 wss://host/ws
// 直接可用，无需在设置里手填中继地址。
//
// 路由：静态资产命中即返回；未命中才进到这里——把 /ws 与 /healthz 转给单例 DO。
import { RelayHub } from "./relay-hub";

export { RelayHub };

interface Env {
  RELAY_HUB: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws" || url.pathname === "/healthz") {
      const id = env.RELAY_HUB.idFromName("hub"); // 单例：所有连接落到同一个 DO
      return env.RELAY_HUB.get(id).fetch(request);
    }
    return new Response("not found", { status: 404 });
  },
};

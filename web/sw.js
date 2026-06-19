// Service Worker：离线壳 + 可安装 PWA。仅缓存 App Shell（静态资源）。
// 版本号每次发布需变更（sw.js 字节变化才会触发浏览器更新 SW）。
const CACHE = "remotevoice-v3";
const ASSETS = [
  "/", "/index.html", "/style.css", "/app.js", "/pcm-worker.js",
  "/manifest.json", "/icon.svg",
  "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png",
];

// 网络优先（导航 + 代码）：保证发布新版后客户端能拿到新代码，离线时回退缓存。
const NETWORK_FIRST = new Set(["/", "/index.html", "/app.js", "/pcm-worker.js"]);

self.addEventListener("install", (e) => {
  // addAll 对新增的图标若缺失会整体失败，故用逐个 add 容错。
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(ASSETS.map((a) => c.add(a))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 仅缓存校验通过（ok + 200 + basic）的同源响应，避免把瞬时 4xx/5xx 冻进缓存。
function cachePut(req, resp) {
  if (resp && resp.ok && resp.status === 200 && resp.type === "basic") {
    const copy = resp.clone();
    caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
  }
  return resp;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return; // WS / POST 不处理
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 跨源（含豆包/ARK）一律放行不缓存

  const isNav = req.mode === "navigate";
  const known = ASSETS.includes(url.pathname);
  if (!known && !isNav) return; // 不对任意同源 GET 做运行时缓存

  if (isNav || NETWORK_FIRST.has(url.pathname)) {
    // 网络优先：拿到新版即回填，离线时回退到缓存（导航回退到 index.html）。
    e.respondWith(
      fetch(req)
        .then((resp) => cachePut(req, resp))
        .catch(() => caches.match(req).then((hit) => hit || caches.match("/index.html"))),
    );
    return;
  }

  // 其余壳资源（css/icon/manifest）：缓存优先 + 受控回填。
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((resp) => cachePut(req, resp)).catch(() => hit)),
  );
});

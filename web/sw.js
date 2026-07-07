// C叉叉 Remote Service Worker
// 仅缓存静态壳（HTML/manifest/图标），让"添加到主屏幕"离线也能打开界面。
// 绝不缓存动态数据——会话内容走 WebSocket（不经 SW），故无需担心陈旧数据。
// 更新策略：导航请求 network-first（始终尝试拿最新 index.html），离线回退缓存。
const CACHE = "czr-shell-v4"; // v4：Claude 后端合并进 index（多 agent 切换器 + Claude 渲染），退休 preview
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // 只管同源静态资源

  // 页面导航：network-first，保证拿到最新版本；离线时回退缓存壳
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          caches.open(CACHE).then((c) => c.put("./index.html", res.clone())).catch(() => {});
          return res;
        })
        .catch(() => caches.match("./index.html").then((r) => r || caches.match("./"))),
    );
    return;
  }

  // 其他静态资源：cache-first（图标/manifest 很少变，SW 版本升级时整体刷新）
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
      }
      return res;
    }).catch(() => cached)),
  );
});

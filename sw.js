// Service Worker لـ Mandoob+ — يخزّن هيكل التطبيق للعمل عند انقطاع الاتصال.
// عند تعديل أي ملف في الواجهة غيّر رقم الإصدار أدناه ليتحدّث الكاش عند المستخدمين.
const CACHE = "mandoob-plus-v1";

const SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/lib.js",
  "/map.js",
  "/icon.svg",
  "/manifest.webmanifest",
  "/icons/icon-192x192.png",
  "/icons/icon-512x512.png",
  "/icons/icon-maskable-512x512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // لا نتدخل في الطلبات الخارجية (خرائط/CDN) ولا في الـ API والبثّ الحي (SSE) إطلاقًا.
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  // التنقّل بين الصفحات: الشبكة أولًا، وعند الانقطاع نعرض الصفحة المخزّنة (SPA).
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put("/index.html", copy)); }
          return res;
        })
        .catch(() => caches.match("/index.html").then((r) => r || caches.match("/")))
    );
    return;
  }

  // الملفات الثابتة: الشبكة أولًا (دائمًا أحدث نسخة) ثم الكاش عند الانقطاع.
  event.respondWith(
    fetch(request, { cache: "no-cache" })
      .then((res) => {
        if (res.ok && res.type === "basic") { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(request, copy)); }
        return res;
      })
      .catch(() => caches.match(request))
  );
});

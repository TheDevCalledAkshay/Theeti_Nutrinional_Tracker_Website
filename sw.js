/* Theeti service worker — offline support + PWA install.
   NOTE: bump the CACHE name whenever you change app files,
   so phones pick up the new version. */
const CACHE = "theeti-v1";
const ASSETS = [
  "./", "index.html", "styles.css", "app.js", "foods.js",
  "logo.svg", "manifest.webmanifest",
  "icon-192.png", "icon-512.png", "icon-maskable-512.png", "icon-apple-180.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  if (new URL(event.request.url).origin !== location.origin) return; // USDA API stays online

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          }
          return res;
        })
        .catch(() => cached); // offline fallback
      return cached || network;
    })
  );
});

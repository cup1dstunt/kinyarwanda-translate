"use strict";
// Service Worker nur für die App-Hülle; API-Aufrufe gehen immer ans Netz.
const CACHE = "shell-v26";
const SHELL = ["/", "/index.html", "/style.css", "/app.js", "/i18n.js", "/manifest.json", "/icon-192.png", "/phrases.json", "/dictionary.json"];

self.addEventListener("install", (e) => {
  // "reload": am Browser-Cache vorbei, damit keine alten Dateien in den neuen Cache geraten
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // Netz zuerst, damit Updates sofort ankommen; Cache nur als Rückfall (offline).
  e.respondWith(
    fetch(e.request.url, { cache: "no-cache" }) // immer beim Server nachfragen, nie alte Kopie aus dem Browser-Cache
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// Push-Mitteilung für eine neue Chat-Nachricht (iOS verlangt, dass jede sichtbar angezeigt wird)
self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { body: e.data ? e.data.text() : "" }; }
  const jobs = [self.registration.showNotification(data.title || "Ikiraro", {
    body: data.body || "", tag: data.chat || "chat", renotify: true,
    icon: "/icon-192.png", badge: "/favicon-32.png", data: { chat: data.chat || "" },
  })];
  if (self.navigator.setAppBadge && data.badge) jobs.push(self.navigator.setAppBadge(data.badge).catch(() => {}));
  e.waitUntil(Promise.all(jobs));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const chat = (e.notification.data && e.notification.data.chat) || "";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    const win = list[0];
    if (win) {
      win.postMessage({ chat });
      return win.focus();
    }
    return self.clients.openWindow("/" + (chat ? "?chat=" + encodeURIComponent(chat) : ""));
  }));
});

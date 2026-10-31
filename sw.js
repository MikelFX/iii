/* Service worker: aplikace funguje offline (po prvním načtení). */
const CACHE = 'imco-sklad-v4';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './db.js', './manifest.json', './icon.svg', './vendor/html5-qrcode.min.js', './vendor/supabase.js', './vendor/jsbarcode.all.min.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request))
  );
});

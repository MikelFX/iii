/* Service worker: aplikace funguje offline (po prvním načtení). */
const CACHE = 'imco-sklad-v5';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './db.js', './manifest.json', './icon.svg', './vendor/html5-qrcode.min.js', './vendor/supabase.js', './vendor/jsbarcode.all.min.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
/* Soubory aplikace: vždy nejdřív z internetu (bez zastaralé kopie z mezipaměti prohlížeče), offline z cache.
 * Požadavky na jiné servery (Supabase) se neukládají. */
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

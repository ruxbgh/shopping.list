// Mărește versiunea când modifici fișierele, ca telefoanele să ia varianta nouă.
const CACHE = 'lista-v8';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'config.js', 'manifest.json',
  'icon-192.png', 'icon-512.png', 'maskable-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Datele Firebase merg direct la rețea (sincronizarea are propriul mecanism offline)
  if (url.hostname.includes('firebaseio.com') || url.hostname.includes('firebasedatabase.app') ||
      url.hostname.includes('googleapis.com') && url.pathname.includes('identitytoolkit')) return;
  // Fișierele aplicației, fonturile și librăriile: răspuns din cache + actualizare în fundal
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: url.origin === location.origin });
    const net = fetch(e.request).then((r) => { if (r.ok || r.type === 'opaque') c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});

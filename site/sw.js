// Service worker: keeps the whole app on the phone so it opens with no data.
// __BUILD__ is replaced at deploy time, so each deploy installs a fresh copy.
const BUILD = '__BUILD__';
const APP_CACHE = 'sib-app-' + BUILD;
const RUNTIME = 'sib-runtime-' + BUILD;

const CORE = [
  './', 'index.html', 'manifest.webmanifest',
  'css/app.css',
  'js/app.js', 'js/data.js', 'js/sync.js', 'js/map.js', 'js/icons.js',
  'vendor/libs.js', 'vendor/maplibre-gl.css',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];
const FONT_STACKS = ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic'];
const FONT_RANGES = ['0-255', '256-511', '8192-8447'];
const OPTIONAL = [
  'version.json',
  'vendor/sprites/v4/light.json', 'vendor/sprites/v4/light.png',
  'vendor/sprites/v4/light@2x.json', 'vendor/sprites/v4/light@2x.png',
  ...FONT_STACKS.flatMap((f) => FONT_RANGES.map((r) => `vendor/fonts/${encodeURIComponent(f)}/${r}.pbf`)),
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    await cache.addAll(CORE);
    await Promise.all(OPTIONAL.map((u) => cache.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([APP_CACHE, RUNTIME, 'sib-offline-map']);
    for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Firebase etc. handle their own offline behaviour
  if (url.pathname.endsWith('.pmtiles') || req.headers.has('range')) return; // map file: handled by the app
  if (url.pathname.endsWith('.pdf')) return;

  if (url.pathname.endsWith('version.json')) {
    event.respondWith(fetch(req).then((res) => { const c = res.clone(); caches.open(APP_CACHE).then((x) => x.put(req, c)); return res; }).catch(() => caches.match(req)));
    return;
  }

  event.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const shell = await caches.match('index.html');
      try { return await fetch(req); } catch { if (shell) return shell; throw new Error('offline'); }
    }
    const res = await fetch(req);
    if (res.ok) { const c = res.clone(); caches.open(RUNTIME).then((x) => x.put(req, c)); }
    return res;
  })());
});

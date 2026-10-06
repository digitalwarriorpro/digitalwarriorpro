// Offline support: the app shell and libraries are cached on install; map tiles are cached
// as reps view them, so a street they've looked at once still shows with no signal.
const VERSION = "knock-v23";
const SHELL = [
  "./", "index.html", "styles.css", "manifest.webmanifest", "icon-32.png", "icon-180.png", "icon-192.png", "icon-512.png",
  "js/main.js", "js/config.js", "js/store.js", "js/sync.js", "js/addresses.js", "js/property.js", "js/county.js", "js/vehicles.js", "js/storms.js", "js/roof.js",
  "vendor/leaflet/leaflet.css", "vendor/leaflet/leaflet.js", "vendor/supabase.js", "vendor/591.supabase.js",
];
const TILE_CACHE = "knock-tiles";
const MAX_TILES = 3000;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: "reload" })).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION && k !== TILE_CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Never cache API traffic (Supabase, address lookups)
  if (/supabase\.co$/.test(url.hostname) || /overpass|nominatim|regrid|mesonet|jocogov|jacksongov|wycokck|nhtsa/.test(url.hostname) || /\/arcgis\/rest\//.test(url.pathname)) return;

  if (/tile|basemaps|maptiler|stadiamaps|mapbox/.test(url.hostname) || /\/\d+\/\d+\/\d+(@2x)?\.(png|jpg|webp|pbf)/.test(url.pathname)) {
    e.respondWith(tile(req));
    return;
  }
  // App files: network first so updates land, cache when offline
  if (url.origin === location.origin) {
    e.respondWith(fetch(req).then((res) => { const copy = res.clone(); if (res.ok) caches.open(VERSION).then((c) => c.put(req, copy)); return res; }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match("index.html"))));
    return;
  }
  // Fonts: cache first
  e.respondWith(caches.match(req).then((r) => r || fetch(req).then((res) => { const copy = res.clone(); if (res.ok) caches.open(VERSION).then((c) => c.put(req, copy)); return res; })).catch(() => Response.error()));
});

async function tile(req) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) {
      cache.put(req, res.clone());
      trim(cache);
    }
    return res;
  } catch {
    return new Response("", { status: 504 });
  }
}
let trimming = false;
async function trim(cache) {
  if (trimming) return; trimming = true;
  try {
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
  } finally { trimming = false; }
}

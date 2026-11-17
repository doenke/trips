// Trips service worker. Network first (4 s timeout), cache only as fallback; silent updates.
const VERSION = '__VERSION__';
const CACHE = `trips-${VERSION}`;
const SHELL = ['/', /*__FILES__*/];
const TIMEOUT_MS = 4000;

// Never cached: login, OAuth, MCP, calendar feeds, health.
const NEVER = [/^\/auth\//, /^\/oauth\//, /^\/mcp/, /^\/ics\//, /^\/healthz/, /^\/\.well-known\//];
// API answers kept for offline reading.
const API_CACHED = [/^\/api\/me$/, /^\/api\/users$/, /^\/api\/trips(\?|$)/, /^\/api\/trips\/[^/]+$/, /^\/api\/attachments\/[^/]+$/];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => Promise.all(SHELL.map((url) => c.add(new Request(url, { cache: 'reload' })).catch(() => undefined))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('trips-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (r) => {
        clearTimeout(t);
        resolve(r);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function networkFirst(request, cacheKey) {
  const cache = await caches.open(CACHE);
  const network = fetch(request).then((response) => {
    if (response.ok && response.type === 'basic') cache.put(cacheKey, response.clone());
    return response;
  });
  try {
    return await withTimeout(network, TIMEOUT_MS);
  } catch {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    return network; // slow but no copy: keep waiting for the network
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  if (NEVER.some((re) => re.test(path))) return;

  if (path.startsWith('/api/')) {
    if (!API_CACHED.some((re) => re.test(path + url.search) || re.test(path))) return;
    event.respondWith(networkFirst(request, request.url));
    return;
  }
  if (request.mode === 'navigate') {
    // Every page of the app is index.html; offline fallback is the cached shell.
    event.respondWith(
      networkFirst(request, new URL('/', self.location.origin).href).catch(async () => (await caches.match('/')) || Response.error()),
    );
    return;
  }
  event.respondWith(networkFirst(request, request.url));
});

// The app asks to keep documents of upcoming trips offline, and to forget everything on logout.
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'precache' && Array.isArray(data.urls)) {
    event.waitUntil(
      caches.open(CACHE).then((cache) =>
        Promise.all(
          data.urls
            .filter((u) => typeof u === 'string' && u.startsWith('/api/attachments/'))
            .map(async (u) => {
              if (await cache.match(new URL(u, self.location.origin).href)) return;
              const r = await fetch(u, { credentials: 'same-origin' }).catch(() => null);
              if (r && r.ok) await cache.put(new URL(u, self.location.origin).href, r);
            }),
        ),
      ),
    );
  }
  if (data.type === 'logout') {
    event.waitUntil(
      caches.open(CACHE).then(async (cache) => {
        for (const req of await cache.keys()) if (new URL(req.url).pathname.startsWith('/api/')) await cache.delete(req);
      }),
    );
  }
});

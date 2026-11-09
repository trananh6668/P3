/**
 * Service Worker cho ứng dụng Cờ Tướng (Xiangqi WASM):
 *  1. Khi cài đặt (install): đọc `precache-manifest.json` do Vite sinh lúc build
 *     và lưu toàn bộ tài nguyên tĩnh (HTML, JS, CSS, stockfish.js, stockfish.wasm,
 *     stockfish.worker.js) vào Cache Storage -> chạy 100% OFFLINE sau lần mở đầu.
 *  2. Khi phục vụ request (fetch): ưu tiên lấy từ Cache (Cache-First cho tài nguyên tĩnh),
 *     đồng thời gắn đầy đủ header COOP/COEP (`Cross-Origin-Opener-Policy: same-origin`,
 *     `Cross-Origin-Embedder-Policy: require-corp`) để kích hoạt `SharedArrayBuffer`
 *     cho Fairy-Stockfish WASM Pthreads ngay cả trên các static host tĩnh.
 */

const CACHE_PREFIX = 'xiangqi-wasm-cache-';
let currentCacheName = `${CACHE_PREFIX}v1`;

function withIsolationHeaders(response, method = 'GET') {
  if (!response || response.status === 0 || response.type === 'opaque') {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  const nullBodyStatus = response.status === 101 || response.status === 204 || response.status === 205 || response.status === 304;
  return new Response(method === 'HEAD' || nullBodyStatus ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function precacheAll() {
  try {
    const manifestUrl = new URL('./precache-manifest.json', self.registration.scope).href;
    const res = await fetch(manifestUrl, { cache: 'no-cache' });
    if (!res.ok) return;
    const manifest = await res.json();
    if (manifest && typeof manifest.build === 'string') {
      currentCacheName = `${CACHE_PREFIX}${manifest.build}`;
    }
    const keys = await caches.keys();
    await Promise.all(
      keys.map((key) => {
        if (key.startsWith(CACHE_PREFIX) && key !== currentCacheName) {
          return caches.delete(key);
        }
        return Promise.resolve(false);
      }),
    );
    const cache = await caches.open(currentCacheName);
    const files = Array.isArray(manifest?.files) ? manifest.files : [];
    const urls = files.map((f) => new URL(f, self.registration.scope).href);
    await cache.addAll(urls);
  } catch {
    // Nếu đang offline ngay lúc cài đặt thì bỏ qua bước precache
  }
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      await precacheAll();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' && request.method !== 'HEAD') return;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cached = await caches.match(request, { ignoreSearch: false });
      if (cached) {
        return withIsolationHeaders(cached, request.method);
      }
      try {
        const networkResponse = await fetch(request);
        if (request.method === 'GET' && networkResponse && networkResponse.ok) {
          const cache = await caches.open(currentCacheName);
          cache.put(request, networkResponse.clone()).catch(() => {});
        }
        return withIsolationHeaders(networkResponse, request.method);
      } catch {
        const fallbackIndex = await caches.match(new URL('./index.html', self.registration.scope).href);
        if (fallbackIndex) return withIsolationHeaders(fallbackIndex, request.method);
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      }
    })(),
  );
});

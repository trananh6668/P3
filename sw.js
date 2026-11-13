// BUILD_ID: mwegbchv
const CACHE_PREFIX = 'xiangqi-wasm-cache-';
const SW_BUILD_ID = 'mwegbchv';
let currentCacheName = `${CACHE_PREFIX}${SW_BUILD_ID}`;

function withIsolationHeaders(response, method = 'GET') {
  if (!response || response.status === 0 || response.type === 'opaque') {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  const nullBodyStatus =
    response.status === 101 ||
    response.status === 204 ||
    response.status === 205 ||
    response.status === 304;
  return new Response(method === 'HEAD' || nullBodyStatus ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function precacheAll() {
  try {
    const manifestUrl = new URL(`./precache-manifest.json?t=${Date.now()}`, self.registration.scope).href;
    const res = await fetch(manifestUrl, { cache: 'no-store' });
    if (!res.ok) return;
    const manifest = await res.json();
    if (manifest && typeof manifest.build === 'string') {
      currentCacheName = `${CACHE_PREFIX}${manifest.build}`;
    }

    // Xóa toàn bộ cache của các bản build cũ
    const keys = await caches.keys();
    await Promise.all(
      keys.map((key) => {
        if (key.startsWith(CACHE_PREFIX) && key !== currentCacheName) {
          return caches.delete(key);
        }
        return Promise.resolve(false);
      }),
    );

    // Tải mới toàn bộ file của bản build hiện tại (bỏ qua bộ nhớ đệm trình duyệt)
    const cache = await caches.open(currentCacheName);
    const files = Array.isArray(manifest?.files) ? manifest.files : [];
    await Promise.all(
      files.map(async (f) => {
        const url = new URL(f, self.registration.scope).href;
        try {
          const response = await fetch(url, { cache: 'reload' });
          if (response.ok) {
            await cache.put(url, response);
          }
        } catch {
          // Bỏ qua từng file lẻ nếu lỗi mạng tạm thời
        }
      }),
    );
  } catch {
    // Nếu đang offline ngay lúc cài đặt thì bỏ qua bước precache
  }
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(precacheAll());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Dọn dẹp lại các cache cũ
      const keys = await caches.keys();
      await Promise.all(
        keys.map((key) => {
          if (key.startsWith(CACHE_PREFIX) && key !== currentCacheName) {
            return caches.delete(key);
          }
          return Promise.resolve(false);
        }),
      );
      await self.clients.claim();

      // Báo cho các tab đang mở biết có phiên bản mới để tự reload
      const clientsList = await self.clients.matchAll({ type: 'window' });
      for (const client of clientsList) {
        client.postMessage({ type: 'SW_UPDATED', buildId: SW_BUILD_ID });
      }
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' && request.method !== 'HEAD') return;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Không cache file sw.js và precache-manifest.json để luôn kiểm tra bản mới
  if (url.pathname.endsWith('/sw.js') || url.pathname.endsWith('/precache-manifest.json')) {
    event.respondWith(
      fetch(request, { cache: 'no-store' }).then((res) => withIsolationHeaders(res, request.method))
    );
    return;
  }

  const isHTMLNavigation =
    request.mode === 'navigate' ||
    url.pathname.endsWith('/') ||
    url.pathname.endsWith('/index.html');

  // Với file index.html: Ưu tiên lấy từ mạng (Network-First) để luôn nhận code mới nhất
  if (isHTMLNavigation) {
    event.respondWith(
      (async () => {
        try {
          const networkResponse = await fetch(request, { cache: 'no-store' });
          if (networkResponse && networkResponse.ok) {
            const cache = await caches.open(currentCacheName);
            cache.put(request, networkResponse.clone()).catch(() => {});
            return withIsolationHeaders(networkResponse, request.method);
          }
        } catch {
          // Mất mạng -> dùng bản trong cache
        }
        const cached =
          (await caches.match(request, { ignoreSearch: true })) ||
          (await caches.match(new URL('./index.html', self.registration.scope).href));
        if (cached) return withIsolationHeaders(cached, request.method);
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      })(),
    );
    return;
  }

  // Với các tài nguyên tĩnh khác (JS, CSS, WASM): Cache-First
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
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      }
    })(),
  );
});
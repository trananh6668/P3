import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Fairy-Stockfish WASM được build với pthreads => cần SharedArrayBuffer
 * => trang phải ở trạng thái "cross-origin isolated" (COOP + COEP).
 */
const crossOriginIsolationHeaders: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const BUILD_ID = Date.now().toString(36);

function listFilesRecursive(dir: string, base = dir): string[] {
  let out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      out = out.concat(listFilesRecursive(full, base));
    } else {
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return out;
}

/**
 * Sinh precache-manifest.json chứa TOÀN BỘ file đầu ra (JS/CSS/worker/WASM/public)
 * để Service Worker cache trước => ứng dụng chạy offline 100% sau lần tải đầu.
 */
function precacheManifestPlugin(): Plugin {
  let publicDir = '';
  return {
    name: 'xiangqi-precache-manifest',
    apply: 'build',
    configResolved(config) {
      publicDir = config.publicDir;
    },
    generateBundle(_options, bundle) {
      const files = new Set<string>(['./', 'index.html']);
      for (const fileName of Object.keys(bundle)) {
        if (!fileName.endsWith('.map')) files.add(fileName);
      }
      if (publicDir) {
        try {
          for (const f of listFilesRecursive(publicDir)) {
            if (!f.startsWith('.') && f !== 'sw.js' && !f.endsWith('.txt') && f !== 'engine/AUTHORS') files.add(f);
          }
        } catch {
          // publicDir không tồn tại -> bỏ qua
        }
      }
      this.emitFile({
        type: 'asset',
        fileName: 'precache-manifest.json',
        source: JSON.stringify({ build: BUILD_ID, files: [...files] }, null, 2),
      });
    },
  };
}

export default defineConfig({
  // Đường dẫn tương đối => bản build chạy được ở bất kỳ thư mục con nào của web server.
  base: '/P3/', // <-- Thêm tên repository vào đây
  plugins: [react(), tailwindcss(), precacheManifestPlugin()],
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  server: {
    headers: crossOriginIsolationHeaders,
  },
  preview: {
    headers: crossOriginIsolationHeaders,
  },
  worker: {
    // Worker được bundle dạng ES module (khớp với new Worker(..., { type: 'module' })).
    format: 'es',
  },
  build: {
    target: 'es2022',
    // Không inline asset thành base64 -> giữ file .wasm/.js tách riêng, dễ cache.
    assetsInlineLimit: 0,
    sourcemap: false,
  },
});

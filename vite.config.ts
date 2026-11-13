import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readdirSync, statSync, readFileSync } from 'node:fs';
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
 * Sinh precache-manifest.json và tự động bơm BUILD_ID vào sw.js lúc build
 * để trình duyệt luôn nhận diện được Service Worker mới khi đẩy lên GitHub.
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
            if (!f.startsWith('.') && f !== 'sw.js' && !f.endsWith('.txt') && f !== 'engine/AUTHORS') {
              files.add(f);
            }
          }
          // Đọc public/sw.js và gắn BUILD_ID mới vào đầu file để đổi hash mỗi lần build
          const swPath = path.join(publicDir, 'sw.js');
          const swContent = readFileSync(swPath, 'utf-8');
          const injectedSw = `// BUILD_ID: ${BUILD_ID}\n` + swContent.replace(/__SW_BUILD_ID__/g, BUILD_ID);
          this.emitFile({
            type: 'asset',
            fileName: 'sw.js',
            source: injectedSw,
          });
        } catch {
          // publicDir hoặc sw.js không tồn tại -> bỏ qua
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
  base: './',
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
    format: 'es',
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    sourcemap: false,
  },
});
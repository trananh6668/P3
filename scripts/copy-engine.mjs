// Sao chép các file engine Fairy-Stockfish (JS glue + WASM + pthread worker)
// từ node_modules sang public/engine để Vite phục vụ dưới dạng tài nguyên tĩnh.
// Chạy tự động ở postinstall / predev / prebuild.
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetDir = path.join(root, 'public', 'engine');
const FILES = ['stockfish.js', 'stockfish.wasm', 'stockfish.worker.js', 'Copying.txt', 'AUTHORS'];

function resolvePackageDir() {
  const require = createRequire(import.meta.url);
  try {
    return path.dirname(require.resolve('fairy-stockfish-nnue.wasm/package.json'));
  } catch {
    const guess = path.join(root, 'node_modules', 'fairy-stockfish-nnue.wasm');
    return existsSync(guess) ? guess : null;
  }
}

const sourceDir = resolvePackageDir();
if (!sourceDir) {
  const alreadyThere = FILES.slice(0, 3).every((f) => existsSync(path.join(targetDir, f)));
  if (alreadyThere) {
    console.warn('[copy-engine] Không tìm thấy package fairy-stockfish-nnue.wasm, dùng file sẵn có trong public/engine.');
    process.exit(0);
  }
  console.error('[copy-engine] Thiếu package "fairy-stockfish-nnue.wasm". Hãy chạy: npm install');
  process.exit(1);
}

mkdirSync(targetDir, { recursive: true });
let copied = 0;
for (const file of FILES) {
  const src = path.join(sourceDir, file);
  const dst = path.join(targetDir, file);
  if (!existsSync(src)) {
    if (file.endsWith('.js') || file.endsWith('.wasm')) {
      console.error(`[copy-engine] Package thiếu file bắt buộc: ${file}`);
      process.exit(1);
    }
    continue;
  }
  if (existsSync(dst) && statSync(dst).size === statSync(src).size && statSync(dst).mtimeMs >= statSync(src).mtimeMs) {
    continue;
  }
  copyFileSync(src, dst);
  copied += 1;
}
console.log(`[copy-engine] public/engine sẵn sàng (${copied} file được cập nhật).`);

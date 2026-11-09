import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// Đăng ký Service Worker khi build production để:
//  1) Gắn header COOP/COEP kích hoạt SharedArrayBuffer trên static host (như GitHub Pages).
//  2) Cache toàn bộ tài nguyên (stockfish.wasm, stockfish.js, stockfish.worker.js) để chạy 100% offline.
const COI_RELOAD_KEY = 'xiangqi-coi-reloaded';

async function bootstrap(): Promise<void> {
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    const swUrl = `${import.meta.env.BASE_URL}sw.js`;
    if (window.crossOriginIsolated) {
      sessionStorage.removeItem(COI_RELOAD_KEY);
      navigator.serviceWorker.register(swUrl).catch(() => {});
    } else if (!sessionStorage.getItem(COI_RELOAD_KEY)) {
      try {
        const reg = await navigator.serviceWorker.register(swUrl);
        await new Promise<void>((resolve) => {
          const timeout = window.setTimeout(resolve, 4000);
          const triggerReload = () => {
            window.clearTimeout(timeout);
            sessionStorage.setItem(COI_RELOAD_KEY, '1');
            window.location.reload();
          };
          if (navigator.serviceWorker.controller || reg.active) {
            triggerReload();
            return;
          }
          navigator.serviceWorker.addEventListener('controllerchange', triggerReload, { once: true });
        });
      } catch {
        // Nếu trình duyệt chặn Service Worker (ví dụ chế độ ẩn danh đặc biệt) thì tiếp tục mở với engine dự phòng
      }
    }
  }

  const rootElement = document.getElementById('root');
  if (!rootElement) {
    throw new Error('Không tìm thấy phần tử #root trong index.html');
  }

  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void bootstrap();

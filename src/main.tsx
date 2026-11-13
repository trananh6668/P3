import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

declare const __BUILD_ID__: string;

const COI_RELOAD_KEY = 'xiangqi-coi-reloaded';
const STORAGE_VERSION_KEY = 'xiangqi-build-version';

function syncBuildVersionStorage(): void {
  try {
    const savedVersion = localStorage.getItem(STORAGE_VERSION_KEY);
    if (savedVersion !== __BUILD_ID__) {
      const coiFlag = sessionStorage.getItem(COI_RELOAD_KEY);
      localStorage.clear();
      sessionStorage.clear();
      if (coiFlag) {
        sessionStorage.setItem(COI_RELOAD_KEY, coiFlag);
      }
      localStorage.setItem(STORAGE_VERSION_KEY, __BUILD_ID__);
    }
  } catch {
    // Bỏ qua nếu trình duyệt chặn Storage
  }
}

async function bootstrap(): Promise<void> {
  syncBuildVersionStorage();

  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    const swUrl = `${import.meta.env.BASE_URL}sw.js`;

    let isRefreshing = false;
    const reloadOnUpdate = () => {
      if (!isRefreshing) {
        isRefreshing = true;
        window.location.reload();
      }
    };

    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'SW_UPDATED') {
        reloadOnUpdate();
      }
    });

    if (window.crossOriginIsolated) {
      sessionStorage.removeItem(COI_RELOAD_KEY);
      navigator.serviceWorker.addEventListener('controllerchange', reloadOnUpdate);

      navigator.serviceWorker
        .register(swUrl, { updateViaCache: 'none' })
        .then((reg) => {
          reg.update().catch(() => {});
        })
        .catch(() => {});
    } else if (!sessionStorage.getItem(COI_RELOAD_KEY)) {
      try {
        const reg = await navigator.serviceWorker.register(swUrl, { updateViaCache: 'none' });
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
        // Tiếp tục mở với engine dự phòng nếu trình duyệt chặn Service Worker
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
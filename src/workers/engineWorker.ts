/**
 * engineWorker.ts — Web Worker chịu trách nhiệm:
 *   1. Nạp Fairy-Stockfish WebAssembly (pthreads + SIMD) từ thư mục tĩnh /engine/.
 *   2. Bắt tay giao thức UCI: uci -> uciok, setoption ..., isready -> readyok.
 *   3. Nhận lệnh từ Main Thread (go / stop / newgame), chuyển thành lệnh UCI text.
 *   4. Parse output engine (info / bestmove) và gửi dữ liệu có cấu trúc về UI.
 *   5. Nếu WASM thất bại ở BẤT KỲ bước nào -> tự động chuyển sang engine JS dự phòng.
 *
 * Toàn bộ tính toán diễn ra ngoài Main Thread nên UI không bao giờ bị chặn.
 */
import { FallbackEngine } from '../engine/fallbackEngine';
import { parseEngineLine } from '../lib/uciParser';
import type {
  EngineBackend,
  EngineInitConfig,
  EngineStatus,
  SearchRequest,
  UciEngineAdapter,
  WorkerRequest,
  WorkerResponse,
} from '../types/xiangqi';

// ───────────────────────── Kiểu dữ liệu của module Emscripten ─────────────────────────

interface StockfishModule {
  postMessage(command: string): void;
  addMessageListener(listener: (line: string) => void): void;
  removeMessageListener(listener: (line: string) => void): void;
  terminate?: () => void;
}

interface StockfishModuleOptions {
  locateFile: (path: string, prefix: string) => string;
  mainScriptUrlOrBlob: string;
  onAbort?: (reason: unknown) => void;
}

type StockfishFactory = (options: StockfishModuleOptions) => Promise<StockfishModule>;

/** Phạm vi toàn cục tối thiểu của Dedicated Worker (tránh xung đột lib DOM/WebWorker). */
interface WorkerScope {
  postMessage(message: WorkerResponse): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerRequest>) => void): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  addEventListener(type: 'unhandledrejection', listener: (event: PromiseRejectionEvent) => void): void;
  close(): void;
  crossOriginIsolated?: boolean;
  Stockfish?: StockfishFactory;
}

const ctx = self as unknown as WorkerScope;

class EngineLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineLoadError';
  }
}

// ───────────────────────── Trạng thái Worker ─────────────────────────

let engine: UciEngineAdapter | null = null;
let backend: EngineBackend | null = null;
let status: EngineStatus = 'idle';
let initPromise: Promise<void> | null = null;
/** Hàng đợi searchId đang chờ `bestmove` — engine UCI luôn trả bestmove theo đúng thứ tự lệnh go. */
const pendingSearches: number[] = [];

interface LineWaiter {
  predicate: (line: string) => boolean;
  resolve: (line: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
let lineWaiters: LineWaiter[] = [];

function post(message: WorkerResponse): void {
  ctx.postMessage(message);
}

function log(direction: 'send' | 'recv' | 'system', line: string): void {
  post({ type: 'log', direction, line });
}

function setStatus(next: EngineStatus, message: string, engineName: string | null = engine?.name ?? null): void {
  status = next;
  post({ type: 'status', status: next, backend, engineName, message });
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function sendToEngine(command: string): void {
  if (!engine) throw new Error('Engine chưa được khởi tạo');
  log('send', command);
  engine.send(command);
}

function rejectAllWaiters(reason: string): void {
  const waiters = lineWaiters;
  lineWaiters = [];
  for (const w of waiters) {
    clearTimeout(w.timer);
    w.reject(new EngineLoadError(reason));
  }
}

function waitForLine(predicate: (line: string) => boolean, timeoutMs: number, label: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const waiter: LineWaiter = {
      predicate,
      resolve,
      reject,
      timer: setTimeout(() => {
        lineWaiters = lineWaiters.filter((w) => w !== waiter);
        reject(new EngineLoadError(`Hết thời gian chờ "${label}" (${Math.round(timeoutMs / 1000)}s).`));
      }, timeoutMs),
    };
    lineWaiters.push(waiter);
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new EngineLoadError(`Hết thời gian chờ: ${label}`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Xử lý từng dòng output của engine (dùng chung cho WASM và JS). */
function handleEngineLine(rawLine: string): void {
  const line = rawLine.trim();
  if (!line) return;

  if (!line.includes(' currmove ')) log('recv', line);

  // Giải phóng các promise đang chờ (uciok / readyok ...)
  if (lineWaiters.length > 0) {
    const remaining: LineWaiter[] = [];
    for (const w of lineWaiters) {
      if (w.predicate(line)) {
        clearTimeout(w.timer);
        w.resolve(line);
      } else {
        remaining.push(w);
      }
    }
    lineWaiters = remaining;
  }

  const parsed = parseEngineLine(line);
  switch (parsed.type) {
    case 'info': {
      const searchId = pendingSearches[0];
      if (searchId === undefined) return;
      const { info } = parsed;
      if (info.depth > 0 && (info.score !== undefined || info.pv.length > 0)) {
        post({ type: 'info', searchId, info });
      }
      break;
    }
    case 'bestmove': {
      const searchId = pendingSearches.shift();
      if (searchId === undefined) return;
      post({ type: 'bestmove', searchId, bestmove: parsed.bestmove, ponder: parsed.ponder });
      break;
    }
    default:
      break;
  }
}

/** Gắn listener có "khoá" theo instance để output từ engine cũ (đã huỷ) không lọt vào. */
function attachEngine(instance: UciEngineAdapter): void {
  engine = instance;
  instance.setListener((line) => {
    if (engine === instance) handleEngineLine(line);
  });
}

function disposeEngine(): void {
  const old = engine;
  engine = null;
  backend = null;
  pendingSearches.length = 0;
  rejectAllWaiters('Engine đã bị huỷ');
  if (old) {
    try {
      old.terminate();
    } catch {
      // bỏ qua lỗi khi huỷ
    }
  }
}

// ───────────────────────── Kiểm tra năng lực trình duyệt ─────────────────────────

/** Module WASM nhỏ nhất dùng lệnh SIMD (v128) — dùng để phát hiện hỗ trợ WASM SIMD. */
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

function checkWasmCapabilities(): void {
  if (typeof WebAssembly !== 'object' || typeof WebAssembly.instantiate !== 'function') {
    throw new EngineLoadError('Trình duyệt không hỗ trợ WebAssembly.');
  }
  if (typeof SharedArrayBuffer === 'undefined') {
    throw new EngineLoadError(
      'SharedArrayBuffer không khả dụng — trang chưa được "cross-origin isolated" (thiếu header COOP/COEP hoặc không chạy trên HTTPS/localhost).',
    );
  }
  if (ctx.crossOriginIsolated === false) {
    throw new EngineLoadError('Trang chưa được cross-origin isolated (cần COOP: same-origin và COEP: require-corp).');
  }
  try {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    if (!(memory.buffer instanceof SharedArrayBuffer)) {
      throw new Error('buffer không phải SharedArrayBuffer');
    }
  } catch (err) {
    throw new EngineLoadError(`Trình duyệt không hỗ trợ WebAssembly Threads: ${errorMessage(err)}`);
  }
  let simd = false;
  try {
    simd = WebAssembly.validate(SIMD_PROBE);
  } catch {
    simd = false;
  }
  if (!simd) throw new EngineLoadError('Trình duyệt không hỗ trợ WebAssembly SIMD (cần Chrome 91+, Firefox 89+, Safari 16.4+).');
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) throw new EngineLoadError(`Hết thời gian tải ${url}`);
    throw new EngineLoadError(`Không tải được ${url}: ${errorMessage(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

// ───────────────────────── Nạp Fairy-Stockfish WASM ─────────────────────────

async function loadWasmEngine(config: EngineInitConfig): Promise<UciEngineAdapter> {
  checkWasmCapabilities();

  const base = config.engineBaseUrl.endsWith('/') ? config.engineBaseUrl : `${config.engineBaseUrl}/`;
  const scriptUrl = new URL('stockfish.js', base).href;
  const wasmUrl = new URL('stockfish.wasm', base).href;
  const pthreadUrl = new URL('stockfish.worker.js', base).href;

  log('system', `Kiểm tra tài nguyên engine tại ${base}`);

  // 1) Kiểm tra trước file .wasm và pthread worker có tồn tại (tránh lỗi khó hiểu từ Emscripten)
  for (const [url, label] of [
    [wasmUrl, 'stockfish.wasm'],
    [pthreadUrl, 'stockfish.worker.js'],
  ] as const) {
    const head = await fetchWithTimeout(url, { method: 'HEAD', cache: 'no-cache' }, config.stepTimeoutMs);
    if (!head.ok && head.status !== 405) {
      throw new EngineLoadError(`Thiếu file ${label} (HTTP ${head.status}). Hãy đặt file vào public/engine/.`);
    }
    const type = head.headers.get('content-type') ?? '';
    if (type.includes('text/html')) {
      throw new EngineLoadError(`Server trả về HTML thay vì ${label} — file không tồn tại trong public/engine/.`);
    }
  }

  // 2) Tải glue code Emscripten. Worker là ES module nên không dùng được importScripts();
  //    ta tải text rồi đánh giá ở phạm vi toàn cục bằng indirect eval.
  const res = await fetchWithTimeout(scriptUrl, { cache: 'no-cache' }, config.stepTimeoutMs);
  if (!res.ok) throw new EngineLoadError(`Không tải được stockfish.js (HTTP ${res.status}).`);
  const code = await res.text();
  if (!code.includes('Stockfish')) {
    throw new EngineLoadError('stockfish.js không hợp lệ (có thể server trả về index.html).');
  }
  try {
    (0, eval)(`${code}\n;self.Stockfish = Stockfish;\n//# sourceURL=${scriptUrl}`);
  } catch (err) {
    throw new EngineLoadError(`Lỗi khi thực thi stockfish.js: ${errorMessage(err)}`);
  }
  const factory = ctx.Stockfish;
  if (typeof factory !== 'function') throw new EngineLoadError('Không tìm thấy hàm khởi tạo Stockfish trong stockfish.js.');

  // 3) Khởi tạo module Emscripten. locateFile trỏ .wasm & pthread worker về /engine/.
  let abortReason: string | null = null;
  const modulePromise = factory({
    locateFile: (path: string) => new URL(path, base).href,
    mainScriptUrlOrBlob: scriptUrl,
    onAbort: (reason: unknown) => {
      abortReason = errorMessage(reason);
      log('system', `WASM abort: ${abortReason}`);
      if (backend === 'wasm' && status === 'ready') {
        // Engine đã chạy rồi mới crash (ví dụ hết bộ nhớ) -> báo lỗi nghiêm trọng để UI khởi động lại.
        rejectAllWaiters(`WASM abort: ${abortReason}`);
        status = 'error';
        post({ type: 'error', message: `Engine WASM bị dừng đột ngột: ${abortReason}`, fatal: true });
      }
    },
  });
  let module: StockfishModule;
  try {
    module = await withTimeout(modulePromise, config.stepTimeoutMs * 2, 'khởi tạo Fairy-Stockfish WASM');
  } catch (err) {
    throw new EngineLoadError(`Khởi tạo WASM thất bại: ${abortReason ?? errorMessage(err)}`);
  }
  if (typeof module.postMessage !== 'function' || typeof module.addMessageListener !== 'function') {
    throw new EngineLoadError('Module WASM không cung cấp API postMessage/addMessageListener.');
  }

  let currentListener: ((line: string) => void) | null = null;
  return {
    name: 'Fairy-Stockfish (WebAssembly)',
    send: (command: string) => module.postMessage(command),
    setListener: (listener: (line: string) => void) => {
      if (currentListener) module.removeMessageListener(currentListener);
      currentListener = listener;
      module.addMessageListener(listener);
    },
    terminate: () => {
      try {
        module.postMessage('quit');
      } catch {
        // engine có thể đã dừng
      }
      try {
        if (currentListener) module.removeMessageListener(currentListener);
        module.terminate?.();
      } catch {
        // bỏ qua
      }
    },
  };
}

/** Bắt tay UCI chuẩn: uci -> uciok -> setoption -> isready -> readyok. */
async function handshake(config: EngineInitConfig, isWasm: boolean): Promise<void> {
  const uciok = waitForLine((l) => l === 'uciok', config.stepTimeoutMs, 'uciok');
  sendToEngine('uci');
  await uciok;

  if (isWasm) {
    sendToEngine('setoption name UCI_Variant value xiangqi');
    sendToEngine(`setoption name Threads value ${Math.max(1, Math.min(8, Math.floor(config.threads)))}`);
    sendToEngine(`setoption name Hash value ${Math.max(8, Math.min(512, Math.floor(config.hashMb)))}`);
  }

  const readyok = waitForLine((l) => l === 'readyok', config.stepTimeoutMs, 'readyok');
  sendToEngine('isready');
  await readyok;
}

async function initialize(config: EngineInitConfig): Promise<void> {
  disposeEngine();
  setStatus('loading', config.forceFallback ? 'Đang khởi động engine JS…' : 'Đang tải Fairy-Stockfish WebAssembly…', null);

  let wasmFailure: string | null = config.forceFallback ? 'Người dùng chọn engine JS.' : null;

  if (!config.forceFallback) {
    try {
      const wasm = await loadWasmEngine(config);
      attachEngine(wasm);
      backend = 'wasm';
      await handshake(config, true);
      setStatus('ready', `Fairy-Stockfish WASM sẵn sàng (${config.threads} luồng, Hash ${config.hashMb}MB).`);
      return;
    } catch (err) {
      wasmFailure = errorMessage(err);
      log('system', `Không dùng được WASM: ${wasmFailure}`);
      post({ type: 'error', message: `Không nạp được engine WASM: ${wasmFailure}`, fatal: false });
      disposeEngine();
    }
  }

  try {
    attachEngine(new FallbackEngine());
    backend = 'fallback';
    await handshake(config, false);
    setStatus('ready', `Đang dùng engine JS dự phòng. Lý do: ${wasmFailure ?? 'không rõ'}`);
  } catch (err) {
    disposeEngine();
    setStatus('error', `Không khởi động được engine nào: ${errorMessage(err)}`, null);
    throw err;
  }
}

// ───────────────────────── Lệnh từ Main Thread ─────────────────────────

function validateSearch(request: SearchRequest): string | null {
  if (!Number.isInteger(request.searchId)) return 'searchId không hợp lệ';
  if (!Number.isInteger(request.depth) || request.depth < 1 || request.depth > 64) return 'depth phải trong khoảng 1..64';
  if (typeof request.fen !== 'string' || request.fen.split('/').length !== 10) return 'FEN không hợp lệ';
  if (!Array.isArray(request.moves) || request.moves.some((m) => !/^[a-i](?:10|[1-9])[a-i](?:10|[1-9])$/.test(m))) {
    return 'Danh sách nước đi không hợp lệ';
  }
  return null;
}

async function handleGo(request: SearchRequest): Promise<void> {
  if (initPromise) {
    try {
      await initPromise;
    } catch {
      // trạng thái lỗi đã được báo
    }
  }
  if (!engine || status !== 'ready') {
    post({ type: 'error', message: 'Engine chưa sẵn sàng, không thể tính nước.', fatal: false });
    post({ type: 'bestmove', searchId: request.searchId, bestmove: null, ponder: null });
    return;
  }
  const problem = validateSearch(request);
  if (problem) {
    post({ type: 'error', message: `Yêu cầu tính toán bị từ chối: ${problem}`, fatal: false });
    post({ type: 'bestmove', searchId: request.searchId, bestmove: null, ponder: null });
    return;
  }
  // Nếu còn lượt tìm kiếm cũ đang chạy: dừng ngay; bestmove của nó sẽ bị UI bỏ qua theo searchId.
  if (pendingSearches.length > 0) sendToEngine('stop');
  pendingSearches.push(request.searchId);
  const movesPart = request.moves.length > 0 ? ` moves ${request.moves.join(' ')}` : '';
  sendToEngine(`position fen ${request.fen}${movesPart}`);
  if (backend === 'fallback') {
    sendToEngine(`go depth ${request.depth} movetime ${Math.max(100, Math.floor(request.fallbackMoveTimeMs))}`);
  } else {
    sendToEngine(`go depth ${request.depth}`);
  }
}

function handleMessage(message: WorkerRequest): void {
  try {
    switch (message.type) {
      case 'init':
        initPromise = initialize(message.config);
        initPromise.catch((err: unknown) => {
          post({ type: 'error', message: errorMessage(err), fatal: true });
        });
        break;
      case 'go':
        void handleGo(message.request).catch((err: unknown) => {
          post({ type: 'error', message: `Lỗi khi gửi lệnh go: ${errorMessage(err)}`, fatal: false });
        });
        break;
      case 'stop':
        if (engine && pendingSearches.length > 0) sendToEngine('stop');
        break;
      case 'newgame':
        if (engine && status === 'ready') {
          if (pendingSearches.length > 0) sendToEngine('stop');
          sendToEngine('ucinewgame');
        }
        break;
      case 'quit':
        disposeEngine();
        ctx.close();
        break;
      default: {
        const unknownType: never = message;
        post({ type: 'error', message: `Thông điệp không xác định: ${JSON.stringify(unknownType)}`, fatal: false });
      }
    }
  } catch (err) {
    post({ type: 'error', message: errorMessage(err), fatal: false });
  }
}

ctx.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const data = event.data;
  if (!data || typeof data !== 'object' || typeof (data as { type?: unknown }).type !== 'string') {
    post({ type: 'error', message: 'Worker nhận thông điệp sai định dạng.', fatal: false });
    return;
  }
  handleMessage(data);
});

ctx.addEventListener('error', (event: ErrorEvent) => {
  post({ type: 'error', message: `Lỗi trong Worker: ${event.message}`, fatal: false });
});

ctx.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  post({ type: 'error', message: `Promise bị từ chối trong Worker: ${errorMessage(event.reason)}`, fatal: false });
});

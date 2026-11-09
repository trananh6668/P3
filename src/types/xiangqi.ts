/**
 * Kiểu dữ liệu dùng chung cho toàn bộ ứng dụng Cờ Tướng:
 *  - Bàn cờ / quân cờ / nước đi
 *  - Mức độ khó
 *  - Giao thức UCI/UCCI giữa Main Thread <-> Web Worker <-> Engine
 */

// ───────────────────────────── Bàn cờ ─────────────────────────────

/** 'w' = Đỏ (đi trước), 'b' = Đen. Giữ đúng ký hiệu của chuỗi FEN. */
export type Side = 'w' | 'b';

/**
 * Loại quân theo ký hiệu FEN (chữ thường):
 * k = Tướng, a = Sĩ, b = Tượng, n = Mã, r = Xe, c = Pháo, p = Tốt
 */
export type PieceKind = 'k' | 'a' | 'b' | 'n' | 'r' | 'c' | 'p';

export interface Piece {
  side: Side;
  kind: PieceKind;
}

/**
 * Ô trên bàn cờ: 0..89, sq = row * 9 + col.
 * row 0 là hàng trên cùng (hàng cuối của Đen, rank 10 trong UCI),
 * row 9 là hàng dưới cùng (hàng cuối của Đỏ, rank 1 trong UCI).
 * col 0 tương ứng file 'a' trong UCI.
 */
export type Square = number;

/**
 * Nước đi mã hoá dạng số nguyên để engine JS chạy nhanh:
 * move = from | (to << 8)
 */
export type EncodedMove = number;

/** Nước đi dạng chuỗi UCI của Fairy-Stockfish, ví dụ "h3e3", "b10c8". */
export type UciMove = string;

export interface MoveDetail {
  from: Square;
  to: Square;
  uci: UciMove;
  /** Mã quân bị ăn (0 nếu không ăn quân). */
  captured: number;
}

export type GameEndReason =
  | 'checkmate'
  | 'stalemate'
  | 'repetition'
  | 'move-limit'
  | 'insufficient-material';

export interface GameStatus {
  over: boolean;
  winner: Side | null;
  reason: GameEndReason | null;
  inCheck: boolean;
}

// ───────────────────────────── Mức độ khó ─────────────────────────────

export type DifficultyId = 'beginner' | 'club' | 'master' | 'grandmaster';

export interface DifficultyLevel {
  id: DifficultyId;
  label: string;
  subtitle: string;
  depth: number;
  expectedTime: string;
  /**
   * Giới hạn thời gian (ms) chỉ áp dụng cho engine JS dự phòng
   * (engine WASM chạy thuần `go depth N`).
   */
  fallbackMoveTimeMs: number;
}

// ───────────────────────────── Giao thức UCI/UCCI ─────────────────────────────

/** Các lệnh UCI được gửi tới engine (chuẩn UCI, tương thích tinh thần UCCI). */
export type UciCommand =
  | 'uci'
  | 'isready'
  | 'ucinewgame'
  | 'stop'
  | 'quit'
  | `setoption name ${string} value ${string}`
  | `position fen ${string}`
  | `position startpos${string}`
  | `go depth ${number}`
  | `go depth ${number} movetime ${number}`;

export type EngineScore =
  | { type: 'cp'; value: number }
  | { type: 'mate'; value: number };

/** Kết quả parse một dòng `info ...` từ engine. */
export interface EngineInfo {
  depth: number;
  seldepth?: number;
  multipv?: number;
  score?: EngineScore;
  bound?: 'lower' | 'upper';
  nodes?: number;
  nps?: number;
  time?: number;
  hashfull?: number;
  pv: UciMove[];
}

/** Các loại dòng output engine đã được parse. */
export type ParsedEngineLine =
  | { type: 'id'; key: 'name' | 'author'; value: string }
  | { type: 'uciok' }
  | { type: 'readyok' }
  | { type: 'option'; raw: string }
  | { type: 'info'; info: EngineInfo }
  | { type: 'info-string'; text: string }
  | { type: 'bestmove'; bestmove: UciMove | null; ponder: UciMove | null }
  | { type: 'unknown'; raw: string };

/**
 * Adapter chung cho mọi engine nói giao thức UCI dạng text
 * (Fairy-Stockfish WASM hoặc engine JS dự phòng).
 */
export interface UciEngineAdapter {
  readonly name: string;
  send(command: string): void;
  setListener(listener: (line: string) => void): void;
  terminate(): void;
}

export type EngineBackend = 'wasm' | 'fallback';
export type EngineStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface EngineInitConfig {
  /** URL tuyệt đối tới thư mục chứa stockfish.js / stockfish.wasm / stockfish.worker.js */
  engineBaseUrl: string;
  threads: number;
  hashMb: number;
  /** Thời gian chờ tối đa cho từng bước khởi động (tải file, uciok, readyok). */
  stepTimeoutMs: number;
  /** Bỏ qua WASM, dùng thẳng engine JS dự phòng. */
  forceFallback: boolean;
}

export interface SearchRequest {
  searchId: number;
  fen: string;
  moves: UciMove[];
  depth: number;
  fallbackMoveTimeMs: number;
}

/** Main Thread -> Worker */
export type WorkerRequest =
  | { type: 'init'; config: EngineInitConfig }
  | { type: 'go'; request: SearchRequest }
  | { type: 'stop' }
  | { type: 'newgame' }
  | { type: 'quit' };

/** Worker -> Main Thread */
export type WorkerResponse =
  | {
      type: 'status';
      status: EngineStatus;
      backend: EngineBackend | null;
      engineName: string | null;
      message: string;
    }
  | { type: 'info'; searchId: number; info: EngineInfo }
  | { type: 'bestmove'; searchId: number; bestmove: UciMove | null; ponder: UciMove | null }
  | { type: 'log'; direction: 'send' | 'recv' | 'system'; line: string }
  | { type: 'error'; message: string; fatal: boolean };

// ───────────────────────────── Trạng thái phân tích hiển thị ─────────────────────────────

export interface AnalysisState {
  searchId: number;
  purpose: SearchPurpose;
  depth: number;
  seldepth: number | null;
  /** Điểm đã quy đổi về góc nhìn của bên Đỏ (dương = Đỏ ưu). */
  scoreRed: EngineScore | null;
  bound: 'lower' | 'upper' | null;
  nodes: number | null;
  nps: number | null;
  timeMs: number | null;
  pv: UciMove[];
  pvNotation: string[];
}

export type SearchPurpose = 'play' | 'hint';

export interface EngineLogEntry {
  id: number;
  direction: 'send' | 'recv' | 'system';
  line: string;
}

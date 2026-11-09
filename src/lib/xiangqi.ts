/**
 * Lõi luật Cờ Tướng (dùng chung cho UI và engine JS dự phòng).
 *
 * Biểu diễn:
 *  - board: Int8Array(90), sq = row * 9 + col, row 0 = hàng trên (phía Đen).
 *  - Quân Đỏ mang mã dương, quân Đen mang mã âm:
 *      1 Tướng, 2 Sĩ, 3 Tượng, 4 Mã, 5 Xe, 6 Pháo, 7 Tốt
 *  - Nước đi mã hoá: from | (to << 8)
 *  - Zobrist hash 2 x 32-bit (hash + lock) cập nhật tăng dần.
 */
import type {
  EncodedMove,
  GameStatus,
  MoveDetail,
  Piece,
  PieceKind,
  Side,
  Square,
  UciMove,
} from '../types/xiangqi';

export const ROWS = 10;
export const COLS = 9;
export const BOARD_SIZE = 90;
export const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';

export const KING = 1;
export const ADVISOR = 2;
export const ELEPHANT = 3;
export const HORSE = 4;
export const ROOK = 5;
export const CANNON = 6;
export const PAWN = 7;

const KIND_TO_CODE: Record<PieceKind, number> = { k: KING, a: ADVISOR, b: ELEPHANT, n: HORSE, r: ROOK, c: CANNON, p: PAWN };
const CODE_TO_KIND: readonly (PieceKind | '')[] = ['', 'k', 'a', 'b', 'n', 'r', 'c', 'p'];
/** Bí danh ký hiệu theo chuẩn UCCI/WXF: h = Mã, e = Tượng. */
const FEN_ALIASES: Record<string, PieceKind> = { h: 'n', e: 'b' };

export const RED_NAMES: Record<PieceKind, string> = { k: '帥', a: '仕', b: '相', n: '傌', r: '俥', c: '炮', p: '兵' };
export const BLACK_NAMES: Record<PieceKind, string> = { k: '將', a: '士', b: '象', n: '馬', r: '車', c: '砲', p: '卒' };
export const VIETNAMESE_NAMES: Record<PieceKind, string> = { k: 'Tướng', a: 'Sĩ', b: 'Tượng', n: 'Mã', r: 'Xe', c: 'Pháo', p: 'Tốt' };

export class FenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FenError';
  }
}

// ───────────────────────────── Tiện ích ô / nước đi ─────────────────────────────

export const rowOf = (sq: Square): number => (sq / 9) | 0;
export const colOf = (sq: Square): number => sq % 9;
export const toSquare = (row: number, col: number): Square => row * 9 + col;
export const inBoard = (row: number, col: number): boolean => row >= 0 && row < ROWS && col >= 0 && col < COLS;

export const encodeMove = (from: Square, to: Square): EncodedMove => from | (to << 8);
export const moveFrom = (m: EncodedMove): Square => m & 0xff;
export const moveTo = (m: EncodedMove): Square => (m >> 8) & 0xff;

export const opposite = (side: Side): Side => (side === 'w' ? 'b' : 'w');
export const sideOfCode = (code: number): Side | null => (code > 0 ? 'w' : code < 0 ? 'b' : null);

export function codeToPiece(code: number): Piece | null {
  if (code === 0) return null;
  const kind = CODE_TO_KIND[Math.abs(code)];
  if (!kind) return null;
  return { side: code > 0 ? 'w' : 'b', kind };
}

export function pieceToCode(piece: Piece): number {
  const code = KIND_TO_CODE[piece.kind];
  return piece.side === 'w' ? code : -code;
}

export function squareToUci(sq: Square): string {
  return String.fromCharCode(97 + colOf(sq)) + String(10 - rowOf(sq));
}

/** Parse "e3" / "b10" -> Square, trả về null nếu sai định dạng. */
export function uciToSquare(text: string): Square | null {
  const m = /^([a-i])(10|[1-9])$/.exec(text);
  if (!m) return null;
  const col = m[1].charCodeAt(0) - 97;
  const row = 10 - Number(m[2]);
  return toSquare(row, col);
}

export function moveToUci(m: EncodedMove): UciMove {
  return squareToUci(moveFrom(m)) + squareToUci(moveTo(m));
}

/** Tách chuỗi UCI thành from/to (chưa kiểm tra tính hợp lệ theo luật). */
export function parseUciMove(uci: string): { from: Square; to: Square } | null {
  const m = /^([a-i](?:10|[1-9]))([a-i](?:10|[1-9]))$/.exec(uci.trim());
  if (!m) return null;
  const from = uciToSquare(m[1]);
  const to = uciToSquare(m[2]);
  if (from === null || to === null || from === to) return null;
  return { from, to };
}

// ───────────────────────────── Zobrist ─────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) | 0;
  };
}

const ZOBRIST_HASH = new Int32Array(15 * BOARD_SIZE);
const ZOBRIST_LOCK = new Int32Array(15 * BOARD_SIZE);
let ZOBRIST_SIDE_HASH = 0;
let ZOBRIST_SIDE_LOCK = 0;
(() => {
  const rnd = mulberry32(0x5eed1234);
  for (let i = 0; i < ZOBRIST_HASH.length; i++) {
    ZOBRIST_HASH[i] = rnd();
    ZOBRIST_LOCK[i] = rnd();
  }
  ZOBRIST_SIDE_HASH = rnd();
  ZOBRIST_SIDE_LOCK = rnd();
})();

const zIndex = (code: number, sq: Square): number => (code + 7) * BOARD_SIZE + sq;

// ───────────────────────────── Hình học quân cờ ─────────────────────────────

const ORTHO: readonly (readonly [number, number])[] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const DIAG: readonly (readonly [number, number])[] = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
/** Vị trí con Mã (tương đối so với ô bị tấn công). */
const HORSE_ATTACKER_OFFSETS: readonly (readonly [number, number])[] = [
  [-2, -1], [-2, 1], [2, -1], [2, 1], [-1, -2], [1, -2], [-1, 2], [1, 2],
];

const inPalace = (side: Side, row: number, col: number): boolean =>
  col >= 3 && col <= 5 && (side === 'w' ? row >= 7 && row <= 9 : row >= 0 && row <= 2);

const ownHalf = (side: Side, row: number): boolean => (side === 'w' ? row >= 5 : row <= 4);

interface UndoRecord {
  move: EncodedMove;
  captured: number;
  halfmove: number;
  hash: number;
  lock: number;
}

// ───────────────────────────── Position ─────────────────────────────

export class Position {
  board: Int8Array;
  turn: Side;
  halfmove: number;
  fullmove: number;
  /** [ô Tướng Đỏ, ô Tướng Đen] */
  kingSq: [number, number];
  hash: number;
  lock: number;
  private undoStack: UndoRecord[] = [];

  private constructor(board: Int8Array, turn: Side, halfmove: number, fullmove: number) {
    this.board = board;
    this.turn = turn;
    this.halfmove = halfmove;
    this.fullmove = fullmove;
    this.kingSq = [-1, -1];
    for (let sq = 0; sq < BOARD_SIZE; sq++) {
      if (board[sq] === KING) this.kingSq[0] = sq;
      else if (board[sq] === -KING) this.kingSq[1] = sq;
    }
    this.hash = 0;
    this.lock = 0;
    this.recomputeHash();
  }

  static start(): Position {
    return Position.fromFen(START_FEN);
  }

  /**
   * Parse FEN Cờ Tướng. Chấp nhận cả ký hiệu UCCI (h/e) lẫn Fairy-Stockfish (n/b).
   * Ném FenError với thông báo tiếng Việt nếu không hợp lệ.
   */
  static fromFen(fenInput: string): Position {
    const fen = fenInput.trim().replace(/\s+/g, ' ');
    if (!fen) throw new FenError('Chuỗi FEN rỗng.');
    const parts = fen.split(' ');
    const placement = parts[0];
    const rows = placement.split('/');
    if (rows.length !== ROWS) {
      throw new FenError(`FEN phải có đúng 10 hàng (hiện có ${rows.length}).`);
    }
    const board = new Int8Array(BOARD_SIZE);
    const counts = new Map<number, number>();
    for (let r = 0; r < ROWS; r++) {
      let c = 0;
      for (const ch of rows[r]) {
        if (ch >= '1' && ch <= '9') {
          c += Number(ch);
          continue;
        }
        const lower = ch.toLowerCase();
        const kind = (FEN_ALIASES[lower] ?? lower) as PieceKind;
        if (!(kind in KIND_TO_CODE)) {
          throw new FenError(`Ký tự quân cờ không hợp lệ "${ch}" ở hàng ${r + 1}.`);
        }
        if (c >= COLS) throw new FenError(`Hàng ${r + 1} có quá 9 cột.`);
        const side: Side = ch === lower ? 'b' : 'w';
        const code = side === 'w' ? KIND_TO_CODE[kind] : -KIND_TO_CODE[kind];
        board[toSquare(r, c)] = code;
        counts.set(code, (counts.get(code) ?? 0) + 1);
        c += 1;
      }
      if (c !== COLS) throw new FenError(`Hàng ${r + 1} có ${c} cột, cần đúng 9 cột.`);
    }

    const turnText = (parts[1] ?? 'w').toLowerCase();
    let turn: Side;
    if (turnText === 'w' || turnText === 'r') turn = 'w';
    else if (turnText === 'b') turn = 'b';
    else throw new FenError(`Lượt đi "${parts[1]}" không hợp lệ (dùng w hoặc b).`);

    // Định dạng FEN Cờ Tướng: <placement> <side> - - <halfmove> <fullmove>
    const halfmove = Number.parseInt(parts[4] ?? '0', 10);
    const fullmove = Number.parseInt(parts[5] ?? '1', 10);

    const limits: Record<PieceKind, number> = { k: 1, a: 2, b: 2, n: 2, r: 2, c: 2, p: 5 };
    for (const side of ['w', 'b'] as const) {
      for (const kind of Object.keys(limits) as PieceKind[]) {
        const code = side === 'w' ? KIND_TO_CODE[kind] : -KIND_TO_CODE[kind];
        const n = counts.get(code) ?? 0;
        const label = `${VIETNAMESE_NAMES[kind]} ${side === 'w' ? 'Đỏ' : 'Đen'}`;
        if (kind === 'k' && n !== 1) throw new FenError(`Phải có đúng 1 ${label} (hiện có ${n}).`);
        if (n > limits[kind]) throw new FenError(`Quá nhiều quân ${label}: ${n} > ${limits[kind]}.`);
      }
    }

    for (let sq = 0; sq < BOARD_SIZE; sq++) {
      const code = board[sq];
      if (code === 0) continue;
      const side: Side = code > 0 ? 'w' : 'b';
      const kind = Math.abs(code);
      const r = rowOf(sq);
      const c = colOf(sq);
      const where = squareToUci(sq);
      if ((kind === KING || kind === ADVISOR) && !inPalace(side, r, c)) {
        throw new FenError(`${kind === KING ? 'Tướng' : 'Sĩ'} ở ${where} nằm ngoài Cửu Cung.`);
      }
      if (kind === ADVISOR && (r + c) % 2 !== (side === 'w' ? 0 : 1)) {
        throw new FenError(`Sĩ ở ${where} không nằm trên đường chéo Cửu Cung.`);
      }
      if (kind === ELEPHANT && !ownHalf(side, r)) {
        throw new FenError(`Tượng ở ${where} không được qua sông.`);
      }
      if (kind === PAWN) {
        const behindStart = side === 'w' ? r > 6 : r < 3;
        if (behindStart) throw new FenError(`Tốt ở ${where} nằm sau vị trí xuất phát.`);
      }
    }

    const pos = new Position(
      board,
      turn,
      Number.isFinite(halfmove) && halfmove >= 0 ? halfmove : 0,
      Number.isFinite(fullmove) && fullmove >= 1 ? fullmove : 1,
    );
    if (pos.kingsFacing()) {
      throw new FenError('Hai Tướng đối mặt trực tiếp (lộ mặt Tướng) — thế cờ không hợp lệ.');
    }
    if (pos.isAttacked(pos.kingSq[turn === 'w' ? 1 : 0], turn)) {
      throw new FenError('Bên không đến lượt đang bị chiếu — thế cờ không hợp lệ.');
    }
    return pos;
  }

  clone(): Position {
    const p = new Position(new Int8Array(this.board), this.turn, this.halfmove, this.fullmove);
    return p;
  }

  toFen(): string {
    const rows: string[] = [];
    for (let r = 0; r < ROWS; r++) {
      let s = '';
      let empty = 0;
      for (let c = 0; c < COLS; c++) {
        const code = this.board[toSquare(r, c)];
        if (code === 0) {
          empty += 1;
          continue;
        }
        if (empty) {
          s += String(empty);
          empty = 0;
        }
        const kind = CODE_TO_KIND[Math.abs(code)];
        s += code > 0 ? kind.toUpperCase() : kind;
      }
      if (empty) s += String(empty);
      rows.push(s);
    }
    return `${rows.join('/')} ${this.turn} - - ${this.halfmove} ${this.fullmove}`;
  }

  pieceAt(sq: Square): Piece | null {
    return codeToPiece(this.board[sq]);
  }

  recomputeHash(): void {
    let h = 0;
    let l = 0;
    for (let sq = 0; sq < BOARD_SIZE; sq++) {
      const code = this.board[sq];
      if (code !== 0) {
        h ^= ZOBRIST_HASH[zIndex(code, sq)];
        l ^= ZOBRIST_LOCK[zIndex(code, sq)];
      }
    }
    if (this.turn === 'b') {
      h ^= ZOBRIST_SIDE_HASH;
      l ^= ZOBRIST_SIDE_LOCK;
    }
    this.hash = h;
    this.lock = l;
  }

  /** Hai Tướng cùng cột và không có quân nào chắn giữa. */
  kingsFacing(): boolean {
    const [rk, bk] = this.kingSq;
    if (rk < 0 || bk < 0 || colOf(rk) !== colOf(bk)) return false;
    for (let sq = bk + 9; sq < rk; sq += 9) {
      if (this.board[sq] !== 0) return false;
    }
    return true;
  }

  /** Ô `sq` có bị bên `by` tấn công hay không (bao gồm luật lộ mặt Tướng). */
  isAttacked(sq: Square, by: Side): boolean {
    if (sq < 0) return false;
    const b = this.board;
    const s = by === 'w' ? 1 : -1;
    const r = rowOf(sq);
    const c = colOf(sq);

    // Xe / Tướng đối mặt / Pháo theo 4 hướng thẳng
    for (const [dr, dc] of ORTHO) {
      let nr = r + dr;
      let nc = c + dc;
      let screen = false;
      while (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) {
        const p = b[nr * 9 + nc];
        if (p !== 0) {
          if (!screen) {
            if (p === s * ROOK) return true;
            if (p === s * KING && dc === 0) return true;
            screen = true;
          } else {
            if (p === s * CANNON) return true;
            break;
          }
        }
        nr += dr;
        nc += dc;
      }
    }

    // Mã (kiểm tra chân Mã)
    for (const [dr, dc] of HORSE_ATTACKER_OFFSETS) {
      const hr = r + dr;
      const hc = c + dc;
      if (hr < 0 || hr >= ROWS || hc < 0 || hc >= COLS) continue;
      if (b[hr * 9 + hc] !== s * HORSE) continue;
      // Chân Mã nằm cạnh con Mã theo hướng đi dài
      const lr = Math.abs(dr) === 2 ? hr - dr / 2 : hr;
      const lc = Math.abs(dc) === 2 ? hc - dc / 2 : hc;
      if (b[lr * 9 + lc] === 0) return true;
    }

    // Tốt
    if (s === 1) {
      if (r + 1 < ROWS && b[(r + 1) * 9 + c] === PAWN) return true;
      if (r <= 4) {
        if (c > 0 && b[r * 9 + c - 1] === PAWN) return true;
        if (c < 8 && b[r * 9 + c + 1] === PAWN) return true;
      }
    } else {
      if (r - 1 >= 0 && b[(r - 1) * 9 + c] === -PAWN) return true;
      if (r >= 5) {
        if (c > 0 && b[r * 9 + c - 1] === -PAWN) return true;
        if (c < 8 && b[r * 9 + c + 1] === -PAWN) return true;
      }
    }

    // Tướng đứng cạnh (theo hàng ngang) — chỉ xảy ra trong Cửu Cung
    for (const [dr, dc] of ORTHO) {
      if (dr !== 0) continue;
      const nr = r;
      const nc = c + dc;
      if (nc >= 0 && nc < COLS && b[nr * 9 + nc] === s * KING) return true;
    }
    return false;
  }

  inCheck(side: Side = this.turn): boolean {
    return this.isAttacked(this.kingSq[side === 'w' ? 0 : 1], opposite(side));
  }

  /** Sinh nước đi giả hợp lệ (chưa kiểm tra tự chiếu) cho bên đang đi. */
  generatePseudoMoves(out: EncodedMove[], capturesOnly = false): void {
    const b = this.board;
    const side = this.turn;
    const sign = side === 'w' ? 1 : -1;

    const push = (from: number, to: number): void => {
      const t = b[to];
      if (t === 0) {
        if (!capturesOnly) out.push(from | (to << 8));
      } else if (t * sign < 0) {
        out.push(from | (to << 8));
      }
    };

    for (let sq = 0; sq < BOARD_SIZE; sq++) {
      const p = b[sq] * sign;
      if (p <= 0) continue;
      const r = (sq / 9) | 0;
      const c = sq - r * 9;
      switch (p) {
        case KING:
          for (const [dr, dc] of ORTHO) {
            const nr = r + dr;
            const nc = c + dc;
            if (inPalace(side, nr, nc)) push(sq, nr * 9 + nc);
          }
          break;
        case ADVISOR:
          for (const [dr, dc] of DIAG) {
            const nr = r + dr;
            const nc = c + dc;
            if (inPalace(side, nr, nc)) push(sq, nr * 9 + nc);
          }
          break;
        case ELEPHANT:
          for (const [dr, dc] of DIAG) {
            const nr = r + 2 * dr;
            const nc = c + 2 * dc;
            if (!inBoard(nr, nc) || !ownHalf(side, nr)) continue;
            if (b[(r + dr) * 9 + (c + dc)] !== 0) continue; // cản mắt Tượng
            push(sq, nr * 9 + nc);
          }
          break;
        case HORSE:
          for (const [dr, dc] of ORTHO) {
            const lr = r + dr;
            const lc = c + dc;
            if (!inBoard(lr, lc) || b[lr * 9 + lc] !== 0) continue; // cản chân Mã
            if (dr !== 0) {
              const nr = r + 2 * dr;
              if (nr < 0 || nr >= ROWS) continue;
              if (c - 1 >= 0) push(sq, nr * 9 + c - 1);
              if (c + 1 < COLS) push(sq, nr * 9 + c + 1);
            } else {
              const nc = c + 2 * dc;
              if (nc < 0 || nc >= COLS) continue;
              if (r - 1 >= 0) push(sq, (r - 1) * 9 + nc);
              if (r + 1 < ROWS) push(sq, (r + 1) * 9 + nc);
            }
          }
          break;
        case ROOK:
          for (const [dr, dc] of ORTHO) {
            let nr = r + dr;
            let nc = c + dc;
            while (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) {
              const to = nr * 9 + nc;
              const t = b[to];
              if (t === 0) {
                if (!capturesOnly) out.push(sq | (to << 8));
              } else {
                if (t * sign < 0) out.push(sq | (to << 8));
                break;
              }
              nr += dr;
              nc += dc;
            }
          }
          break;
        case CANNON:
          for (const [dr, dc] of ORTHO) {
            let nr = r + dr;
            let nc = c + dc;
            let screen = false;
            while (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) {
              const to = nr * 9 + nc;
              const t = b[to];
              if (!screen) {
                if (t === 0) {
                  if (!capturesOnly) out.push(sq | (to << 8));
                } else {
                  screen = true;
                }
              } else if (t !== 0) {
                if (t * sign < 0) out.push(sq | (to << 8));
                break;
              }
              nr += dr;
              nc += dc;
            }
          }
          break;
        case PAWN: {
          const fr = r - sign; // Đỏ tiến lên (row giảm), Đen tiến xuống
          if (fr >= 0 && fr < ROWS) push(sq, fr * 9 + c);
          const crossed = side === 'w' ? r <= 4 : r >= 5;
          if (crossed) {
            if (c > 0) push(sq, r * 9 + c - 1);
            if (c < 8) push(sq, r * 9 + c + 1);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  /** Thực hiện nước đi (không kiểm tra hợp lệ). Trả về mã quân bị ăn. */
  makeMove(m: EncodedMove): number {
    const from = m & 0xff;
    const to = (m >> 8) & 0xff;
    const b = this.board;
    const piece = b[from];
    const captured = b[to];
    this.undoStack.push({ move: m, captured, halfmove: this.halfmove, hash: this.hash, lock: this.lock });

    this.hash ^= ZOBRIST_HASH[zIndex(piece, from)] ^ ZOBRIST_HASH[zIndex(piece, to)] ^ ZOBRIST_SIDE_HASH;
    this.lock ^= ZOBRIST_LOCK[zIndex(piece, from)] ^ ZOBRIST_LOCK[zIndex(piece, to)] ^ ZOBRIST_SIDE_LOCK;
    if (captured !== 0) {
      this.hash ^= ZOBRIST_HASH[zIndex(captured, to)];
      this.lock ^= ZOBRIST_LOCK[zIndex(captured, to)];
    }

    b[to] = piece;
    b[from] = 0;
    if (piece === KING) this.kingSq[0] = to;
    else if (piece === -KING) this.kingSq[1] = to;
    if (captured === KING) this.kingSq[0] = -1;
    else if (captured === -KING) this.kingSq[1] = -1;

    this.halfmove = captured !== 0 ? 0 : this.halfmove + 1;
    if (this.turn === 'b') this.fullmove += 1;
    this.turn = this.turn === 'w' ? 'b' : 'w';
    return captured;
  }

  unmakeMove(): void {
    const rec = this.undoStack.pop();
    if (!rec) throw new Error('unmakeMove: không còn nước để hoàn tác');
    const from = rec.move & 0xff;
    const to = (rec.move >> 8) & 0xff;
    const b = this.board;
    const piece = b[to];
    b[from] = piece;
    b[to] = rec.captured;
    if (piece === KING) this.kingSq[0] = from;
    else if (piece === -KING) this.kingSq[1] = from;
    if (rec.captured === KING) this.kingSq[0] = to;
    else if (rec.captured === -KING) this.kingSq[1] = to;
    this.turn = this.turn === 'w' ? 'b' : 'w';
    if (this.turn === 'b') this.fullmove -= 1;
    this.halfmove = rec.halfmove;
    this.hash = rec.hash;
    this.lock = rec.lock;
  }

  /** Nước đi "bỏ lượt" dùng cho Null-Move Pruning trong engine. */
  makeNullMove(): void {
    this.undoStack.push({ move: -1, captured: 0, halfmove: this.halfmove, hash: this.hash, lock: this.lock });
    this.hash ^= ZOBRIST_SIDE_HASH;
    this.lock ^= ZOBRIST_SIDE_LOCK;
    this.turn = this.turn === 'w' ? 'b' : 'w';
  }

  unmakeNullMove(): void {
    const rec = this.undoStack.pop();
    if (!rec || rec.move !== -1) throw new Error('unmakeNullMove: ngăn xếp không khớp');
    this.turn = this.turn === 'w' ? 'b' : 'w';
    this.hash = rec.hash;
    this.lock = rec.lock;
    this.halfmove = rec.halfmove;
  }

  /** Nước giả hợp lệ `m` có để Tướng của bên đi bị chiếu / lộ mặt không. */
  isLegalPseudo(m: EncodedMove): boolean {
    const mover = this.turn;
    this.makeMove(m);
    const ok = !this.isAttacked(this.kingSq[mover === 'w' ? 0 : 1], this.turn);
    this.unmakeMove();
    return ok;
  }

  generateLegalMoves(): EncodedMove[] {
    const pseudo: EncodedMove[] = [];
    this.generatePseudoMoves(pseudo);
    return pseudo.filter((m) => this.isLegalPseudo(m));
  }

  legalMovesFrom(sq: Square): EncodedMove[] {
    return this.generateLegalMoves().filter((m) => moveFrom(m) === sq);
  }

  /** Trả về nước đi đã mã hoá nếu chuỗi UCI là nước hợp lệ trong thế cờ hiện tại. */
  findLegalMove(uci: string): EncodedMove | null {
    const parsed = parseUciMove(uci);
    if (!parsed) return null;
    const m = encodeMove(parsed.from, parsed.to);
    const piece = this.board[parsed.from];
    if (piece === 0 || (piece > 0) !== (this.turn === 'w')) return null;
    const pseudo: EncodedMove[] = [];
    this.generatePseudoMoves(pseudo);
    if (!pseudo.includes(m)) return null;
    return this.isLegalPseudo(m) ? m : null;
  }

  moveDetail(m: EncodedMove): MoveDetail {
    return { from: moveFrom(m), to: moveTo(m), uci: moveToUci(m), captured: this.board[moveTo(m)] };
  }

  /** Còn quân có thể tấn công (Xe, Mã, Pháo, Tốt) hay không. */
  hasAttackingMaterial(side: Side): boolean {
    const sign = side === 'w' ? 1 : -1;
    for (let sq = 0; sq < BOARD_SIZE; sq++) {
      const p = this.board[sq] * sign;
      if (p === ROOK || p === HORSE || p === CANNON || p === PAWN) return true;
    }
    return false;
  }
}

// ───────────────────────────── Ký hiệu Cờ Tướng Tiếng Việt ─────────────────────────────

/**
 * Chuyển nước đi sang ký hiệu Cờ Tướng Tiếng Việt chuẩn, ví dụ: "Pháo 2 bình 5", "Mã 8 tấn 7", "Xe trước tấn 1".
 * Phải gọi TRƯỚC khi thực hiện nước đi trên `pos`.
 */
export function moveToChinese(pos: Position, m: EncodedMove): string {
  const from = moveFrom(m);
  const to = moveTo(m);
  const code = pos.board[from];
  const piece = codeToPiece(code);
  if (!piece) return moveToUci(m);
  const red = piece.side === 'w';
  const pieceName = VIETNAMESE_NAMES[piece.kind];
  const fileNo = (col: number): number => (red ? 9 - col : col + 1);
  const fr = rowOf(from);
  const fc = colOf(from);
  const tr = rowOf(to);
  const tc = colOf(to);

  // Các quân cùng loại, cùng bên trên cùng cột -> dùng trước / giữa / sau
  const sameFile: number[] = [];
  for (let r = 0; r < ROWS; r++) {
    if (pos.board[toSquare(r, fc)] === code) sameFile.push(r);
  }
  // Sắp xếp từ "trước" ra "sau" theo hướng tiến của bên đi
  sameFile.sort((a, b) => (red ? a - b : b - a));
  let prefix: string;
  if (sameFile.length >= 2 && piece.kind !== 'a' && piece.kind !== 'b') {
    const idx = sameFile.indexOf(fr);
    const labels =
      sameFile.length === 2
        ? ['trước', 'sau']
        : sameFile.length === 3
          ? ['trước', 'giữa', 'sau']
          : ['1', '2', '3', '4', '5'];
    prefix = `${pieceName} ${labels[idx]}`;
  } else {
    prefix = `${pieceName} ${fileNo(fc)}`;
  }

  const forward = red ? tr < fr : tr > fr;
  let action: string;
  let target: number;
  if (tr === fr) {
    action = 'bình';
    target = fileNo(tc);
  } else {
    action = forward ? 'tấn' : 'thoái';
    const diagonalMover = piece.kind === 'n' || piece.kind === 'b' || piece.kind === 'a';
    target = diagonalMover ? fileNo(tc) : Math.abs(tr - fr);
  }
  return `${prefix} ${action} ${target}`;
}

/** Chuyển một dãy nước UCI (PV) sang ký hiệu truyền thống; dừng ở nước không hợp lệ. */
export function uciLineToChinese(fen: string, line: readonly UciMove[], maxMoves = 12): string[] {
  let pos: Position;
  try {
    pos = Position.fromFen(fen);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const uci of line.slice(0, maxMoves)) {
    const m = pos.findLegalMove(uci);
    if (m === null) break;
    out.push(moveToChinese(pos, m));
    pos.makeMove(m);
  }
  return out;
}

// ───────────────────────────── Trạng thái ván cờ ─────────────────────────────

export interface ReplayResult {
  position: Position;
  /** FEN sau mỗi nửa nước, phần tử 0 là thế xuất phát. */
  fens: string[];
  notations: string[];
  details: MoveDetail[];
  status: GameStatus;
  /** Chỉ số nước đầu tiên không hợp lệ (nếu có). */
  invalidAt: number | null;
}

/** Số nửa nước không ăn quân tối đa trước khi xử hoà (tương đương luật 60 nước). */
export const MOVE_LIMIT_PLIES = 120;

export function evaluateStatus(pos: Position, hashHistory: readonly string[]): GameStatus {
  const inCheck = pos.inCheck();
  const legal = pos.generateLegalMoves();
  if (legal.length === 0) {
    // Cờ Tướng: hết nước đi (kể cả không bị chiếu - "khốn bí") đều là THUA.
    return { over: true, winner: opposite(pos.turn), reason: inCheck ? 'checkmate' : 'stalemate', inCheck };
  }
  const current = hashHistory[hashHistory.length - 1];
  if (current !== undefined) {
    let occurrences = 0;
    for (const h of hashHistory) if (h === current) occurrences += 1;
    if (occurrences >= 3) return { over: true, winner: null, reason: 'repetition', inCheck };
  }
  if (pos.halfmove >= MOVE_LIMIT_PLIES) {
    return { over: true, winner: null, reason: 'move-limit', inCheck };
  }
  if (!pos.hasAttackingMaterial('w') && !pos.hasAttackingMaterial('b')) {
    return { over: true, winner: null, reason: 'insufficient-material', inCheck };
  }
  return { over: false, winner: null, reason: null, inCheck };
}

/** Phát lại ván cờ từ FEN xuất phát + danh sách nước UCI. */
export function replayGame(startFen: string, moves: readonly UciMove[]): ReplayResult {
  const position = Position.fromFen(startFen);
  const fens = [position.toFen()];
  const notations: string[] = [];
  const details: MoveDetail[] = [];
  const hashes = [`${position.hash}:${position.lock}`];
  let invalidAt: number | null = null;
  for (let i = 0; i < moves.length; i++) {
    const m = position.findLegalMove(moves[i]);
    if (m === null) {
      invalidAt = i;
      break;
    }
    notations.push(moveToChinese(position, m));
    details.push(position.moveDetail(m));
    position.makeMove(m);
    fens.push(position.toFen());
    hashes.push(`${position.hash}:${position.lock}`);
  }
  return { position, fens, notations, details, status: evaluateStatus(position, hashes), invalidAt };
}

export function describeResult(status: GameStatus): string {
  if (!status.over) return '';
  const winner = status.winner === 'w' ? 'Đỏ' : status.winner === 'b' ? 'Đen' : '';
  switch (status.reason) {
    case 'checkmate':
      return `${winner} thắng — chiếu bí!`;
    case 'stalemate':
      return `${winner} thắng — đối phương hết nước đi (khốn bí).`;
    case 'repetition':
      return 'Hoà — thế cờ lặp lại 3 lần.';
    case 'move-limit':
      return 'Hoà — 60 nước liên tiếp không ăn quân.';
    case 'insufficient-material':
      return 'Hoà — cả hai bên không còn quân tấn công.';
    default:
      return 'Ván cờ kết thúc.';
  }
}

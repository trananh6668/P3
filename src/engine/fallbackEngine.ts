/**
 * Engine Cờ Tướng viết bằng TypeScript thuần — dùng làm PHƯƠNG ÁN DỰ PHÒNG
 * khi Fairy-Stockfish WASM không thể nạp được (trình duyệt không hỗ trợ
 * SharedArrayBuffer / thiếu header COOP-COEP / thiếu file .wasm ...).
 *
 * Engine "nói" cùng giao thức UCI dạng text như Fairy-Stockfish nên Worker
 * có thể dùng chung một luồng xử lý cho cả hai backend.
 *
 * Thuật toán: Iterative Deepening + Alpha-Beta (PVS) + Quiescence Search,
 * Transposition Table (Zobrist), Null-Move Pruning, Late Move Reduction,
 * Killer/History heuristic, MVV-LVA, Check Extension, Mate Distance Pruning.
 */
import {
  CANNON,
  HORSE,
  Position,
  ROOK,
  START_FEN,
  moveToUci,
} from '../lib/xiangqi';
import type { EncodedMove, UciEngineAdapter } from '../types/xiangqi';

const MATE = 30000;
const MATE_BOUND = MATE - 1000;
const INF = 32000;
const MAX_PLY = 64;
const MAX_DEPTH = 40;

const TT_BITS = 19;
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;
const TT_EXACT = 1;
const TT_LOWER = 2;
const TT_UPPER = 3;

/** Giá trị quân theo mã (index = |code|). */
const PIECE_VALUE = [0, 0, 120, 120, 270, 600, 285, 60];
/** Giá trị nạn nhân cho MVV-LVA. */
const MVV_VALUE = [0, 100, 2, 2, 4, 9, 5, 1];

// Bảng điểm vị trí (Piece-Square Tables) cho quân ĐỎ, row 0 = hàng cuối của Đen.
// prettier-ignore
const PST_PAWN = [
   0,  3,  6,  9, 12,  9,  6,  3,  0,
  18, 36, 56, 80,120, 80, 56, 36, 18,
  14, 26, 42, 60, 80, 60, 42, 26, 14,
  10, 20, 30, 34, 40, 34, 30, 20, 10,
   6, 12, 18, 18, 20, 18, 18, 12,  6,
   2,  0,  8,  0,  8,  0,  8,  0,  2,
   0,  0, -2,  0,  4,  0, -2,  0,  0,
   0,  0,  0,  0,  0,  0,  0,  0,  0,
   0,  0,  0,  0,  0,  0,  0,  0,  0,
   0,  0,  0,  0,  0,  0,  0,  0,  0,
];
// prettier-ignore
const PST_HORSE = [
   4,  8, 16, 12,  4, 12, 16,  8,  4,
   4, 10, 28, 16,  8, 16, 28, 10,  4,
  12, 14, 16, 20, 18, 20, 16, 14, 12,
   8, 24, 18, 24, 20, 24, 18, 24,  8,
   6, 16, 14, 18, 16, 18, 14, 16,  6,
   4, 12, 16, 14, 12, 14, 16, 12,  4,
   2,  6,  8,  6, 10,  6,  8,  6,  2,
   4,  2,  8,  8,  4,  8,  8,  2,  4,
   0,  2,  4,  4, -2,  4,  4,  2,  0,
   0, -4,  0,  0,  0,  0,  0, -4,  0,
];
// prettier-ignore
const PST_ROOK = [
  14, 14, 12, 18, 16, 18, 12, 14, 14,
  16, 20, 18, 24, 26, 24, 18, 20, 16,
  12, 12, 12, 18, 18, 18, 12, 12, 12,
  12, 18, 16, 22, 22, 22, 16, 18, 12,
  12, 14, 12, 18, 18, 18, 12, 14, 12,
  12, 16, 14, 20, 20, 20, 14, 16, 12,
   6, 10,  8, 14, 14, 14,  8, 10,  6,
   4,  8,  6, 14, 12, 14,  6,  8,  4,
   8,  4,  8, 16,  8, 16,  8,  4,  8,
  -2, 10,  6, 14, 12, 14,  6, 10, -2,
];
// prettier-ignore
const PST_CANNON = [
   6,  4,  0,-10,-12,-10,  0,  4,  6,
   2,  2,  0, -4,-14, -4,  0,  2,  2,
   2,  2,  0,-10, -8,-10,  0,  2,  2,
   0,  0, -2,  4, 10,  4, -2,  0,  0,
   0,  0,  0,  2,  8,  2,  0,  0,  0,
  -2,  0,  4,  2,  6,  2,  4,  0, -2,
   0,  0,  0,  2,  4,  2,  0,  0,  0,
   4,  0,  8,  6, 10,  6,  8,  0,  4,
   0,  2,  4,  6,  6,  6,  4,  2,  0,
   0,  0,  2,  6,  6,  6,  2,  0,  0,
];
// prettier-ignore
const PST_KING = [
   0, 0, 0,  0,  0,  0, 0, 0, 0,
   0, 0, 0,  0,  0,  0, 0, 0, 0,
   0, 0, 0,  0,  0,  0, 0, 0, 0,
   0, 0, 0,  0,  0,  0, 0, 0, 0,
   0, 0, 0,  0,  0,  0, 0, 0, 0,
   0, 0, 0,  0,  0,  0, 0, 0, 0,
   0, 0, 0,  0,  0,  0, 0, 0, 0,
   0, 0, 0,-16,-14,-16, 0, 0, 0,
   0, 0, 0, -8, -6, -8, 0, 0, 0,
   0, 0, 0,  2,  6,  2, 0, 0, 0,
];
const PST_ZERO = new Array<number>(90).fill(0);
const PST: readonly (readonly number[])[] = [PST_ZERO, PST_KING, PST_ZERO, PST_ZERO, PST_HORSE, PST_ROOK, PST_CANNON, PST_PAWN];

/** Lật dọc ô cờ để tra PST cho quân Đen. */
const MIRROR = new Int16Array(90);
for (let sq = 0; sq < 90; sq++) MIRROR[sq] = (9 - ((sq / 9) | 0)) * 9 + (sq % 9);

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export class FallbackEngine implements UciEngineAdapter {
  readonly name = 'XiangqiJS (engine TypeScript dự phòng)';

  private listener: ((line: string) => void) | null = null;
  private terminated = false;

  // Trạng thái thế cờ do lệnh `position` thiết lập
  private rootPosition: Position = Position.fromFen(START_FEN);
  private rootHashes: number[] = [this.rootPosition.hash];

  // Điều phối nhiều lệnh `go`/`stop` nối tiếp nhau
  private goCounter = 0;
  private stopBelow = 0;
  private chain: Promise<void> = Promise.resolve();

  // Trạng thái tìm kiếm
  private pos: Position = this.rootPosition;
  private repStack: number[] = [];
  private nodes = 0;
  private seldepth = 0;
  private deadline = 0;
  private aborted = false;

  private readonly ttLock = new Int32Array(TT_SIZE);
  private readonly ttMove = new Int32Array(TT_SIZE);
  private readonly ttScore = new Int16Array(TT_SIZE);
  private readonly ttDepth = new Int8Array(TT_SIZE);
  private readonly ttFlag = new Uint8Array(TT_SIZE);

  private readonly killers = new Int32Array(MAX_PLY * 2);
  private readonly history = new Int32Array(90 * 90);
  private readonly pvTable = new Int32Array(MAX_PLY * MAX_PLY);
  private readonly pvLength = new Int32Array(MAX_PLY + 1);

  setListener(listener: (line: string) => void): void {
    this.listener = listener;
  }

  terminate(): void {
    this.terminated = true;
    this.stopBelow = Number.MAX_SAFE_INTEGER;
    this.listener = null;
  }

  send(command: string): void {
    if (this.terminated) return;
    const line = command.trim();
    if (!line) return;
    const tokens = line.split(/\s+/);
    switch (tokens[0]) {
      case 'uci':
        this.emit(`id name ${this.name}`);
        this.emit('id author Xiangqi WASM App');
        this.emit('option name UCI_Variant type combo default xiangqi var xiangqi');
        this.emit('uciok');
        break;
      case 'isready':
        this.emit('readyok');
        break;
      case 'ucinewgame':
        this.clearTables();
        this.rootPosition = Position.fromFen(START_FEN);
        this.rootHashes = [this.rootPosition.hash];
        break;
      case 'setoption':
        // Engine dự phòng không có tuỳ chọn cấu hình; bỏ qua một cách an toàn.
        break;
      case 'position':
        this.handlePosition(tokens);
        break;
      case 'go':
        this.handleGo(tokens);
        break;
      case 'stop':
        this.stopBelow = this.goCounter;
        break;
      case 'quit':
        this.terminate();
        break;
      default:
        this.emit(`info string Lệnh không được hỗ trợ: ${tokens[0]}`);
        break;
    }
  }

  // ───────────────────────── Xử lý lệnh ─────────────────────────

  private emit(line: string): void {
    if (!this.terminated && this.listener) this.listener(line);
  }

  private clearTables(): void {
    this.ttLock.fill(0);
    this.ttMove.fill(0);
    this.ttScore.fill(0);
    this.ttDepth.fill(0);
    this.ttFlag.fill(0);
    this.history.fill(0);
    this.killers.fill(0);
  }

  private handlePosition(tokens: string[]): void {
    let fen: string;
    let idx: number;
    if (tokens[1] === 'startpos') {
      fen = START_FEN;
      idx = 2;
    } else if (tokens[1] === 'fen') {
      const movesIdx = tokens.indexOf('moves');
      const end = movesIdx === -1 ? tokens.length : movesIdx;
      fen = tokens.slice(2, end).join(' ');
      idx = end;
    } else {
      this.emit('info string Lỗi: lệnh position cần "startpos" hoặc "fen <chuỗi>"');
      return;
    }
    let pos: Position;
    try {
      pos = Position.fromFen(fen);
    } catch (err) {
      this.emit(`info string Lỗi FEN: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const hashes = [pos.hash];
    if (tokens[idx] === 'moves') {
      for (const uci of tokens.slice(idx + 1)) {
        const m = pos.findLegalMove(uci);
        if (m === null) {
          this.emit(`info string Nước đi không hợp lệ bị bỏ qua: ${uci}`);
          break;
        }
        pos.makeMove(m);
        hashes.push(pos.hash);
      }
    }
    this.rootPosition = pos.clone();
    this.rootHashes = hashes;
  }

  private handleGo(tokens: string[]): void {
    let depth = MAX_DEPTH;
    let movetime = 10_000;
    const dIdx = tokens.indexOf('depth');
    if (dIdx > 0) {
      const v = Number.parseInt(tokens[dIdx + 1] ?? '', 10);
      if (Number.isFinite(v) && v > 0) depth = Math.min(v, MAX_DEPTH);
    }
    const tIdx = tokens.indexOf('movetime');
    if (tIdx > 0) {
      const v = Number.parseInt(tokens[tIdx + 1] ?? '', 10);
      if (Number.isFinite(v) && v > 0) movetime = v;
    }
    const token = ++this.goCounter;
    // Lệnh go mới => huỷ mọi lượt tìm kiếm trước đó (chúng vẫn trả về bestmove theo đúng thứ tự).
    this.stopBelow = token - 1;
    const root = this.rootPosition.clone();
    const hashes = this.rootHashes.slice();
    this.chain = this.chain
      .then(() => this.think(token, root, hashes, depth, movetime))
      .catch((err: unknown) => {
        this.emit(`info string Lỗi engine dự phòng: ${err instanceof Error ? err.message : String(err)}`);
        this.emit('bestmove (none)');
      });
  }

  private shouldStop(token: number): boolean {
    return this.terminated || token <= this.stopBelow;
  }

  // ───────────────────────── Tìm kiếm ─────────────────────────

  private async think(token: number, root: Position, hashes: number[], maxDepth: number, movetime: number): Promise<void> {
    if (this.terminated) return;
    const start = now();
    this.pos = root;
    this.repStack = hashes;
    this.nodes = 0;
    this.seldepth = 0;
    this.aborted = false;
    this.deadline = start + Math.max(50, movetime);
    this.killers.fill(0);
    for (let i = 0; i < this.history.length; i++) this.history[i] >>= 2;

    const legal = root.generateLegalMoves();
    if (legal.length === 0) {
      this.emit(`info depth 0 score mate 0`);
      this.emit('bestmove (none)');
      return;
    }

    let bestMove: EncodedMove = legal[0];
    let bestPv: EncodedMove[] = [legal[0]];

    for (let depth = 1; depth <= maxDepth; depth++) {
      await yieldToEventLoop(); // cho phép nhận lệnh stop / go mới
      if (this.shouldStop(token)) break;
      const elapsed = now() - start;
      if (depth > 1 && elapsed > movetime * 0.45) break; // vòng tiếp theo khó kịp hoàn thành

      const score = this.negamax(depth, -INF, INF, 0, false);
      if (this.aborted) break;

      const pvLen = this.pvLength[0];
      if (pvLen > 0) {
        bestPv = Array.from(this.pvTable.subarray(0, pvLen));
        bestMove = bestPv[0];
      }
      this.emitInfo(depth, score, start, bestPv);

      if (Math.abs(score) >= MATE_BOUND && MATE - Math.abs(score) <= depth) break;
      if (legal.length === 1 && depth >= 2) break;
    }

    if (!this.terminated) this.emit(`bestmove ${moveToUci(bestMove)}`);
  }

  private emitInfo(depth: number, score: number, start: number, pv: EncodedMove[]): void {
    const elapsed = Math.max(1, Math.round(now() - start));
    const nps = Math.round((this.nodes * 1000) / elapsed);
    let scoreText: string;
    if (score >= MATE_BOUND) scoreText = `mate ${Math.ceil((MATE - score) / 2)}`;
    else if (score <= -MATE_BOUND) scoreText = `mate -${Math.ceil((MATE + score) / 2)}`;
    else scoreText = `cp ${score}`;
    this.emit(
      `info depth ${depth} seldepth ${this.seldepth} score ${scoreText} nodes ${this.nodes} nps ${nps} time ${elapsed} pv ${pv
        .map(moveToUci)
        .join(' ')}`,
    );
  }

  private timeUp(): boolean {
    return now() >= this.deadline;
  }

  private evaluate(): number {
    const b = this.pos.board;
    let score = 0;
    for (let sq = 0; sq < 90; sq++) {
      const p = b[sq];
      if (p > 0) score += PIECE_VALUE[p] + PST[p][sq];
      else if (p < 0) score -= PIECE_VALUE[-p] + PST[-p][MIRROR[sq]];
    }
    return (this.pos.turn === 'w' ? score : -score) + 4; // +4: lợi thế đi trước (tempo)
  }

  private hasBigPieces(): boolean {
    const b = this.pos.board;
    const sign = this.pos.turn === 'w' ? 1 : -1;
    for (let sq = 0; sq < 90; sq++) {
      const p = b[sq] * sign;
      if (p === ROOK || p === HORSE || p === CANNON) return true;
    }
    return false;
  }

  private isRepetition(): boolean {
    const stack = this.repStack;
    const top = stack.length - 1;
    const h = stack[top];
    const limit = Math.max(0, top - this.pos.halfmove);
    for (let i = top - 2; i >= limit; i -= 2) {
      if (stack[i] === h) return true;
    }
    return false;
  }

  private orderScore(m: EncodedMove, ttMove: EncodedMove, ply: number): number {
    if (m === ttMove) return 2_000_000;
    const b = this.pos.board;
    const from = m & 0xff;
    const to = (m >> 8) & 0xff;
    const victim = b[to];
    if (victim !== 0) return 1_000_000 + MVV_VALUE[Math.abs(victim)] * 64 - Math.abs(b[from]);
    if (m === this.killers[ply * 2]) return 900_000;
    if (m === this.killers[ply * 2 + 1]) return 800_000;
    return this.history[from * 90 + to];
  }

  private updatePv(ply: number, m: EncodedMove): void {
    const base = ply * MAX_PLY;
    const childBase = (ply + 1) * MAX_PLY;
    this.pvTable[base + ply] = m;
    const childLen = ply + 1 < MAX_PLY ? this.pvLength[ply + 1] : ply + 1;
    for (let k = ply + 1; k < childLen; k++) this.pvTable[base + k] = this.pvTable[childBase + k];
    this.pvLength[ply] = Math.max(childLen, ply + 1);
  }

  private negamax(depthIn: number, alphaIn: number, betaIn: number, ply: number, allowNull: boolean): number {
    let depth = depthIn;
    let alpha = alphaIn;
    let beta = betaIn;
    this.pvLength[ply] = ply;
    if (this.aborted) return 0;
    if ((++this.nodes & 1023) === 0 && this.timeUp()) {
      this.aborted = true;
      return 0;
    }
    if (ply > this.seldepth) this.seldepth = ply;
    const pos = this.pos;

    if (ply > 0) {
      if (this.isRepetition()) return 0;
      alpha = Math.max(alpha, -MATE + ply);
      beta = Math.min(beta, MATE - ply - 1);
      if (alpha >= beta) return alpha;
    }
    if (ply >= MAX_PLY - 2) return this.evaluate();

    const inCheck = pos.inCheck();
    if (inCheck) depth += 1;
    if (depth <= 0) return this.quiesce(alpha, beta, ply, 0);

    const isPv = beta - alpha > 1;
    const idx = pos.hash & TT_MASK;
    let ttMove: EncodedMove = 0;
    if (this.ttLock[idx] === pos.lock && this.ttFlag[idx] !== 0) {
      ttMove = this.ttMove[idx];
      if (ply > 0 && !isPv && this.ttDepth[idx] >= depth) {
        let s = this.ttScore[idx];
        if (s >= MATE_BOUND) s -= ply;
        else if (s <= -MATE_BOUND) s += ply;
        const flag = this.ttFlag[idx];
        if (flag === TT_EXACT) return s;
        if (flag === TT_LOWER && s >= beta) return s;
        if (flag === TT_UPPER && s <= alpha) return s;
      }
    }

    // Null-Move Pruning
    if (!isPv && !inCheck && allowNull && ply > 0 && depth >= 3 && beta < MATE_BOUND && this.hasBigPieces()) {
      const R = depth > 6 ? 3 : 2;
      pos.makeNullMove();
      this.repStack.push(pos.hash);
      const s = -this.negamax(depth - 1 - R, -beta, -beta + 1, ply + 1, false);
      this.repStack.pop();
      pos.unmakeNullMove();
      if (this.aborted) return 0;
      if (s >= beta) return s >= MATE_BOUND ? beta : s;
    }

    const moves: EncodedMove[] = [];
    pos.generatePseudoMoves(moves);
    const scores = new Int32Array(moves.length);
    for (let i = 0; i < moves.length; i++) scores[i] = this.orderScore(moves[i], ttMove, ply);

    const moverIdx = pos.turn === 'w' ? 0 : 1;
    const oldAlpha = alpha;
    let best = -INF;
    let bestMove: EncodedMove = 0;
    let legal = 0;

    for (let i = 0; i < moves.length; i++) {
      // Selection sort lười: chọn nước có điểm sắp xếp cao nhất còn lại
      let bi = i;
      for (let j = i + 1; j < moves.length; j++) if (scores[j] > scores[bi]) bi = j;
      if (bi !== i) {
        const tm = moves[i];
        moves[i] = moves[bi];
        moves[bi] = tm;
        const ts = scores[i];
        scores[i] = scores[bi];
        scores[bi] = ts;
      }
      const m = moves[i];
      const captured = pos.board[(m >> 8) & 0xff];
      pos.makeMove(m);
      if (pos.isAttacked(pos.kingSq[moverIdx], pos.turn)) {
        pos.unmakeMove();
        continue;
      }
      legal += 1;
      this.repStack.push(pos.hash);

      let score: number;
      if (legal === 1) {
        score = -this.negamax(depth - 1, -beta, -alpha, ply + 1, true);
      } else {
        let reduction = 0;
        const quiet = captured === 0 && scores[i] < 800_000;
        if (depth >= 3 && legal > 3 && !inCheck && quiet && !pos.inCheck()) {
          reduction = legal > 10 ? 2 : 1;
        }
        score = -this.negamax(depth - 1 - reduction, -alpha - 1, -alpha, ply + 1, true);
        if (!this.aborted && score > alpha && reduction > 0) {
          score = -this.negamax(depth - 1, -alpha - 1, -alpha, ply + 1, true);
        }
        if (!this.aborted && score > alpha && score < beta) {
          score = -this.negamax(depth - 1, -beta, -alpha, ply + 1, true);
        }
      }

      this.repStack.pop();
      pos.unmakeMove();
      if (this.aborted) return 0;

      if (score > best) {
        best = score;
        bestMove = m;
        if (score > alpha) {
          alpha = score;
          this.updatePv(ply, m);
          if (score >= beta) {
            if (captured === 0) {
              if (this.killers[ply * 2] !== m) {
                this.killers[ply * 2 + 1] = this.killers[ply * 2];
                this.killers[ply * 2] = m;
              }
              const hIdx = (m & 0xff) * 90 + ((m >> 8) & 0xff);
              this.history[hIdx] = Math.min(700_000, this.history[hIdx] + depth * depth);
            }
            break;
          }
        }
      }
    }

    if (legal === 0) return -MATE + ply; // Cờ Tướng: hết nước = thua

    let stored = best;
    if (stored >= MATE_BOUND) stored += ply;
    else if (stored <= -MATE_BOUND) stored -= ply;
    const replace = this.ttLock[idx] !== pos.lock || depth >= this.ttDepth[idx] || this.ttFlag[idx] === 0;
    if (replace) {
      this.ttLock[idx] = pos.lock;
      this.ttMove[idx] = bestMove;
      this.ttScore[idx] = Math.max(-32000, Math.min(32000, stored));
      this.ttDepth[idx] = Math.min(127, depth);
      this.ttFlag[idx] = best >= beta ? TT_LOWER : best > oldAlpha ? TT_EXACT : TT_UPPER;
    }
    return best;
  }

  private quiesce(alphaIn: number, beta: number, ply: number, qdepth: number): number {
    let alpha = alphaIn;
    this.pvLength[ply] = ply;
    if (this.aborted) return 0;
    if ((++this.nodes & 1023) === 0 && this.timeUp()) {
      this.aborted = true;
      return 0;
    }
    if (ply > this.seldepth) this.seldepth = ply;
    if (ply >= MAX_PLY - 2) return this.evaluate();

    const pos = this.pos;
    const inCheck = pos.inCheck();
    let best: number;
    if (inCheck) {
      if (qdepth > 6) return this.evaluate();
      best = -MATE + ply;
    } else {
      const stand = this.evaluate();
      if (stand >= beta) return stand;
      if (stand > alpha) alpha = stand;
      best = stand;
    }

    const moves: EncodedMove[] = [];
    pos.generatePseudoMoves(moves, !inCheck);
    const b = pos.board;
    const scores = new Int32Array(moves.length);
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      const victim = b[(m >> 8) & 0xff];
      scores[i] = victim !== 0 ? MVV_VALUE[Math.abs(victim)] * 64 - Math.abs(b[m & 0xff]) : 0;
    }
    const moverIdx = pos.turn === 'w' ? 0 : 1;
    let legal = 0;

    for (let i = 0; i < moves.length; i++) {
      let bi = i;
      for (let j = i + 1; j < moves.length; j++) if (scores[j] > scores[bi]) bi = j;
      if (bi !== i) {
        const tm = moves[i];
        moves[i] = moves[bi];
        moves[bi] = tm;
        const ts = scores[i];
        scores[i] = scores[bi];
        scores[bi] = ts;
      }
      const m = moves[i];
      pos.makeMove(m);
      if (pos.isAttacked(pos.kingSq[moverIdx], pos.turn)) {
        pos.unmakeMove();
        continue;
      }
      legal += 1;
      const score = -this.quiesce(-beta, -alpha, ply + 1, qdepth + 1);
      pos.unmakeMove();
      if (this.aborted) return 0;
      if (score > best) {
        best = score;
        if (score > alpha) {
          alpha = score;
          this.updatePv(ply, m);
          if (score >= beta) break;
        }
      }
    }
    if (inCheck && legal === 0) return -MATE + ply;
    return best;
  }
}

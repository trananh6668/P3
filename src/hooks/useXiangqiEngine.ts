/**
 * useXiangqiEngine — cầu nối giữa React UI và Web Worker chạy engine.
 *
 *  - Quản lý vòng đời Worker (tạo / khởi tạo / watchdog / khởi động lại / huỷ).
 *  - Quản lý trạng thái ván cờ: FEN xuất phát + danh sách nước UCI (nguồn chân lý duy nhất).
 *  - Tự động yêu cầu engine đi khi tới lượt máy, huỷ ngay (`stop`) khi Undo / ván mới / đổi bên.
 *  - Parse thông tin phân tích (depth, score, nps, pv) và quy đổi điểm về góc nhìn bên Đỏ.
 *  - Mọi kết quả trễ (stale) đều bị loại bỏ dựa trên searchId + khoá thế cờ.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DIFFICULTY_LEVELS, getDifficulty } from '../lib/difficulty';
import { FenError, Position, START_FEN, opposite, replayGame, uciLineToChinese, type ReplayResult } from '../lib/xiangqi';
import type {
  AnalysisState,
  DifficultyId,
  EngineBackend,
  EngineInitConfig,
  EngineLogEntry,
  EngineScore,
  EngineStatus,
  SearchPurpose,
  Side,
  UciMove,
  WorkerRequest,
  WorkerResponse,
} from '../types/xiangqi';

const INIT_WATCHDOG_MS = 60_000;
const MIN_ENGINE_MOVE_DELAY_MS = 280;
const MAX_LOG_ENTRIES = 300;
const STORAGE_KEY = 'xiangqi-wasm:v1';

export interface EngineState {
  status: EngineStatus;
  backend: EngineBackend | null;
  engineName: string | null;
  message: string;
}

interface ActiveSearch {
  id: number;
  purpose: SearchPurpose;
  /** Khoá thế cờ lúc bắt đầu tính: startFen|moves */
  key: string;
  /** FEN của thế cờ được phân tích (để dịch PV sang ký hiệu truyền thống). */
  fen: string;
  sideToMove: Side;
  startedAt: number;
  applying: boolean;
}

interface PersistedState {
  startFen: string;
  moves: UciMove[];
  playerSide: Side;
  difficultyId: DifficultyId;
}

interface GameSnapshot {
  startFen: string;
  moves: UciMove[];
  key: string;
  game: ReplayResult;
  playerSide: Side;
}

function loadPersisted(): PersistedState {
  const fallback: PersistedState = { startFen: START_FEN, moves: [], playerSide: 'w', difficultyId: 'club' };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const data = JSON.parse(raw) as Partial<PersistedState>;
    const startFen = typeof data.startFen === 'string' ? data.startFen : START_FEN;
    const moves = Array.isArray(data.moves) ? data.moves.filter((m): m is string => typeof m === 'string') : [];
    const replay = replayGame(startFen, moves);
    const validMoves = replay.invalidAt === null ? moves : moves.slice(0, replay.invalidAt);
    return {
      startFen,
      moves: validMoves,
      playerSide: data.playerSide === 'b' ? 'b' : 'w',
      difficultyId: DIFFICULTY_LEVELS.some((l) => l.id === data.difficultyId) ? (data.difficultyId as DifficultyId) : 'club',
    };
  } catch {
    return fallback;
  }
}

function negateScore(score: EngineScore): EngineScore {
  return score.type === 'cp' ? { type: 'cp', value: -score.value } : { type: 'mate', value: -score.value };
}

function sideAtPly(startTurn: Side, ply: number): Side {
  return ply % 2 === 0 ? startTurn : opposite(startTurn);
}

/** Số nước giữ lại sau khi Undo, hoặc null nếu không có gì để đi lại. */
function computeUndoTarget(startTurn: Side, moveCount: number, playerSide: Side): number | null {
  if (moveCount === 0) return null;
  let k = moveCount - 1;
  while (k > 0 && sideAtPly(startTurn, k) !== playerSide) k -= 1;
  if (sideAtPly(startTurn, k) !== playerSide) return null;
  return k;
}

function defaultThreads(): number {
  const hc = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2;
  return Math.max(1, Math.min(4, hc - 1));
}

export function useXiangqiEngine() {
  const [initial] = useState(loadPersisted);
  const [startFen, setStartFen] = useState<string>(initial.startFen);
  const [moves, setMoves] = useState<UciMove[]>(initial.moves);
  const [playerSide, setPlayerSide] = useState<Side>(initial.playerSide);
  const [difficultyId, setDifficultyId] = useState<DifficultyId>(initial.difficultyId);
  const [engine, setEngine] = useState<EngineState>({
    status: 'idle',
    backend: null,
    engineName: null,
    message: 'Chưa khởi động engine.',
  });
  const [analysis, setAnalysis] = useState<AnalysisState | null>(null);
  const [thinking, setThinking] = useState<SearchPurpose | null>(null);
  const [hintMove, setHintMove] = useState<UciMove | null>(null);
  const [logs, setLogs] = useState<EngineLogEntry[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);

  const game = useMemo(() => replayGame(startFen, moves), [startFen, moves]);
  const gameKey = `${startFen}|${moves.join(' ')}`;

  const workerRef = useRef<Worker | null>(null);
  const activeSearchRef = useRef<ActiveSearch | null>(null);
  const searchCounterRef = useRef(0);
  const logIdRef = useRef(0);
  const initWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const applyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const engineStatusRef = useRef<EngineStatus>('idle');
  const backendRef = useRef<EngineBackend | null>(null);
  const difficultyRef = useRef<DifficultyId>(difficultyId);
  const gameRef = useRef<GameSnapshot>({ startFen, moves, key: gameKey, game, playerSide });

  // Luôn giữ snapshot mới nhất cho các callback bất đồng bộ (message từ Worker, timer).
  useLayoutEffect(() => {
    gameRef.current = { startFen, moves, key: gameKey, game, playerSide };
    difficultyRef.current = difficultyId;
  }, [startFen, moves, gameKey, game, playerSide, difficultyId]);

  useEffect(() => {
    engineStatusRef.current = engine.status;
    backendRef.current = engine.backend;
  }, [engine.status, engine.backend]);

  // Lưu ván cờ để mở lại (offline) vẫn tiếp tục được.
  useEffect(() => {
    try {
      const data: PersistedState = { startFen, moves, playerSide, difficultyId };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // localStorage có thể bị chặn (chế độ riêng tư) -> bỏ qua
    }
  }, [startFen, moves, playerSide, difficultyId]);

  const pushLog = useCallback((direction: EngineLogEntry['direction'], line: string) => {
    logIdRef.current += 1;
    const entry: EngineLogEntry = { id: logIdRef.current, direction, line };
    setLogs((prev) => {
      const next = prev.length >= MAX_LOG_ENTRIES ? prev.slice(prev.length - MAX_LOG_ENTRIES + 1) : prev.slice();
      next.push(entry);
      return next;
    });
  }, []);

  const clearSearchTimers = useCallback(() => {
    if (searchWatchdogRef.current) {
      clearTimeout(searchWatchdogRef.current);
      searchWatchdogRef.current = null;
    }
    if (applyTimerRef.current) {
      clearTimeout(applyTimerRef.current);
      applyTimerRef.current = null;
    }
  }, []);

  /** Huỷ lượt tính hiện tại: gửi `stop` và bỏ qua mọi kết quả trễ của nó. */
  const cancelSearch = useCallback(() => {
    clearSearchTimers();
    const active = activeSearchRef.current;
    activeSearchRef.current = null;
    if (active && !active.applying) {
      try {
        workerRef.current?.postMessage({ type: 'stop' } satisfies WorkerRequest);
      } catch {
        // worker đã chết
      }
    }
    setThinking(null);
  }, [clearSearchTimers]);

  const handleWorkerMessage = useCallback(
    (msg: WorkerResponse) => {
      switch (msg.type) {
        case 'status': {
          engineStatusRef.current = msg.status;
          backendRef.current = msg.backend;
          setEngine({ status: msg.status, backend: msg.backend, engineName: msg.engineName, message: msg.message });
          if (msg.status !== 'loading' && initWatchdogRef.current) {
            clearTimeout(initWatchdogRef.current);
            initWatchdogRef.current = null;
          }
          if (msg.status !== 'ready') {
            clearSearchTimers();
            activeSearchRef.current = null;
            setThinking(null);
          }
          break;
        }
        case 'info': {
          const active = activeSearchRef.current;
          if (!active || active.id !== msg.searchId) return;
          const { info } = msg;
          const scoreRed = info.score ? (active.sideToMove === 'w' ? info.score : negateScore(info.score)) : null;
          setAnalysis((prev) => ({
            searchId: active.id,
            purpose: active.purpose,
            depth: info.depth,
            seldepth: info.seldepth ?? null,
            scoreRed: scoreRed ?? (prev && prev.searchId === active.id ? prev.scoreRed : null),
            bound: info.bound ?? null,
            nodes: info.nodes ?? null,
            nps: info.nps ?? null,
            timeMs: info.time ?? null,
            pv: info.pv.length > 0 ? info.pv : prev && prev.searchId === active.id ? prev.pv : [],
            pvNotation:
              info.pv.length > 0
                ? uciLineToChinese(active.fen, info.pv, 12)
                : prev && prev.searchId === active.id
                  ? prev.pvNotation
                  : [],
          }));
          break;
        }
        case 'bestmove': {
          const active = activeSearchRef.current;
          if (!active || active.id !== msg.searchId || active.applying) return;
          if (searchWatchdogRef.current) {
            clearTimeout(searchWatchdogRef.current);
            searchWatchdogRef.current = null;
          }
          const current = gameRef.current;
          if (current.key !== active.key) {
            activeSearchRef.current = null;
            setThinking(null);
            return;
          }
          if (!msg.bestmove) {
            activeSearchRef.current = null;
            setThinking(null);
            if (!current.game.status.over) setLastError('Engine không trả về nước đi hợp lệ.');
            return;
          }
          if (current.game.position.findLegalMove(msg.bestmove) === null) {
            activeSearchRef.current = null;
            setThinking(null);
            setLastError(`Engine trả về nước đi không hợp lệ: ${msg.bestmove}`);
            return;
          }
          if (active.purpose === 'hint') {
            activeSearchRef.current = null;
            setThinking(null);
            setHintMove(msg.bestmove);
            return;
          }
          // Nước của máy: giữ một khoảng trễ tối thiểu để người chơi kịp nhìn thấy nước đi.
          active.applying = true;
          const bestmove = msg.bestmove;
          const wait = Math.max(0, MIN_ENGINE_MOVE_DELAY_MS - (performance.now() - active.startedAt));
          applyTimerRef.current = setTimeout(() => {
            applyTimerRef.current = null;
            if (activeSearchRef.current !== active) return;
            activeSearchRef.current = null;
            setThinking(null);
            if (gameRef.current.key !== active.key) return;
            setMoves((prev) => [...prev, bestmove]);
          }, wait);
          break;
        }
        case 'log':
          pushLog(msg.direction, msg.line);
          break;
        case 'error':
          setLastError(msg.message);
          pushLog('system', `LỖI: ${msg.message}`);
          if (msg.fatal) {
            clearSearchTimers();
            activeSearchRef.current = null;
            setThinking(null);
            engineStatusRef.current = 'error';
            setEngine((prev) => ({ ...prev, status: 'error', message: msg.message }));
          }
          break;
        default:
          break;
      }
    },
    [clearSearchTimers, pushLog],
  );

  const teardownWorker = useCallback(() => {
    clearSearchTimers();
    if (initWatchdogRef.current) {
      clearTimeout(initWatchdogRef.current);
      initWatchdogRef.current = null;
    }
    activeSearchRef.current = null;
    const worker = workerRef.current;
    workerRef.current = null;
    if (worker) {
      try {
        worker.postMessage({ type: 'quit' } satisfies WorkerRequest);
      } catch {
        // bỏ qua
      }
      worker.terminate(); // terminate() cũng huỷ toàn bộ pthread worker lồng bên trong
    }
  }, [clearSearchTimers]);

  const spawnWorker = useCallback(
    (forceFallback: boolean) => {
      teardownWorker();
      setThinking(null);
      engineStatusRef.current = 'loading';
      setEngine({ status: 'loading', backend: null, engineName: null, message: 'Đang tạo Web Worker…' });

      let worker: Worker;
      try {
        worker = new Worker(new URL('../workers/engineWorker.ts', import.meta.url), {
          type: 'module',
          name: 'xiangqi-engine',
        });
      } catch (err) {
        engineStatusRef.current = 'error';
        setEngine({
          status: 'error',
          backend: null,
          engineName: null,
          message: `Không tạo được Web Worker: ${err instanceof Error ? err.message : String(err)}. Hãy chạy ứng dụng qua HTTP server (không mở trực tiếp file://).`,
        });
        return;
      }
      workerRef.current = worker;

      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        if (workerRef.current !== worker) return;
        handleWorkerMessage(event.data);
      };
      worker.onerror = (event: ErrorEvent) => {
        event.preventDefault();
        if (workerRef.current !== worker) return;
        const message = `Web Worker gặp lỗi: ${event.message || 'không tải được script worker'}`;
        clearSearchTimers();
        activeSearchRef.current = null;
        setThinking(null);
        setLastError(message);
        engineStatusRef.current = 'error';
        setEngine((prev) => ({ ...prev, status: 'error', message }));
      };
      worker.onmessageerror = () => {
        setLastError('Không giải mã được thông điệp từ Worker.');
      };

      const config: EngineInitConfig = {
        engineBaseUrl: new URL(`${import.meta.env.BASE_URL}engine/`, window.location.href).href,
        threads: defaultThreads(),
        hashMb: 64,
        stepTimeoutMs: 20_000,
        forceFallback,
      };

      initWatchdogRef.current = setTimeout(() => {
        initWatchdogRef.current = null;
        if (workerRef.current === worker && engineStatusRef.current === 'loading') {
          const message = `Engine không phản hồi sau ${INIT_WATCHDOG_MS / 1000}s. Hãy thử khởi động lại hoặc dùng engine JS.`;
          engineStatusRef.current = 'error';
          setEngine((prev) => ({ ...prev, status: 'error', message }));
          setLastError(message);
        }
      }, INIT_WATCHDOG_MS);

      worker.postMessage({ type: 'init', config } satisfies WorkerRequest);
    },
    [clearSearchTimers, handleWorkerMessage, teardownWorker],
  );

  useEffect(() => {
    spawnWorker(false);
    return teardownWorker;
  }, [spawnWorker, teardownWorker]);

  const startSearch = useCallback(
    (purpose: SearchPurpose): boolean => {
      const worker = workerRef.current;
      if (!worker || engineStatusRef.current !== 'ready') return false;
      cancelSearch();
      const current = gameRef.current;
      const level = getDifficulty(difficultyRef.current);
      searchCounterRef.current += 1;
      const id = searchCounterRef.current;
      activeSearchRef.current = {
        id,
        purpose,
        key: current.key,
        fen: current.game.position.toFen(),
        sideToMove: current.game.position.turn,
        startedAt: performance.now(),
        applying: false,
      };
      setThinking(purpose);
      setLastError(null);
      setAnalysis({
        searchId: id,
        purpose,
        depth: 0,
        seldepth: null,
        scoreRed: null,
        bound: null,
        nodes: null,
        nps: null,
        timeMs: null,
        pv: [],
        pvNotation: [],
      });
      worker.postMessage({
        type: 'go',
        request: {
          searchId: id,
          fen: current.startFen,
          moves: current.moves,
          depth: level.depth,
          fallbackMoveTimeMs: level.fallbackMoveTimeMs,
        },
      } satisfies WorkerRequest);

      // Watchdog: nếu engine "treo" quá lâu thì huỷ và báo lỗi thay vì chờ vô hạn.
      const watchdogMs = backendRef.current === 'fallback' ? level.fallbackMoveTimeMs + 15_000 : 180_000;
      searchWatchdogRef.current = setTimeout(() => {
        searchWatchdogRef.current = null;
        if (activeSearchRef.current?.id === id && !activeSearchRef.current.applying) {
          cancelSearch();
          setLastError('Engine không trả lời trong thời gian cho phép. Hãy thử "Khởi động lại engine".');
        }
      }, watchdogMs);
      return true;
    },
    [cancelSearch],
  );

  // Tự động cho máy đi khi tới lượt.
  useEffect(() => {
    if (engine.status !== 'ready') return;
    if (game.status.over || game.invalidAt !== null) return;
    if (game.position.turn === playerSide) return;
    const active = activeSearchRef.current;
    if (active && active.purpose === 'play' && active.key === gameKey) return;
    startSearch('play');
  }, [engine.status, game, gameKey, playerSide, startSearch]);

  // ───────────────────────── Hành động của người chơi ─────────────────────────

  const makeMove = useCallback(
    (uci: UciMove): boolean => {
      const current = gameRef.current;
      if (current.game.status.over) return false;
      if (current.game.position.turn !== current.playerSide) return false;
      if (current.game.position.findLegalMove(uci) === null) return false;
      if (activeSearchRef.current) cancelSearch(); // huỷ lượt "gợi ý" nếu đang chạy
      setHintMove(null);
      setMoves((prev) => [...prev, uci]);
      return true;
    },
    [cancelSearch],
  );

  const undo = useCallback(() => {
    const current = gameRef.current;
    const startTurn: Side = current.game.fens[0]?.split(' ')[1] === 'b' ? 'b' : 'w';
    const target = computeUndoTarget(startTurn, current.moves.length, current.playerSide);
    if (target === null) return;
    cancelSearch();
    setHintMove(null);
    setAnalysis(null);
    setLastError(null);
    setMoves(current.moves.slice(0, target));
  }, [cancelSearch]);

  const newGame = useCallback(() => {
    cancelSearch();
    setHintMove(null);
    setAnalysis(null);
    setLastError(null);
    setStartFen(START_FEN);
    setMoves([]);
    workerRef.current?.postMessage({ type: 'newgame' } satisfies WorkerRequest);
  }, [cancelSearch]);

  const flipSide = useCallback(() => {
    cancelSearch();
    setHintMove(null);
    setPlayerSide((s) => opposite(s));
  }, [cancelSearch]);

  const loadFen = useCallback(
    (fenText: string): { ok: true } | { ok: false; error: string } => {
      let normalized: string;
      try {
        const pos = Position.fromFen(fenText);
        normalized = pos.toFen();
        if (pos.generateLegalMoves().length === 0) {
          return { ok: false, error: 'Bên đến lượt đã hết nước đi (ván đã kết thúc).' };
        }
      } catch (err) {
        return { ok: false, error: err instanceof FenError ? err.message : `FEN không hợp lệ: ${String(err)}` };
      }
      cancelSearch();
      setHintMove(null);
      setAnalysis(null);
      setLastError(null);
      setStartFen(normalized);
      setMoves([]);
      workerRef.current?.postMessage({ type: 'newgame' } satisfies WorkerRequest);
      return { ok: true };
    },
    [cancelSearch],
  );

  const requestHint = useCallback(() => {
    const current = gameRef.current;
    if (current.game.status.over || current.game.position.turn !== current.playerSide) return;
    setHintMove(null);
    startSearch('hint');
  }, [startSearch]);

  /** Yêu cầu máy đi ngay với nước tốt nhất tìm được tới lúc này (gửi `stop`, giữ searchId). */
  const forceMoveNow = useCallback(() => {
    const active = activeSearchRef.current;
    if (!active || active.applying) return;
    workerRef.current?.postMessage({ type: 'stop' } satisfies WorkerRequest);
  }, []);

  const stopThinking = useCallback(() => {
    cancelSearch();
  }, [cancelSearch]);

  const restartEngine = useCallback(
    (forceFallback = false) => {
      cancelSearch();
      setLastError(null);
      setLogs([]);
      spawnWorker(forceFallback);
    },
    [cancelSearch, spawnWorker],
  );

  const setDifficulty = useCallback((id: DifficultyId) => {
    setDifficultyId(id);
  }, []);

  const clearLogs = useCallback(() => setLogs([]), []);
  const dismissError = useCallback(() => setLastError(null), []);

  const startTurn: Side = game.fens[0]?.split(' ')[1] === 'b' ? 'b' : 'w';
  const canUndo = computeUndoTarget(startTurn, game.details.length, playerSide) !== null;
  const lastMove = game.details.length > 0 ? game.details[game.details.length - 1] : null;
  const currentFen = game.fens[game.fens.length - 1] ?? startFen;
  const isPlayerTurn = !game.status.over && game.position.turn === playerSide;

  return {
    // trạng thái ván cờ
    game,
    position: game.position,
    currentFen,
    startFen,
    moves,
    lastMove,
    playerSide,
    isPlayerTurn,
    canUndo,
    hintMove,
    // engine
    engine,
    analysis,
    thinking,
    logs,
    lastError,
    difficultyId,
    difficulty: getDifficulty(difficultyId),
    // hành động
    makeMove,
    undo,
    newGame,
    flipSide,
    loadFen,
    requestHint,
    forceMoveNow,
    stopThinking,
    restartEngine,
    setDifficulty,
    clearLogs,
    dismissError,
  };
}

export type XiangqiEngineApi = ReturnType<typeof useXiangqiEngine>;

import React, { useEffect, useState } from 'react';
import { DIFFICULTY_LEVELS } from '../lib/difficulty';
import { START_FEN, describeResult } from '../lib/xiangqi';
import type { EngineState } from '../hooks/useXiangqiEngine';
import type {
  AnalysisState,
  DifficultyId,
  DifficultyLevel,
  EngineLogEntry,
  EngineScore,
  GameStatus,
  SearchPurpose,
  Side,
  UciMove,
} from '../types/xiangqi';

export interface ControlsProps {
  engine: EngineState;
  status: GameStatus;
  turn: Side;
  playerSide: Side;
  isPlayerTurn: boolean;
  canUndo: boolean;
  thinking: SearchPurpose | null;
  difficultyId: DifficultyId;
  difficulty: DifficultyLevel;
  analysis: AnalysisState | null;
  currentFen: string;
  moves: UciMove[];
  notations: string[];
  logs: EngineLogEntry[];
  lastError: string | null;
  showPvArrow: boolean;
  onTogglePvArrow: () => void;
  onSelectDifficulty: (id: DifficultyId) => void;
  onUndo: () => void;
  onNewGame: () => void;
  onFlipSide: () => void;
  onRequestHint: () => void;
  onForceMoveNow: () => void;
  onStopThinking: () => void;
  onLoadFen: (fen: string) => { ok: true } | { ok: false; error: string };
  onRestartEngine: (forceFallback?: boolean) => void;
  onClearLogs: () => void;
  onDismissError: () => void;
}

interface FenPreset {
  name: string;
  description: string;
  fen: string;
}

const FEN_PRESETS: readonly FenPreset[] = [
  {
    name: 'Thế trận khởi đầu chuẩn',
    description: 'Bàn cờ 32 quân tiêu chuẩn, Đỏ đi trước',
    fen: START_FEN,
  },
  {
    name: 'Đơn Đao Phú Hội (Cờ thế sát cuộc)',
    description: 'Đỏ đi trước phối hợp Xe – Pháo – Tốt công sát',
    fen: '3ak1b2/4a4/4b4/9/9/9/9/3r5/4p4/2R1K4 w - - 0 1',
  },
  {
    name: 'Song Xa Công Cửu Cung',
    description: 'Đỏ cầm Song Xe – Mã công thành tốc thắng',
    fen: '2bakab2/9/4c4/p1p1p1p1p/9/2P6/P3P1P1P/2N1C4/9/1RBAKABR1 w - - 0 1',
  },
  {
    name: 'Trung cuộc Pháo Đầu đối Bình Phong Mã',
    description: 'Thế trận khai – trung cuộc kinh điển',
    fen: 'r1bakab1r/9/1cn4c1/p1p1p1p1p/9/2P6/P3P1P1P/1C2C1N2/9/RNBAKAB1R b - - 2 4',
  },
];

function formatScore(score: EngineScore | null, bound: 'lower' | 'upper' | null): {
  main: string;
  sub: string;
  redPercent: number;
  tone: 'red' | 'black' | 'neutral';
} {
  if (!score) {
    return { main: '0.00', sub: 'Chưa có đánh giá', redPercent: 50, tone: 'neutral' };
  }
  const boundSymbol = bound === 'lower' ? '≥ ' : bound === 'upper' ? '≤ ' : '';
  if (score.type === 'mate') {
    const n = score.value;
    if (n === 0) {
      return { main: 'Chiếu bí', sub: 'Đã chiếu bí', redPercent: 50, tone: 'neutral' };
    }
    const redWins = n > 0;
    return {
      main: `${boundSymbol}${redWins ? '+' : '-'}Bí ${Math.abs(n)}`,
      sub: `${redWins ? 'Đỏ' : 'Đen'} chiếu bí sau ${Math.abs(n)} nước`,
      redPercent: redWins ? 98 : 2,
      tone: redWins ? 'red' : 'black',
    };
  }
  const cp = score.value;
  const pawns = cp / 100;
  const sign = cp > 0 ? '+' : '';
  // Sigmoid quy đổi cp -> % thanh thế trận (4..96%)
  const redPercent = Math.round(Math.max(4, Math.min(96, 50 + 46 * Math.tanh(cp / 450))));
  const tone = cp > 25 ? 'red' : cp < -25 ? 'black' : 'neutral';
  return {
    main: `${boundSymbol}${sign}${pawns.toFixed(2)}`,
    sub: `${sign}${cp} điểm (${cp > 25 ? 'Đỏ ưu thế' : cp < -25 ? 'Đen ưu thế' : 'Cân bằng'})`,
    redPercent,
    tone,
  };
}

function formatNps(nps: number | null): string {
  if (nps === null || !Number.isFinite(nps)) return '—';
  if (nps >= 1_000_000) return `${(nps / 1_000_000).toFixed(2)} triệu/s`;
  if (nps >= 1_000) return `${(nps / 1_000).toFixed(1)} nghìn/s`;
  return `${nps} nút/s`;
}

function formatNodes(nodes: number | null): string {
  if (nodes === null || !Number.isFinite(nodes)) return '—';
  return nodes.toLocaleString('vi-VN');
}

export const Controls: React.FC<ControlsProps> = ({
  engine,
  status,
  turn,
  playerSide,
  isPlayerTurn,
  canUndo,
  thinking,
  difficultyId,
  difficulty,
  analysis,
  currentFen,
  moves,
  notations,
  logs,
  lastError,
  showPvArrow,
  onTogglePvArrow,
  onSelectDifficulty,
  onUndo,
  onNewGame,
  onFlipSide,
  onRequestHint,
  onForceMoveNow,
  onStopThinking,
  onLoadFen,
  onRestartEngine,
  onClearLogs,
  onDismissError,
}) => {
  const [fenInput, setFenInput] = useState<string>(currentFen);
  const [fenError, setFenError] = useState<string | null>(null);
  const [fenCopied, setFenCopied] = useState<boolean>(false);
  const [fenNotice, setFenNotice] = useState<string | null>(null);
  const [showUciLog, setShowUciLog] = useState<boolean>(false);
  const [pvMode, setPvMode] = useState<'vietnamese' | 'uci'>('vietnamese');

  useEffect(() => {
    setFenInput(currentFen);
    setFenError(null);
  }, [currentFen]);

  const evalFormatted = formatScore(analysis?.scoreRed ?? null, analysis?.bound ?? null);
  const depthProgress = analysis
    ? Math.min(100, Math.round((analysis.depth / Math.max(1, difficulty.depth)) * 100))
    : 0;

  const handleCopyFen = async () => {
    try {
      await navigator.clipboard.writeText(currentFen);
      setFenCopied(true);
      setTimeout(() => setFenCopied(false), 1800);
    } catch {
      setFenInput(currentFen);
      setFenNotice('Đã chọn chuỗi FEN trong ô nhập bên dưới.');
      setTimeout(() => setFenNotice(null), 2000);
    }
  };

  const handleApplyFen = (e: React.FormEvent) => {
    e.preventDefault();
    const res = onLoadFen(fenInput);
    if (!res.ok) {
      setFenError(res.error);
      setFenNotice(null);
    } else {
      setFenError(null);
      setFenNotice('Đã nạp thế cờ FEN thành công.');
      setTimeout(() => setFenNotice(null), 2200);
    }
  };

  // Ghép các nửa nước (ply) thành từng cặp (Đỏ - Đen) cho bảng biên bản
  const movePairs: { moveNumber: number; red?: { vn: string; uci: string }; black?: { vn: string; uci: string } }[] = [];
  for (let i = 0; i < moves.length; i += 2) {
    movePairs.push({
      moveNumber: Math.floor(i / 2) + 1,
      red: moves[i] ? { vn: notations[i] ?? moves[i], uci: moves[i] } : undefined,
      black: moves[i + 1] ? { vn: notations[i + 1] ?? moves[i + 1], uci: moves[i + 1] } : undefined,
    });
  }

  return (
    <div className="flex flex-col gap-4 w-full">
      {/* Cảnh báo lỗi nếu có */}
      {lastError && (
        <div
          role="alert"
          className="rounded-xl bg-red-50 border border-red-300 px-3.5 py-2.5 text-xs text-red-900 flex items-start justify-between gap-2 shadow-sm"
        >
          <div>
            <span className="font-semibold text-red-700">Thông báo bộ máy: </span>
            <span>{lastError}</span>
          </div>
          <button
            type="button"
            onClick={onDismissError}
            className="text-red-700 hover:text-red-950 px-2 py-0.5 rounded bg-red-100 hover:bg-red-200 font-medium shrink-0 cursor-pointer"
          >
            Đóng
          </button>
        </div>
      )}

      {/* 1. Bảng trạng thái ván đấu & điều khiển chính */}
      <section className="rounded-2xl bg-white border border-amber-200/90 p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-stone-200">
          <div className="flex items-center gap-2.5">
            <span
              className={`inline-block w-3.5 h-3.5 rounded-full ring-2 ${
                turn === 'w'
                  ? 'bg-red-600 ring-red-200 shadow-[0_0_8px_rgba(220,38,38,0.45)]'
                  : 'bg-stone-800 ring-stone-300 shadow-[0_0_8px_rgba(28,25,23,0.35)]'
              }`}
            />
            <div>
              <div className="text-sm font-bold text-stone-900">
                {status.over
                  ? describeResult(status)
                  : turn === playerSide
                    ? `Lượt của bạn (${playerSide === 'w' ? 'Quân Đỏ' : 'Quân Đen'})`
                    : `Máy đang suy nghĩ (${turn === 'w' ? 'Quân Đỏ' : 'Quân Đen'})…`}
              </div>
              <div className="text-xs text-stone-600">
                {status.inCheck && !status.over ? (
                  <span className="text-red-600 font-bold">⚡ Đang chiếu Tướng! </span>
                ) : null}
                <span>
                  Bạn cầm:{' '}
                  <strong className={playerSide === 'w' ? 'text-red-600' : 'text-stone-900'}>
                    {playerSide === 'w' ? 'Quân Đỏ (Đi tiên)' : 'Quân Đen (Đi hậu)'}
                  </strong>
                </span>
              </div>
            </div>
          </div>

          {/* Nhãn trạng thái Bộ máy */}
          <div className="flex items-center gap-1.5 text-xs">
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full font-semibold border ${
                engine.status === 'ready' && engine.backend === 'wasm'
                  ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
                  : engine.status === 'ready'
                    ? 'bg-amber-50 text-amber-800 border-amber-300'
                    : engine.status === 'loading'
                      ? 'bg-sky-50 text-sky-800 border-sky-300 animate-pulse'
                      : 'bg-red-50 text-red-800 border-red-300'
              }`}
              title={engine.message}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  engine.status === 'ready'
                    ? engine.backend === 'wasm'
                      ? 'bg-emerald-500'
                      : 'bg-amber-500'
                    : engine.status === 'loading'
                      ? 'bg-sky-500'
                      : 'bg-red-500'
                }`}
              />
              {engine.status === 'loading'
                ? 'Đang nạp bộ máy…'
                : engine.backend === 'wasm'
                  ? 'WASM · Ngoại tuyến'
                  : engine.backend === 'fallback'
                    ? 'Bộ máy JS · Ngoại tuyến'
                    : 'Lỗi bộ máy'}
            </span>
          </div>
        </div>

        {/* Các nút điều khiển ván cờ */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
          <button
            type="button"
            onClick={onUndo}
            disabled={!canUndo}
            title="Hủy ngay lượt tính của máy và lùi lại nước đi"
            className="flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-semibold bg-stone-100 hover:bg-stone-200 disabled:opacity-40 disabled:pointer-events-none text-stone-800 border border-stone-300 transition cursor-pointer"
          >
            <span>↩</span>
            <span>Đi lại</span>
          </button>

          <button
            type="button"
            onClick={onNewGame}
            title="Dừng bộ máy và bắt đầu ván cờ mới"
            className="flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-semibold bg-amber-600 hover:bg-amber-700 text-white border border-amber-700/30 shadow-xs transition cursor-pointer"
          >
            <span>⟳</span>
            <span>Ván mới</span>
          </button>

          <button
            type="button"
            onClick={onFlipSide}
            title="Lật bàn cờ và đổi bên cầm quân (Đỏ <-> Đen)"
            className="flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-semibold bg-stone-100 hover:bg-stone-200 text-stone-800 border border-stone-300 transition cursor-pointer"
          >
            <span>⇅</span>
            <span>Đổi sang {playerSide === 'w' ? 'Đen' : 'Đỏ'}</span>
          </button>

          {thinking === 'play' ? (
            <button
              type="button"
              onClick={onForceMoveNow}
              title="Yêu cầu máy dừng tính thêm và đi ngay nước tốt nhất hiện tại"
              className="flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-semibold bg-rose-600 hover:bg-rose-700 text-white border border-rose-700/30 transition cursor-pointer animate-pulse"
            >
              <span>⏹</span>
              <span>Đi ngay</span>
            </button>
          ) : thinking === 'hint' ? (
            <button
              type="button"
              onClick={onStopThinking}
              className="flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-semibold bg-rose-600 hover:bg-rose-700 text-white border border-rose-700/30 transition cursor-pointer"
            >
              <span>⏹</span>
              <span>Dừng gợi ý</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={onRequestHint}
              disabled={!isPlayerTurn || status.over || engine.status !== 'ready'}
              title="Nhờ bộ máy phân tích và gợi ý nước đi tốt nhất cho bạn"
              className="flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 disabled:pointer-events-none text-white border border-emerald-700/30 shadow-xs transition cursor-pointer"
            >
              <span>💡</span>
              <span>Gợi ý nước</span>
            </button>
          )}
        </div>
      </section>

      {/* 2. Chọn cấp độ tính toán (Depth Levels) */}
      <section className="rounded-2xl bg-white border border-amber-200/90 p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
          <div>
            <h2 className="text-xs font-bold uppercase tracking-wider text-amber-800">
              Cấp độ khó & Độ sâu tính toán
            </h2>
            <p className="text-[11px] text-stone-500">
              Độ sâu tìm kiếm: <strong className="text-stone-800">{difficulty.depth} tầng</strong> (phản hồi{' '}
              {difficulty.expectedTime})
            </p>
          </div>
          <select
            aria-label="Chọn cấp độ khó"
            value={difficultyId}
            onChange={(e) => onSelectDifficulty(e.target.value as DifficultyId)}
            className="bg-amber-50/70 text-stone-800 text-xs font-semibold rounded-lg px-2.5 py-1.5 border border-amber-300 focus:outline-none focus:border-amber-600 cursor-pointer"
          >
            {DIFFICULTY_LEVELS.map((lvl) => (
              <option key={lvl.id} value={lvl.id}>
                {lvl.label} ({lvl.subtitle}) — Độ sâu {lvl.depth}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {DIFFICULTY_LEVELS.map((lvl) => {
            const active = lvl.id === difficultyId;
            return (
              <button
                key={lvl.id}
                type="button"
                onClick={() => onSelectDifficulty(lvl.id)}
                className={`text-left rounded-xl p-2.5 border transition cursor-pointer ${
                  active
                    ? 'bg-amber-50 border-amber-500 text-stone-900 shadow-xs ring-1 ring-amber-500/30'
                    : 'bg-stone-50 border-stone-200 text-stone-700 hover:bg-amber-50/40 hover:border-amber-300'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold">{lvl.label}</span>
                  <span
                    className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                      active ? 'bg-amber-600 text-white font-bold' : 'bg-stone-200 text-stone-700'
                    }`}
                  >
                    Độ sâu {lvl.depth}
                  </span>
                </div>
                <div className="text-[10px] text-stone-500 mt-0.5 truncate">{lvl.subtitle}</div>
                <div className="text-[10px] text-amber-800 font-medium mt-0.5">{lvl.expectedTime}</div>
              </button>
            );
          })}
        </div>
      </section>

      {/* 3. Bảng phân tích trạng thái thời gian thực */}
      <section className="rounded-2xl bg-white border border-amber-200/90 p-4 shadow-sm">
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-bold uppercase tracking-wider text-amber-800">
              Phân tích thế trận thời gian thực
            </h2>
          </div>
          <label className="inline-flex items-center gap-1.5 text-[11px] text-stone-700 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showPvArrow}
              onChange={onTogglePvArrow}
              className="accent-amber-600 rounded cursor-pointer"
            />
            <span>Hiện mũi tên gợi ý</span>
          </label>
        </div>

        {/* Thanh đánh giá thế trận Đỏ / Đen */}
        <div className="mb-3">
          <div className="flex justify-between text-[11px] font-semibold mb-1">
            <span className="text-red-600">Đỏ ({evalFormatted.redPercent}%)</span>
            <span className="text-stone-700 font-mono">{evalFormatted.sub}</span>
            <span className="text-stone-800">Đen ({100 - evalFormatted.redPercent}%)</span>
          </div>
          <div className="w-full h-2.5 rounded-full bg-stone-200 overflow-hidden flex border border-stone-300">
            <div
              className="bg-gradient-to-r from-red-600 to-red-500 transition-all duration-300"
              style={{ width: `${evalFormatted.redPercent}%` }}
            />
            <div
              className="bg-gradient-to-r from-stone-600 to-stone-800 transition-all duration-300"
              style={{ width: `${100 - evalFormatted.redPercent}%` }}
            />
          </div>
        </div>

        {/* 3 chỉ số chính: Độ sâu, Điểm thế trận, Tốc độ duyệt */}
        <div className="grid grid-cols-3 gap-2.5 mb-3">
          <div className="rounded-xl bg-amber-50/50 border border-amber-200/80 p-2.5">
            <div className="text-[10px] uppercase tracking-wider text-stone-500 font-semibold">Độ sâu đang tính</div>
            <div className="text-base sm:text-lg font-bold font-mono text-amber-900 mt-0.5">
              {analysis && analysis.depth > 0 ? (
                <>
                  {analysis.depth}
                  <span className="text-xs text-stone-500 font-normal">
                    /{analysis.seldepth ?? analysis.depth} (mục tiêu {difficulty.depth})
                  </span>
                </>
              ) : (
                '—'
              )}
            </div>
            <div className="w-full h-1.5 bg-amber-100 rounded-full overflow-hidden mt-1.5">
              <div
                className="h-full bg-amber-600 transition-all duration-200"
                style={{ width: `${depthProgress}%` }}
              />
            </div>
          </div>

          <div className="rounded-xl bg-amber-50/50 border border-amber-200/80 p-2.5">
            <div className="text-[10px] uppercase tracking-wider text-stone-500 font-semibold">Điểm thế trận</div>
            <div
              className={`text-base sm:text-lg font-bold font-mono mt-0.5 ${
                evalFormatted.tone === 'red'
                  ? 'text-red-600'
                  : evalFormatted.tone === 'black'
                    ? 'text-sky-700'
                    : 'text-stone-800'
              }`}
            >
              {analysis?.scoreRed ? evalFormatted.main : '—'}
            </div>
            <div className="text-[10px] text-stone-500 truncate mt-0.5">
              {analysis?.scoreRed
                ? analysis.scoreRed.type === 'cp'
                  ? `Điểm thô: ${analysis.scoreRed.value > 0 ? '+' : ''}${analysis.scoreRed.value} cp`
                  : `Chiếu bí sau ${Math.abs(analysis.scoreRed.value)} nước`
                : 'Tính theo góc nhìn quân Đỏ'}
            </div>
          </div>

          <div className="rounded-xl bg-amber-50/50 border border-amber-200/80 p-2.5">
            <div className="text-[10px] uppercase tracking-wider text-stone-500 font-semibold">Tốc độ duyệt</div>
            <div className="text-base sm:text-lg font-bold font-mono text-emerald-700 mt-0.5">
              {formatNps(analysis?.nps ?? null)}
            </div>
            <div className="text-[10px] text-stone-500 truncate mt-0.5">
              Số nút: {formatNodes(analysis?.nodes ?? null)}
              {analysis?.timeMs ? ` · ${(analysis.timeMs / 1000).toFixed(2)}s` : ''}
            </div>
          </div>
        </div>

        {/* Nước đi gợi ý / Biến chính (PV) */}
        <div className="rounded-xl bg-stone-50 border border-stone-200 p-2.5">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <span className="text-[10px] uppercase tracking-wider text-stone-600 font-semibold">
              Chuỗi nước đi dự kiến (Biến chính)
            </span>
            <div className="inline-flex rounded-md bg-stone-200/80 p-0.5 text-[10px]">
              <button
                type="button"
                onClick={() => setPvMode('vietnamese')}
                className={`px-2 py-0.5 rounded cursor-pointer ${
                  pvMode === 'vietnamese' ? 'bg-amber-600 text-white font-bold' : 'text-stone-700'
                }`}
              >
                Ký hiệu Việt
              </button>
              <button
                type="button"
                onClick={() => setPvMode('uci')}
                className={`px-2 py-0.5 rounded cursor-pointer ${
                  pvMode === 'uci' ? 'bg-amber-600 text-white font-bold' : 'text-stone-700'
                }`}
              >
                Tọa độ ô
              </button>
            </div>
          </div>

          {analysis && analysis.pv.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 text-xs font-mono">
              {(pvMode === 'vietnamese' && analysis.pvNotation.length > 0 ? analysis.pvNotation : analysis.pv).map(
                (step, idx) => (
                  <span
                    key={`${idx}-${step}`}
                    className={`px-2 py-0.5 rounded border ${
                      idx === 0
                        ? 'bg-amber-100 border-amber-400 text-amber-950 font-bold'
                        : 'bg-white border-stone-300 text-stone-700'
                    }`}
                    title={`Tọa độ: ${analysis.pv[idx] ?? ''}`}
                  >
                    <span className="text-stone-400 mr-1">{idx + 1}.</span>
                    {step}
                  </span>
                ),
              )}
            </div>
          ) : (
            <div className="text-xs text-stone-500 italic">
              Chưa có dữ liệu phân tích — hãy đi một nước hoặc bấm &ldquo;Gợi ý nước&rdquo;.
            </div>
          )}
        </div>
      </section>

      {/* 4. Tải / Xuất thế cờ dạng chuỗi FEN */}
      <section className="rounded-2xl bg-white border border-amber-200/90 p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <h2 className="text-xs font-bold uppercase tracking-wider text-amber-800">
            Tải / Xuất Thế Cờ (Chuỗi FEN)
          </h2>
          <div className="flex items-center gap-1.5">
            <select
              aria-label="Chọn thế cờ mẫu"
              value=""
              onChange={(e) => {
                const chosen = e.target.value;
                if (!chosen) return;
                setFenInput(chosen);
                const res = onLoadFen(chosen);
                if (!res.ok) setFenError(res.error);
                else {
                  setFenError(null);
                  setFenNotice('Đã nạp thế cờ mẫu.');
                  setTimeout(() => setFenNotice(null), 2000);
                }
              }}
              className="bg-stone-100 text-stone-800 text-[11px] font-medium rounded-lg px-2 py-1 border border-stone-300 cursor-pointer"
            >
              <option value="">+ Chọn thế cờ mẫu…</option>
              {FEN_PRESETS.map((preset) => (
                <option key={preset.name} value={preset.fen}>
                  {preset.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleCopyFen}
              className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-300 cursor-pointer"
            >
              {fenCopied ? '✓ Đã chép FEN' : 'Sao chép FEN'}
            </button>
          </div>
        </div>

        <form onSubmit={handleApplyFen} className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={fenInput}
            onChange={(e) => {
              setFenInput(e.target.value);
              if (fenError) setFenError(null);
            }}
            placeholder="Nhập chuỗi FEN Cờ Tướng…"
            aria-label="Chuỗi FEN"
            className="flex-1 rounded-xl bg-stone-50 border border-stone-300 px-3 py-2 text-xs font-mono text-stone-800 focus:outline-none focus:border-amber-600 focus:bg-white"
          />
          <button
            type="submit"
            className="px-3.5 py-2 rounded-xl text-xs font-semibold bg-amber-600 hover:bg-amber-700 text-white transition shrink-0 cursor-pointer"
          >
            Nạp thế cờ FEN
          </button>
        </form>

        {fenError && <p className="text-xs text-red-600 font-medium mt-1.5">{fenError}</p>}
        {fenNotice && <p className="text-xs text-emerald-700 font-medium mt-1.5">{fenNotice}</p>}
      </section>

      {/* 5. Biên bản ván cờ & Nhật ký giao thức bộ máy */}
      <section className="rounded-2xl bg-white border border-amber-200/90 p-4 shadow-sm">
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setShowUciLog(false)}
              className={`text-xs font-bold uppercase tracking-wider px-2.5 py-1 rounded-lg cursor-pointer transition ${
                !showUciLog
                  ? 'bg-amber-100 text-amber-900 border border-amber-400'
                  : 'text-stone-500 hover:bg-stone-100'
              }`}
            >
              Biên bản ({moves.length} nước)
            </button>
            <button
              type="button"
              onClick={() => setShowUciLog(true)}
              className={`text-xs font-bold uppercase tracking-wider px-2.5 py-1 rounded-lg cursor-pointer transition ${
                showUciLog
                  ? 'bg-amber-100 text-amber-900 border border-amber-400'
                  : 'text-stone-500 hover:bg-stone-100'
              }`}
            >
              Nhật ký bộ máy ({logs.length})
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            {showUciLog && logs.length > 0 && (
              <button
                type="button"
                onClick={onClearLogs}
                className="text-[11px] px-2 py-0.5 rounded bg-stone-100 hover:bg-stone-200 text-stone-700 border border-stone-300 cursor-pointer"
              >
                Xoá nhật ký
              </button>
            )}
            <button
              type="button"
              onClick={() => onRestartEngine(engine.backend === 'wasm')}
              title={
                engine.backend === 'wasm'
                  ? 'Chuyển thử sang Bộ máy JS dự phòng'
                  : 'Thử nạp lại bộ máy Fairy-Stockfish WebAssembly'
              }
              className="text-[11px] px-2.5 py-1 rounded-lg bg-stone-100 hover:bg-stone-200 text-stone-700 border border-stone-300 font-medium cursor-pointer"
            >
              {engine.backend === 'wasm' ? 'Đổi sang Bộ máy JS' : 'Nạp lại WASM'}
            </button>
          </div>
        </div>

        {!showUciLog ? (
          <div className="max-h-44 overflow-y-auto rounded-xl bg-stone-50 border border-stone-200 p-2 text-xs font-mono">
            {movePairs.length === 0 ? (
              <div className="text-stone-500 italic py-3 text-center">
                Chưa có nước đi nào. Hãy nhấp vào quân cờ trên bàn để bắt đầu.
              </div>
            ) : (
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="text-[10px] uppercase text-stone-500 border-b border-stone-200">
                    <th className="py-1 px-2 w-10">#</th>
                    <th className="py-1 px-2 text-red-600">Đỏ (Đi tiên)</th>
                    <th className="py-1 px-2 text-stone-800">Đen (Đi hậu)</th>
                  </tr>
                </thead>
                <tbody>
                  {movePairs.map((pair) => (
                    <tr key={pair.moveNumber} className="border-b border-stone-200/70 last:border-0">
                      <td className="py-1 px-2 text-stone-500">{pair.moveNumber}.</td>
                      <td className="py-1 px-2 text-red-700 font-medium">
                        {pair.red ? (
                          <>
                            <span>{pair.red.vn}</span>
                            <span className="text-[10px] text-stone-400 ml-1.5">({pair.red.uci})</span>
                          </>
                        ) : (
                          ''
                        )}
                      </td>
                      <td className="py-1 px-2 text-stone-800 font-medium">
                        {pair.black ? (
                          <>
                            <span>{pair.black.vn}</span>
                            <span className="text-[10px] text-stone-400 ml-1.5">({pair.black.uci})</span>
                          </>
                        ) : (
                          ''
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : (
          <div className="max-h-44 overflow-y-auto rounded-xl bg-stone-50 border border-stone-200 p-2.5 text-[11px] font-mono space-y-1">
            {logs.length === 0 ? (
              <div className="text-stone-500 italic py-2 text-center">Chưa có thông điệp giao thức.</div>
            ) : (
              logs.slice(-80).map((entry) => (
                <div
                  key={entry.id}
                  className={
                    entry.direction === 'send'
                      ? 'text-amber-800'
                      : entry.direction === 'system'
                        ? 'text-sky-700'
                        : 'text-emerald-800'
                  }
                >
                  <span className="text-stone-400 mr-1.5 font-semibold">
                    {entry.direction === 'send' ? 'GỬI→MÁY' : entry.direction === 'system' ? 'HỆ THỐNG' : 'MÁY→UI'}
                  </span>
                  <span className="break-all">{entry.line}</span>
                </div>
              ))
            )}
          </div>
        )}
      </section>
    </div>
  );
};

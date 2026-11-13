import React, { useEffect, useRef, useState } from 'react';
import { Board } from './components/Board';
import { Controls } from './components/Controls';
import { useXiangqiEngine } from './hooks/useXiangqiEngine';
import { describeResult } from './lib/xiangqi';

export const App: React.FC = () => {
  const {
    game,
    position,
    currentFen,
    moves,
    lastMove,
    playerSide,
    isPlayerTurn,
    canUndo,
    hintMove,
    engine,
    analysis,
    thinking,
    logs,
    lastError,
    difficultyId,
    difficulty,
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
  } = useXiangqiEngine();

  const [showPvArrow, setShowPvArrow] = useState<boolean>(true);
  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );

  // Tự động xóa trạng thái bàn cờ cũ và làm mới bàn cờ mỗi khi tải lại trang (F5)
  const didResetOnMount = useRef(false);
  useEffect(() => {
    if (didResetOnMount.current) return;
    didResetOnMount.current = true;

    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && /xiangqi|cotuong|game|board|fen|state/i.test(key)) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach((k) => localStorage.removeItem(k));
    } catch {
      // Bỏ qua nếu trình duyệt chặn localStorage
    }

    newGame();
  }, [newGame]);

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  // Phím tắt Ctrl+Z -> Đi lại
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        e.preventDefault();
        if (canUndo) undo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canUndo, undo]);

  const pvPreviewMove = showPvArrow && analysis && analysis.pv.length > 0 ? analysis.pv[0] : null;
  const topSide = playerSide === 'w' ? 'b' : 'w';
  const bottomSide = playerSide;

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#fdfaf3] via-[#f8f2e4] to-[#efe6d2] text-stone-800 flex flex-col">
      {/* Thanh tiêu đề trên cùng */}
      <header className="border-b border-amber-200/90 bg-white/90 backdrop-blur-md sticky top-0 z-20 shadow-xs">
        <div className="max-w-7xl mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-amber-100 to-amber-300 flex items-center justify-center shadow-xs border-2 border-red-700">
              <span className="text-red-700 font-extrabold text-sm tracking-tight select-none">TƯỚNG</span>
            </div>
            <div>
              <h1 className="text-base sm:text-lg font-bold tracking-wide text-stone-900 flex items-center gap-2">
                <span>Cờ Tướng Đại Sư</span>
                <span className="hidden sm:inline-block text-[10px] font-semibold uppercase px-2 py-0.5 rounded bg-amber-100 text-amber-900 border border-amber-300">
                  100% Ngoại tuyến
                </span>
              </h1>
              <p className="text-xs text-stone-500">
                Bộ máy Fairy-Stockfish WebAssembly chạy trên luồng Web Worker độc lập
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <span
              className={`px-2.5 py-1 rounded-full font-semibold border ${
                isOnline
                  ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
                  : 'bg-amber-100 text-amber-900 border-amber-400'
              }`}
            >
              {isOnline ? '● Sẵn sàng ngoại tuyến' : '● Đang chạy ngoại tuyến'}
            </span>
            <span className="hidden md:inline-block px-2.5 py-1 rounded-full bg-stone-100 border border-stone-300 text-stone-700 font-medium">
              {engine.engineName ?? 'Đang khởi tạo bộ máy…'}
            </span>
          </div>
        </div>
      </header>

      {/* Nội dung chính: Bàn cờ bên trái + Bảng phân tích & điều khiển bên phải */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-3 sm:px-6 py-5 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Cột bàn cờ */}
        <div className="lg:col-span-7 flex flex-col items-center gap-2.5">
          {/* Thông tin người chơi phía trên (Máy) */}
          <div className="w-full max-w-[640px] flex items-center justify-between px-3.5 py-2.5 rounded-xl bg-white border border-amber-200/90 shadow-xs text-xs">
            <div className="flex items-center gap-2.5">
              <span
                className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs border-2 ${
                  topSide === 'w'
                    ? 'bg-red-50 text-red-700 border-red-600'
                    : 'bg-stone-100 text-stone-900 border-stone-700'
                }`}
              >
                {topSide === 'w' ? 'ĐỎ' : 'ĐEN'}
              </span>
              <div>
                <div className="font-bold text-stone-900">
                  Máy ({engine.backend === 'wasm' ? 'Fairy-Stockfish - WASM' : 'Bộ máy JS'})
                </div>
                <div className="text-[11px] text-stone-500">
                  {difficulty.label} (Depth {difficulty.depth}) {topSide === 'w' ? 'Quân Đỏ · Đi tiên' : 'Quân Đen · Đi hậu'}
                </div>
              </div>
            </div>
            <div>
              {thinking === 'play' ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] leading-tight rounded-full bg-amber-100 text-amber-900 border border-amber-300 font-semibold">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-600 animate-ping" />
                  Suy nghĩ...
                </span>
              ) : (
                <span className="text-stone-500 font-medium">Chờ lượt</span>
              )}
            </div>
          </div>

          {/* Bàn cờ SVG */}
          <Board
            position={position}
            playerSide={playerSide}
            isPlayerTurn={isPlayerTurn}
            lastMove={lastMove}
            hintMove={hintMove}
            pvPreviewMove={pvPreviewMove}
            disabled={game.status.over}
            onMove={makeMove}
          />

          {/* Thông tin người chơi phía dưới (Bạn) */}
          <div className="w-full max-w-[640px] flex items-center justify-between px-3.5 py-2.5 rounded-xl bg-white border border-amber-200/90 shadow-xs text-xs">
            <div className="flex items-center gap-2.5">
              <span
                className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs border-2 ${
                  bottomSide === 'w'
                    ? 'bg-red-50 text-red-700 border-red-600'
                    : 'bg-stone-100 text-stone-900 border-stone-700'
                }`}
              >
                {bottomSide === 'w' ? 'ĐỎ' : 'ĐEN'}
              </span>
              <div>
                <div className="font-bold text-stone-900">
                  Người chơi ({bottomSide === 'w' ? 'Quân Đỏ · Đi tiên' : 'Quân Đen · Đi hậu'})
                </div>
                <div className="text-[11px] text-stone-500">
                  Kéo thả hoặc nhấp chọn để đi
                </div>
              </div>
            </div>
            <div>
              {game.status.over ? (
                <span className="px-2.5 py-1 rounded-full bg-amber-100 text-amber-900 font-bold border border-amber-400">
                  {describeResult(game.status)}
                </span>
              ) : isPlayerTurn ? (
                <span className="px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-800 font-bold border border-emerald-300">
                  Đến lượt bạn
                </span>
              ) : (
                <span className="text-stone-500 font-medium">Đợi máy đi</span>
              )}
            </div>
          </div>
        </div>

        {/* Cột điều khiển & bảng phân tích thời gian thực */}
        <div className="lg:col-span-5 w-full">
          <Controls
            engine={engine}
            status={game.status}
            turn={position.turn}
            playerSide={playerSide}
            isPlayerTurn={isPlayerTurn}
            canUndo={canUndo}
            thinking={thinking}
            difficultyId={difficultyId}
            difficulty={difficulty}
            analysis={analysis}
            currentFen={currentFen}
            moves={moves}
            notations={game.notations}
            logs={logs}
            lastError={lastError}
            showPvArrow={showPvArrow}
            onTogglePvArrow={() => setShowPvArrow((v) => !v)}
            onSelectDifficulty={setDifficulty}
            onUndo={undo}
            onNewGame={newGame}
            onFlipSide={flipSide}
            onRequestHint={requestHint}
            onForceMoveNow={forceMoveNow}
            onStopThinking={stopThinking}
            onLoadFen={loadFen}
            onRestartEngine={restartEngine}
            onClearLogs={clearLogs}
            onDismissError={dismissError}
          />
        </div>
      </main>
    </div>
  );
};

export default App;
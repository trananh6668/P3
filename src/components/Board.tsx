import React, { useEffect, useMemo, useState } from 'react';
import {
  BLACK_NAMES,
  BOARD_SIZE,
  COLS,
  RED_NAMES,
  ROWS,
  VIETNAMESE_NAMES,
  colOf,
  encodeMove,
  moveTo,
  moveToUci,
  parseUciMove,
  rowOf,
  squareToUci,
  type Position,
} from '../lib/xiangqi';
import type { MoveDetail, Piece, Side, Square, UciMove } from '../types/xiangqi';

export interface BoardProps {
  position: Position;
  playerSide: Side;
  isPlayerTurn: boolean;
  lastMove: MoveDetail | null;
  hintMove: UciMove | null;
  pvPreviewMove: UciMove | null;
  disabled?: boolean;
  onMove: (uci: UciMove) => boolean;
}

// ───────────────────── Hằng số hình học bàn cờ SVG ─────────────────────

const CELL = 68;
const PAD_X = 64;
const PAD_Y = 64;
const GRID_W = (COLS - 1) * CELL; // 8 * 68 = 544
const GRID_H = (ROWS - 1) * CELL; // 9 * 68 = 612
const SVG_W = GRID_W + PAD_X * 2; // 672
const SVG_H = GRID_H + PAD_Y * 2; // 740
const PIECE_R = 29;

/** Tọa độ điểm giao (r, c) theo góc nhìn hiện tại (đã xét lật bàn cờ). */
function gridXY(row: number, col: number, flipped: boolean): { x: number; y: number } {
  const vr = flipped ? ROWS - 1 - row : row;
  const vc = flipped ? COLS - 1 - col : col;
  return {
    x: PAD_X + vc * CELL,
    y: PAD_Y + vr * CELL,
  };
}

function squareXY(sq: Square, flipped: boolean): { x: number; y: number } {
  return gridXY(rowOf(sq), colOf(sq), flipped);
}

/**
 * Tạo đường dẫn SVG cho hoa văn chữ L tại các vị trí Pháo và Tốt.
 * Tự động lược bỏ nửa trái hoặc nửa phải khi nằm ở biên (cột 0 hoặc cột 8).
 */
function buildFiducialPath(row: number, col: number, flipped: boolean): string {
  const { x, y } = gridXY(row, col, flipped);
  const gap = 5;
  const len = 13;
  // Khi lật bàn cờ, cột 0 (biên trái gốc) chuyển sang biên phải trên màn hình
  const visualCol = flipped ? COLS - 1 - col : col;
  const showLeft = visualCol > 0;
  const showRight = visualCol < COLS - 1;
  const parts: string[] = [];

  if (showLeft) {
    // Góc trên-trái
    parts.push(`M ${x - gap - len} ${y - gap} L ${x - gap} ${y - gap} L ${x - gap} ${y - gap - len}`);
    // Góc dưới-trái
    parts.push(`M ${x - gap - len} ${y + gap} L ${x - gap} ${y + gap} L ${x - gap} ${y + gap + len}`);
  }
  if (showRight) {
    // Góc trên-phải
    parts.push(`M ${x + gap + len} ${y - gap} L ${x + gap} ${y - gap} L ${x + gap} ${y - gap - len}`);
    // Góc dưới-phải
    parts.push(`M ${x + gap + len} ${y + gap} L ${x + gap} ${y + gap} L ${x + gap} ${y + gap + len}`);
  }
  return parts.join(' ');
}

const FIDUCIAL_COORDS: readonly (readonly [number, number])[] = [
  // Vị trí Pháo Đen & Đỏ
  [2, 1],
  [2, 7],
  [7, 1],
  [7, 7],
  // Vị trí Tốt Đen
  [3, 0],
  [3, 2],
  [3, 4],
  [3, 6],
  [3, 8],
  // Vị trí Tốt Đỏ
  [6, 0],
  [6, 2],
  [6, 4],
  [6, 6],
  [6, 8],
];

const CN_FILE_LABELS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const AR_FILE_LABELS = ['１', '２', '３', '４', '５', '６', '７', '８', '９'];

export const Board: React.FC<BoardProps> = ({
  position,
  playerSide,
  isPlayerTurn,
  lastMove,
  hintMove,
  pvPreviewMove,
  disabled = false,
  onMove,
}) => {
  const flipped = playerSide === 'b';
  const [selectedSq, setSelectedSq] = useState<Square | null>(null);

  // Reset ô đang chọn khi thế cờ hoặc bên cầm quân thay đổi
  const fenKey = position.toFen();
  useEffect(() => {
    setSelectedSq(null);
  }, [fenKey, playerSide]);

  // Các ô đích hợp lệ từ ô đang chọn
  const legalTargets = useMemo(() => {
    const map = new Map<Square, UciMove>();
    if (selectedSq === null || !isPlayerTurn || disabled) return map;
    const piece = position.pieceAt(selectedSq);
    if (!piece || piece.side !== playerSide) return map;
    for (const m of position.legalMovesFrom(selectedSq)) {
      map.set(moveTo(m), moveToUci(m));
    }
    return map;
  }, [position, selectedSq, isPlayerTurn, disabled, playerSide]);

  // Kiểm tra Tướng có đang bị chiếu không
  const checkedKingSq = useMemo<Square | null>(() => {
    if (!position.inCheck(position.turn)) return null;
    return position.kingSq[position.turn === 'w' ? 0 : 1];
  }, [position]);

  // Phân tích mũi tên gợi ý (hintMove hoặc nước đầu của PV)
  const arrowMove = useMemo(() => {
    const uci = hintMove ?? pvPreviewMove;
    if (!uci) return null;
    const parsed = parseUciMove(uci);
    if (!parsed) return null;
    return {
      from: parsed.from,
      to: parsed.to,
      isHint: Boolean(hintMove),
    };
  }, [hintMove, pvPreviewMove]);

  const handleSquareClick = (sq: Square) => {
    if (disabled || !isPlayerTurn) return;

    // Nếu người chơi bấm vào một ô đích hợp lệ từ quân đang chọn -> đi luôn
    if (selectedSq !== null && legalTargets.has(sq)) {
      const uci = legalTargets.get(sq)!;
      setSelectedSq(null);
      onMove(uci);
      return;
    }

    // Nếu bấm vào quân của mình -> chọn (hoặc bỏ chọn nếu bấm lại chính nó)
    const piece = position.pieceAt(sq);
    if (piece && piece.side === playerSide) {
      setSelectedSq((prev) => (prev === sq ? null : sq));
      return;
    }

    // Bấm vào ô trống không hợp lệ hoặc quân đối phương ngoài tầm ăn -> bỏ chọn
    if (selectedSq !== null) {
      // Thử kiểm tra xem có phải nước hợp lệ không (phòng trường hợp cache)
      const uci = moveToUci(encodeMove(selectedSq, sq));
      if (position.findLegalMove(uci) !== null) {
        setSelectedSq(null);
        onMove(uci);
        return;
      }
      setSelectedSq(null);
    }
  };

  // Danh sách quân cờ hiện có trên bàn
  const pieces: { sq: Square; piece: Piece }[] = [];
  for (let sq = 0; sq < BOARD_SIZE; sq++) {
    const p = position.pieceAt(sq);
    if (p) pieces.push({ sq, piece: p });
  }

  return (
    <div className="relative select-none w-full max-w-[640px] mx-auto">
      <div className="rounded-2xl p-2 sm:p-3 bg-gradient-to-br from-[#8c5828] via-[#6e421c] to-[#522f12] shadow-[0_14px_34px_rgba(92,53,18,0.28)] ring-1 ring-amber-800/30">
        <svg
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          className="w-full h-auto block rounded-xl shadow-inner"
          role="grid"
          aria-label="Bàn cờ Tướng 9 cột 10 hàng"
        >
          <defs>
            {/* Vân gỗ mặt bàn cờ */}
            <linearGradient id="xq-wood-surface" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#f3d59b" />
              <stop offset="35%" stopColor="#e7be78" />
              <stop offset="70%" stopColor="#dead62" />
              <stop offset="100%" stopColor="#cf984c" />
            </linearGradient>

            <linearGradient id="xq-river-tint" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#c58c3e" stopOpacity="0.16" />
              <stop offset="50%" stopColor="#f8e3b4" stopOpacity="0.28" />
              <stop offset="100%" stopColor="#c58c3e" stopOpacity="0.16" />
            </linearGradient>

            {/* Quân cờ Đỏ — ngà voi chạm khắc son đỏ */}
            <radialGradient id="xq-piece-red" cx="35%" cy="30%" r="70%">
              <stop offset="0%" stopColor="#fffaf0" />
              <stop offset="55%" stopColor="#f7dfc0" />
              <stop offset="90%" stopColor="#dfb685" />
              <stop offset="100%" stopColor="#b8844c" />
            </radialGradient>

            {/* Quân cờ Đen — gỗ mun / ngà cổ chạm khắc mực tàu */}
            <radialGradient id="xq-piece-black" cx="35%" cy="30%" r="70%">
              <stop offset="0%" stopColor="#fdf6e6" />
              <stop offset="55%" stopColor="#efd4ad" />
              <stop offset="90%" stopColor="#d1a673" />
              <stop offset="100%" stopColor="#9f6e3b" />
            </radialGradient>

            {/* Bóng đổ cho quân cờ */}
            <filter id="xq-piece-shadow" x="-25%" y="-20%" width="150%" height="155%">
              <feDropShadow dx="0" dy="3.5" stdDeviation="2.6" floodColor="#1f1005" floodOpacity="0.52" />
            </filter>

            {/* Hiệu ứng phát sáng khi chọn hoặc bị chiếu */}
            <filter id="xq-glow-red" x="-40%" y="-40%" width="180%" height="180%">
              <feDropShadow dx="0" dy="0" stdDeviation="5" floodColor="#ef4444" floodOpacity="0.9" />
            </filter>

            {/* Đầu mũi tên cho nước gợi ý / PV */}
            <marker
              id="xq-arrow-hint"
              viewBox="0 0 10 10"
              refX="7"
              refY="5"
              markerWidth="5.5"
              markerHeight="5.5"
              orient="auto-start-reverse"
            >
              <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="#10b981" />
            </marker>
            <marker
              id="xq-arrow-pv"
              viewBox="0 0 10 10"
              refX="7"
              refY="5"
              markerWidth="5.5"
              markerHeight="5.5"
              orient="auto-start-reverse"
            >
              <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="#f59e0b" />
            </marker>
          </defs>

          {/* Nền mặt bàn cờ */}
          <rect x="0" y="0" width={SVG_W} height={SVG_H} rx="14" fill="url(#xq-wood-surface)" />

          {/* Các đường vân gỗ trang trí tinh tế */}
          <g stroke="#8c5422" strokeOpacity="0.08" strokeWidth="1.4" fill="none" pointerEvents="none">
            <path d={`M 0 120 Q ${SVG_W * 0.45} 102 ${SVG_W} 128`} />
            <path d={`M 0 265 Q ${SVG_W * 0.55} 288 ${SVG_W} 258`} />
            <path d={`M 0 430 Q ${SVG_W * 0.35} 410 ${SVG_W} 442`} />
            <path d={`M 0 590 Q ${SVG_W * 0.65} 612 ${SVG_W} 584`} />
          </g>

          {/* Khung viền kép truyền thống bên ngoài lưới cờ */}
          <rect
            x={PAD_X - 12}
            y={PAD_Y - 12}
            width={GRID_W + 24}
            height={GRID_H + 24}
            fill="none"
            stroke="#3f210b"
            strokeWidth="3.2"
            rx="3"
          />
          <rect
            x={PAD_X - 6}
            y={PAD_Y - 6}
            width={GRID_W + 12}
            height={GRID_H + 12}
            fill="none"
            stroke="#593012"
            strokeWidth="1.2"
          />

          {/* Nhãn số cột phía trên và phía dưới bàn cờ */}
          <g
            fontFamily='"Noto Serif TC", "KaiTi", "STKaiti", serif'
            fontSize="15"
            fontWeight="700"
            fill="#4b280e"
            textAnchor="middle"
            pointerEvents="none"
          >
            {Array.from({ length: COLS }, (_, c) => {
              const x = PAD_X + c * CELL;
              // Phía trên: nếu không lật là Đen (1..9 từ trái qua phải), nếu lật là Đỏ (一..九 từ phải qua trái -> khi lật là trái qua phải)
              const topLabel = flipped ? CN_FILE_LABELS[c] : AR_FILE_LABELS[c];
              const bottomLabel = flipped ? AR_FILE_LABELS[COLS - 1 - c] : CN_FILE_LABELS[COLS - 1 - c];
              return (
                <React.Fragment key={c}>
                  <text x={x} y={PAD_Y - 24} opacity="0.82">
                    {topLabel}
                  </text>
                  <text x={x} y={PAD_Y + GRID_H + 34} opacity="0.82">
                    {bottomLabel}
                  </text>
                </React.Fragment>
              );
            })}
          </g>

          {/* Vùng sông Sở Hà – Hán Giới */}
          <rect
            x={PAD_X}
            y={PAD_Y + 4 * CELL}
            width={GRID_W}
            height={CELL}
            fill="url(#xq-river-tint)"
            pointerEvents="none"
          />

          {/* 10 đường kẻ ngang */}
          <g stroke="#3b1f0b" strokeWidth="1.85" strokeLinecap="square" pointerEvents="none">
            {Array.from({ length: ROWS }, (_, r) => {
              const y = PAD_Y + r * CELL;
              return (
                <line
                  key={`h-${r}`}
                  x1={PAD_X}
                  y1={y}
                  x2={PAD_X + GRID_W}
                  y2={y}
                  strokeWidth={r === 0 || r === ROWS - 1 || r === 4 || r === 5 ? 2.2 : 1.7}
                />
              );
            })}

            {/* 9 đường kẻ dọc (7 đường giữa ngắt qua sông, 2 đường biên thông suốt) */}
            {Array.from({ length: COLS }, (_, c) => {
              const x = PAD_X + c * CELL;
              if (c === 0 || c === COLS - 1) {
                return <line key={`v-${c}`} x1={x} y1={PAD_Y} x2={x} y2={PAD_Y + GRID_H} strokeWidth="2.2" />;
              }
              return (
                <React.Fragment key={`v-${c}`}>
                  <line x1={x} y1={PAD_Y} x2={x} y2={PAD_Y + 4 * CELL} />
                  <line x1={x} y1={PAD_Y + 5 * CELL} x2={x} y2={PAD_Y + GRID_H} />
                </React.Fragment>
              );
            })}

            {/* Đường chéo Cửu Cung phía trên và phía dưới */}
            <line x1={PAD_X + 3 * CELL} y1={PAD_Y} x2={PAD_X + 5 * CELL} y2={PAD_Y + 2 * CELL} strokeWidth="1.65" />
            <line x1={PAD_X + 5 * CELL} y1={PAD_Y} x2={PAD_X + 3 * CELL} y2={PAD_Y + 2 * CELL} strokeWidth="1.65" />
            <line
              x1={PAD_X + 3 * CELL}
              y1={PAD_Y + 7 * CELL}
              x2={PAD_X + 5 * CELL}
              y2={PAD_Y + 9 * CELL}
              strokeWidth="1.65"
            />
            <line
              x1={PAD_X + 5 * CELL}
              y1={PAD_Y + 7 * CELL}
              x2={PAD_X + 3 * CELL}
              y2={PAD_Y + 9 * CELL}
              strokeWidth="1.65"
            />
          </g>

          {/* Hoa văn tâm Pháo / Tốt */}
          <g stroke="#3b1f0b" strokeWidth="1.6" fill="none" strokeLinecap="round" pointerEvents="none">
            {FIDUCIAL_COORDS.map(([r, c]) => (
              <path key={`fid-${r}-${c}`} d={buildFiducialPath(r, c, flipped)} />
            ))}
          </g>

          {/* Chữ 楚河 (Sở Hà) — 漢界 (Hán Giới) */}
          <g
            fontFamily='"STKaiti", "KaiTi", "Noto Serif TC", "PMingLiU", serif'
            fontSize="30"
            fontWeight="700"
            fill="#4b280e"
            fillOpacity="0.78"
            textAnchor="middle"
            dominantBaseline="central"
            pointerEvents="none"
          >
            <text x={PAD_X + 2 * CELL} y={PAD_Y + 4.5 * CELL} letterSpacing="10">
              {flipped ? '漢界' : '楚河'}
            </text>
            <text x={PAD_X + 6 * CELL} y={PAD_Y + 4.5 * CELL} letterSpacing="10">
              {flipped ? '楚河' : '漢界'}
            </text>
            {/* Hoa văn trang trí giữa sông */}
            <g transform={`translate(${PAD_X + 4 * CELL}, ${PAD_Y + 4.5 * CELL})`} opacity="0.55">
              <polygon points="0,-10 10,0 0,10 -10,0" fill="none" stroke="#4b280e" strokeWidth="1.6" />
              <circle cx="0" cy="0" r="3" fill="#4b280e" />
            </g>
          </g>

          {/* Đánh dấu nước đi vừa thực hiện (ô xuất phát & ô đích) */}
          {lastMove &&
            (() => {
              const fromPt = squareXY(lastMove.from, flipped);
              const toPt = squareXY(lastMove.to, flipped);
              return (
                <g pointerEvents="none">
                  <line
                    x1={fromPt.x}
                    y1={fromPt.y}
                    x2={toPt.x}
                    y2={toPt.y}
                    stroke="#2563eb"
                    strokeWidth="3.5"
                    strokeDasharray="6 4"
                    strokeOpacity="0.65"
                  />
                  <circle
                    cx={fromPt.x}
                    cy={fromPt.y}
                    r="11"
                    fill="#2563eb"
                    fillOpacity="0.22"
                    stroke="#1d4ed8"
                    strokeWidth="2"
                  />
                  <circle
                    cx={toPt.x}
                    cy={toPt.y}
                    r={PIECE_R + 4}
                    fill="none"
                    stroke="#2563eb"
                    strokeWidth="2.8"
                    strokeDasharray="7 4"
                  />
                </g>
              );
            })()}

          {/* Vòng cảnh báo đỏ khi Tướng đang bị chiếu */}
          {checkedKingSq !== null &&
            (() => {
              const pt = squareXY(checkedKingSq, flipped);
              return (
                <g pointerEvents="none" filter="url(#xq-glow-red)">
                  <circle
                    cx={pt.x}
                    cy={pt.y}
                    r={PIECE_R + 5}
                    fill="none"
                    stroke="#dc2626"
                    strokeWidth="3.8"
                  />
                </g>
              );
            })()}

          {/* Vòng sáng cho quân đang được chọn */}
          {selectedSq !== null &&
            (() => {
              const pt = squareXY(selectedSq, flipped);
              return (
                <circle
                  cx={pt.x}
                  cy={pt.y}
                  r={PIECE_R + 4}
                  fill="none"
                  stroke="#059669"
                  strokeWidth="3.4"
                  pointerEvents="none"
                />
              );
            })()}

          {/* Quân cờ */}
          {pieces.map(({ sq, piece }) => {
            const { x, y } = squareXY(sq, flipped);
            const isRed = piece.side === 'w';
            const isSelected = selectedSq === sq;
            const isTarget = legalTargets.has(sq);
            const hanzi = isRed ? RED_NAMES[piece.kind] : BLACK_NAMES[piece.kind];
            const vnName = `${VIETNAMESE_NAMES[piece.kind]} ${isRed ? 'Đỏ' : 'Đen'}`;
            const strokeColor = isRed ? '#b41f18' : '#1b242c';
            const textColor = isRed ? '#b81d13' : '#151c23';

            return (
              <g
                key={`piece-${sq}`}
                transform={`translate(${x}, ${y}) scale(${isSelected ? 1.08 : 1})`}
                className={
                  isPlayerTurn && !disabled && (piece.side === playerSide || isTarget)
                    ? 'cursor-pointer transition-transform duration-150'
                    : 'transition-transform duration-150'
                }
                onClick={() => handleSquareClick(sq)}
                role="button"
                tabIndex={-1}
                aria-label={`${vnName} tại ${squareToUci(sq)}`}
              >
                {/* Đế gỗ 3D */}
                <circle
                  cx="0"
                  cy="2"
                  r={PIECE_R}
                  fill="#5a3312"
                  filter="url(#xq-piece-shadow)"
                />
                {/* Mặt quân cờ */}
                <circle
                  cx="0"
                  cy="0"
                  r={PIECE_R}
                  fill={isRed ? 'url(#xq-piece-red)' : 'url(#xq-piece-black)'}
                  stroke="#693d18"
                  strokeWidth="1.8"
                />
                {/* Vòng khắc chỉ đôi trên mặt quân */}
                <circle
                  cx="0"
                  cy="0"
                  r={PIECE_R - 4.5}
                  fill="none"
                  stroke={strokeColor}
                  strokeWidth="1.9"
                  strokeOpacity="0.88"
                />
                <circle
                  cx="0"
                  cy="0"
                  r={PIECE_R - 7}
                  fill="none"
                  stroke={strokeColor}
                  strokeWidth="0.7"
                  strokeOpacity="0.45"
                />
                {/* Chữ Hán truyền thống */}
                <text
                  x="0"
                  y="1.5"
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontFamily='"STKaiti", "KaiTi", "Kaiti SC", "Noto Serif TC", "PMingLiU", serif'
                  fontSize="30"
                  fontWeight="700"
                  fill={textColor}
                  style={{ textShadow: '0 1px 0 rgba(255,255,255,0.65)' }}
                >
                  {hanzi}
                </text>
              </g>
            );
          })}

          {/* Chấm gợi ý các nước đi hợp lệ của quân đang chọn */}
          {Array.from(legalTargets.keys()).map((targetSq) => {
            const { x, y } = squareXY(targetSq, flipped);
            const isCapture = position.pieceAt(targetSq) !== null;
            return (
              <g
                key={`target-${targetSq}`}
                className="cursor-pointer"
                onClick={() => handleSquareClick(targetSq)}
              >
                {isCapture ? (
                  <circle
                    cx={x}
                    cy={y}
                    r={PIECE_R + 3}
                    fill="none"
                    stroke="#10b981"
                    strokeWidth="3.6"
                    strokeDasharray="8 4"
                  />
                ) : (
                  <>
                    <circle cx={x} cy={y} r="9" fill="#10b981" fillOpacity="0.88" />
                    <circle cx={x} cy={y} r="14" fill="#10b981" fillOpacity="0.22" />
                  </>
                )}
              </g>
            );
          })}

          {/* Mũi tên gợi ý nước đi (Hint) hoặc nước đầu tiên của PV */}
          {arrowMove &&
            (() => {
              const fromPt = squareXY(arrowMove.from, flipped);
              const toPt = squareXY(arrowMove.to, flipped);
              const dx = toPt.x - fromPt.x;
              const dy = toPt.y - fromPt.y;
              const dist = Math.hypot(dx, dy) || 1;
              const trimStart = 12;
              const trimEnd = 16;
              const x1 = fromPt.x + (dx / dist) * trimStart;
              const y1 = fromPt.y + (dy / dist) * trimStart;
              const x2 = toPt.x - (dx / dist) * trimEnd;
              const y2 = toPt.y - (dy / dist) * trimEnd;
              const color = arrowMove.isHint ? '#10b981' : '#f59e0b';
              const marker = arrowMove.isHint ? 'url(#xq-arrow-hint)' : 'url(#xq-arrow-pv)';
              return (
                <g pointerEvents="none" opacity="0.9">
                  <circle cx={fromPt.x} cy={fromPt.y} r="7" fill={color} />
                  <line
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    stroke={color}
                    strokeWidth="5"
                    strokeLinecap="round"
                    markerEnd={marker}
                  />
                </g>
              );
            })()}

          {/* Vùng bấm vô hình trên 90 giao điểm để dễ chọn các ô trống */}
          {Array.from({ length: BOARD_SIZE }, (_, sq) => {
            if (position.pieceAt(sq) !== null) return null;
            const { x, y } = squareXY(sq, flipped);
            return (
              <rect
                key={`hit-${sq}`}
                x={x - CELL / 2}
                y={y - CELL / 2}
                width={CELL}
                height={CELL}
                fill="transparent"
                className={legalTargets.has(sq) ? 'cursor-pointer' : undefined}
                onClick={() => handleSquareClick(sq)}
              />
            );
          })}
        </svg>
      </div>
    </div>
  );
};

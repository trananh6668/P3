import React, { useEffect, useMemo, useRef, useState } from 'react';
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
const DRAG_THRESHOLD_SVG = 6;

/** Ép buộc trình duyệt luôn render ở chế độ sáng, ngăn chặn Dark Reader / Auto Dark Mode */
const FORCE_LIGHT_MODE_STYLE: React.CSSProperties = {
  colorScheme: 'only light',
  forcedColorAdjust: 'none',
  WebkitPrintColorAdjust: 'exact',
  printColorAdjust: 'exact',
  outline: 'none',
  WebkitTapHighlightColor: 'transparent',
};

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

/** Tìm ô cờ gần nhất từ tọa độ (x, y) trong hệ tọa độ SVG */
function svgXYToSquare(x: number, y: number, flipped: boolean): Square | null {
  const vc = Math.round((x - PAD_X) / CELL);
  const vr = Math.round((y - PAD_Y) / CELL);
  if (vc < 0 || vc >= COLS || vr < 0 || vr >= ROWS) return null;

  const gx = PAD_X + vc * CELL;
  const gy = PAD_Y + vr * CELL;
  if (Math.hypot(x - gx, y - gy) > CELL * 0.62) return null;

  const row = flipped ? ROWS - 1 - vr : vr;
  const col = flipped ? COLS - 1 - vc : vc;
  return (row * COLS + col) as Square;
}

/**
 * Tạo đường dẫn SVG cho hoa văn chữ L tại các vị trí Pháo và Tốt.
 * Tự động lược bỏ nửa trái hoặc nửa phải khi nằm ở biên (cột 0 hoặc cột 8).
 */
function buildFiducialPath(row: number, col: number, flipped: boolean): string {
  const { x, y } = gridXY(row, col, flipped);
  const gap = 5;
  const len = 13;
  const visualCol = flipped ? COLS - 1 - col : col;
  const showLeft = visualCol > 0;
  const showRight = visualCol < COLS - 1;
  const parts: string[] = [];

  if (showLeft) {
    parts.push(`M ${x - gap - len} ${y - gap} L ${x - gap} ${y - gap} L ${x - gap} ${y - gap - len}`);
    parts.push(`M ${x - gap - len} ${y + gap} L ${x - gap} ${y + gap} L ${x - gap} ${y + gap + len}`);
  }
  if (showRight) {
    parts.push(`M ${x + gap + len} ${y - gap} L ${x + gap} ${y - gap} L ${x + gap} ${y - gap - len}`);
    parts.push(`M ${x + gap + len} ${y + gap} L ${x + gap} ${y + gap} L ${x + gap} ${y + gap + len}`);
  }
  return parts.join(' ');
}

const FIDUCIAL_COORDS: readonly (readonly [number, number])[] = [
  [2, 1],
  [2, 7],
  [7, 1],
  [7, 7],
  [3, 0],
  [3, 2],
  [3, 4],
  [3, 6],
  [3, 8],
  [6, 0],
  [6, 2],
  [6, 4],
  [6, 6],
  [6, 8],
];

const CN_FILE_LABELS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const AR_FILE_LABELS = ['１', '２', '３', '４', '５', '６', '７', '８', '９'];

interface DragState {
  fromSq: Square;
  piece: Piece;
  startX: number;
  startY: number;
  currX: number;
  currY: number;
  hoverSq: Square | null;
  hasMoved: boolean;
  wasAlreadySelected: boolean;
}

/** Hàm dựng hình đồ họa 1 quân cờ */
function renderPieceGraphics(piece: Piece) {
  const isRed = piece.side === 'w';
  const hanzi = isRed ? RED_NAMES[piece.kind] : BLACK_NAMES[piece.kind];
  const discFillGradient = isRed
    ? 'url(#xq-piece-red-fill)'
    : 'url(#xq-piece-black-fill)';
  const rimColor = '#693d18';
  const ringColor = isRed ? '#b91c1c' : '#1e293b';
  const fontColor = isRed ? '#b91c1c' : '#0f172a';

  return (
    <>
      {/* Bóng đổ dưới mặt bàn cờ */}
      <circle
        cx="0"
        cy="4"
        r={PIECE_R + 0.5}
        fill="#2a1405"
        fillOpacity="0.38"
        style={{ fill: '#2a1405', fillOpacity: 0.38 }}
      />

      {/* Đế gỗ 3D của quân cờ */}
      <circle cx="0" cy="2.2" r={PIECE_R} fill="url(#xq-piece-base)" />

      {/* Thân quân cờ - tô bằng radialGradient ngà gỗ sáng */}
      <circle
        cx="0"
        cy="0"
        r={PIECE_R}
        fill={discFillGradient}
        stroke={rimColor}
        style={{ stroke: rimColor }}
        strokeWidth="1.8"
      />

      {/* Vòng tròn viền trong */}
      <circle
        cx="0"
        cy="0"
        r={PIECE_R - 4.5}
        fill="none"
        stroke={ringColor}
        style={{ stroke: ringColor }}
        strokeWidth="1.9"
        strokeOpacity="0.88"
      />
      <circle
        cx="0"
        cy="0"
        r={PIECE_R - 7}
        fill="none"
        stroke={ringColor}
        style={{ stroke: ringColor }}
        strokeWidth="0.75"
        strokeOpacity="0.45"
      />

      {/* Chữ Hán khắc chìm */}
      <text
        x="0"
        y="2.3"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily='"STKaiti", "KaiTi", "Kaiti SC", "Noto Serif TC", "PMingLiU", serif'
        fontSize="30"
        fontWeight="700"
        fill="#fffaf0"
        fillOpacity="0.65"
        style={{ fill: '#fffaf0', fillOpacity: 0.65 }}
        pointerEvents="none"
      >
        {hanzi}
      </text>
      <text
        x="0"
        y="1.2"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily='"STKaiti", "KaiTi", "Kaiti SC", "Noto Serif TC", "PMingLiU", serif'
        fontSize="30"
        fontWeight="700"
        fill={fontColor}
        style={{
          fill: fontColor,
          stroke: 'none',
          textShadow: 'none',
        }}
        pointerEvents="none"
      >
        {hanzi}
      </text>
    </>
  );
}

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
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [selectedSq, setSelectedSq] = useState<Square | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);

  const fenKey = position.toFen();
  useEffect(() => {
    setSelectedSq(null);
    setDragState(null);
  }, [fenKey, playerSide]);

  const clientToSvgCoords = (clientX: number, clientY: number): { x: number; y: number } => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return {
      x: ((clientX - rect.left) / rect.width) * SVG_W,
      y: ((clientY - rect.top) / rect.height) * SVG_H,
    };
  };

  const activeOriginSq = dragState ? dragState.fromSq : selectedSq;

  const legalTargets = useMemo(() => {
    const map = new Map<Square, UciMove>();
    if (activeOriginSq === null || !isPlayerTurn || disabled) return map;
    const piece = position.pieceAt(activeOriginSq);
    if (!piece || piece.side !== playerSide) return map;
    for (const m of position.legalMovesFrom(activeOriginSq)) {
      map.set(moveTo(m), moveToUci(m));
    }
    return map;
  }, [position, activeOriginSq, isPlayerTurn, disabled, playerSide]);

  const checkedKingSq = useMemo<Square | null>(() => {
    if (!position.inCheck(position.turn)) return null;
    return position.kingSq[position.turn === 'w' ? 0 : 1];
  }, [position]);

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

    if (selectedSq !== null && legalTargets.has(sq)) {
      const uci = legalTargets.get(sq)!;
      setSelectedSq(null);
      onMove(uci);
      return;
    }

    const piece = position.pieceAt(sq);
    if (piece && piece.side === playerSide) {
      setSelectedSq((prev) => (prev === sq ? null : sq));
      return;
    }

    if (selectedSq !== null) {
      const uci = moveToUci(encodeMove(selectedSq, sq));
      if (position.findLegalMove(uci) !== null) {
        setSelectedSq(null);
        onMove(uci);
        return;
      }
      setSelectedSq(null);
    }
  };

  // ───────────────────── Xử lý Kéo & Thả (Pointer Events) ─────────────────────

  const handlePiecePointerDown = (
    e: React.PointerEvent<SVGGElement>,
    sq: Square,
    piece: Piece
  ) => {
    if (disabled || !isPlayerTurn) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    if (piece.side === playerSide) {
      e.stopPropagation();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      const pt = clientToSvgCoords(e.clientX, e.clientY);
      const wasAlreadySelected = selectedSq === sq;
      setSelectedSq(sq);
      setDragState({
        fromSq: sq,
        piece,
        startX: pt.x,
        startY: pt.y,
        currX: pt.x,
        currY: pt.y,
        hoverSq: sq,
        hasMoved: false,
        wasAlreadySelected,
      });
      return;
    }

    if (selectedSq !== null && legalTargets.has(sq)) {
      e.stopPropagation();
      const uci = legalTargets.get(sq)!;
      setSelectedSq(null);
      setDragState(null);
      onMove(uci);
    }
  };

  const handleSvgPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragState) return;
    const pt = clientToSvgCoords(e.clientX, e.clientY);
    const dist = Math.hypot(pt.x - dragState.startX, pt.y - dragState.startY);
    const hasMoved = dragState.hasMoved || dist > DRAG_THRESHOLD_SVG;
    const hoverSq = svgXYToSquare(pt.x, pt.y, flipped);

    setDragState((prev) =>
      prev
        ? {
            ...prev,
            currX: pt.x,
            currY: pt.y,
            hoverSq,
            hasMoved,
          }
        : null
    );
  };

  const finishDrag = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragState) return;
    const pt = clientToSvgCoords(e.clientX, e.clientY);
    const dropSq = svgXYToSquare(pt.x, pt.y, flipped);
    const { fromSq, hasMoved, wasAlreadySelected } = dragState;

    setDragState(null);

    if (hasMoved) {
      if (dropSq !== null && dropSq !== fromSq) {
        const uci =
          legalTargets.get(dropSq) ?? moveToUci(encodeMove(fromSq, dropSq));
        if (position.findLegalMove(uci) !== null) {
          setSelectedSq(null);
          onMove(uci);
          return;
        }
      }
      setSelectedSq(fromSq);
    } else {
      if (wasAlreadySelected) {
        setSelectedSq(null);
      } else {
        setSelectedSq(fromSq);
      }
    }
  };

  const cancelDrag = () => {
    if (!dragState) return;
    setDragState(null);
  };

  const pieces: { sq: Square; piece: Piece }[] = [];
  for (let sq = 0; sq < BOARD_SIZE; sq++) {
    const p = position.pieceAt(sq);
    if (p) pieces.push({ sq, piece: p });
  }

  const isDraggingActively = Boolean(dragState && dragState.hasMoved);

  return (
    <div
      className="xq-board-light-lock relative select-none w-full max-w-[640px] mx-auto"
      style={FORCE_LIGHT_MODE_STYLE}
      data-darkreader-ignore=""
    >
      <div
        className="rounded-2xl p-2 sm:p-3 shadow-[0_14px_34px_rgba(92,53,18,0.28)] ring-1 ring-amber-800/30"
        style={{
          ...FORCE_LIGHT_MODE_STYLE,
          backgroundColor: '#6e421c',
          backgroundImage: 'linear-gradient(135deg, #8c5828 0%, #6e421c 50%, #522f12 100%)',
        }}
        data-darkreader-ignore=""
      >
        <svg
          ref={svgRef}
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          className={`w-full h-auto block rounded-xl shadow-inner touch-none focus:outline-none ${
            isDraggingActively ? 'cursor-grabbing' : ''
          }`}
          style={{ ...FORCE_LIGHT_MODE_STYLE, touchAction: 'none' }}
          aria-label="Bàn cờ Tướng 9 cột 10 hàng"
          data-darkreader-ignore=""
          onPointerMove={handleSvgPointerMove}
          onPointerUp={finishDrag}
          onPointerCancel={cancelDrag}
        >
          <defs>
            {/* Gradient mặt bàn cờ gỗ */}
            <linearGradient id="xq-wood-surface" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#f3d59b" style={{ stopColor: '#f3d59b' }} />
              <stop offset="35%" stopColor="#e7be78" style={{ stopColor: '#e7be78' }} />
              <stop offset="70%" stopColor="#dead62" style={{ stopColor: '#dead62' }} />
              <stop offset="100%" stopColor="#cf984c" style={{ stopColor: '#cf984c' }} />
            </linearGradient>

            {/* Gradient sông Sở Hà - Hán Giới */}
            <linearGradient id="xq-river-tint" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#c58c3e" stopOpacity="0.16" style={{ stopColor: '#c58c3e', stopOpacity: 0.16 }} />
              <stop offset="50%" stopColor="#f8e3b4" stopOpacity="0.28" style={{ stopColor: '#f8e3b4', stopOpacity: 0.28 }} />
              <stop offset="100%" stopColor="#c58c3e" stopOpacity="0.16" style={{ stopColor: '#c58c3e', stopOpacity: 0.16 }} />
            </linearGradient>

            {/* Gradient mặt quân cờ chống lỗi Dark Mode */}
            <radialGradient id="xq-piece-red-fill" cx="35%" cy="30%" r="70%" fx="30%" fy="25%">
              <stop offset="0%" stopColor="#fffdf9" style={{ stopColor: '#fffdf9' }} />
              <stop offset="45%" stopColor="#fcecd2" style={{ stopColor: '#fcecd2' }} />
              <stop offset="82%" stopColor="#f0cfa0" style={{ stopColor: '#f0cfa0' }} />
              <stop offset="100%" stopColor="#dcab6e" style={{ stopColor: '#dcab6e' }} />
            </radialGradient>

            <radialGradient id="xq-piece-black-fill" cx="35%" cy="30%" r="70%" fx="30%" fy="25%">
              <stop offset="0%" stopColor="#fffef9" style={{ stopColor: '#fffef9' }} />
              <stop offset="45%" stopColor="#faebd4" style={{ stopColor: '#faebd4' }} />
              <stop offset="82%" stopColor="#ebd0a4" style={{ stopColor: '#ebd0a4' }} />
              <stop offset="100%" stopColor="#d5a66a" style={{ stopColor: '#d5a66a' }} />
            </radialGradient>

            {/* Gradient đế gỗ 3D của quân cờ */}
            <linearGradient id="xq-piece-base" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#6e3f19" style={{ stopColor: '#6e3f19' }} />
              <stop offset="100%" stopColor="#3d200a" style={{ stopColor: '#3d200a' }} />
            </linearGradient>

            <marker
              id="xq-arrow-hint"
              viewBox="0 0 10 10"
              refX="7"
              refY="5"
              markerWidth="5.5"
              markerHeight="5.5"
              orient="auto-start-reverse"
            >
              <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="#10b981" style={{ fill: '#10b981' }} />
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
              <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="#f59e0b" style={{ fill: '#f59e0b' }} />
            </marker>
          </defs>

          {/* Nền bàn cờ */}
          <rect x="0" y="0" width={SVG_W} height={SVG_H} rx="14" fill="url(#xq-wood-surface)" />

          {/* Vân gỗ trang trí */}
          <g stroke="#8c5422" style={{ stroke: '#8c5422' }} strokeOpacity="0.08" strokeWidth="1.4" fill="none" pointerEvents="none">
            <path d={`M 0 120 Q ${SVG_W * 0.45} 102 ${SVG_W} 128`} />
            <path d={`M 0 265 Q ${SVG_W * 0.55} 288 ${SVG_W} 258`} />
            <path d={`M 0 430 Q ${SVG_W * 0.35} 410 ${SVG_W} 442`} />
            <path d={`M 0 590 Q ${SVG_W * 0.65} 612 ${SVG_W} 584`} />
          </g>

          {/* Khung viền bàn cờ */}
          <rect
            x={PAD_X - 12}
            y={PAD_Y - 12}
            width={GRID_W + 24}
            height={GRID_H + 24}
            fill="none"
            stroke="#3f210b"
            style={{ stroke: '#3f210b' }}
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
            style={{ stroke: '#593012' }}
            strokeWidth="1.2"
          />

          {/* Nhãn số cột */}
          <g
            fontFamily='"Noto Serif TC", "KaiTi", "STKaiti", serif'
            fontSize="15"
            fontWeight="700"
            fill="#4b280e"
            style={{ fill: '#4b280e' }}
            textAnchor="middle"
            pointerEvents="none"
          >
            {Array.from({ length: COLS }, (_, c) => {
              const x = PAD_X + c * CELL;
              const topLabel = flipped ? CN_FILE_LABELS[c] : AR_FILE_LABELS[c];
              const bottomLabel = flipped ? AR_FILE_LABELS[COLS - 1 - c] : CN_FILE_LABELS[COLS - 1 - c];
              return (
                <React.Fragment key={c}>
                  <text x={x} y={PAD_Y - 24} opacity="0.82">{topLabel}</text>
                  <text x={x} y={PAD_Y + GRID_H + 34} opacity="0.82">{bottomLabel}</text>
                </React.Fragment>
              );
            })}
          </g>

          {/* Sông Sở Hà – Hán Giới */}
          <rect
            x={PAD_X}
            y={PAD_Y + 4 * CELL}
            width={GRID_W}
            height={CELL}
            fill="url(#xq-river-tint)"
            pointerEvents="none"
          />

          {/* Đường kẻ bàn cờ */}
          <g stroke="#3b1f0b" style={{ stroke: '#3b1f0b' }} strokeWidth="1.85" strokeLinecap="square" pointerEvents="none">
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

            <line x1={PAD_X + 3 * CELL} y1={PAD_Y} x2={PAD_X + 5 * CELL} y2={PAD_Y + 2 * CELL} strokeWidth="1.65" />
            <line x1={PAD_X + 5 * CELL} y1={PAD_Y} x2={PAD_X + 3 * CELL} y2={PAD_Y + 2 * CELL} strokeWidth="1.65" />
            <line x1={PAD_X + 3 * CELL} y1={PAD_Y + 7 * CELL} x2={PAD_X + 5 * CELL} y2={PAD_Y + 9 * CELL} strokeWidth="1.65" />
            <line x1={PAD_X + 5 * CELL} y1={PAD_Y + 7 * CELL} x2={PAD_X + 3 * CELL} y2={PAD_Y + 9 * CELL} strokeWidth="1.65" />
          </g>

          {/* Hoa văn phụ */}
          <g stroke="#3b1f0b" style={{ stroke: '#3b1f0b' }} strokeWidth="1.6" fill="none" strokeLinecap="round" pointerEvents="none">
            {FIDUCIAL_COORDS.map(([r, c]) => (
              <path key={`fid-${r}-${c}`} d={buildFiducialPath(r, c, flipped)} />
            ))}
          </g>

          {/* Chữ Sở Hà Hán Giới */}
          <g
            fontFamily='"STKaiti", "KaiTi", "Noto Serif TC", "PMingLiU", serif'
            fontSize="30"
            fontWeight="700"
            fill="#4b280e"
            style={{ fill: '#4b280e' }}
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
            <g transform={`translate(${PAD_X + 4 * CELL}, ${PAD_Y + 4.5 * CELL})`} opacity="0.55">
              <polygon points="0,-10 10,0 0,10 -10,0" fill="none" stroke="#4b280e" style={{ stroke: '#4b280e' }} strokeWidth="1.6" />
              <circle cx="0" cy="0" r="3" fill="#4b280e" style={{ fill: '#4b280e' }} />
            </g>
          </g>

          {/* Nước đi gần nhất */}
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
                    style={{ stroke: '#2563eb' }}
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
                    style={{ fill: '#2563eb', stroke: '#1d4ed8' }}
                    strokeWidth="2"
                  />
                  <circle
                    cx={toPt.x}
                    cy={toPt.y}
                    r={PIECE_R + 4}
                    fill="none"
                    stroke="#2563eb"
                    style={{ stroke: '#2563eb' }}
                    strokeWidth="2.8"
                    strokeDasharray="7 4"
                  />
                </g>
              );
            })()}

          {/* Chiếu tướng */}
          {checkedKingSq !== null &&
            (() => {
              const pt = squareXY(checkedKingSq, flipped);
              return (
                <g pointerEvents="none">
                  <circle
                    cx={pt.x}
                    cy={pt.y}
                    r={PIECE_R + 6}
                    fill="none"
                    stroke="#ef4444"
                    strokeOpacity="0.35"
                    style={{ stroke: '#ef4444' }}
                    strokeWidth="6"
                  />
                  <circle
                    cx={pt.x}
                    cy={pt.y}
                    r={PIECE_R + 4}
                    fill="none"
                    stroke="#dc2626"
                    style={{ stroke: '#dc2626' }}
                    strokeWidth="3.2"
                  />
                </g>
              );
            })()}

          {/* ────────────────── HỆ THỐNG QUÂN CỜ CỐ ĐỊNH MÀU ────────────────── */}
          {pieces.map(({ sq, piece }) => {
            const { x, y } = squareXY(sq, flipped);
            const isRed = piece.side === 'w';
            const isSelected = selectedSq === sq && !isDraggingActively;
            const isBeingDragged = isDraggingActively && dragState?.fromSq === sq;
            const isTarget = legalTargets.has(sq);
            const vnName = `${VIETNAMESE_NAMES[piece.kind]} ${isRed ? 'Đỏ' : 'Đen'}`;
            const canInteract =
              isPlayerTurn && !disabled && (piece.side === playerSide || isTarget);

            return (
              <g
                key={`piece-${sq}`}
                transform={`translate(${x}, ${y}) scale(${isSelected ? 1.08 : 1})`}
                opacity={isBeingDragged ? 0.35 : 1}
                style={{ outline: 'none', WebkitTapHighlightColor: 'transparent' }}
                className={
                  canInteract
                    ? `${
                        piece.side === playerSide ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'
                      } transition-transform duration-150 focus:outline-none`
                    : 'transition-transform duration-150 focus:outline-none'
                }
                onPointerDown={(e) => handlePiecePointerDown(e, sq, piece)}
                aria-label={`${vnName} tại ${squareToUci(sq)}`}
              >
                {renderPieceGraphics(piece)}
              </g>
            );
          })}

          {/* Vòng tròn viền xanh lá bao quanh quân cờ đang chọn (vẽ trên lớp quân cờ để sắc nét, không có khung vuông đen) */}
          {activeOriginSq !== null &&
            (() => {
              const pt = squareXY(activeOriginSq, flipped);
              const isScaled = selectedSq === activeOriginSq && !isDraggingActively;
              return (
                <circle
                  cx={pt.x}
                  cy={pt.y}
                  r={isScaled ? PIECE_R * 1.08 + 3 : PIECE_R + 3.5}
                  fill="none"
                  stroke="#059669"
                  style={{ stroke: '#059669' }}
                  strokeWidth="3.4"
                  pointerEvents="none"
                />
              );
            })()}

          {/* Vòng sáng báo hiệu ô đích hợp lệ khi đang rê quân cờ qua */}
          {isDraggingActively &&
            dragState?.hoverSq !== null &&
            dragState?.hoverSq !== undefined &&
            legalTargets.has(dragState.hoverSq) &&
            (() => {
              const pt = squareXY(dragState.hoverSq, flipped);
              return (
                <circle
                  cx={pt.x}
                  cy={pt.y}
                  r={PIECE_R + 6}
                  fill="#10b981"
                  fillOpacity="0.24"
                  stroke="#059669"
                  style={{ fill: '#10b981', stroke: '#059669' }}
                  strokeWidth="3"
                  pointerEvents="none"
                />
              );
            })()}

          {/* Các điểm/vòng tròn gợi ý nước đi hợp lệ */}
          {Array.from(legalTargets.keys()).map((targetSq) => {
            const { x, y } = squareXY(targetSq, flipped);
            const isCapture = position.pieceAt(targetSq) !== null;
            const isHoveredTarget =
              isDraggingActively && dragState?.hoverSq === targetSq;
            return (
              <g
                key={`target-${targetSq}`}
                className="cursor-pointer focus:outline-none"
                style={{ outline: 'none' }}
                onClick={() => handleSquareClick(targetSq)}
              >
                {isCapture ? (
                  <circle
                    cx={x}
                    cy={y}
                    r={PIECE_R + 3}
                    fill="none"
                    stroke="#10b981"
                    style={{ stroke: '#10b981' }}
                    strokeWidth={isHoveredTarget ? '4.5' : '3.6'}
                    strokeDasharray="8 4"
                  />
                ) : (
                  <>
                    <circle
                      cx={x}
                      cy={y}
                      r={isHoveredTarget ? '11' : '9'}
                      fill="#10b981"
                      style={{ fill: '#10b981' }}
                      fillOpacity="0.88"
                    />
                    <circle
                      cx={x}
                      cy={y}
                      r={isHoveredTarget ? '18' : '14'}
                      fill="#10b981"
                      style={{ fill: '#10b981' }}
                      fillOpacity="0.22"
                    />
                  </>
                )}
              </g>
            );
          })}

          {/* Mũi tên gợi ý */}
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
                  <circle cx={fromPt.x} cy={fromPt.y} r="7" fill={color} style={{ fill: color }} />
                  <line
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    stroke={color}
                    style={{ stroke: color }}
                    strokeWidth="5"
                    strokeLinecap="round"
                    markerEnd={marker}
                  />
                </g>
              );
            })()}

          {/* Vùng click trên các giao điểm trống */}
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
                style={{ outline: 'none' }}
                className={legalTargets.has(sq) ? 'cursor-pointer focus:outline-none' : 'focus:outline-none'}
                onClick={() => handleSquareClick(sq)}
              />
            );
          })}

          {/* Quân cờ nổi di chuyển theo con trỏ khi đang kéo */}
          {isDraggingActively && dragState && (
            <g
              transform={`translate(${dragState.currX}, ${dragState.currY}) scale(1.14)`}
              pointerEvents="none"
              style={{ pointerEvents: 'none', outline: 'none' }}
            >
              {renderPieceGraphics(dragState.piece)}
            </g>
          )}
        </svg>
      </div>
    </div>
  );
};
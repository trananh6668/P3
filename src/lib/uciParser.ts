/**
 * Parser cho output dạng text của engine UCI (Fairy-Stockfish) / UCCI.
 */
import type { EngineInfo, ParsedEngineLine, UciMove } from '../types/xiangqi';

const INFO_NUMERIC_KEYS = new Set(['depth', 'seldepth', 'multipv', 'nodes', 'nps', 'time', 'hashfull', 'tbhits', 'currmovenumber']);
const MOVE_PATTERN = /^[a-i](?:10|[0-9])[a-i](?:10|[0-9])$/;

export function isUciMove(text: string): boolean {
  return MOVE_PATTERN.test(text);
}

export function parseInfoLine(line: string): EngineInfo | { text: string } | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== 'info') return null;
  const info: EngineInfo = { depth: 0, pv: [] };
  let i = 1;
  while (i < tokens.length) {
    const key = tokens[i];
    if (key === 'string') {
      return { text: tokens.slice(i + 1).join(' ') };
    }
    if (key === 'pv') {
      const pv: UciMove[] = [];
      for (let j = i + 1; j < tokens.length; j++) {
        if (!isUciMove(tokens[j])) break;
        pv.push(tokens[j]);
      }
      info.pv = pv;
      break;
    }
    if (key === 'score') {
      const kind = tokens[i + 1];
      const value = Number.parseInt(tokens[i + 2] ?? '', 10);
      if ((kind === 'cp' || kind === 'mate') && Number.isFinite(value)) {
        info.score = { type: kind, value };
      }
      i += 3;
      const maybeBound = tokens[i];
      if (maybeBound === 'lowerbound') {
        info.bound = 'lower';
        i += 1;
      } else if (maybeBound === 'upperbound') {
        info.bound = 'upper';
        i += 1;
      }
      continue;
    }
    if (key === 'wdl') {
      i += 4;
      continue;
    }
    if (key === 'currmove') {
      i += 2;
      continue;
    }
    if (INFO_NUMERIC_KEYS.has(key)) {
      const value = Number(tokens[i + 1]);
      if (Number.isFinite(value)) {
        switch (key) {
          case 'depth':
            info.depth = value;
            break;
          case 'seldepth':
            info.seldepth = value;
            break;
          case 'multipv':
            info.multipv = value;
            break;
          case 'nodes':
            info.nodes = value;
            break;
          case 'nps':
            info.nps = value;
            break;
          case 'time':
            info.time = value;
            break;
          case 'hashfull':
            info.hashfull = value;
            break;
          default:
            break;
        }
      }
      i += 2;
      continue;
    }
    i += 1;
  }
  return info;
}

export function parseEngineLine(rawLine: string): ParsedEngineLine {
  const line = rawLine.trim();
  if (line === 'uciok') return { type: 'uciok' };
  if (line === 'readyok') return { type: 'readyok' };
  if (line.startsWith('id ')) {
    const rest = line.slice(3);
    if (rest.startsWith('name ')) return { type: 'id', key: 'name', value: rest.slice(5).trim() };
    if (rest.startsWith('author ')) return { type: 'id', key: 'author', value: rest.slice(7).trim() };
  }
  if (line.startsWith('option ')) return { type: 'option', raw: line };
  if (line.startsWith('bestmove')) {
    const tokens = line.split(/\s+/);
    const best = tokens[1] && isUciMove(tokens[1]) ? tokens[1] : null;
    const ponderIdx = tokens.indexOf('ponder');
    const ponder = ponderIdx > 0 && tokens[ponderIdx + 1] && isUciMove(tokens[ponderIdx + 1]) ? tokens[ponderIdx + 1] : null;
    return { type: 'bestmove', bestmove: best, ponder };
  }
  if (line.startsWith('info')) {
    const parsed = parseInfoLine(line);
    if (parsed && 'text' in parsed) return { type: 'info-string', text: parsed.text };
    if (parsed) return { type: 'info', info: parsed };
  }
  return { type: 'unknown', raw: line };
}

import type { DifficultyId, DifficultyLevel } from '../types/xiangqi';

export const DIFFICULTY_LEVELS: readonly DifficultyLevel[] = [
  {
    id: 'beginner',
    label: 'Dễ',
    subtitle: 'Tập sự',
    depth: 4,
    expectedTime: '~0.1–0.3 giây',
    fallbackMoveTimeMs: 800,
  },
  {
    id: 'club',
    label: 'Trung bình',
    subtitle: 'Phong trào',
    depth: 8,
    expectedTime: '~0.5–1 giây',
    fallbackMoveTimeMs: 2000,
  },
  {
    id: 'master',
    label: 'Khó',
    subtitle: 'Kiện tướng',
    depth: 12,
    expectedTime: '~1.5–3 giây',
    fallbackMoveTimeMs: 4000,
  },
  {
    id: 'grandmaster',
    label: 'Đại kiện tướng',
    subtitle: 'Kỳ vương',
    depth: 16,
    expectedTime: 'Phân tích sâu',
    fallbackMoveTimeMs: 8000,
  },
];

export function getDifficulty(id: DifficultyId): DifficultyLevel {
  return DIFFICULTY_LEVELS.find((l) => l.id === id) ?? DIFFICULTY_LEVELS[1];
}

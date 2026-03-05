import type { GymVisit, TrainingMenuItem } from '../types';
import { diffDays } from './date';

export interface LastPerformance {
  date: string;
  endedAtLocal: string;
  weightKg: number;
  reps: number;
  sets: number;
  note?: string;
}

export function formatTrainingLabel(trainingName: string, bodyPart?: string, equipment?: string): string {
  const name = (trainingName ?? '').trim();
  const part = (bodyPart ?? '').trim();
  const tool = (equipment ?? '').trim();
  return `${name} : ${part || '未設定'} : ${tool || '未設定'}`;
}

export function getLastPerformance(menuItemId: string, gymVisits: GymVisit[]): LastPerformance | null {
  const sorted = [...gymVisits].sort((a, b) => a.date.localeCompare(b.date));
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const entry = sorted[i].entries.find((e) => e.menuItemId === menuItemId);
    if (entry) {
      return {
        date: sorted[i].date,
        endedAtLocal: sorted[i].endedAtLocal,
        weightKg: entry.weightKg,
        reps: entry.reps,
        sets: entry.sets,
        note: typeof entry.note === 'string' ? entry.note : undefined
      };
    }
  }
  return null;
}

function getFrequencyDays(days: TrainingMenuItem['frequency']): number {
  return days;
}

function scoreItem(params: {
  item: TrainingMenuItem;
  todayYmd: string;
  gymVisits: GymVisit[];
}): {
  neverDone: boolean;
  overdueDays: number;
  daysSinceLast: number;
} {
  const { item, todayYmd, gymVisits } = params;
  const last = getLastPerformance(item.id, gymVisits);
  if (!last) {
    return {
      neverDone: true,
      overdueDays: Number.POSITIVE_INFINITY,
      daysSinceLast: Number.MAX_SAFE_INTEGER
    };
  }

  const daysSinceLast = Math.max(0, diffDays(last.date, todayYmd));
  const intervalDays = getFrequencyDays(item.frequency);
  return {
    neverDone: false,
    overdueDays: daysSinceLast - intervalDays,
    daysSinceLast
  };
}

export function getPrioritizedMenuItems(params: {
  menuItems: TrainingMenuItem[];
  gymVisits: GymVisit[];
  todayYmd: string;
}): TrainingMenuItem[] {
  const { menuItems, gymVisits, todayYmd } = params;

  return [...menuItems]
    .filter((item) => item.isActive)
    .sort((a, b) => {
      const scoreA = scoreItem({
        item: a,
        todayYmd,
        gymVisits
      });
      const scoreB = scoreItem({
        item: b,
        todayYmd,
        gymVisits
      });
      if (scoreA.neverDone !== scoreB.neverDone) {
        return scoreA.neverDone ? -1 : 1;
      }
      if (scoreA.overdueDays !== scoreB.overdueDays) {
        return scoreB.overdueDays - scoreA.overdueDays;
      }
      if (scoreA.daysSinceLast !== scoreB.daysSinceLast) {
        return scoreB.daysSinceLast - scoreA.daysSinceLast;
      }
      return a.order - b.order;
    });
}

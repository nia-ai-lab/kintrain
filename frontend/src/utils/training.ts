import type { GymVisit, TrainingMenuItem } from '../types';
import {
  equipmentTypeLabel,
  formatMuscleTargets,
  type EquipmentType,
  type MuscleTarget
} from '../muscleTaxonomy';
import { diffDays } from './date';

export interface LastPerformance {
  date: string;
  endedAtLocal: string;
  weightKg: number;
  reps: number;
  sets: number;
  note?: string;
}

export function formatTrainingLabel(
  trainingName: string,
  muscleTargets?: MuscleTarget[],
  equipmentType?: EquipmentType,
  isAiGenerated?: boolean
): string {
  const name = (trainingName ?? '').trim();
  const part = formatMuscleTargets(muscleTargets ?? []);
  const tool = equipmentType ? equipmentTypeLabel(equipmentType) : '';
  const suffix = isAiGenerated ? ' (AI生成)' : '';
  return `${name} : ${part || '筋群未設定'} : ${tool || '未設定'}${suffix}`;
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

type PrioritizableTrainingSessionItem = {
  order: number;
  lastPerformanceSnapshot?: {
    visitDateLocal?: string;
  };
};

function getElapsedDaysSinceLastPerformance(
  item: PrioritizableTrainingSessionItem,
  todayYmd: string
): number {
  const lastDate = item.lastPerformanceSnapshot?.visitDateLocal;
  if (!lastDate) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, diffDays(lastDate, todayYmd));
}

export function getPrioritizedTrainingSessionItems<T extends PrioritizableTrainingSessionItem>(params: {
  items: T[];
  todayYmd: string;
  menuSetType: 'reusable' | 'temporary';
}): T[] {
  const { items, todayYmd, menuSetType } = params;
  const bySetOrder = [...items].sort((a, b) => a.order - b.order);
  if (menuSetType === 'temporary') {
    return bySetOrder;
  }

  const setOrderRank = new Map<T, number>();
  bySetOrder.forEach((item, index) => {
    setOrderRank.set(item, index + 1);
  });

  const byElapsedDays = [...bySetOrder].sort((a, b) => {
    const elapsedA = getElapsedDaysSinceLastPerformance(a, todayYmd);
    const elapsedB = getElapsedDaysSinceLastPerformance(b, todayYmd);
    if (elapsedA !== elapsedB) {
      return elapsedB - elapsedA;
    }
    return (setOrderRank.get(a) ?? 0) - (setOrderRank.get(b) ?? 0);
  });

  const elapsedDaysRank = new Map<T, number>();
  let currentElapsedRank = 1;
  let previousElapsedDays: number | undefined;
  byElapsedDays.forEach((item, index) => {
    const elapsedDays = getElapsedDaysSinceLastPerformance(item, todayYmd);
    if (index > 0 && elapsedDays !== previousElapsedDays) {
      currentElapsedRank = index + 1;
    }
    elapsedDaysRank.set(item, currentElapsedRank);
    previousElapsedDays = elapsedDays;
  });

  return [...bySetOrder].sort((a, b) => {
    const setRankA = setOrderRank.get(a) ?? Number.MAX_SAFE_INTEGER;
    const setRankB = setOrderRank.get(b) ?? Number.MAX_SAFE_INTEGER;
    const elapsedRankA = elapsedDaysRank.get(a) ?? Number.MAX_SAFE_INTEGER;
    const elapsedRankB = elapsedDaysRank.get(b) ?? Number.MAX_SAFE_INTEGER;
    // Lower scores run first. Set order is intentionally weighted more heavily
    // so elapsed time can adjust, but not completely replace, the planned order.
    const scoreA = setRankA * 2 + elapsedRankA;
    const scoreB = setRankB * 2 + elapsedRankB;
    return scoreA - scoreB || setRankA - setRankB;
  });
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

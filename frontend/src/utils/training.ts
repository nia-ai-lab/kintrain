import type { GymVisit, TrainingMenuItem } from '../types';
import { diffDays } from './date';

export interface LastPerformance {
  date: string;
  endedAtLocal: string;
  weightKg: number;
  reps: number;
  sets: number;
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
        sets: entry.sets
      };
    }
  }
  return null;
}

export function getYesterdayMenuIds(todayYmd: string, gymVisits: GymVisit[]): Set<string> {
  const set = new Set<string>();
  const sorted = [...gymVisits].sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length === 0) {
    return set;
  }

  const latestPastVisit = [...sorted]
    .filter((visit) => visit.date < todayYmd)
    .slice(-1)
    .at(0);

  if (!latestPastVisit) {
    return set;
  }

  const latestDate = latestPastVisit.date;
  if (diffDays(latestDate, todayYmd) !== 1) {
    return set;
  }

  sorted
    .filter((visit) => visit.date === latestDate)
    .forEach((visit) => {
      visit.entries.forEach((entry) => set.add(entry.menuItemId));
    });

  return set;
}

export function getTodayDoneIds(todayYmd: string, gymVisits: GymVisit[]): Set<string> {
  const done = new Set<string>();
  gymVisits
    .filter((visit) => visit.date === todayYmd)
    .forEach((visit) => visit.entries.forEach((entry) => done.add(entry.menuItemId)));
  return done;
}

function scoreItem(params: {
  item: TrainingMenuItem;
  todayYmd: string;
  gymVisits: GymVisit[];
  yesterdayIds: Set<string>;
  todayDoneIds: Set<string>;
}): number {
  const { item, todayYmd, gymVisits, yesterdayIds, todayDoneIds } = params;
  const last = getLastPerformance(item.id, gymVisits);
  let score = 1000 - item.order * 2;

  if (last) {
    const days = Math.max(0, diffDays(last.date, todayYmd));
    score += Math.min(60, days * 3);
  } else {
    score += 80;
  }

  if (yesterdayIds.has(item.id)) {
    score -= 120;
  }

  if (todayDoneIds.has(item.id)) {
    score -= 60;
  }

  return score;
}

export function getPrioritizedMenuItems(params: {
  menuItems: TrainingMenuItem[];
  gymVisits: GymVisit[];
  todayYmd: string;
}): TrainingMenuItem[] {
  const { menuItems, gymVisits, todayYmd } = params;
  const yesterdayIds = getYesterdayMenuIds(todayYmd, gymVisits);
  const todayDoneIds = getTodayDoneIds(todayYmd, gymVisits);

  return [...menuItems]
    .filter((item) => item.isActive)
    .sort((a, b) => {
      const scoreA = scoreItem({
        item: a,
        todayYmd,
        gymVisits,
        yesterdayIds,
        todayDoneIds
      });
      const scoreB = scoreItem({
        item: b,
        todayYmd,
        gymVisits,
        yesterdayIds,
        todayDoneIds
      });
      if (scoreA !== scoreB) {
        return scoreB - scoreA;
      }
      return a.order - b.order;
    });
}

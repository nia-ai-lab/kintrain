import type { GymVisitDto, GymVisitEntry, UpdateGymVisitInput } from '../api/coreApi';

/** The values a person can correct on a recorded exercise. */
export type GymVisitEntryEdit = {
  weightKg: string;
  reps: string;
  sets: string;
  removed: boolean;
};

export type WeightFieldKind = 'none' | 'perSide' | 'assistance' | 'additional' | 'total';

/** Which weight the entry was recorded with, so the editor can label the field the same way. */
export function getWeightFieldKind(entry: GymVisitEntry): WeightFieldKind {
  if (entry.loadModelSnapshot === 'bodyweight') return 'none';
  if (entry.loadModelSnapshot === 'assisted_bodyweight') return 'assistance';
  if (entry.loadModelSnapshot === 'bodyweight_plus_external_load') return 'additional';
  if (entry.weightInputModeSnapshot === 'perSide') return 'perSide';
  return 'total';
}

export function toEntryEdit(entry: GymVisitEntry): GymVisitEntryEdit {
  return {
    weightKg: String(entry.weightKg ?? 0),
    reps: String(entry.reps),
    sets: String(entry.sets),
    removed: false
  };
}

function parseCount(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 999 ? parsed : null;
}

function parseWeight(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1000 ? Math.round(parsed * 100) / 100 : null;
}

/** API responses carry nulls for unset fields, but the update API only accepts them as absent. */
function withoutNulls<T extends object>(value: T, keep: ReadonlyArray<keyof T> = []): T {
  return Object.fromEntries(
    Object.entries(value).filter(([key, item]) => item !== null || keep.includes(key as keyof T))
  ) as T;
}

export type GymVisitUpdateResult = { ok: true; input: UpdateGymVisitInput } | { ok: false; message: string };

/**
 * Applies the corrected weight, reps and sets to a stored visit. Everything else recorded with
 * the visit (exercise snapshots, menu set links, times) is sent back unchanged.
 */
export function buildGymVisitUpdate(visit: GymVisitDto, edits: GymVisitEntryEdit[]): GymVisitUpdateResult {
  const entries: GymVisitEntry[] = [];
  for (const [index, entry] of visit.entries.entries()) {
    const edit = edits[index];
    if (!edit) {
      return { ok: false, message: '編集内容を読み取れませんでした。もう一度開き直してください。' };
    }
    if (edit.removed) continue;

    const reps = parseCount(edit.reps);
    const sets = parseCount(edit.sets);
    if (reps === null || sets === null) {
      return { ok: false, message: `${entry.trainingNameSnapshot}の回数とセット数は1以上の整数で入力してください。` };
    }
    const weightKind = getWeightFieldKind(entry);
    const weightKg = weightKind === 'none' ? entry.weightKg ?? 0 : parseWeight(edit.weightKg);
    if (weightKg === null) {
      return { ok: false, message: `${entry.trainingNameSnapshot}の重量は0以上の数値で入力してください。` };
    }

    const base = withoutNulls(entry, ['assistanceKg']);
    const weightChanged = weightKg !== entry.weightKg;
    const next: GymVisitEntry = { ...base, weightKg, reps, sets };
    // The server recalculates the total from the weight and the recorded bar/multiplier settings.
    delete next.calculatedTotalWeightKg;
    if (weightKind === 'additional') {
      next.additionalLoadKg = weightKg;
    }
    if (weightKind === 'assistance' && (weightChanged || entry.assistanceKg !== null)) {
      next.assistanceKg = weightKg;
    }
    entries.push(next);
  }

  if (entries.length === 0) {
    return { ok: false, message: 'すべての種目を外すことはできません。少なくとも1種目を残してください。' };
  }

  return {
    ok: true,
    input: {
      startedAtUtc: visit.startedAtUtc,
      endedAtUtc: visit.endedAtUtc,
      timeZoneId: visit.timeZoneId,
      visitDateLocal: visit.visitDateLocal,
      entries,
      ...(typeof visit.note === 'string' ? { note: visit.note } : {})
    }
  };
}

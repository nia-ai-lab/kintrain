import type { WeightInputMode, WeightLoadMultiplier } from '../types';

export type WeightLoadSnapshot = {
  weightKg: number;
  weightInputModeSnapshot?: WeightInputMode;
  loadMultiplierSnapshot?: number;
  fixedWeightKgSnapshot?: number;
  calculatedTotalWeightKg?: number;
};

export function normalizeWeightInputMode(value: unknown): WeightInputMode {
  if (value === 'direct' || value === 'perSide') {
    return value;
  }
  return 'legacyUnspecified';
}

export function normalizeLoadMultiplier(value: unknown, mode: WeightInputMode): WeightLoadMultiplier {
  if (value === 1 || value === 2) {
    return value;
  }
  return mode === 'perSide' ? 2 : 1;
}

export function normalizeFixedWeightKg(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0;
  }
  return Math.round(numeric * 100) / 100;
}

export function calculateTotalWeightKg(
  weightKg: number | undefined,
  mode: WeightInputMode,
  loadMultiplier: number,
  fixedWeightKg: number
): number | undefined {
  if (
    mode === 'legacyUnspecified' ||
    typeof weightKg !== 'number' ||
    !Number.isFinite(weightKg) ||
    weightKg < 0
  ) {
    return undefined;
  }
  return Math.round((weightKg * loadMultiplier + fixedWeightKg) * 100) / 100;
}

export function formatWeightLoad(snapshot: WeightLoadSnapshot): string {
  const mode = normalizeWeightInputMode(snapshot.weightInputModeSnapshot);
  if (mode === 'legacyUnspecified') {
    return `${snapshot.weightKg}kg（重量の意味は未設定）`;
  }
  const multiplier = normalizeLoadMultiplier(snapshot.loadMultiplierSnapshot, mode);
  const fixedWeightKg = normalizeFixedWeightKg(snapshot.fixedWeightKgSnapshot);
  const calculated =
    typeof snapshot.calculatedTotalWeightKg === 'number' && Number.isFinite(snapshot.calculatedTotalWeightKg)
      ? snapshot.calculatedTotalWeightKg
      : calculateTotalWeightKg(snapshot.weightKg, mode, multiplier, fixedWeightKg);
  if (mode === 'direct') {
    return `${snapshot.weightKg}kg`;
  }
  const fixedLabel = fixedWeightKg > 0 ? ` + 固定${fixedWeightKg}kg` : '';
  return `片側${snapshot.weightKg}kg（総重量${calculated ?? '-'}kg = ×${multiplier}${fixedLabel}）`;
}

import type { WeightInputMode, WeightLoadMultiplier } from '../types';

export type WeightLoadSnapshot = {
  weightKg: number;
  weightInputModeSnapshot?: WeightInputMode;
  loadMultiplierSnapshot?: number;
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

export function calculateTotalWeightKg(
  weightKg: number | undefined,
  mode: WeightInputMode,
  loadMultiplier: number
): number | undefined {
  if (
    mode === 'legacyUnspecified' ||
    typeof weightKg !== 'number' ||
    !Number.isFinite(weightKg) ||
    weightKg < 0
  ) {
    return undefined;
  }
  return Math.round(weightKg * loadMultiplier * 100) / 100;
}

export function formatWeightLoad(snapshot: WeightLoadSnapshot): string {
  const mode = normalizeWeightInputMode(snapshot.weightInputModeSnapshot);
  if (mode === 'legacyUnspecified') {
    return `${snapshot.weightKg}kg（重量の意味は未設定）`;
  }
  const multiplier = normalizeLoadMultiplier(snapshot.loadMultiplierSnapshot, mode);
  const calculated =
    typeof snapshot.calculatedTotalWeightKg === 'number' && Number.isFinite(snapshot.calculatedTotalWeightKg)
      ? snapshot.calculatedTotalWeightKg
      : calculateTotalWeightKg(snapshot.weightKg, mode, multiplier);
  if (mode === 'direct') {
    return `${snapshot.weightKg}kg`;
  }
  return `片側${snapshot.weightKg}kg（総重量${calculated ?? '-'}kg = ×${multiplier}）`;
}

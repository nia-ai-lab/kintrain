import type { ConditionRating } from '../types';

export function isTenPointRating(value: unknown): value is ConditionRating {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 10;
}

export function getRatingColor(value?: number | null): string {
  if (!isTenPointRating(value)) {
    return 'rgba(100, 112, 126, 0.18)';
  }

  const ratio = (value - 1) / 9;
  const hue = 8 + ratio * (170 - 8);
  const saturation = 62;
  const lightness = 60 - ratio * 6;
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

export function getRatingTrackBackground(): string {
  return 'linear-gradient(90deg, #c7665c 0%, #de9359 42%, #e1bb67 62%, #6fb58e 82%, #0f766e 100%)';
}


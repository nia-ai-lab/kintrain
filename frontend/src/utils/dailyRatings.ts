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


const ratingTrackStops: Array<[number, [number, number, number]]> = [
  [0, [199, 102, 92]],
  [0.42, [222, 147, 89]],
  [0.62, [225, 187, 103]],
  [0.82, [111, 181, 142]],
  [1, [15, 118, 110]]
];

/** Color for a 1-10 rating sampled from the same gradient as the Daily slider track. */
export function getRatingScaleColor(value: number): string {
  const ratio = Math.min(1, Math.max(0, (value - 1) / 9));
  for (let index = 1; index < ratingTrackStops.length; index += 1) {
    const [endAt, end] = ratingTrackStops[index];
    if (ratio <= endAt) {
      const [startAt, start] = ratingTrackStops[index - 1];
      const t = (ratio - startAt) / (endAt - startAt);
      const channel = (i: number) => Math.round(start[i] + (end[i] - start[i]) * t);
      return `rgb(${channel(0)} ${channel(1)} ${channel(2)})`;
    }
  }
  return 'rgb(15 118 110)';
}

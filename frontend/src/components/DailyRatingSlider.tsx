import type { CSSProperties } from 'react';
import type { ConditionRating } from '../types';
import { getRatingColor, getRatingTrackBackground, isTenPointRating } from '../utils/dailyRatings';

export function DailyRatingSlider({
  label,
  value,
  onChange
}: {
  label: string;
  value?: ConditionRating;
  onChange: (value: ConditionRating) => void;
}) {
  const displayValue = isTenPointRating(value) ? value : 5;
  const percent = ((displayValue - 1) / 9) * 100;

  return (
    <div className="daily-rating-slider-card">
      <div className="row-between align-start">
        <div className="daily-rating-label-group">
          <h3>{label}</h3>
          <p className="muted">低い ↔ 高い</p>
        </div>
        <span
          className="daily-rating-value-pill"
          style={{
            background: getRatingColor(displayValue),
            color: displayValue >= 7 ? '#f8fffd' : '#182028'
          }}
        >
          {value ? `${value} / 10` : '未入力'}
        </span>
      </div>
      <div className="daily-rating-slider-shell">
        <input
          className="daily-rating-slider-input"
          type="range"
          min={1}
          max={10}
          step={1}
          value={displayValue}
          onChange={(event) => onChange(Number(event.currentTarget.value) as ConditionRating)}
          aria-label={label}
          style={
            {
              '--rating-progress': `${percent}%`,
              '--rating-thumb-color': getRatingColor(displayValue),
              '--rating-track': getRatingTrackBackground()
            } as CSSProperties
          }
        />
      </div>
      <div className="daily-rating-scale" aria-hidden="true">
        <span>1</span>
        <span>5</span>
        <span>10</span>
      </div>
    </div>
  );
}

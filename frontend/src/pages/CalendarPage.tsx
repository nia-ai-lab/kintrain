import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { getCalendarMonth } from '../api/coreApi';
import { getRatingScaleColor, isTenPointRating } from '../utils/dailyRatings';
import { addMonths, getDaysInMonth, pad2, toYm, toYmd, weekdayIndex } from '../utils/date';

const weekdayLabels = ['日', '月', '火', '水', '木', '金', '土'];

type CalendarView = 'activity' | 'condition' | 'mood';

const VIEW_STORAGE_KEY = 'kintrain-calendar-view';

const viewOptions: Array<{ value: CalendarView; label: string }> = [
  { value: 'activity', label: '実施' },
  { value: 'condition', label: '体調' },
  { value: 'mood', label: '気分' }
];

function loadCalendarView(): CalendarView {
  try {
    const saved = localStorage.getItem(VIEW_STORAGE_KEY);
    return saved === 'condition' || saved === 'mood' ? saved : 'activity';
  } catch {
    return 'activity';
  }
}

function saveCalendarView(view: CalendarView) {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // Remembering the view is a convenience; ignore storage failures.
  }
}

function TrainingIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6.5 7v10M17.5 7v10M3.5 9.5v5M20.5 9.5v5M6.5 12h11" />
    </svg>
  );
}

function RecoveryIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 19c0-8 5-13 14-14-1 9-6 14-14 14Z" />
      <path d="M5 19 13 11" />
    </svg>
  );
}

function ChevronIcon({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={direction === 'left' ? 'M14.5 6 8.5 12l6 6' : 'M9.5 6l6 6-6 6'} />
    </svg>
  );
}

export function CalendarPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const currentYm = params.get('month') ?? toYm(new Date());
  const todayYmd = toYmd(new Date());
  const [view, setView] = useState<CalendarView>(loadCalendarView);
  const [calendarMap, setCalendarMap] = useState<
    Record<string, {
      trained: boolean;
      recovered: boolean;
      plannedMenuSetName?: string;
      plannedMenuSetKind?: 'training' | 'recovery';
      planStatus?: 'none' | 'planned' | 'as_planned' | 'changed' | 'additional';
      conditionRating?: number | null;
      moodRating?: number | null;
    }>
  >({});

  const cells = useMemo(() => {
    const [year, month] = currentYm.split('-').map(Number);
    const firstYmd = `${year}-${pad2(month)}-01`;
    const daysInMonth = getDaysInMonth(currentYm);
    const startOffset = weekdayIndex(firstYmd);

    const result: Array<{ ymd: string | null }> = Array.from({ length: startOffset }).map(() => ({ ymd: null }));
    for (let d = 1; d <= daysInMonth; d += 1) {
      result.push({ ymd: `${year}-${pad2(month)}-${pad2(d)}` });
    }
    while (result.length % 7 !== 0) {
      result.push({ ymd: null });
    }
    return result;
  }, [currentYm]);

  useEffect(() => {
    let cancelled = false;
    void getCalendarMonth(currentYm)
      .then((response) => {
        if (cancelled) {
          return;
        }
        const nextMap: typeof calendarMap = {};
        for (const day of response.days ?? []) {
          const date = typeof day.date === 'string' ? day.date : '';
          if (!date) {
            continue;
          }
          nextMap[date] = {
            trained: Boolean(day.trained),
            recovered: Boolean(day.recovered),
            plannedMenuSetName: day.plannedMenuSetName,
            plannedMenuSetKind: day.plannedMenuSetKind,
            planStatus: day.planStatus,
            conditionRating: typeof day.conditionRating === 'number' ? day.conditionRating : null,
            moodRating: typeof day.moodRating === 'number' ? day.moodRating : null
          };
        }
        setCalendarMap(nextMap);
      })
      .catch(() => {
        if (!cancelled) {
          setCalendarMap({});
        }
      });
    return () => {
      cancelled = true;
    };
  }, [currentYm]);

  function changeView(next: CalendarView) {
    setView(next);
    saveCalendarView(next);
  }

  const ratingLabel = view === 'condition' ? '体調' : '気分';

  return (
    <div className="stack-lg calendar-page">
      <section className="card calendar-shell-card">
        <h1>カレンダー</h1>

        <div className="row-between calendar-toolbar">
          <button
            type="button"
            className="btn ghost calendar-month-button"
            aria-label="前月"
            onClick={() => setParams({ month: addMonths(currentYm, -1) })}
          >
            <ChevronIcon direction="left" />
          </button>
          <h2>{currentYm.replace('-', ' / ')}</h2>
          <button
            type="button"
            className="btn ghost calendar-month-button"
            aria-label="次月"
            onClick={() => setParams({ month: addMonths(currentYm, 1) })}
          >
            <ChevronIcon direction="right" />
          </button>
        </div>

        <div className="calendar-view-switch" role="group" aria-label="カレンダーの表示">
          {viewOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className={view === option.value ? 'is-active' : ''}
              aria-pressed={view === option.value}
              onClick={() => changeView(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="calendar-grid calendar-weekdays">
          {weekdayLabels.map((label) => (
            <div key={label} className="calendar-weekday">
              {label}
            </div>
          ))}
        </div>

        <div className={`calendar-grid calendar-days is-${view}`}>
          {cells.map((cell, idx) => {
            if (!cell.ymd) {
              return <div className="calendar-cell empty" key={`empty-${idx}`} />;
            }
            const dayData = calendarMap[cell.ymd];
            const isToday = cell.ymd === todayYmd;
            const isUpcoming = cell.ymd >= todayYmd;
            const isTrained = Boolean(dayData?.trained);
            const isRecovered = Boolean(dayData?.recovered);
            const isTrainingPlanned = isUpcoming && !isTrained && dayData?.plannedMenuSetKind === 'training';
            const isRecoveryPlanned = isUpcoming && !isRecovered && dayData?.plannedMenuSetKind === 'recovery';
            const dayNumber = Number(cell.ymd.slice(-2));
            const classes = ['calendar-cell'];
            if (isToday) {
              classes.push('today');
            }

            if (view === 'activity') {
              const summary = [
                isTrained ? '筋トレ実施' : isTrainingPlanned ? '筋トレ予定' : '',
                isRecovered ? 'リカバリー実施' : isRecoveryPlanned ? 'リカバリー予定' : ''
              ].filter(Boolean);
              return (
                <button
                  type="button"
                  className={classes.join(' ')}
                  key={cell.ymd}
                  aria-label={`${dayNumber}日${summary.length > 0 ? ` ${summary.join('、')}` : ''}`}
                  onClick={() => navigate(`/daily/${cell.ymd}`)}
                >
                  <span className="day-number">{dayNumber}</span>
                  <span className="calendar-activity-slots" aria-hidden="true">
                    <span
                      className={`calendar-activity-icon is-training${isTrained ? ' is-done' : isTrainingPlanned ? ' is-planned' : ''}`}
                    >
                      {(isTrained || isTrainingPlanned) && <TrainingIcon />}
                    </span>
                    <span
                      className={`calendar-activity-icon is-recovery${isRecovered ? ' is-done' : isRecoveryPlanned ? ' is-planned' : ''}`}
                    >
                      {(isRecovered || isRecoveryPlanned) && <RecoveryIcon />}
                    </span>
                  </span>
                </button>
              );
            }

            const rating = view === 'condition' ? dayData?.conditionRating : dayData?.moodRating;
            const hasRating = isTenPointRating(rating);
            if (hasRating) {
              classes.push('has-rating');
            }
            return (
              <button
                type="button"
                className={classes.join(' ')}
                key={cell.ymd}
                aria-label={`${dayNumber}日 ${ratingLabel} ${hasRating ? `${rating}/10` : '未記録'}`}
                style={hasRating ? ({ '--rating-color': getRatingScaleColor(rating) } as React.CSSProperties) : undefined}
                onClick={() => navigate(`/daily/${cell.ymd}`)}
              >
                <span className="day-number">{dayNumber}</span>
                <span className="calendar-rating-value" aria-hidden="true">
                  {hasRating ? rating : '–'}
                </span>
              </button>
            );
          })}
        </div>

        {view === 'activity' ? (
          <div className="calendar-legend">
            <span className="calendar-legend-item">
              <span className="calendar-activity-icon is-training is-done" aria-hidden="true">
                <TrainingIcon />
              </span>
              筋トレ
            </span>
            <span className="calendar-legend-item">
              <span className="calendar-activity-icon is-recovery is-done" aria-hidden="true">
                <RecoveryIcon />
              </span>
              リカバリー
            </span>
            <span className="calendar-legend-item">
              <span className="calendar-activity-icon is-training is-planned" aria-hidden="true">
                <TrainingIcon />
              </span>
              点線は予定
            </span>
          </div>
        ) : (
          <div className="calendar-legend calendar-rating-legend">
            <span>{ratingLabel} 1</span>
            <span className="calendar-rating-scale" aria-hidden="true">
              {Array.from({ length: 10 }, (_, index) => (
                <span key={index} style={{ backgroundColor: getRatingScaleColor(index + 1) }} />
              ))}
            </span>
            <span>10</span>
            <span className="calendar-rating-missing">– 未記録</span>
          </div>
        )}
      </section>
    </div>
  );
}

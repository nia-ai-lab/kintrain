import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { getCalendarMonth } from '../api/coreApi';
import { addMonths, getDaysInMonth, pad2, toYm, toYmd, weekdayIndex } from '../utils/date';

const weekdayLabels = ['日', '月', '火', '水', '木', '金', '土'];

const conditionIcons: Record<number, string> = {
  1: '😵',
  2: '😟',
  3: '😐',
  4: '🙂',
  5: '😄'
};

export function CalendarPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const currentYm = params.get('month') ?? toYm(new Date());
  const todayYmd = toYmd(new Date());
  const [calendarMap, setCalendarMap] = useState<Record<string, { trained: boolean; conditionRating?: number | null }>>({});

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
        const nextMap: Record<string, { trained: boolean; conditionRating?: number | null }> = {};
        for (const day of response.days ?? []) {
          const date = typeof day.date === 'string' ? day.date : '';
          if (!date) {
            continue;
          }
          nextMap[date] = {
            trained: Boolean(day.trained),
            conditionRating: typeof day.conditionRating === 'number' ? day.conditionRating : null
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

  return (
    <div className="stack-lg calendar-page">
      <section className="card calendar-shell-card">
        <div className="row-between">
          <h1>カレンダー</h1>
          <Link to="/dashboard" className="btn ghost">
            ダッシュボードへ
          </Link>
        </div>

        <div className="row-between calendar-toolbar">
          <button type="button" className="btn subtle" onClick={() => setParams({ month: addMonths(currentYm, -1) })}>
            前月
          </button>
          <h2>{currentYm.replace('-', ' / ')}</h2>
          <button type="button" className="btn subtle" onClick={() => setParams({ month: addMonths(currentYm, 1) })}>
            次月
          </button>
        </div>

        <div className="calendar-grid calendar-weekdays">
          {weekdayLabels.map((label) => (
            <div key={label} className="calendar-weekday">
              {label}
            </div>
          ))}
        </div>

        <div className="calendar-grid calendar-days">
          {cells.map((cell, idx) => {
            if (!cell.ymd) {
              return <div className="calendar-cell empty" key={`empty-${idx}`} />;
            }
            const dayData = calendarMap[cell.ymd];
            const isTrained = Boolean(dayData?.trained);
            const isToday = cell.ymd === todayYmd;
            const rating = dayData?.conditionRating ?? null;
            const classes = ['calendar-cell'];
            if (isTrained) {
              classes.push('trained');
            }
            if (isToday) {
              classes.push('today');
            }

            return (
              <button
                type="button"
                className={classes.join(' ')}
                key={cell.ymd}
                onClick={() => navigate(`/daily/${cell.ymd}`)}
              >
                <span className="day-number">{Number(cell.ymd.slice(-2))}</span>
                <span className={`train-dot${isTrained ? '' : ' placeholder'}`}>●</span>
                <span className="condition-icon">{rating ? conditionIcons[rating] : '○'}</span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

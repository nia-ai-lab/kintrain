import { Link } from 'react-router-dom';
import { useAppState, useTodayYmd } from '../AppState';
import { ymdToDisplay } from '../utils/date';
import { formatTrainingLabel } from '../utils/training';

export function DashboardPage() {
  const { data } = useAppState();
  const today = useTodayYmd();
  const todayRecord = data.dailyRecords[today];
  const latestVisit = [...data.gymVisits].sort((a, b) => b.date.localeCompare(a.date))[0];

  return (
    <div className="stack-lg">
      <section className="hero-card">
        <p className="eyebrow">TODAY {ymdToDisplay(today)}</p>
        <div className="row-wrap">
          <Link to="/training-session" className="btn primary">
            トレーニング開始
          </Link>
          <Link to={`/daily/${today}`} className="btn ghost">
            本日の日記をつける
          </Link>
        </div>
      </section>

      <section className="grid-2">
        <article className="card">
          <h2>今日の状態</h2>
          <p className="muted">{ymdToDisplay(today)}</p>
          <ul className="simple-list">
            <li>体重: {todayRecord?.bodyWeightKg ? `${todayRecord.bodyWeightKg} kg` : '未入力'}</li>
            <li>体脂肪率: {todayRecord?.bodyFatPercent ? `${todayRecord.bodyFatPercent} %` : '未入力'}</li>
            <li>体調: {todayRecord?.conditionRating ? `${todayRecord.conditionRating} / 5` : '未入力'}</li>
          </ul>
        </article>

        <article className="card">
          <h2>直近の筋トレ</h2>
          {latestVisit ? (
            <>
              <p className="muted">{ymdToDisplay(latestVisit.date)}</p>
              <ol className="simple-list numbered-list">
                {latestVisit.entries.slice(0, 4).map((entry) => (
                  <li key={entry.id}>
                    {formatTrainingLabel(entry.trainingName, entry.bodyPart)} {entry.weightKg}kg x {entry.reps}回 x {entry.sets}set
                  </li>
                ))}
              </ol>
              <Link to="/calendar" className="text-link">
                カレンダーで確認
              </Link>
            </>
          ) : (
            <p className="muted">まだ記録がありません。</p>
          )}
        </article>
      </section>
    </div>
  );
}

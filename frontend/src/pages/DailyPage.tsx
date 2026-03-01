import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAppState, useTodayYmd } from '../AppState';
import { ConditionRatingPicker } from '../components/ConditionRatingPicker';
import { ymdToDisplay } from '../utils/date';
import { formatTrainingLabel } from '../utils/training';

export function DailyPage() {
  const { date } = useParams<{ date: string }>();
  const today = useTodayYmd();
  const targetDate = date ?? today;

  const { data, saveDailyRecord, setConditionRating, addOtherActivity, removeOtherActivity, flushDailyRecord, getDailySaveStatus } =
    useAppState();
  const [activityInput, setActivityInput] = useState('');
  const [saveMessage, setSaveMessage] = useState('');

  const record = data.dailyRecords[targetDate] ?? {
    date: targetDate,
    timeZoneId: data.userProfile.timeZoneId,
    otherActivities: [] as string[]
  };

  const visits = useMemo(
    () => data.gymVisits.filter((visit) => visit.date === targetDate),
    [data.gymVisits, targetDate]
  );
  const visitEntries = useMemo(() => visits.flatMap((visit) => visit.entries), [visits]);
  const dailySaveStatus = getDailySaveStatus(targetDate);

  return (
    <div className="stack-lg">
      <section className="card">
        <div className="row-between">
          <h1>Daily</h1>
          <div className="row-wrap">
            <Link to="/calendar" className="btn ghost">
              カレンダー
            </Link>
            <Link to="/training-session" className="btn primary">
              トレーニング開始
            </Link>
          </div>
        </div>
        <div className="row-between">
          <p className="muted">{ymdToDisplay(targetDate)}</p>
          <button
            type="button"
            className="btn subtle"
            disabled={dailySaveStatus.isSaving || !dailySaveStatus.isDirty}
            onClick={async () => {
              const result = await flushDailyRecord(targetDate);
              setSaveMessage(result.ok ? '保存しました。' : result.message ?? '保存に失敗しました。');
            }}
          >
            保存
          </button>
        </div>
        <p className="muted">
          {dailySaveStatus.isSaving
            ? '保存中...'
            : dailySaveStatus.error
              ? `保存エラー: ${dailySaveStatus.error}`
              : dailySaveStatus.lastSavedAtLocal
                ? `最終保存: ${dailySaveStatus.lastSavedAtLocal.replace('T', ' ').slice(11, 16)}`
                : '未保存'}
          {!dailySaveStatus.isSaving && dailySaveStatus.isDirty ? '（未保存の変更あり）' : ''}
        </p>
        {saveMessage && <p className="status-text">{saveMessage}</p>}
      </section>

      <section className="card">
        <h2>体重・体脂肪率</h2>
        <div className="input-grid body-metrics-grid">
          <label>
            体重 (kg)
            <input
              type="number"
              min={0}
              step={0.1}
              value={record.bodyWeightKg ?? ''}
              onChange={(e) =>
                saveDailyRecord(targetDate, {
                  bodyWeightKg: e.target.value ? Number(e.target.value) : undefined
                })
              }
            />
          </label>
          <label>
            体脂肪率 (%)
            <input
              type="number"
              min={0}
              step={0.1}
              value={record.bodyFatPercent ?? ''}
              onChange={(e) =>
                saveDailyRecord(targetDate, {
                  bodyFatPercent: e.target.value ? Number(e.target.value) : undefined
                })
              }
            />
          </label>
          <label className="body-time-field">
            測定時刻
            <input
              type="time"
              value={record.bodyMetricMeasuredTime ?? ''}
              onChange={(e) =>
                saveDailyRecord(targetDate, {
                  bodyMetricMeasuredTime: e.target.value || undefined
                })
              }
            />
          </label>
        </div>
      </section>

      <section className="card">
        <h2>体調</h2>
        <ConditionRatingPicker value={record.conditionRating} onChange={(rating) => setConditionRating(targetDate, rating)} />
        <label>
          コメント
          <textarea
            value={record.conditionComment ?? ''}
            onChange={(e) => saveDailyRecord(targetDate, { conditionComment: e.target.value })}
            placeholder="任意で体調メモ"
          />
        </label>
      </section>

      <section className="card">
        <h2>日記</h2>
        <textarea
          value={record.diary ?? ''}
          onChange={(e) => saveDailyRecord(targetDate, { diary: e.target.value })}
          placeholder="今日の記録や気づき"
        />
      </section>

      <section className="card">
        <h2>その他トレーニング</h2>
        <div className="row-wrap">
          <input value={activityInput} onChange={(e) => setActivityInput(e.target.value)} placeholder="例: ジョギング 1km" />
          <button
            type="button"
            className="btn subtle"
            onClick={() => {
              addOtherActivity(targetDate, activityInput);
              setActivityInput('');
            }}
          >
            追加
          </button>
        </div>
        <ul className="simple-list">
          {record.otherActivities.map((activity, idx) => (
            <li key={`${activity}-${idx}`}>
              {activity}
              <button type="button" className="text-link danger-link" onClick={() => removeOtherActivity(targetDate, idx)}>
                削除
              </button>
            </li>
          ))}
          {record.otherActivities.length === 0 && <li className="muted">未入力</li>}
        </ul>
      </section>

      <section className="card">
        <h2>当日の筋トレ内容</h2>
        {visitEntries.length === 0 ? (
          <p className="muted">この日の筋トレ記録はまだありません。</p>
        ) : (
          <ol className="simple-list numbered-list">
            {visitEntries.map((entry) => (
              <li key={entry.id}>
                {formatTrainingLabel(entry.trainingName, entry.bodyPart)} {entry.weightKg}kg x {entry.reps}回 x {entry.sets}set
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

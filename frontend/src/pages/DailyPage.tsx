import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAppState, useTodayYmd } from '../AppState';
import { getDailyTrainingPlan, listRecoveryExecutions, type DailyTrainingPlanDto, type RecoveryExecutionDto } from '../api/coreApi';
import { DailyRatingSlider } from '../components/DailyRatingSlider';
import { ymdToDisplay } from '../utils/date';
import { formatTrainingLabel } from '../utils/training';
import { formatWeightLoad } from '../utils/weightLoad';

export function DailyPage() {
  const { date } = useParams<{ date: string }>();
  const today = useTodayYmd();
  const targetDate = date ?? today;

  const {
    data,
    refreshDailyRecord,
    saveDailyRecord,
    setConditionRating,
    setMoodRating,
    addOtherActivity,
    removeOtherActivity,
    flushDailyRecord,
    getDailySaveStatus
  } =
    useAppState();
  const [activityInput, setActivityInput] = useState('');
  const [painAreaInput, setPainAreaInput] = useState('');
  const [saveMessage, setSaveMessage] = useState('');
  const [recoveryExecutions, setRecoveryExecutions] = useState<RecoveryExecutionDto[]>([]);
  const [dailyPlan, setDailyPlan] = useState<DailyTrainingPlanDto | null>(null);

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
  const painAreas = record.painAreas ?? [];

  useEffect(() => {
    void refreshDailyRecord(targetDate);
    void Promise.all([
      listRecoveryExecutions({ from: targetDate, to: targetDate }),
      getDailyTrainingPlan(targetDate)
    ]).then(([executions, plan]) => {
      setRecoveryExecutions(executions);
      setDailyPlan(plan);
    }).catch(() => {
      setRecoveryExecutions([]);
      setDailyPlan(null);
    });
  }, [refreshDailyRecord, targetDate]);

  return (
    <div className="stack-lg daily-page">
      <section className="card daily-hero-card">
        <div className="row-between">
          <h1>Daily</h1>
          <div className="row-wrap">
            <Link to="/calendar" className="btn ghost">
              カレンダー
            </Link>
            <Link to="/training-session" className="btn primary">
              実施を登録
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
                ? `最終保存: ${dailySaveStatus.lastSavedAtLocal.replace('T', ' ').slice(0, 16)}`
                : '未保存'}
          {!dailySaveStatus.isSaving && dailySaveStatus.isDirty ? '（未保存の変更あり）' : ''}
        </p>
        {saveMessage && <p className="status-text">{saveMessage}</p>}
      </section>

      <section className="card daily-section-card">
        <h2>当日の計画</h2>
        {dailyPlan ? (
          <p><strong>{dailyPlan.menuSetName}</strong>・{dailyPlan.menuSetKind === 'recovery' ? 'リカバリー' : 'トレーニング'}</p>
        ) : (
          <p className="muted">この日の計画はありません。</p>
        )}
      </section>

      <section className="card daily-section-card">
        <h2>体組成</h2>
        <div className="input-grid body-metrics-grid">
          <label className="body-metric-value-field">
            <span className="body-metric-label">
              <span>体重</span>
              <span className="body-metric-unit"> (kg)</span>
            </span>
            <input
              type="number"
              min={0.01}
              step={0.1}
              inputMode="decimal"
              value={record.bodyWeightKg ?? ''}
              onChange={(e) =>
                saveDailyRecord(targetDate, {
                  bodyWeightKg: e.target.value ? Number(e.target.value) : null
                })
              }
            />
          </label>
          <label className="body-metric-value-field">
            <span className="body-metric-label">
              <span>体脂肪率</span>
              <span className="body-metric-unit"> (%)</span>
            </span>
            <input
              type="number"
              min={0}
              step={0.1}
              inputMode="decimal"
              value={record.bodyFatPercent ?? ''}
              onChange={(e) =>
                saveDailyRecord(targetDate, {
                  bodyFatPercent: e.target.value ? Number(e.target.value) : null
                })
              }
            />
          </label>
          <label className="body-metric-value-field">
            <span className="body-metric-label">
              <span>筋肉量</span>
              <span className="body-metric-unit"> (kg)</span>
            </span>
            <input
              type="number"
              min={0.01}
              step={0.1}
              inputMode="decimal"
              value={record.muscleMassKg ?? ''}
              onChange={(e) =>
                saveDailyRecord(targetDate, {
                  muscleMassKg: e.target.value ? Number(e.target.value) : null
                })
              }
            />
          </label>
          <label className="body-time-field body-metrics-time-row">
            測定時刻
            <input
              type="time"
              value={record.bodyMetricMeasuredTime ?? ''}
              onChange={(e) =>
                saveDailyRecord(targetDate, {
                  bodyMetricMeasuredTime: e.target.value || null
                })
              }
            />
          </label>
        </div>
      </section>

      <section className="card daily-section-card daily-rating-section-card">
        <h2>体調・気分</h2>
        <div className="daily-rating-grid">
          <DailyRatingSlider label="体調" value={record.conditionRating} onChange={(rating) => setConditionRating(targetDate, rating)} />
          <DailyRatingSlider label="気分" value={record.moodRating} onChange={(rating) => setMoodRating(targetDate, rating)} />
        </div>
        <label>
          コメント
          <textarea
            className="daily-condition-comment-textarea"
            rows={2}
            value={record.conditionComment ?? ''}
            onChange={(e) => saveDailyRecord(targetDate, { conditionComment: e.target.value })}
            placeholder="体調や気分のメモ"
          />
        </label>
      </section>

      <section className="card daily-section-card">
        <h2>回復・トレーニング準備</h2>
        <div className="input-grid body-metrics-grid">
          <label>
            睡眠時間
            <input
              type="number"
              min={0}
              max={24}
              step={0.25}
              value={record.sleepHours ?? ''}
              onChange={(e) =>
                saveDailyRecord(targetDate, {
                  sleepHours: e.target.value ? Number(e.target.value) : undefined
                })
              }
            />
          </label>
          <label>
            安静時心拍数 (bpm)
            <input
              type="number"
              min={20}
              max={250}
              step={1}
              value={record.restingHeartRate ?? ''}
              onChange={(e) =>
                saveDailyRecord(targetDate, {
                  restingHeartRate: e.target.value ? Number(e.target.value) : undefined
                })
              }
            />
          </label>
        </div>
        <div className="daily-rating-grid">
          <DailyRatingSlider
            label="睡眠の質"
            value={record.sleepQuality}
            onChange={(sleepQuality) => saveDailyRecord(targetDate, { sleepQuality })}
          />
          <DailyRatingSlider
            label="疲労度"
            value={record.fatigueLevel}
            onChange={(fatigueLevel) => saveDailyRecord(targetDate, { fatigueLevel })}
          />
          <DailyRatingSlider
            label="やる気"
            value={record.motivationLevel}
            onChange={(motivationLevel) => saveDailyRecord(targetDate, { motivationLevel })}
          />
          <DailyRatingSlider
            label="筋肉痛"
            value={record.muscleSorenessLevel}
            onChange={(muscleSorenessLevel) => saveDailyRecord(targetDate, { muscleSorenessLevel })}
          />
        </div>
      </section>

      <section className="card daily-section-card">
        <h2>食事</h2>
        <label>
          食事内容・栄養メモ
          <textarea
            rows={5}
            maxLength={5000}
            value={record.mealNotes ?? ''}
            onChange={(e) => saveDailyRecord(targetDate, { mealNotes: e.target.value })}
            placeholder={'例:\n朝：オートミール、卵、ヨーグルト\nトレーニング前：バナナ\n夜：外食でやや食べ過ぎ。水分は少なめ'}
          />
        </label>
        <p className="muted">食事内容、量、時間、水分、サプリメントなどを自由に記録できます。</p>
      </section>

      <section className="card daily-section-card">
        <h2>痛み・違和感</h2>
        <div className="row-wrap">
          <input
            value={painAreaInput}
            maxLength={100}
            onChange={(e) => setPainAreaInput(e.target.value)}
            placeholder="例: 右肩"
          />
          <button
            type="button"
            className="btn subtle"
            disabled={!painAreaInput.trim() || painAreas.length >= 20}
            onClick={() => {
              const area = painAreaInput.trim();
              if (!area) return;
              saveDailyRecord(targetDate, {
                painAreas: [
                  ...painAreas,
                  {
                    area,
                    severity: 5,
                    occursAtRest: false,
                    occursDuringMovement: true,
                    numbness: false,
                    weakness: false
                  }
                ]
              });
              setPainAreaInput('');
            }}
          >
            部位を追加
          </button>
        </div>
        <div className="stack">
          {painAreas.map((pain, index) => (
            <div className="card subtle-card" key={`${pain.area}-${index}`}>
              <div className="row-between">
                <strong>{pain.area}</strong>
                <button
                  type="button"
                  className="text-link danger-link"
                  onClick={() =>
                    saveDailyRecord(targetDate, {
                      painAreas: painAreas.filter((_, targetIndex) => targetIndex !== index)
                    })
                  }
                >
                  削除
                </button>
              </div>
              <DailyRatingSlider
                label="痛みの強さ"
                value={pain.severity}
                onChange={(severity) =>
                  saveDailyRecord(targetDate, {
                    painAreas: painAreas.map((item, targetIndex) =>
                      targetIndex === index ? { ...item, severity } : item
                    )
                  })
                }
              />
              <div className="row-wrap">
                {[
                  ['occursAtRest', '安静時にも痛む'],
                  ['occursDuringMovement', '動作時に痛む'],
                  ['numbness', 'しびれ'],
                  ['weakness', '筋力低下']
                ].map(([field, label]) => (
                  <label className="inline-check" key={field}>
                    <input
                      type="checkbox"
                      checked={Boolean(pain[field as keyof typeof pain])}
                      onChange={(e) =>
                        saveDailyRecord(targetDate, {
                          painAreas: painAreas.map((item, targetIndex) =>
                            targetIndex === index ? { ...item, [field]: e.target.checked } : item
                          )
                        })
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
          ))}
          {painAreas.length === 0 && <p className="muted">痛み・違和感の記録はありません。</p>}
        </div>
      </section>

      <section className="card daily-section-card">
        <h2>日記</h2>
        <textarea
          className="daily-diary-textarea"
          rows={6}
          value={record.diary ?? ''}
          onChange={(e) => saveDailyRecord(targetDate, { diary: e.target.value })}
          placeholder="今日の記録や気づき"
        />
      </section>

      <section className="card daily-section-card">
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

      <section className="card daily-section-card">
        <h2>当日の筋トレ内容</h2>
        {visitEntries.length === 0 ? (
          <p className="muted">この日の筋トレ記録はまだありません。</p>
        ) : (
          <ol className="simple-list numbered-list">
            {visitEntries.map((entry) => (
              <li key={entry.id}>
                {formatTrainingLabel(entry.trainingName, entry.muscleTargetsSnapshot, entry.equipmentTypeSnapshot)} {formatWeightLoad(entry)} x {entry.reps}回 x {entry.sets}set
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="card daily-section-card">
        <h2>当日のリカバリー内容</h2>
        {recoveryExecutions.length === 0 ? (
          <p className="muted">この日のリカバリー記録はまだありません。</p>
        ) : (
          <ul className="simple-list">
            {recoveryExecutions.flatMap((execution) => execution.entries.map((entry, index) => (
              <li key={`${execution.executionId}-${index}`}>
                <strong>{entry.activityNameSnapshot}</strong>
                {entry.actualDurationMinutes ? `・${entry.actualDurationMinutes}分` : ''}
                {entry.note ? `・${entry.note}` : ''}
                <small>{execution.sourceMenuSetNameSnapshot}</small>
              </li>
            )))}
          </ul>
        )}
      </section>
    </div>
  );
}

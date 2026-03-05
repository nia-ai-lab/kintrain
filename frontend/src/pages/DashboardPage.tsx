import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppState, useTodayYmd } from '../AppState';
import { ymdToDisplay } from '../utils/date';
import { formatTrainingLabel } from '../utils/training';

export function DashboardPage() {
  const { data, saveGoal, refreshDailyRecord } = useAppState();
  const today = useTodayYmd();
  const todayRecord = data.dailyRecords[today];
  const latestVisit = [...data.gymVisits].sort((a, b) => b.date.localeCompare(a.date))[0];
  const [isGoalModalOpen, setIsGoalModalOpen] = useState(false);
  const [goalWeightInput, setGoalWeightInput] = useState(data.goal.targetWeightKg !== undefined ? String(data.goal.targetWeightKg) : '');
  const [goalBodyFatInput, setGoalBodyFatInput] = useState(
    data.goal.targetBodyFatPercent !== undefined ? String(data.goal.targetBodyFatPercent) : ''
  );
  const [goalDeadlineInput, setGoalDeadlineInput] = useState(data.goal.deadlineDate ?? '');
  const [goalCommentInput, setGoalCommentInput] = useState(data.goal.comment ?? '');
  const [goalStatus, setGoalStatus] = useState('');
  const [isSavingGoal, setIsSavingGoal] = useState(false);

  useEffect(() => {
    void refreshDailyRecord(today);
  }, [refreshDailyRecord, today]);

  useEffect(() => {
    if (isGoalModalOpen) {
      return;
    }
    setGoalWeightInput(data.goal.targetWeightKg !== undefined ? String(data.goal.targetWeightKg) : '');
    setGoalBodyFatInput(data.goal.targetBodyFatPercent !== undefined ? String(data.goal.targetBodyFatPercent) : '');
    setGoalDeadlineInput(data.goal.deadlineDate ?? '');
    setGoalCommentInput(data.goal.comment ?? '');
  }, [data.goal.comment, data.goal.deadlineDate, data.goal.targetBodyFatPercent, data.goal.targetWeightKg, isGoalModalOpen]);

  const openGoalModal = () => {
    setGoalWeightInput(data.goal.targetWeightKg !== undefined ? String(data.goal.targetWeightKg) : '');
    setGoalBodyFatInput(data.goal.targetBodyFatPercent !== undefined ? String(data.goal.targetBodyFatPercent) : '');
    setGoalDeadlineInput(data.goal.deadlineDate ?? '');
    setGoalCommentInput(data.goal.comment ?? '');
    setGoalStatus('');
    setIsGoalModalOpen(true);
  };

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

      <article className="card card-highlight">
        <div className="row-wrap row-between">
          <h2>ゴール</h2>
          <button type="button" className="btn subtle" onClick={openGoalModal}>
            ゴール設定
          </button>
        </div>
        <ul className="simple-list">
          <li>目標体重: {typeof data.goal.targetWeightKg === 'number' ? `${data.goal.targetWeightKg} kg` : '未設定'}</li>
          <li>目標体脂肪率: {typeof data.goal.targetBodyFatPercent === 'number' ? `${data.goal.targetBodyFatPercent} %` : '未設定'}</li>
          <li>期限: {data.goal.deadlineDate ? ymdToDisplay(data.goal.deadlineDate) : '未設定'}</li>
          <li className="goal-line">
            <span className="goal-line-label">コメント:</span>
            <span className="goal-line-value">{data.goal.comment?.trim() ? data.goal.comment : '未設定'}</span>
          </li>
        </ul>
      </article>

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
                    {formatTrainingLabel(entry.trainingName, entry.bodyPart, entry.equipment)} {entry.weightKg}kg x {entry.reps}回 x {entry.sets}set
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

      {isGoalModalOpen && (
        <div className="overlay-modal" role="dialog" aria-modal="true" aria-labelledby="goal-modal-title">
          <div className="overlay-modal-card">
            <h3 id="goal-modal-title">ゴール設定</h3>
            <label>
              目標体重 (kg)
              <input
                type="number"
                min={1}
                step={0.1}
                value={goalWeightInput}
                onChange={(event) => setGoalWeightInput(event.currentTarget.value)}
              />
            </label>
            <label>
              目標体脂肪率 (%)
              <input
                type="number"
                min={1}
                max={100}
                step={0.1}
                value={goalBodyFatInput}
                onChange={(event) => setGoalBodyFatInput(event.currentTarget.value)}
              />
            </label>
            <label>
              期限
              <input type="date" value={goalDeadlineInput} onChange={(event) => setGoalDeadlineInput(event.currentTarget.value)} />
            </label>
            <label>
              コメント
              <textarea
                value={goalCommentInput}
                onChange={(event) => setGoalCommentInput(event.currentTarget.value)}
                placeholder="任意でゴールに関するメモを入力"
              />
            </label>
            {goalStatus && <p className="status-text">{goalStatus}</p>}
            <div className="overlay-modal-actions">
              <button type="button" className="btn subtle" disabled={isSavingGoal} onClick={() => setIsGoalModalOpen(false)}>
                キャンセル
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={isSavingGoal}
                onClick={async () => {
                  const targetWeightKg = Number(goalWeightInput);
                  const targetBodyFatPercent = Number(goalBodyFatInput);
                  if (!Number.isFinite(targetWeightKg) || targetWeightKg <= 0) {
                    setGoalStatus('目標体重は0より大きい数値を入力してください。');
                    return;
                  }
                  if (!Number.isFinite(targetBodyFatPercent) || targetBodyFatPercent <= 0) {
                    setGoalStatus('目標体脂肪率は0より大きい数値を入力してください。');
                    return;
                  }
                  if (goalDeadlineInput && !/^\d{4}-\d{2}-\d{2}$/.test(goalDeadlineInput)) {
                    setGoalStatus('期限は YYYY-MM-DD 形式で入力してください。');
                    return;
                  }
                  setIsSavingGoal(true);
                  const result = await saveGoal({
                    targetWeightKg,
                    targetBodyFatPercent,
                    deadlineDate: goalDeadlineInput || undefined,
                    comment: goalCommentInput
                  });
                  if (result.ok) {
                    setIsGoalModalOpen(false);
                  } else {
                    setGoalStatus(result.message ?? 'ゴール設定の保存に失敗しました。');
                  }
                  setIsSavingGoal(false);
                }}
              >
                {isSavingGoal ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

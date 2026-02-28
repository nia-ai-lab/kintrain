import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppState, useTodayYmd } from '../AppState';
import type { SetDetail } from '../types';
import { isoToDisplayDateTime, ymdToDisplay } from '../utils/date';
import { getLastPerformance, getPrioritizedMenuItems } from '../utils/training';

function toPositiveNumberOrUndefined(value: string): number | undefined {
  if (value.trim() === '') {
    return undefined;
  }
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : undefined;
}

function toWeightNumber(value: string): number | undefined {
  const num = toPositiveNumberOrUndefined(value);
  if (num === undefined) {
    return undefined;
  }
  return Math.round(num * 100) / 100;
}

function toCountNumber(value: string): number | undefined {
  const num = toPositiveNumberOrUndefined(value);
  if (num === undefined) {
    return undefined;
  }
  return Math.floor(num);
}

function formatRepsTarget(min: number, max: number): string {
  if (min === max) {
    return `${min}回`;
  }
  return `${min}~${max}回`;
}

function formatRepsInputLabel(min: number, max: number): string {
  return `回数 (${min}回 - ${max}回)`;
}

export function TrainingSessionPage() {
  const { data, setDraftEntry, setDraftSetDetails, clearDraftEntry, clearDraft, finalizeTrainingSession } = useAppState();
  const today = useTodayYmd();
  const navigate = useNavigate();
  const [openSetDetailIds, setOpenSetDetailIds] = useState<Record<string, boolean>>({});
  const [statusText, setStatusText] = useState('');

  const draftEntries = data.trainingDraft?.entriesByItemId ?? {};
  const prioritized = useMemo(
    () =>
      getPrioritizedMenuItems({
        menuItems: data.menuItems,
        gymVisits: data.gymVisits,
        todayYmd: today
      }),
    [data.menuItems, data.gymVisits, today]
  );

  function initSetDetails(menuItemId: string, sets: number, weightKg: number, reps: number) {
    const details: SetDetail[] = Array.from({ length: Math.max(1, sets) }).map((_, idx) => ({
      setIndex: idx + 1,
      weightKg,
      reps
    }));
    setDraftSetDetails(menuItemId, details);
  }

  return (
    <div className="stack-lg">
      <section className="card card-highlight">
        <div className="session-header">
          <div>
            <h1>トレーニング実施</h1>
            <p className="session-date">{ymdToDisplay(today)}</p>
          </div>
          <button
            type="button"
            className="btn ghost session-clear-button"
            onClick={() => {
              clearDraft();
              setStatusText('途中入力をクリアしました。');
            }}
          >
            下書きをクリア
          </button>
        </div>

        {data.trainingDraft && <p className="muted">下書き保存中: {data.trainingDraft.updatedAtLocal.replace('T', ' ').slice(0, 16)}</p>}
        {statusText && <p className="status-text">{statusText}</p>}
      </section>

      <section className="stack-md">
        {prioritized.map((item, index) => {
          const draft = draftEntries[item.id];
          const last = getLastPerformance(item.id, data.gymVisits);
          const seedWeightKg = last?.weightKg ?? item.defaultWeightKg;
          const seedReps = last?.reps ?? item.defaultRepsMax;
          const seedSets = last?.sets ?? item.defaultSets;
          const weightValue = draft?.weightKg;
          const repsValue = draft?.reps;
          const setsValue = draft?.sets;
          const isDetailOpen = !!openSetDetailIds[item.id];

          return (
            <article className="card" key={item.id}>
              <div className="training-item-head">
                <div>
                  <p className="priority-chip">優先 {index + 1}</p>
                  <h2>{item.trainingName}</h2>
                  <p className="muted">
                    直近:{' '}
                    {last
                      ? `${isoToDisplayDateTime(last.endedAtLocal)} ${last.weightKg}kg x ${last.reps}回 x ${last.sets}set`
                      : `未実施（メニュー: ${item.defaultWeightKg}kg x ${formatRepsTarget(item.defaultRepsMin, item.defaultRepsMax)} x ${item.defaultSets}set）`}
                  </p>
                </div>
                <div className="session-actions">
                  <button
                    type="button"
                    className="btn subtle copy-last-button"
                    onClick={() => {
                      setDraftEntry(item.id, {
                        menuItemId: item.id,
                        weightKg: seedWeightKg,
                        reps: seedReps,
                        sets: seedSets
                      });
                      setStatusText(
                        last
                          ? `${item.trainingName} に前回値を入力しました。`
                          : `${item.trainingName} にメニュー既定値を入力しました。`
                      );
                    }}
                  >
                    前回と同じ
                  </button>
                  <button
                    type="button"
                    className="btn danger copy-last-button"
                    onClick={() => {
                      clearDraftEntry(item.id);
                      setOpenSetDetailIds((prev) => ({ ...prev, [item.id]: false }));
                      setStatusText(`${item.trainingName} を今回の記録対象から外しました。`);
                    }}
                  >
                    入力クリア
                  </button>
                </div>
              </div>

              <div className="input-grid training-metrics-grid">
                <label>
                  重量
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    value={weightValue ?? ''}
                    placeholder="未入力"
                    onChange={(e) =>
                      setDraftEntry(item.id, {
                        menuItemId: item.id,
                        weightKg: toWeightNumber(e.target.value)
                      })
                    }
                  />
                </label>
                <label>
                  {formatRepsInputLabel(item.defaultRepsMin, item.defaultRepsMax)}
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={repsValue ?? ''}
                    placeholder="未入力"
                    onChange={(e) =>
                      setDraftEntry(item.id, {
                        menuItemId: item.id,
                        reps: toCountNumber(e.target.value)
                      })
                    }
                  />
                </label>
                <label>
                  セット
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={setsValue ?? ''}
                    placeholder="未入力"
                    onChange={(e) =>
                      setDraftEntry(item.id, {
                        menuItemId: item.id,
                        sets: toCountNumber(e.target.value)
                      })
                    }
                  />
                </label>
              </div>

              <div className="row-wrap">
                <button
                  type="button"
                  className="btn subtle"
                  onClick={() => {
                    const nowOpen = !isDetailOpen;
                    setOpenSetDetailIds((prev) => ({ ...prev, [item.id]: nowOpen }));
                    if (nowOpen && (!draft?.setDetails || draft.setDetails.length === 0)) {
                      const detailSets = Math.max(1, setsValue ?? seedSets);
                      const detailWeight = weightValue ?? seedWeightKg;
                      const detailReps = repsValue ?? seedReps;
                      initSetDetails(item.id, detailSets, detailWeight, detailReps);
                    }
                  }}
                >
                  {isDetailOpen ? 'セット詳細を閉じる' : 'セット詳細を入力'}
                </button>
              </div>

              {isDetailOpen && (
                <div className="set-detail-list">
                  {(draft?.setDetails ?? []).map((detail, detailIndex) => (
                    <div className="set-detail-row" key={detail.setIndex}>
                      <span>{detail.setIndex}set</span>
                      <input
                        type="number"
                        min={0}
                        step={0.01}
                        value={detail.weightKg}
                        onChange={(e) => {
                          const next = [...(draft?.setDetails ?? [])];
                          next[detailIndex] = {
                            ...detail,
                            weightKg: toWeightNumber(e.target.value) ?? 0
                          };
                          setDraftSetDetails(item.id, next);
                        }}
                      />
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={detail.reps}
                        onChange={(e) => {
                          const next = [...(draft?.setDetails ?? [])];
                          next[detailIndex] = {
                            ...detail,
                            reps: Number(e.target.value)
                          };
                          setDraftSetDetails(item.id, next);
                        }}
                      />
                    </div>
                  ))}
                </div>
              )}
            </article>
          );
        })}
      </section>

      <section className="sticky-action">
        <button
          type="button"
          className="btn primary large"
          onClick={async () => {
            const result = await finalizeTrainingSession(today);
            if (!result.ok) {
              setStatusText(result.message ?? '保存に失敗しました。');
              return;
            }
            setStatusText('');
            navigate(`/daily/${today}`);
          }}
        >
          記録して終了
        </button>
      </section>
    </div>
  );
}

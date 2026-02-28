import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppState, useTodayYmd } from '../AppState';
import type { SetDetail } from '../types';
import { ymdToDisplay } from '../utils/date';
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
        todayYmd: today,
        draftEntriesByItemId: draftEntries
      }),
    [data.menuItems, data.gymVisits, today, draftEntries]
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
                    直近: {last ? `${ymdToDisplay(last.date)} ${last.weightKg}kg x ${last.reps}回 x ${last.sets}set` : '実績なし'}
                  </p>
                </div>
                <div className="session-actions">
                  <button
                    type="button"
                    className="btn subtle copy-last-button"
                    onClick={() => {
                      if (!last) {
                        return;
                      }
                      setDraftEntry(item.id, {
                        menuItemId: item.id,
                        weightKg: last.weightKg,
                        reps: last.reps,
                        sets: last.sets
                      });
                      setStatusText(`${item.trainingName} に前回値を入力しました。`);
                    }}
                    disabled={!last}
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
                    placeholder={String(item.defaultWeightKg)}
                    onChange={(e) =>
                      setDraftEntry(item.id, {
                        menuItemId: item.id,
                        weightKg: toWeightNumber(e.target.value)
                      })
                    }
                  />
                </label>
                <label>
                  回数
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={repsValue ?? ''}
                    placeholder={String(item.defaultReps)}
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
                    placeholder={String(item.defaultSets)}
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
                      const seedSets = Math.max(1, setsValue ?? item.defaultSets);
                      const seedWeight = weightValue ?? item.defaultWeightKg;
                      const seedReps = repsValue ?? item.defaultReps;
                      initSetDetails(item.id, seedSets, seedWeight, seedReps);
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
          onClick={() => {
            const result = finalizeTrainingSession(today);
            if (result.savedCount === 0) {
              setStatusText('有効な入力がないため保存されませんでした。');
              return;
            }
            navigate(`/daily/${today}`);
          }}
        >
          記録して終了
        </button>
      </section>
    </div>
  );
}

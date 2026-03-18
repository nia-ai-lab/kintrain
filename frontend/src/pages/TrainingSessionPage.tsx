import { useEffect, useRef, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppState, useTodayYmd } from '../AppState';
import { getTrainingSessionView } from '../api/coreApi';
import type { DraftEntry, SetDetail, TrainingEquipment, TrainingFrequencyDays, TrainingMenuItem } from '../types';
import { isoToDisplayDateTime, ymdToDisplay } from '../utils/date';
import { formatTrainingLabel, getPrioritizedTrainingSessionItems } from '../utils/training';

const maxTrainingSessionEntryCount = 12;
const maxTrainingSessionEntryMessage =
  '一度に登録できる実施は12件までです。トレーニングを続ける場合は一度記録してください。';

type TrainingSessionLastPerformanceSnapshot = {
  performedAtUtc: string;
  weightKg: number;
  reps: number;
  sets: number;
  note?: string;
  visitDateLocal: string;
};

type TrainingSessionMenuItem = TrainingMenuItem & {
  lastPerformanceSnapshot?: TrainingSessionLastPerformanceSnapshot;
};

function normalizeTrainingEquipment(value: unknown): TrainingEquipment {
  if (value === 'マシン' || value === 'フリー' || value === '自重' || value === 'その他') {
    return value;
  }
  if (typeof value === 'string') {
    const legacy = value.trim();
    if (legacy === 'バーベル' || legacy === 'ダンベル' || legacy === 'ケトルベル') {
      return 'フリー';
    }
  }
  return 'マシン';
}

function normalizeTrainingFrequency(value: unknown): TrainingFrequencyDays {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 8) {
    return value as TrainingFrequencyDays;
  }
  return 3;
}

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

function hasStartedDraftEntry(entry: Partial<DraftEntry> | undefined): boolean {
  return (entry?.weightKg ?? 0) > 0 || (entry?.reps ?? 0) > 0 || (entry?.sets ?? 0) > 0;
}

export function TrainingSessionPage() {
  const { data, setDraftEntry, setDraftSetDetails, clearDraftEntry, clearDraft, finalizeTrainingSession } = useAppState();
  const today = useTodayYmd();
  const navigate = useNavigate();
  const [openSetDetailIds, setOpenSetDetailIds] = useState<Record<string, boolean>>({});
  const [statusText, setStatusText] = useState('');
  const [isConfirmModalOpen, setIsConfirmModalOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [sessionItems, setSessionItems] = useState<TrainingSessionMenuItem[]>([]);
  const [isSessionViewLoading, setIsSessionViewLoading] = useState(true);
  const [sessionViewError, setSessionViewError] = useState('');
  const toastTimerRef = useRef<number | null>(null);

  const draftEntries = data.trainingDraft?.entriesByItemId ?? {};
  const defaultMenuSet = useMemo(() => {
    return data.menuSets.find((set) => set.isDefault) ?? data.menuSets[0] ?? null;
  }, [data.menuSets]);

  useEffect(() => {
    let isActive = true;

    const loadTrainingSessionView = async () => {
      setIsSessionViewLoading(true);
      setSessionViewError('');
      try {
        const remote = await getTrainingSessionView(today);
        if (!isActive) {
          return;
        }
        const items = (remote.items ?? [])
          .filter((item) => item.isActive !== false)
          .map((item) => ({
            id: item.trainingMenuItemId,
            trainingName: item.trainingName,
            bodyPart: item.bodyPart ?? '',
            equipment: normalizeTrainingEquipment(item.equipment),
            isAiGenerated: item.isAiGenerated === true,
            memo: typeof item.memo === 'string' ? item.memo : '',
            frequency: normalizeTrainingFrequency(item.frequency),
            defaultWeightKg: Number(item.defaultWeightKg),
            defaultRepsMin: Number(item.defaultRepsMin),
            defaultRepsMax: Number(item.defaultRepsMax),
            defaultSets: Number(item.defaultSets),
            order: Number(item.displayOrder),
            isActive: item.isActive !== false,
            lastPerformanceSnapshot: item.lastPerformanceSnapshot
              ? {
                  performedAtUtc: item.lastPerformanceSnapshot.performedAtUtc,
                  weightKg: Number(item.lastPerformanceSnapshot.weightKg),
                  reps: Number(item.lastPerformanceSnapshot.reps),
                  sets: Number(item.lastPerformanceSnapshot.sets),
                  note: typeof item.lastPerformanceSnapshot.note === 'string' ? item.lastPerformanceSnapshot.note : undefined,
                  visitDateLocal: item.lastPerformanceSnapshot.visitDateLocal
                }
              : undefined
          }));
        setSessionItems(items);
      } catch (error) {
        if (!isActive) {
          return;
        }
        const message = error instanceof Error ? error.message : '実施メニューの取得に失敗しました。';
        setSessionViewError(message);
        setSessionItems([]);
      } finally {
        if (isActive) {
          setIsSessionViewLoading(false);
        }
      }
    };

    void loadTrainingSessionView();
    return () => {
      isActive = false;
    };
  }, [today]);

  const prioritized = useMemo(() => {
    return getPrioritizedTrainingSessionItems({
      items: sessionItems,
      todayYmd: today
    });
  }, [sessionItems, today]);

  function initSetDetails(menuItemId: string, sets: number, weightKg: number, reps: number) {
    const details: SetDetail[] = Array.from({ length: Math.max(1, sets) }).map((_, idx) => ({
      setIndex: idx + 1,
      weightKg,
      reps
    }));
    setDraftSetDetails(menuItemId, details);
  }

  const enteredItems = useMemo(() => {
    return prioritized
      .map((item) => {
        const draft = draftEntries[item.id];
        const hasStarted =
          (draft?.weightKg ?? 0) > 0 ||
          (draft?.reps ?? 0) > 0 ||
          (draft?.sets ?? 0) > 0;
        const isValid =
          (draft?.weightKg ?? 0) > 0 &&
          (draft?.reps ?? 0) > 0 &&
          (draft?.sets ?? 0) > 0;
        return {
          item,
          draft,
          hasStarted,
          isValid
        };
      })
      .filter((entry) => entry.hasStarted);
  }, [prioritized, draftEntries]);

  const validEnteredItems = enteredItems.filter((entry) => entry.isValid);
  const incompleteEnteredItems = enteredItems.filter((entry) => !entry.isValid);
  const startedItemCount = enteredItems.length;

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  function showToast(message: string) {
    setToastMessage(message);
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToastMessage('');
      toastTimerRef.current = null;
    }, 3500);
  }

  function guardTrainingEntryLimit(menuItemId: string, patch: Partial<DraftEntry>): boolean {
    const current = draftEntries[menuItemId];
    const currentStarted = hasStartedDraftEntry(current);
    const nextStarted = hasStartedDraftEntry({
      ...(current ?? { menuItemId }),
      ...patch
    });

    if (currentStarted || !nextStarted || startedItemCount < maxTrainingSessionEntryCount) {
      return true;
    }

    setStatusText(maxTrainingSessionEntryMessage);
    showToast(maxTrainingSessionEntryMessage);
    return false;
  }

  return (
    <div className="stack-lg training-session-page">
      <section className="card card-highlight training-session-hero">
        <div className="session-header">
          <div>
            <h1>トレーニング実施</h1>
            <p className="session-date">{ymdToDisplay(today)}</p>
            {defaultMenuSet && <p className="muted">メニューセット: {defaultMenuSet.setName}</p>}
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

      <section className="stack-md training-session-list">
        {isSessionViewLoading && (
          <article className="card training-session-card">
            <p className="muted">実施メニューを読み込み中です。</p>
          </article>
        )}

        {!isSessionViewLoading && sessionViewError && (
          <article className="card training-session-card">
            <p className="status-text">{sessionViewError}</p>
          </article>
        )}

        {!isSessionViewLoading && !sessionViewError && prioritized.length === 0 && (
          <article className="card training-session-card">
            <p className="muted">デフォルトのメニューセットに有効な種目がありません。</p>
          </article>
        )}

        {prioritized.map((item, index) => {
          const draft = draftEntries[item.id];
          const last = item.lastPerformanceSnapshot;
          const seedWeightKg = last?.weightKg ?? item.defaultWeightKg;
          const seedReps = last?.reps ?? item.defaultRepsMax;
          const seedSets = last?.sets ?? item.defaultSets;
          const seedMemo = (last?.note?.trim() || item.memo || '').trim();
          const weightValue = draft?.weightKg;
          const repsValue = draft?.reps;
          const setsValue = draft?.sets;
          const memoValue =
            draft && Object.prototype.hasOwnProperty.call(draft, 'memo') ? (draft.memo ?? '') : seedMemo;
          const isDetailOpen = !!openSetDetailIds[item.id];
          const hasStarted =
            (draft?.weightKg ?? 0) > 0 ||
            (draft?.reps ?? 0) > 0 ||
            (draft?.sets ?? 0) > 0;

          return (
            <article className={`card training-session-card${hasStarted ? ' is-entered' : ''}`} key={item.id}>
              <div className="training-item-head">
                <div>
                  <p className="priority-chip">優先 {index + 1}</p>
                  <h2>{formatTrainingLabel(item.trainingName, item.bodyPart, item.equipment, item.isAiGenerated)}</h2>
                  <p className="muted">
                    直近:{' '}
                    {last
                      ? `${isoToDisplayDateTime(last.performedAtUtc)} ${last.weightKg}kg x ${last.reps}回 x ${last.sets}set`
                      : `未実施（メニュー: ${item.defaultWeightKg}kg x ${formatRepsTarget(item.defaultRepsMin, item.defaultRepsMax)} x ${item.defaultSets}set）`}
                  </p>
                </div>
                <div className="session-actions">
                  <button
                    type="button"
                    className="btn subtle copy-last-button"
                    onClick={() => {
                      if (
                        !guardTrainingEntryLimit(item.id, {
                          menuItemId: item.id,
                          weightKg: seedWeightKg,
                          reps: seedReps,
                          sets: seedSets
                        })
                      ) {
                        return;
                      }
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
                    onChange={(e) => {
                      const nextWeightKg = toWeightNumber(e.target.value);
                      if (
                        !guardTrainingEntryLimit(item.id, {
                          menuItemId: item.id,
                          weightKg: nextWeightKg
                        })
                      ) {
                        return;
                      }
                      setDraftEntry(item.id, {
                        menuItemId: item.id,
                        weightKg: nextWeightKg
                      });
                    }}
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
                    onChange={(e) => {
                      const nextReps = toCountNumber(e.target.value);
                      if (
                        !guardTrainingEntryLimit(item.id, {
                          menuItemId: item.id,
                          reps: nextReps
                        })
                      ) {
                        return;
                      }
                      setDraftEntry(item.id, {
                        menuItemId: item.id,
                        reps: nextReps
                      });
                    }}
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
                    onChange={(e) => {
                      const nextSets = toCountNumber(e.target.value);
                      if (
                        !guardTrainingEntryLimit(item.id, {
                          menuItemId: item.id,
                          sets: nextSets
                        })
                      ) {
                        return;
                      }
                      setDraftEntry(item.id, {
                        menuItemId: item.id,
                        sets: nextSets
                      });
                    }}
                  />
                </label>
              </div>
              <label>
                メモ
                <input
                  type="text"
                  value={memoValue}
                  placeholder="任意でメモを入力"
                  maxLength={500}
                  onChange={(e) =>
                    setDraftEntry(item.id, {
                      menuItemId: item.id,
                      memo: e.target.value
                    })
                  }
                />
              </label>

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
          onClick={() => {
            setIsConfirmModalOpen(true);
          }}
        >
          記録して終了
        </button>
      </section>

      {isConfirmModalOpen && (
        <div className="overlay-modal" role="dialog" aria-modal="true" aria-labelledby="training-session-confirm-title">
          <div className="overlay-modal-card training-session-confirm-modal">
            <h3 id="training-session-confirm-title">記録内容の確認</h3>
            {validEnteredItems.length === 0 ? (
              <p>保存対象がありません。重量・回数・セットを入力してから記録してください。</p>
            ) : (
              <>
                <p>以下の内容で記録します。</p>
                <ul className="simple-list training-session-confirm-list">
                  {validEnteredItems.map(({ item, draft }) => (
                    <li key={item.id}>
                      <strong>{formatTrainingLabel(item.trainingName, item.bodyPart, item.equipment, item.isAiGenerated)}</strong>
                      <span>
                        {draft?.weightKg}kg x {draft?.reps}回 x {draft?.sets}set
                      </span>
                      {draft?.memo?.trim() && <span className="muted">メモ: {draft.memo.trim()}</span>}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {incompleteEnteredItems.length > 0 && (
              <div className="training-session-confirm-warning">
                <p>以下は入力途中のため、今回の保存対象には含まれません。</p>
                <ul className="simple-list">
                  {incompleteEnteredItems.map(({ item, draft }) => (
                    <li key={item.id}>
                      <strong>{formatTrainingLabel(item.trainingName, item.bodyPart, item.equipment, item.isAiGenerated)}</strong>
                      <span>
                        重量:{draft?.weightKg ?? '未入力'} / 回数:{draft?.reps ?? '未入力'} / セット:{draft?.sets ?? '未入力'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="overlay-modal-actions">
              <button
                type="button"
                className="btn subtle"
                disabled={isSaving}
                onClick={() => setIsConfirmModalOpen(false)}
              >
                キャンセル
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={isSaving || validEnteredItems.length === 0}
                onClick={async () => {
                  setIsSaving(true);
                  const result = await finalizeTrainingSession(today);
                  setIsSaving(false);
                  if (!result.ok) {
                    setIsConfirmModalOpen(false);
                    setStatusText(result.message ?? '保存に失敗しました。');
                    return;
                  }
                  setIsConfirmModalOpen(false);
                  setStatusText('');
                  navigate(`/daily/${today}`);
                }}
              >
                {isSaving ? '記録中...' : 'この内容で記録'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toastMessage && (
        <div className="page-toast" role="status" aria-live="polite">
          {toastMessage}
        </div>
      )}
    </div>
  );
}

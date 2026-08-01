import { useEffect, useRef, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppState, useTodayYmd } from '../AppState';
import { deleteTrainingMenuSet, getTrainingSessionView } from '../api/coreApi';
import type { DraftEntry, TrainingFrequencyDays, TrainingMenuItem } from '../types';
import { isoToDisplayDateTime, ymdToDisplay } from '../utils/date';
import { formatTrainingLabel, getPrioritizedTrainingSessionItems } from '../utils/training';
import {
  calculateTotalWeightKg,
  formatWeightLoad,
  normalizeFixedWeightKg,
  normalizeLoadMultiplier,
  normalizeWeightInputMode
} from '../utils/weightLoad';

const maxTrainingSessionEntryCount = 12;
const maxTrainingSessionEntryMessage =
  '一度に登録できる実施は12件までです。トレーニングを続ける場合は一度記録してください。';

type TrainingSessionLastPerformanceSnapshot = {
  performedAtUtc: string;
  weightKg: number;
  weightInputModeSnapshot?: 'direct' | 'perSide' | 'legacyUnspecified';
  loadMultiplierSnapshot?: 1 | 2;
  fixedWeightKgSnapshot?: number;
  calculatedTotalWeightKg?: number;
  reps: number;
  sets: number;
  note?: string;
  visitDateLocal: string;
};

type TrainingSessionMenuItem = TrainingMenuItem & {
  menuSetItemId: string;
  targetWeightKg: number;
  targetRepsMin: number;
  targetRepsMax: number;
  targetSets: number;
  targetInstruction: string;
  lastPerformanceSnapshot?: TrainingSessionLastPerformanceSnapshot;
};

type RemovedConfirmEntry = {
  draftKey: string;
  item: TrainingMenuItem;
  draft: DraftEntry;
};

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
  if (value.trim() === '') {
    return undefined;
  }
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
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
  return entry?.weightKg !== undefined || (entry?.reps ?? 0) > 0 || (entry?.sets ?? 0) > 0;
}

function hasValidWeight(entry: Partial<DraftEntry> | undefined): boolean {
  return typeof entry?.weightKg === 'number' && Number.isFinite(entry.weightKg) && entry.weightKg >= 0;
}

export function TrainingSessionPage() {
  const { data, setDraftEntry, clearDraftEntry, clearDraft, finalizeTrainingSession, refreshCoreData } = useAppState();
  const today = useTodayYmd();
  const navigate = useNavigate();
  const [statusText, setStatusText] = useState('');
  const [isConfirmModalOpen, setIsConfirmModalOpen] = useState(false);
  const [removedConfirmEntries, setRemovedConfirmEntries] = useState<RemovedConfirmEntry[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [sessionItems, setSessionItems] = useState<TrainingSessionMenuItem[]>([]);
  const [isSessionViewLoading, setIsSessionViewLoading] = useState(true);
  const [sessionViewError, setSessionViewError] = useState('');
  const [resolvedMenuSet, setResolvedMenuSet] = useState<{
    trainingMenuSetId: string;
    setName: string;
    setType: 'reusable' | 'temporary';
    source: 'manual' | 'ai';
    isDefault: boolean;
  } | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const draftEntries = data.trainingDraft?.entriesByItemId ?? {};
  const menuSets = useMemo(() => {
    return data.menuSets.filter((set) => set.isActive).sort((a, b) => a.order - b.order);
  }, [data.menuSets]);
  const [selectedMenuSetId, setSelectedMenuSetId] = useState('');

  useEffect(() => {
    if (menuSets.length === 0) {
      if (selectedMenuSetId) {
        setSelectedMenuSetId('');
      }
      return;
    }
    if (selectedMenuSetId && !menuSets.some((set) => set.id === selectedMenuSetId)) {
      setSelectedMenuSetId('');
    }
  }, [menuSets, selectedMenuSetId]);

  const effectiveSelectedMenuSetId = selectedMenuSetId;

  useEffect(() => {
    let isActive = true;

    const loadTrainingSessionView = async () => {
      setIsSessionViewLoading(true);
      setSessionViewError('');
      try {
        const remote = await getTrainingSessionView(today, effectiveSelectedMenuSetId || undefined);
        if (!isActive) {
          return;
        }
        const items = (remote.items ?? [])
          .filter((item) => item.isActive !== false)
          .map((item) => {
            const weightInputMode = normalizeWeightInputMode(item.weightInputMode);
            return {
            id: item.trainingMenuItemId,
            trainingName: item.trainingName,
            exerciseFamilyId: item.exerciseFamilyId,
            muscleTargets: item.muscleTargets ?? [],
            movementFamily: item.movementFamily,
            jointActions: item.jointActions,
            laterality: item.laterality,
            loadModel: item.loadModel,
            classificationVersion: item.classificationVersion,
            equipmentType: item.equipmentType,
            equipmentProfileId: item.equipmentProfileId,
            cableSettings: item.cableSettings,
            isAiGenerated: item.isAiGenerated === true,
            description: typeof item.description === 'string' ? item.description : '',
            frequency: normalizeTrainingFrequency(item.recommendedIntervalDays),
            defaultWeightKg: Number(item.targetWeightKg),
            weightInputMode,
            loadMultiplier: normalizeLoadMultiplier(item.loadMultiplier, weightInputMode),
            fixedWeightKg:
              weightInputMode === 'direct' ? 0 : normalizeFixedWeightKg(item.fixedWeightKg),
            defaultRepsMin: Number(item.targetRepsMin),
            defaultRepsMax: Number(item.targetRepsMax),
            defaultSets: Number(item.targetSets),
            order: Number(item.displayOrder),
            isActive: item.isActive !== false,
            usageCount: 0,
            menuSetItemId: item.trainingMenuSetItemId,
            targetWeightKg: Number(item.targetWeightKg),
            targetRepsMin: Number(item.targetRepsMin),
            targetRepsMax: Number(item.targetRepsMax),
            targetSets: Number(item.targetSets),
            targetInstruction: item.instruction ?? '',
            lastPerformanceSnapshot: item.lastPerformanceSnapshot
              ? {
                  performedAtUtc: item.lastPerformanceSnapshot.performedAtUtc,
                  weightKg: Number(item.lastPerformanceSnapshot.weightKg),
                  weightInputModeSnapshot: normalizeWeightInputMode(
                    item.lastPerformanceSnapshot.weightInputModeSnapshot
                  ),
                  loadMultiplierSnapshot: item.lastPerformanceSnapshot.loadMultiplierSnapshot,
                  fixedWeightKgSnapshot: item.lastPerformanceSnapshot.fixedWeightKgSnapshot,
                  calculatedTotalWeightKg: item.lastPerformanceSnapshot.calculatedTotalWeightKg,
                  reps: Number(item.lastPerformanceSnapshot.reps),
                  sets: Number(item.lastPerformanceSnapshot.sets),
                  note: typeof item.lastPerformanceSnapshot.note === 'string' ? item.lastPerformanceSnapshot.note : undefined,
                  visitDateLocal: item.lastPerformanceSnapshot.visitDateLocal
                }
              : undefined
            };
          });
        setResolvedMenuSet(remote.resolvedMenuSet);
        if (!selectedMenuSetId && remote.resolvedMenuSet?.trainingMenuSetId) {
          setSelectedMenuSetId(remote.resolvedMenuSet.trainingMenuSetId);
        }
        setSessionItems(items);
      } catch (error) {
        if (!isActive) {
          return;
        }
        const message = error instanceof Error ? error.message : '実施メニューの取得に失敗しました。';
        setSessionViewError(message);
        setResolvedMenuSet(null);
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
  }, [effectiveSelectedMenuSetId, selectedMenuSetId, today]);

  const prioritized = useMemo(() => {
    return getPrioritizedTrainingSessionItems({
      items: sessionItems,
      todayYmd: today,
      menuSetType: resolvedMenuSet?.setType ?? 'reusable'
    });
  }, [resolvedMenuSet?.setType, sessionItems, today]);

  const menuItemById = useMemo(() => {
    const map = new Map<string, TrainingMenuItem>();
    for (const item of data.menuItems) {
      map.set(item.id, item);
    }
    for (const item of sessionItems) {
      map.set(item.id, item);
    }
    return map;
  }, [data.menuItems, sessionItems]);

  const enteredItems = useMemo(() => {
    return Object.entries(draftEntries)
      .map(([draftKey, draft]) => {
        const item =
          menuItemById.get(draft.menuItemId) ??
          ({
            id: draft.menuItemId,
            trainingName: '不明トレーニング',
            exerciseFamilyId: draft.menuItemId,
            muscleTargets: [],
            movementFamily: 'isolation',
            jointActions: [],
            laterality: 'bilateral',
            loadModel: 'external_load',
            classificationVersion: 1,
            equipmentType: 'other',
            isAiGenerated: false,
            description: '',
            frequency: 3,
            defaultWeightKg: 0,
            weightInputMode: 'legacyUnspecified',
            loadMultiplier: 1,
            fixedWeightKg: 0,
            defaultRepsMin: 1,
            defaultRepsMax: 1,
            defaultSets: 1,
            order: Number.MAX_SAFE_INTEGER,
            isActive: true
            ,
            usageCount: 0
          } satisfies TrainingMenuItem);
        const hasStarted =
          draft?.weightKg !== undefined ||
          (draft?.reps ?? 0) > 0 ||
          (draft?.sets ?? 0) > 0;
        const isValid =
          hasValidWeight(draft) &&
          (draft?.reps ?? 0) > 0 &&
          (draft?.sets ?? 0) > 0;
        return {
          draftKey,
          item,
          draft,
          hasStarted,
          isValid
        };
      })
      .filter((entry) => entry.hasStarted)
      .sort((a, b) => a.item.order - b.item.order || a.item.trainingName.localeCompare(b.item.trainingName));
  }, [draftEntries, menuItemById]);

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

  function removeConfirmEntry(entry: RemovedConfirmEntry) {
    setRemovedConfirmEntries((current) => {
      if (current.some((removed) => removed.draftKey === entry.draftKey)) {
        return current;
      }
      return [...current, entry];
    });
    clearDraftEntry(entry.draftKey);
  }

  function restoreConfirmEntry(entry: RemovedConfirmEntry) {
    setDraftEntry(entry.draftKey, entry.draft);
    setRemovedConfirmEntries((current) =>
      current.filter((removed) => removed.draftKey !== entry.draftKey)
    );
  }

  function closeConfirmModal() {
    setIsConfirmModalOpen(false);
    setRemovedConfirmEntries([]);
  }

  return (
    <div className="stack-lg training-session-page">
      <section className="card card-highlight training-session-hero">
        <div className="session-header">
          <div>
            <h1>トレーニング実施</h1>
            <p className="session-date">{ymdToDisplay(today)}</p>
            <label className="session-menu-set-select">
              <span>
                今日のメニュー
                {resolvedMenuSet?.setType === 'temporary' ? ' ・ 一時' : ''}
                {resolvedMenuSet?.source === 'ai' ? ' ・ AI作成' : ''}
              </span>
              <select
                value={resolvedMenuSet?.trainingMenuSetId ?? effectiveSelectedMenuSetId}
                disabled={menuSets.length === 0}
                onChange={(event) => {
                  setSelectedMenuSetId(event.target.value);
                }}
              >
                {menuSets.length === 0 ? (
                  <option value="">メニューセットなし</option>
                ) : (
                  menuSets.map((set) => (
                    <option value={set.id} key={set.id}>
                      {set.setName}
                      {set.isDefault ? ' (デフォルト)' : ''}
                    </option>
                  ))
                )}
              </select>
            </label>
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
            <p className="muted">選択中のメニューセットに有効な種目がありません。</p>
          </article>
        )}

        {prioritized.map((item, index) => {
          const draftKey = item.menuSetItemId || item.id;
          const draft = draftEntries[draftKey];
          const last = item.lastPerformanceSnapshot;
          const seedWeightKg = last?.weightKg ?? item.defaultWeightKg;
          const seedReps = last?.reps ?? item.defaultRepsMax;
          const seedSets = last?.sets ?? item.defaultSets;
          const seedMemo = last?.note?.trim() ?? '';
          const weightValue = draft?.weightKg;
          const repsValue = draft?.reps;
          const setsValue = draft?.sets;
          const memoValue =
            draft && Object.prototype.hasOwnProperty.call(draft, 'memo') ? (draft.memo ?? '') : seedMemo;
          const sourcePatch = {
            menuSetId: resolvedMenuSet?.trainingMenuSetId,
            menuSetItemId: item.menuSetItemId,
            menuSetName: resolvedMenuSet?.setName,
            menuSetType: resolvedMenuSet?.setType,
            targetWeightKg: item.targetWeightKg,
            targetRepsMin: item.targetRepsMin,
            targetRepsMax: item.targetRepsMax,
            targetSets: item.targetSets,
            targetInstruction: item.targetInstruction
          };
          const hasStarted =
            draft?.weightKg !== undefined ||
            (draft?.reps ?? 0) > 0 ||
            (draft?.sets ?? 0) > 0;

          return (
            <article className={`card training-session-card${hasStarted ? ' is-entered' : ''}`} key={draftKey}>
              <div className="training-item-head">
                <div className="training-item-summary">
                  <p className="priority-chip">優先 {index + 1}</p>
                  <h2>{formatTrainingLabel(item.trainingName, item.muscleTargets, item.equipmentType, item.isAiGenerated)}</h2>
                  <p className="muted">
                    {resolvedMenuSet?.setType === 'temporary' ? '本日の設定' : 'メニューセットの設定'}: {formatWeightLoad({
                      weightKg: item.targetWeightKg,
                      weightInputModeSnapshot: item.weightInputMode,
                      loadMultiplierSnapshot: item.loadMultiplier,
                      fixedWeightKgSnapshot: item.fixedWeightKg,
                      calculatedTotalWeightKg: calculateTotalWeightKg(
                        item.targetWeightKg,
                        item.weightInputMode,
                        item.loadMultiplier,
                        item.fixedWeightKg
                      )
                    })} x {formatRepsTarget(item.targetRepsMin, item.targetRepsMax)} x {item.targetSets}set
                  </p>
                  <p className="muted">
                    直近:{' '}
                    {last
                      ? `${isoToDisplayDateTime(last.performedAtUtc)} ${formatWeightLoad({
                          weightKg: last.weightKg,
                          weightInputModeSnapshot: last.weightInputModeSnapshot,
                          loadMultiplierSnapshot: last.loadMultiplierSnapshot,
                          fixedWeightKgSnapshot: last.fixedWeightKgSnapshot,
                          calculatedTotalWeightKg: last.calculatedTotalWeightKg
                        })} x ${last.reps}回 x ${last.sets}set`
                      : `未実施（メニュー: ${formatWeightLoad({
                          weightKg: item.defaultWeightKg,
                          weightInputModeSnapshot: item.weightInputMode,
                          loadMultiplierSnapshot: item.loadMultiplier,
                          fixedWeightKgSnapshot: item.fixedWeightKg,
                          calculatedTotalWeightKg: calculateTotalWeightKg(
                            item.defaultWeightKg,
                            item.weightInputMode,
                            item.loadMultiplier,
                            item.fixedWeightKg
                          )
                        })} x ${formatRepsTarget(item.defaultRepsMin, item.defaultRepsMax)} x ${item.defaultSets}set）`}
                  </p>
                </div>
                <div className="session-actions">
                  <button
                    type="button"
                    className="btn primary copy-last-button"
                    onClick={() => {
                      if (!guardTrainingEntryLimit(draftKey, {
                        menuItemId: item.id,
                        weightKg: item.targetWeightKg,
                        reps: item.targetRepsMax,
                        sets: item.targetSets
                      })) {
                        return;
                      }
                      setDraftEntry(draftKey, {
                        menuItemId: item.id,
                        ...sourcePatch,
                        weightKg: item.targetWeightKg,
                        reps: item.targetRepsMax,
                        sets: item.targetSets
                      });
                      setStatusText(`${item.trainingName} に設定値を入力しました。`);
                    }}
                  >
                    設定値を入力
                  </button>
                  <button
                    type="button"
                    className="btn subtle copy-last-button"
                    disabled={!last}
                    onClick={() => {
                      if (
                        !guardTrainingEntryLimit(draftKey, {
                          menuItemId: item.id,
                          weightKg: seedWeightKg,
                          reps: seedReps,
                          sets: seedSets
                        })
                      ) {
                        return;
                      }
                      setDraftEntry(draftKey, {
                        menuItemId: item.id,
                        ...sourcePatch,
                        weightKg: seedWeightKg,
                        reps: seedReps,
                        sets: seedSets
                      });
                      setStatusText(
                        `${item.trainingName} に前回値を入力しました。`
                      );
                    }}
                  >
                    前回値を入力
                  </button>
                  <button
                    type="button"
                    className="btn danger copy-last-button"
                    onClick={() => {
                      clearDraftEntry(draftKey);
                      setStatusText(`${item.trainingName} を今回の記録対象から外しました。`);
                    }}
                  >
                    入力を消す
                  </button>
                </div>
              </div>

              {item.description.trim() && (
                <details className="training-description">
                  <summary>説明</summary>
                  <p>{item.description.trim()}</p>
                </details>
              )}

              <div className="input-grid training-metrics-grid">
                <label>
                  <span className="training-metric-title">
                    {item.loadModel === 'assisted_bodyweight'
                      ? '補助重量 (kg)'
                      : item.loadModel === 'bodyweight_plus_external_load'
                        ? '追加重量 (kg)'
                        : item.weightInputMode === 'perSide'
                          ? '片側重量 (kg)'
                          : '重量 (kg)'}
                  </span>
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    value={weightValue ?? ''}
                    placeholder="未入力"
                    onChange={(e) => {
                      const nextWeightKg = toWeightNumber(e.target.value);
                      if (
                        !guardTrainingEntryLimit(draftKey, {
                          menuItemId: item.id,
                          weightKg: nextWeightKg
                        })
                      ) {
                        return;
                      }
                      setDraftEntry(draftKey, {
                        menuItemId: item.id,
                        ...sourcePatch,
                        weightKg: nextWeightKg
                      });
                    }}
                  />
                </label>
                <label>
                  <span className="training-metric-title">
                    {formatRepsInputLabel(item.defaultRepsMin, item.defaultRepsMax)}
                  </span>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={repsValue ?? ''}
                    placeholder="未入力"
                    onChange={(e) => {
                      const nextReps = toCountNumber(e.target.value);
                      if (
                        !guardTrainingEntryLimit(draftKey, {
                          menuItemId: item.id,
                          reps: nextReps
                        })
                      ) {
                        return;
                      }
                      setDraftEntry(draftKey, {
                        menuItemId: item.id,
                        ...sourcePatch,
                        reps: nextReps
                      });
                    }}
                  />
                </label>
                <label>
                  <span className="training-metric-title">セット</span>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={setsValue ?? ''}
                    placeholder="未入力"
                    onChange={(e) => {
                      const nextSets = toCountNumber(e.target.value);
                      if (
                        !guardTrainingEntryLimit(draftKey, {
                          menuItemId: item.id,
                          sets: nextSets
                        })
                      ) {
                        return;
                      }
                      setDraftEntry(draftKey, {
                        menuItemId: item.id,
                        ...sourcePatch,
                        sets: nextSets
                      });
                    }}
                  />
                </label>
                <span
                  className={`muted training-metric-total${
                    item.weightInputMode === 'legacyUnspecified' ? '' : ' is-calculated'
                  }`}
                >
                  {item.weightInputMode === 'legacyUnspecified'
                    ? '重量の意味が未設定です。メニュー設定で指定してください。'
                    : item.weightInputMode === 'direct'
                      ? `総重量 ${weightValue ?? '-'}kg`
                      : `換算総重量 ${
                          calculateTotalWeightKg(
                            weightValue,
                            item.weightInputMode,
                            item.loadMultiplier,
                            item.fixedWeightKg
                          ) ?? '-'
                        }kg（×${item.loadMultiplier} + 固定${item.fixedWeightKg}kg）`}
                </span>
              </div>
              <label>
                メモ
                <input
                  type="text"
                  value={memoValue}
                  placeholder="任意でメモを入力"
                  maxLength={500}
                  onChange={(e) =>
                    setDraftEntry(draftKey, {
                      menuItemId: item.id,
                      ...sourcePatch,
                      memo: e.target.value
                    })
                  }
                />
              </label>
            </article>
          );
        })}
      </section>

      <section className="sticky-action">
        <button
          type="button"
          className="btn primary large"
          onClick={() => {
            setRemovedConfirmEntries([]);
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
                  {validEnteredItems.map(({ draftKey, item, draft }) => (
                    <li key={draftKey}>
                      <div className="training-session-confirm-entry-head">
                        <strong>{formatTrainingLabel(item.trainingName, item.muscleTargets, item.equipmentType, item.isAiGenerated)}</strong>
                        <button
                          type="button"
                          className="btn danger training-session-confirm-entry-action"
                          disabled={isSaving}
                          aria-label={`${item.trainingName}を今回の記録から除外`}
                          onClick={() => removeConfirmEntry({ draftKey, item, draft })}
                        >
                          記録から除外
                        </button>
                      </div>
                      <span>
                        {formatWeightLoad({
                          weightKg: draft?.weightKg ?? 0,
                          weightInputModeSnapshot: item.weightInputMode,
                          loadMultiplierSnapshot: item.loadMultiplier,
                          fixedWeightKgSnapshot: item.fixedWeightKg,
                          calculatedTotalWeightKg: calculateTotalWeightKg(
                            draft?.weightKg,
                            item.weightInputMode,
                            item.loadMultiplier,
                            item.fixedWeightKg
                          )
                        })} x {draft?.reps}回 x {draft?.sets}set
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
                <ul className="simple-list training-session-confirm-list">
                  {incompleteEnteredItems.map(({ draftKey, item, draft }) => (
                    <li key={draftKey}>
                      <strong>{formatTrainingLabel(item.trainingName, item.muscleTargets, item.equipmentType, item.isAiGenerated)}</strong>
                      <span>
                        重量:{draft?.weightKg ?? '未入力'} / 回数:{draft?.reps ?? '未入力'} / セット:{draft?.sets ?? '未入力'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {removedConfirmEntries.length > 0 && (
              <div className="training-session-confirm-removed">
                <p role="status" aria-live="polite">今回の記録から除外しました。</p>
                <ul className="simple-list">
                  {removedConfirmEntries.map((entry) => (
                    <li key={entry.draftKey}>
                      <span>
                        <strong>
                          {formatTrainingLabel(
                            entry.item.trainingName,
                            entry.item.muscleTargets,
                            entry.item.equipmentType,
                            entry.item.isAiGenerated
                          )}
                        </strong>
                        <small>記録対象から除外</small>
                      </span>
                      <button
                        type="button"
                        className="btn subtle training-session-confirm-entry-action"
                        disabled={isSaving}
                        aria-label={`${entry.item.trainingName}を元に戻す`}
                        onClick={() => restoreConfirmEntry(entry)}
                      >
                        元に戻す
                      </button>
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
                onClick={closeConfirmModal}
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
                    closeConfirmModal();
                    setStatusText(result.message ?? '保存に失敗しました。');
                    return;
                  }
                  closeConfirmModal();
                  setStatusText('');
                  if (
                    resolvedMenuSet?.setType === 'temporary' &&
                    window.confirm('記録が完了しました。この一時メニューセットを削除しますか？ 実施履歴は残ります。')
                  ) {
                    try {
                      await deleteTrainingMenuSet(resolvedMenuSet.trainingMenuSetId);
                      await refreshCoreData();
                    } catch (error) {
                      setStatusText(error instanceof Error ? error.message : '一時セットを削除できませんでした。');
                      return;
                    }
                  }
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

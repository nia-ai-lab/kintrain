import { useEffect, useRef, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAppState, useTodayYmd } from '../AppState';
import {
  createRecoveryExecution,
  deleteTrainingMenuSet,
  getDailyTrainingPlan,
  getTrainingSessionView,
  listGymVisits,
  listRecoveryExecutions
} from '../api/coreApi';
import type { DraftEntry, TrainingFrequencyDays, TrainingMenuItem, TrainingMenuSet } from '../types';
import {
  equipmentTypeLabel,
  equipmentTypeOptions,
  formatMuscleTargets,
  type EquipmentType
} from '../muscleTaxonomy';
import {
  addYmdDays,
  combineYmdWithInstantTimeUtc,
  isValidYmd,
  isoToDisplayDateTime,
  ymdToDisplay
} from '../utils/date';
import { formatTrainingLabel, getPrioritizedTrainingSessionItems } from '../utils/training';
import {
  matchesSessionEquipment,
  matchesSessionName,
  normalizeSessionSearchText
} from '../utils/trainingSessionFilters';
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
const masterMenuSelectionId = '__training_menu_master__';

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
  hasMenuSetPrescription: boolean;
  targetWeightKg: number;
  targetRepsMin: number;
  targetRepsMax: number;
  targetSets: number;
  targetInstruction: string;
  targetDurationMinutes?: number;
  lastPerformanceSnapshot?: TrainingSessionLastPerformanceSnapshot;
  targetDatePerformanceSnapshot?: TrainingSessionLastPerformanceSnapshot;
  performedOnTargetDateCount: number;
  isReadOnly: boolean;
};

type RemovedConfirmEntry = {
  draftKey: string;
  item: TrainingMenuItem;
  draft: DraftEntry;
};

type RecoveryDraft = { checked: boolean; actualDurationMinutes?: number; note: string };

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

function SessionDatePicker({
  targetDate,
  today,
  onChange
}: {
  targetDate: string;
  today: string;
  onChange: (date: string) => void;
}) {
  const isPastDate = targetDate < today;
  return (
    <div className="session-date-picker">
      <div className="session-date-controls">
        <label>
          <span>実施日</span>
          <input
            type="date"
            value={targetDate}
            max={today}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
        <div className="session-date-shortcuts" aria-label="日付ショートカット">
          <button
            type="button"
            className={`btn subtle${targetDate === addYmdDays(today, -1) ? ' is-selected' : ''}`}
            aria-pressed={targetDate === addYmdDays(today, -1)}
            onClick={() => onChange(addYmdDays(today, -1))}
          >
            昨日
          </button>
          <button
            type="button"
            className={`btn subtle${targetDate === today ? ' is-selected' : ''}`}
            aria-pressed={targetDate === today}
            onClick={() => onChange(today)}
          >
            今日
          </button>
        </div>
      </div>
      {isPastDate && (
        <p className="session-past-notice">
          <strong>過去日の記録</strong>
          <span>{ymdToDisplay(targetDate)} の実績として保存します。</span>
        </p>
      )}
    </div>
  );
}

function EquipmentFilterSheet({
  selected,
  counts,
  onApply,
  onClose
}: {
  selected: EquipmentType[];
  counts: Map<EquipmentType, number>;
  onApply: (selected: EquipmentType[]) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<EquipmentType[]>(selected);
  const searchRef = useRef<HTMLInputElement>(null);
  const sheetRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    searchRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key === 'Tab' && sheetRef.current) {
        const focusable = Array.from(
          sheetRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')
        );
        if (focusable.length === 0) {
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const normalizedQuery = normalizeSessionSearchText(query);
  const options = equipmentTypeOptions.filter((option) =>
    !normalizedQuery || normalizeSessionSearchText(option.label).includes(normalizedQuery)
  );

  return (
    <div
      className="equipment-filter-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        ref={sheetRef}
        className="equipment-filter-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="equipment-filter-title"
      >
        <div className="equipment-filter-handle" aria-hidden="true" />
        <div className="equipment-filter-heading">
          <div>
            <h2 id="equipment-filter-title">使用する器具</h2>
            <p>{draft.length ? `${draft.length}件選択中` : '複数選択できます'}</p>
          </div>
          <button type="button" className="btn subtle equipment-filter-close" onClick={onClose} aria-label="器具フィルターを閉じる">
            閉じる
          </button>
        </div>
        <label className="equipment-filter-search">
          <span>器具名で絞り込み</span>
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder="例: ダンベル"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="equipment-filter-options" role="group" aria-label="使用する器具の候補">
          {options.map((option) => {
            const checked = draft.includes(option.value);
            return (
              <label className={`equipment-filter-option${checked ? ' is-selected' : ''}`} key={option.value}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => {
                    setDraft((current) => event.target.checked
                      ? [...current, option.value]
                      : current.filter((value) => value !== option.value));
                  }}
                />
                <span>{option.label}</span>
                <small>{counts.get(option.value) ?? 0}種目</small>
              </label>
            );
          })}
          {options.length === 0 && <p className="muted equipment-filter-empty">一致する器具がありません。</p>}
        </div>
        <div className="equipment-filter-actions">
          <button type="button" className="btn subtle" onClick={() => setDraft([])}>
            選択をクリア
          </button>
          <button type="button" className="btn primary" onClick={() => onApply(draft)}>
            {draft.length ? `${draft.length}件を適用` : '器具指定なしで適用'}
          </button>
        </div>
      </section>
    </div>
  );
}

export function TrainingSessionPage() {
  const { data, setDraftEntry, clearDraftEntry, clearDraft, finalizeTrainingSession, refreshCoreData } = useAppState();
  const today = useTodayYmd();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedDate = searchParams.get('date') ?? '';
  const hasInvalidRequestedDate = Boolean(requestedDate) && (!isValidYmd(requestedDate) || requestedDate > today);
  const targetDate = hasInvalidRequestedDate || !requestedDate ? today : requestedDate;
  const [statusText, setStatusText] = useState('');
  const [isConfirmModalOpen, setIsConfirmModalOpen] = useState(false);
  const [removedConfirmEntries, setRemovedConfirmEntries] = useState<RemovedConfirmEntry[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [sessionItems, setSessionItems] = useState<TrainingSessionMenuItem[]>([]);
  const [isSessionViewLoading, setIsSessionViewLoading] = useState(true);
  const [sessionViewError, setSessionViewError] = useState('');
  const [menuSetKind, setMenuSetKind] = useState<'training' | 'recovery'>('training');
  const [resolvedMenuSet, setResolvedMenuSet] = useState<{
    trainingMenuSetId: string;
    setName: string;
    setType: 'reusable' | 'temporary';
    source: 'manual' | 'ai';
    isDefault: boolean;
    menuSetKind: 'training' | 'recovery';
  } | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const handledDraftDateMismatchRef = useRef('');
  const equipmentFilterButtonRef = useRef<HTMLButtonElement>(null);

  const draftEntries = data.trainingDraft?.targetDate === targetDate
    ? data.trainingDraft.entriesByItemId
    : {};
  const menuSets = useMemo(() => {
    return data.menuSets.filter((set) => set.isActive).sort((a, b) => a.order - b.order);
  }, [data.menuSets]);
  const [selectedMenuSetId, setSelectedMenuSetId] = useState('');
  const [nameFilter, setNameFilter] = useState('');
  const [selectedEquipmentTypes, setSelectedEquipmentTypes] = useState<EquipmentType[]>([]);
  const [isEquipmentFilterOpen, setIsEquipmentFilterOpen] = useState(false);
  const [showCompletedOnly, setShowCompletedOnly] = useState(false);
  const [recoveryDraftsBySet, setRecoveryDraftsBySet] = useState<Record<string, Record<string, RecoveryDraft>>>({});
  const [existingExecutionCount, setExistingExecutionCount] = useState(0);

  useEffect(() => {
    if (hasInvalidRequestedDate) {
      setStatusText('未来日または不正な日付は指定できないため、本日を表示しています。');
    }
  }, [hasInvalidRequestedDate]);

  useEffect(() => {
    let active = true;
    void Promise.all([
      listGymVisits({ from: targetDate, to: targetDate, limit: 200 }),
      listRecoveryExecutions({ from: targetDate, to: targetDate })
    ]).then(([trainingExecutions, recoveryExecutions]) => {
      if (active) {
        setExistingExecutionCount(trainingExecutions.items.length + recoveryExecutions.length);
      }
    }).catch(() => {
      if (active) {
        setExistingExecutionCount(0);
      }
    });
    return () => {
      active = false;
    };
  }, [targetDate]);

  function changeTargetDate(nextDate: string) {
    if (!isValidYmd(nextDate) || nextDate > today || nextDate === targetDate) {
      return;
    }
    if (data.trainingDraft && data.trainingDraft.targetDate !== nextDate) {
      const shouldDiscard = window.confirm(
        `${ymdToDisplay(data.trainingDraft.targetDate)} の入力途中の内容があります。\n下書きを破棄して実施日を変更しますか？`
      );
      if (!shouldDiscard) {
        return;
      }
      clearDraft();
    }
    setRecoveryDraftsBySet({});
    setSelectedMenuSetId('');
    setStatusText('');
    setIsConfirmModalOpen(false);
    setRemovedConfirmEntries([]);
    const next = new URLSearchParams(searchParams);
    next.set('date', nextDate);
    setSearchParams(next);
  }

  useEffect(() => {
    const draftDate = data.trainingDraft?.targetDate;
    if (!draftDate || draftDate === targetDate) {
      handledDraftDateMismatchRef.current = '';
      return;
    }
    const mismatchKey = `${draftDate}:${targetDate}`;
    if (handledDraftDateMismatchRef.current === mismatchKey) {
      return;
    }
    handledDraftDateMismatchRef.current = mismatchKey;
    const shouldDiscard = window.confirm(
      `${ymdToDisplay(draftDate)} の入力途中の内容があります。\n「OK」で下書きを破棄して ${ymdToDisplay(targetDate)} を開きます。\n「キャンセル」で下書きの日付へ戻ります。`
    );
    if (shouldDiscard) {
      clearDraft();
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.set('date', draftDate);
    setSearchParams(next, { replace: true });
  }, [clearDraft, data.trainingDraft?.targetDate, searchParams, setSearchParams, targetDate]);

  useEffect(() => {
    if (menuSets.length === 0) {
      if (selectedMenuSetId && selectedMenuSetId !== masterMenuSelectionId) {
        setSelectedMenuSetId('');
      }
      return;
    }
    if (
      selectedMenuSetId &&
      selectedMenuSetId !== masterMenuSelectionId &&
      !menuSets.some((set) => set.id === selectedMenuSetId)
    ) {
      setSelectedMenuSetId('');
    }
  }, [menuSets, selectedMenuSetId]);

  const effectiveSelectedMenuSetId = selectedMenuSetId;
  const requestedViewMode: 'menuSet' | 'master' | 'completed' = showCompletedOnly
    ? 'completed'
    : effectiveSelectedMenuSetId === masterMenuSelectionId
      ? 'master'
      : 'menuSet';

  useEffect(() => {
    let isActive = true;

    const loadTrainingSessionView = async () => {
      setIsSessionViewLoading(true);
      setSessionViewError('');
      try {
        const remote = await getTrainingSessionView(targetDate, {
          viewMode: requestedViewMode,
          trainingMenuSetId: requestedViewMode === 'menuSet' ? effectiveSelectedMenuSetId || undefined : undefined
        });
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
            itemKind: item.itemKind,
            standardDurationMinutes: item.standardDurationMinutes,
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
            defaultWeightKg: Number(item.targetWeightKg ?? 0),
            weightInputMode,
            loadMultiplier: normalizeLoadMultiplier(item.loadMultiplier, weightInputMode),
            fixedWeightKg:
              weightInputMode === 'direct' ? 0 : normalizeFixedWeightKg(item.fixedWeightKg),
            defaultRepsMin: Number(item.targetRepsMin ?? 1),
            defaultRepsMax: Number(item.targetRepsMax ?? 1),
            defaultSets: Number(item.targetSets ?? 1),
            order: Number(item.displayOrder),
            isActive: item.isActive !== false,
            usageCount: 0,
            menuSetItemId: item.trainingMenuSetItemId ?? item.trainingMenuItemId,
            hasMenuSetPrescription: item.hasMenuSetPrescription === true,
            targetWeightKg: Number(item.targetWeightKg ?? 0),
            targetRepsMin: Number(item.targetRepsMin ?? 1),
            targetRepsMax: Number(item.targetRepsMax ?? 1),
            targetSets: Number(item.targetSets ?? 1),
            targetInstruction: item.instruction ?? '',
            targetDurationMinutes: item.targetDurationMinutes,
            performedOnTargetDateCount: Number(item.performedOnTargetDateCount ?? 0),
            isReadOnly: item.isReadOnly === true,
            targetDatePerformanceSnapshot: item.targetDatePerformanceSnapshot
              ? {
                  performedAtUtc: item.targetDatePerformanceSnapshot.performedAtUtc,
                  weightKg: Number(item.targetDatePerformanceSnapshot.weightKg),
                  weightInputModeSnapshot: normalizeWeightInputMode(
                    item.targetDatePerformanceSnapshot.weightInputModeSnapshot
                  ),
                  loadMultiplierSnapshot: item.targetDatePerformanceSnapshot.loadMultiplierSnapshot,
                  fixedWeightKgSnapshot: item.targetDatePerformanceSnapshot.fixedWeightKgSnapshot,
                  calculatedTotalWeightKg: item.targetDatePerformanceSnapshot.calculatedTotalWeightKg,
                  reps: Number(item.targetDatePerformanceSnapshot.reps),
                  sets: Number(item.targetDatePerformanceSnapshot.sets),
                  note: typeof item.targetDatePerformanceSnapshot.note === 'string'
                    ? item.targetDatePerformanceSnapshot.note
                    : undefined,
                  visitDateLocal: item.targetDatePerformanceSnapshot.visitDateLocal
                }
              : undefined,
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
        setMenuSetKind(remote.menuSetKind);
        if (requestedViewMode === 'menuSet' && !selectedMenuSetId && remote.resolvedMenuSet?.trainingMenuSetId) {
          setSelectedMenuSetId(remote.resolvedMenuSet.trainingMenuSetId);
        }
        setSessionItems(items);
      } catch (error) {
        if (!isActive) {
          return;
        }
        const message = error instanceof Error ? error.message : '実施メニューの取得に失敗しました。';
        setSessionViewError(message);
        setMenuSetKind('training');
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
  }, [effectiveSelectedMenuSetId, requestedViewMode, selectedMenuSetId, targetDate]);

  const orderedItems = useMemo(() => {
    if (requestedViewMode === 'menuSet') {
      return getPrioritizedTrainingSessionItems({
        items: sessionItems,
        todayYmd: targetDate,
        menuSetType: resolvedMenuSet?.setType ?? 'reusable'
      });
    }
    return [...sessionItems].sort(
      (a, b) => a.order - b.order || a.trainingName.localeCompare(b.trainingName, 'ja')
    );
  }, [requestedViewMode, resolvedMenuSet?.setType, sessionItems, targetDate]);

  const priorityByItemId = useMemo(
    () => new Map(orderedItems.map((item, index) => [item.id, index + 1])),
    [orderedItems]
  );
  const selectedEquipmentSet = useMemo(
    () => new Set(selectedEquipmentTypes),
    [selectedEquipmentTypes]
  );
  const prioritized = useMemo(
    () => orderedItems.filter((item) =>
      matchesSessionName(item.trainingName, nameFilter) &&
      matchesSessionEquipment(item.equipmentType, selectedEquipmentSet)
    ),
    [nameFilter, orderedItems, selectedEquipmentSet]
  );
  const equipmentCounts = useMemo(() => {
    const counts = new Map<EquipmentType, number>();
    for (const item of orderedItems) {
      counts.set(item.equipmentType, (counts.get(item.equipmentType) ?? 0) + 1);
    }
    return counts;
  }, [orderedItems]);
  const hiddenStartedItemCount = useMemo(() => {
    const visibleIds = new Set(prioritized.map((item) => item.id));
    return Object.values(draftEntries).filter(
      (draft) => hasStartedDraftEntry(draft) && !visibleIds.has(draft.menuItemId)
    ).length;
  }, [draftEntries, prioritized]);

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

  const existingDraftKeyByMenuItemId = useMemo(() => {
    const map = new Map<string, string>();
    for (const [draftKey, draft] of Object.entries(draftEntries)) {
      if (!map.has(draft.menuItemId)) {
        map.set(draft.menuItemId, draftKey);
      }
    }
    return map;
  }, [draftEntries]);

  const enteredItems = useMemo(() => {
    return Object.entries(draftEntries)
      .map(([draftKey, draft]) => {
        const item =
          menuItemById.get(draft.menuItemId) ??
          ({
            id: draft.menuItemId,
            trainingName: '不明トレーニング',
            itemKind: 'training',
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
    setDraftEntry(targetDate, entry.draftKey, entry.draft);
    setRemovedConfirmEntries((current) =>
      current.filter((removed) => removed.draftKey !== entry.draftKey)
    );
  }

  function closeConfirmModal() {
    setIsConfirmModalOpen(false);
    setRemovedConfirmEntries([]);
  }

  function selectMenuSet(nextMenuSetId: string) {
    setSelectedMenuSetId(nextMenuSetId);
  }

  function closeEquipmentFilter() {
    setIsEquipmentFilterOpen(false);
    window.requestAnimationFrame(() => equipmentFilterButtonRef.current?.focus());
  }

  if (menuSetKind === 'recovery' && resolvedMenuSet) {
    return (
      <RecoverySessionPage
        targetDate={targetDate}
        today={today}
        timeZoneId={data.userProfile.timeZoneId}
        menuSets={menuSets}
        selectedMenuSetId={resolvedMenuSet.trainingMenuSetId}
        resolvedMenuSet={resolvedMenuSet}
        items={sessionItems}
        isLoading={isSessionViewLoading}
        error={sessionViewError}
        existingExecutionCount={existingExecutionCount}
        drafts={recoveryDraftsBySet[resolvedMenuSet.trainingMenuSetId] ?? {}}
        onDraftsChange={(drafts) => setRecoveryDraftsBySet((current) => ({
          ...current,
          [resolvedMenuSet.trainingMenuSetId]: drafts
        }))}
        onSelectMenuSet={selectMenuSet}
        onChangeTargetDate={changeTargetDate}
        onSaved={() => {
          setRecoveryDraftsBySet((current) => ({
            ...current,
            [resolvedMenuSet.trainingMenuSetId]: {}
          }));
          navigate(`/daily/${targetDate}`);
        }}
      />
    );
  }

  return (
    <div className="stack-lg training-session-page">
      <section className="card card-highlight training-session-hero">
        <div className="session-header">
          <div>
            <h1>実施</h1>
            <SessionDatePicker targetDate={targetDate} today={today} onChange={changeTargetDate} />
            <label className="session-menu-set-select">
              <span>
                {showCompletedOnly ? '全メニューセット横断' : 'この日のメニュー'}
                {resolvedMenuSet?.setType === 'temporary' ? ' ・ 一時' : ''}
                {resolvedMenuSet?.source === 'ai' ? ' ・ AI作成' : ''}
              </span>
              <select
                value={resolvedMenuSet?.trainingMenuSetId ?? effectiveSelectedMenuSetId}
                disabled={showCompletedOnly}
                onChange={(event) => {
                  selectMenuSet(event.target.value);
                }}
              >
                {!effectiveSelectedMenuSetId && <option value="" disabled>メニューを選択</option>}
                <option value={masterMenuSelectionId}>種目マスタ（全種目）</option>
                {menuSets.map((set) => (
                  <option value={set.id} key={set.id}>
                    {set.setName}
                    {set.menuSetKind === 'recovery' ? '・リカバリー' : '・トレーニング'}
                    {set.isDefault ? ' (デフォルト)' : ''}
                  </option>
                ))}
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

        {menuSetKind === 'training' && (
          <div className="session-filter-panel" aria-label="種目の絞り込み">
            <div className="session-filter-primary-row">
              <label className="session-name-filter">
                <span className="sr-only">種目名</span>
                <input
                  type="search"
                  value={nameFilter}
                  placeholder="種目名で検索"
                  onChange={(event) => setNameFilter(event.target.value)}
                />
              </label>
              <button
                ref={equipmentFilterButtonRef}
                type="button"
                className={`btn subtle session-equipment-filter-button${selectedEquipmentTypes.length ? ' is-active' : ''}`}
                onClick={() => setIsEquipmentFilterOpen(true)}
              >
                器具{selectedEquipmentTypes.length ? ` ${selectedEquipmentTypes.length}` : ''}
              </button>
            </div>
            <div className="session-filter-status-row">
              <button
                type="button"
                className={`session-completed-toggle${showCompletedOnly ? ' is-active' : ''}`}
                aria-pressed={showCompletedOnly}
                onClick={() => setShowCompletedOnly((current) => !current)}
              >
                実施済みのみ
              </button>
              <span className="session-result-count" role="status" aria-live="polite">
                {prioritized.length} / {orderedItems.length}種目
              </span>
              {(nameFilter || selectedEquipmentTypes.length > 0) && (
                <button
                  type="button"
                  className="session-filter-clear"
                  onClick={() => {
                    setNameFilter('');
                    setSelectedEquipmentTypes([]);
                  }}
                >
                  条件をクリア
                </button>
              )}
            </div>
            {showCompletedOnly && <p className="session-filter-scope">対象日の全メニューセットを横断しています。</p>}
            {selectedEquipmentTypes.length > 0 && (
              <div className="session-equipment-chips" aria-label="選択中の器具">
                {selectedEquipmentTypes.map((equipmentType) => (
                  <button
                    type="button"
                    key={equipmentType}
                    onClick={() => setSelectedEquipmentTypes((current) =>
                      current.filter((value) => value !== equipmentType)
                    )}
                    aria-label={`${equipmentTypeLabel(equipmentType)}を解除`}
                  >
                    {equipmentTypeLabel(equipmentType)} <span aria-hidden="true">×</span>
                  </button>
                ))}
              </div>
            )}
            {hiddenStartedItemCount > 0 && (
              <p className="session-hidden-draft-note">入力中 {hiddenStartedItemCount}件は条件外でも下書きに保持されています。</p>
            )}
          </div>
        )}

        {data.trainingDraft && <p className="muted">下書き保存中: {data.trainingDraft.updatedAtLocal.replace('T', ' ').slice(0, 16)}</p>}
        <p className={existingExecutionCount > 0 ? 'session-existing-warning' : 'muted session-existing-summary'}>
          {existingExecutionCount > 0
            ? `この日には既に${existingExecutionCount}件の実施記録があります。保存すると追加記録になります。`
            : 'この日の実施記録はまだありません。'}
        </p>
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
            <p className="muted">
              {orderedItems.length > 0
                ? '条件に一致する種目がありません。'
                : requestedViewMode === 'completed'
                  ? 'この日の実施済み種目はありません。'
                  : requestedViewMode === 'master'
                    ? '登録済みのトレーニング種目がありません。'
                    : '選択中のメニューセットに有効な項目がありません。'}
            </p>
            {orderedItems.length > 0 && (
              <button
                type="button"
                className="btn subtle session-empty-clear"
                onClick={() => {
                  setNameFilter('');
                  setSelectedEquipmentTypes([]);
                }}
              >
                条件をクリア
              </button>
            )}
          </article>
        )}

        {prioritized.map((item, index) => {
          const draftKey = item.menuSetItemId && draftEntries[item.menuSetItemId]
            ? item.menuSetItemId
            : existingDraftKeyByMenuItemId.get(item.id) ?? item.menuSetItemId ?? item.id;
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
          const sourcePatch: Partial<DraftEntry> = item.hasMenuSetPrescription && resolvedMenuSet
            ? {
                menuSetId: resolvedMenuSet.trainingMenuSetId,
                menuSetItemId: item.menuSetItemId,
                menuSetName: resolvedMenuSet.setName,
                menuSetType: resolvedMenuSet.setType,
                targetWeightKg: item.targetWeightKg,
                targetRepsMin: item.targetRepsMin,
                targetRepsMax: item.targetRepsMax,
                targetSets: item.targetSets,
                targetInstruction: item.targetInstruction
              }
            : draft?.menuSetId
              ? {
                  menuSetId: draft.menuSetId,
                  menuSetItemId: draft.menuSetItemId,
                  menuSetName: draft.menuSetName,
                  menuSetType: draft.menuSetType,
                  targetWeightKg: draft.targetWeightKg,
                  targetRepsMin: draft.targetRepsMin,
                  targetRepsMax: draft.targetRepsMax,
                  targetSets: draft.targetSets,
                  targetInstruction: draft.targetInstruction
                }
              : {};
          const hasStarted =
            draft?.weightKg !== undefined ||
            (draft?.reps ?? 0) > 0 ||
            (draft?.sets ?? 0) > 0;

          return (
            <article className={`card training-session-card${hasStarted ? ' is-entered' : ''}${item.performedOnTargetDateCount > 0 ? ' is-completed' : ''}${item.isReadOnly ? ' is-read-only' : ''}`} key={draftKey}>
              <div className="training-item-head">
                <div className="training-item-summary">
                  <div className="training-item-badges">
                    {requestedViewMode === 'menuSet' && (
                      <p className="priority-chip">優先 {priorityByItemId.get(item.id) ?? index + 1}</p>
                    )}
                    {item.performedOnTargetDateCount > 0 && (
                      <p className="session-completed-badge">
                        実施済み{item.performedOnTargetDateCount > 1 ? ` ${item.performedOnTargetDateCount}回` : ''}
                      </p>
                    )}
                    {item.isReadOnly && <p className="session-history-only-badge">履歴のみ</p>}
                  </div>
                  <h2>{item.trainingName}{item.isAiGenerated ? '（AI）' : ''}</h2>
                  <p className="training-item-meta">
                    {formatMuscleTargets(item.muscleTargets) || '対象筋未設定'}・{equipmentTypeLabel(item.equipmentType)}
                  </p>
                  {item.hasMenuSetPrescription && (
                    <p className="muted">
                    {resolvedMenuSet?.setType === 'temporary' ? 'この日の設定' : 'メニューセットの設定'}: {formatWeightLoad({
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
                  )}
                  {item.targetDatePerformanceSnapshot && (
                    <p className="session-target-date-performance">
                      当日最新: {formatWeightLoad({
                        weightKg: item.targetDatePerformanceSnapshot.weightKg,
                        weightInputModeSnapshot: item.targetDatePerformanceSnapshot.weightInputModeSnapshot,
                        loadMultiplierSnapshot: item.targetDatePerformanceSnapshot.loadMultiplierSnapshot,
                        fixedWeightKgSnapshot: item.targetDatePerformanceSnapshot.fixedWeightKgSnapshot,
                        calculatedTotalWeightKg: item.targetDatePerformanceSnapshot.calculatedTotalWeightKg
                      })} × {item.targetDatePerformanceSnapshot.reps}回 × {item.targetDatePerformanceSnapshot.sets}set
                    </p>
                  )}
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
                      : item.hasMenuSetPrescription
                        ? `未実施（設定: ${formatWeightLoad({
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
                          })} x ${formatRepsTarget(item.defaultRepsMin, item.defaultRepsMax)} x ${item.defaultSets}set）`
                        : '未実施（数値を入力してください）'}
                  </p>
                </div>
                {!item.isReadOnly && <div className="session-actions">
                  {item.hasMenuSetPrescription && (
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
                      setDraftEntry(targetDate, draftKey, {
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
                  )}
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
                      setDraftEntry(targetDate, draftKey, {
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
                </div>}
              </div>

              {item.description.trim() && (
                <details className="training-description">
                  <summary>説明</summary>
                  <p>{item.description.trim()}</p>
                </details>
              )}

              {!item.isReadOnly && <>
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
                      setDraftEntry(targetDate, draftKey, {
                        menuItemId: item.id,
                        ...sourcePatch,
                        weightKg: nextWeightKg
                      });
                    }}
                  />
                </label>
                <label>
                  <span className="training-metric-title">
                    {item.hasMenuSetPrescription
                      ? formatRepsInputLabel(item.defaultRepsMin, item.defaultRepsMax)
                      : '回数'}
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
                      setDraftEntry(targetDate, draftKey, {
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
                      setDraftEntry(targetDate, draftKey, {
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
                    setDraftEntry(targetDate, draftKey, {
                      menuItemId: item.id,
                      ...sourcePatch,
                      memo: e.target.value
                    })
                  }
                />
              </label>
              </>}
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
          {targetDate < today ? `${ymdToDisplay(targetDate)} として記録を確認` : '記録して終了'}
        </button>
      </section>

      {isConfirmModalOpen && (
        <div className="overlay-modal" role="dialog" aria-modal="true" aria-labelledby="training-session-confirm-title">
          <div className="overlay-modal-card training-session-confirm-modal">
            <h3 id="training-session-confirm-title">記録内容の確認</h3>
            <div className="training-session-confirm-date">
              <span>実施日</span>
              <strong>{ymdToDisplay(targetDate)}</strong>
              {targetDate < today && <small>過去日の記録として保存します。</small>}
            </div>
            {existingExecutionCount > 0 && (
              <p className="training-session-confirm-warning">
                この日には既に{existingExecutionCount}件の実施記録があります。今回の内容は追加記録になります。
              </p>
            )}
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
                  const result = await finalizeTrainingSession(targetDate);
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
                  navigate(`/daily/${targetDate}`);
                }}
              >
                {isSaving ? '記録中...' : targetDate < today ? 'この日付で記録' : 'この内容で記録'}
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
      {isEquipmentFilterOpen && (
        <EquipmentFilterSheet
          selected={selectedEquipmentTypes}
          counts={equipmentCounts}
          onClose={closeEquipmentFilter}
          onApply={(selected) => {
            setSelectedEquipmentTypes(selected);
            closeEquipmentFilter();
          }}
        />
      )}
    </div>
  );
}

function RecoverySessionPage({
  targetDate,
  today,
  timeZoneId,
  menuSets,
  selectedMenuSetId,
  resolvedMenuSet,
  items,
  isLoading,
  error,
  existingExecutionCount,
  drafts,
  onDraftsChange,
  onSelectMenuSet,
  onChangeTargetDate,
  onSaved
}: {
  targetDate: string;
  today: string;
  timeZoneId: string;
  menuSets: TrainingMenuSet[];
  selectedMenuSetId: string;
  resolvedMenuSet: NonNullable<ReturnType<typeof getResolvedMenuSetShape>>;
  items: TrainingSessionMenuItem[];
  isLoading: boolean;
  error: string;
  existingExecutionCount: number;
  drafts: Record<string, RecoveryDraft>;
  onDraftsChange: (drafts: Record<string, RecoveryDraft>) => void;
  onSelectMenuSet: (id: string) => void;
  onChangeTargetDate: (date: string) => void;
  onSaved: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [plannedName, setPlannedName] = useState('予定なし');
  const [plannedSetId, setPlannedSetId] = useState<string | null>(null);
  const [plannedSetCompleted, setPlannedSetCompleted] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([
      getDailyTrainingPlan(targetDate),
      listGymVisits({ from: targetDate, to: targetDate, limit: 200 }),
      listRecoveryExecutions({ from: targetDate, to: targetDate })
    ]).then(([plan, trainingExecutions, recoveryExecutions]) => {
      if (active) {
        const planId = plan?.trainingMenuSetId;
        setPlannedName(plan ? `${plan.menuSetName}（${plan.menuSetKind === 'recovery' ? 'リカバリー' : 'トレーニング'}）` : '予定なし');
        setPlannedSetId(planId ?? null);
        setPlannedSetCompleted(Boolean(planId) && (
          trainingExecutions.items.some((execution) =>
            execution.visitDateLocal === targetDate &&
            execution.entries.some((entry) => entry.sourceTrainingMenuSetId === planId)
          ) || recoveryExecutions.some((execution) =>
            execution.executionDateLocal === targetDate && execution.sourceMenuSetId === planId
          )
        ));
      }
    }).catch(() => {
      if (active) {
        setPlannedName('予定なし');
        setPlannedSetId(null);
        setPlannedSetCompleted(false);
      }
    });
    return () => { active = false; };
  }, [targetDate]);

  useEffect(() => {
    setConfirming(false);
  }, [selectedMenuSetId, targetDate]);

  const selected = items.filter((item) => drafts[item.menuSetItemId]?.checked);
  const relation = plannedSetId === null
    ? '予定外'
    : plannedSetId === resolvedMenuSet.trainingMenuSetId
      ? '計画どおり'
      : plannedSetCompleted
        ? '追加実施'
      : '予定と異なる実施';

  return (
    <div className="stack-lg training-session-page">
      <section className="card card-highlight training-session-hero">
        <div className="session-header">
          <div>
            <h1>実施</h1>
            <SessionDatePicker targetDate={targetDate} today={today} onChange={onChangeTargetDate} />
            <label className="session-menu-set-select">
              <span>この日のメニュー ・ リカバリー</span>
              <select value={selectedMenuSetId} onChange={(event) => onSelectMenuSet(event.target.value)}>
                <option value={masterMenuSelectionId}>種目マスタ（全種目）</option>
                {menuSets.map((set) => (
                  <option value={set.id} key={set.id}>
                    {set.setName}・{set.menuSetKind === 'recovery' ? 'リカバリー' : 'トレーニング'}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button type="button" className="btn ghost" onClick={() => onDraftsChange({})}>入力をクリア</button>
        </div>
        <p className={existingExecutionCount > 0 ? 'session-existing-warning' : 'muted session-existing-summary'}>
          {existingExecutionCount > 0
            ? `この日には既に${existingExecutionCount}件の実施記録があります。保存すると追加記録になります。`
            : 'この日の実施記録はまだありません。'}
        </p>
        {status && <p className="status-text">{status}</p>}
      </section>

      <section className="stack-md training-session-list">
        {isLoading && <article className="card"><p className="muted">実施メニューを読み込み中です。</p></article>}
        {!isLoading && error && <article className="card"><p className="status-text">{error}</p></article>}
        {!isLoading && !error && items.map((item) => {
          const key = item.menuSetItemId;
          const draft = drafts[key] ?? { checked: false, note: '' };
          return (
            <article className={`card stack-md training-session-card${draft.checked ? ' is-entered' : ''}`} key={key}>
              <label className="recovery-selection-control">
                <input
                  type="checkbox"
                  checked={draft.checked}
                  onChange={(event) => {
                    setStatus('');
                    onDraftsChange({ ...drafts, [key]: { ...draft, checked: event.target.checked } });
                  }}
                />
                <span className="recovery-selection-copy">
                  <strong>{item.trainingName}</strong>
                  <small>{draft.checked ? '今回の記録に含めます' : 'チェックして今回の記録に含める'}</small>
                </span>
              </label>
              {item.targetInstruction && <p className="muted">{item.targetInstruction}</p>}
              {item.targetDurationMinutes && <p className="muted">目標時間: {item.targetDurationMinutes}分</p>}
              <div className="input-grid">
                <label>
                  実施時間（分・任意）
                  <input
                    type="number"
                    min={1}
                    max={1440}
                    value={draft.actualDurationMinutes ?? ''}
                    placeholder="入力なしでも登録できます"
                    onChange={(event) => {
                      const actualDurationMinutes = event.target.value ? Number(event.target.value) : undefined;
                      setStatus('');
                      onDraftsChange({
                        ...drafts,
                        [key]: {
                          ...draft,
                          checked: actualDurationMinutes !== undefined ? true : draft.checked,
                          actualDurationMinutes
                        }
                      });
                    }}
                  />
                </label>
                <label>
                  メモ（任意）
                  <input
                    value={draft.note}
                    maxLength={500}
                    onChange={(event) => {
                      const note = event.target.value;
                      setStatus('');
                      onDraftsChange({
                        ...drafts,
                        [key]: { ...draft, checked: note.trim() !== '' ? true : draft.checked, note }
                      });
                    }}
                  />
                </label>
              </div>
            </article>
          );
        })}
        {!isLoading && !error && items.length === 0 && <article className="card"><p className="muted">このセットにはリカバリー活動がありません。</p></article>}
      </section>

      <section className="sticky-action">
        <button
          type="button"
          className="btn primary large"
          disabled={isLoading || Boolean(error) || items.length === 0}
          onClick={() => {
            if (selected.length === 0) {
              setStatus('記録するリカバリーを選択してください。チェックを入れるか、実施時間・メモを入力してください。');
              return;
            }
            setStatus('');
            setConfirming(true);
          }}
        >
          {targetDate < today ? `${ymdToDisplay(targetDate)} として記録を確認` : '記録内容を確認'}
        </button>
      </section>

      {confirming && (
        <div className="overlay-modal" role="dialog" aria-modal="true" aria-labelledby="recovery-confirm-title">
          <div className="overlay-modal-card training-session-confirm-modal">
            <h3 id="recovery-confirm-title">記録内容の確認</h3>
            <div className="training-session-confirm-date">
              <span>実施日</span>
              <strong>{ymdToDisplay(targetDate)}</strong>
              {targetDate < today && <small>過去日の記録として保存します。</small>}
            </div>
            {existingExecutionCount > 0 && (
              <p className="training-session-confirm-warning">
                この日には既に{existingExecutionCount}件の実施記録があります。今回の内容は追加記録になります。
              </p>
            )}
            <p>予定: {plannedName}</p>
            <p>実施: {resolvedMenuSet.setName}（リカバリー）</p>
            <p className="priority-chip">{relation}</p>
            <ul className="simple-list">
              {selected.map((item) => {
                const draft = drafts[item.menuSetItemId];
                return <li key={item.menuSetItemId}><strong>{item.trainingName}</strong>{draft.actualDurationMinutes ? `・${draft.actualDurationMinutes}分` : ''}{draft.note ? `・${draft.note}` : ''}</li>;
              })}
            </ul>
            <div className="overlay-modal-actions">
              <button type="button" className="btn subtle" disabled={saving} onClick={() => setConfirming(false)}>戻る</button>
              <button
                type="button"
                className="btn primary"
                disabled={saving}
                onClick={async () => {
                  setSaving(true);
                  setStatus('');
                  try {
                    const performedAtUtc = combineYmdWithInstantTimeUtc(targetDate, new Date(), timeZoneId);
                    await createRecoveryExecution({
                      executionDateLocal: targetDate,
                      timeZoneId,
                      sourceMenuSetId: resolvedMenuSet.trainingMenuSetId,
                      sourceMenuSetNameSnapshot: resolvedMenuSet.setName,
                      sourceMenuSetTypeSnapshot: resolvedMenuSet.setType,
                      entries: selected.map((item) => ({
                        menuItemId: item.id,
                        activityNameSnapshot: item.trainingName,
                        sourceMenuSetItemId: item.menuSetItemId,
                        targetDurationMinutesSnapshot: item.targetDurationMinutes,
                        actualDurationMinutes: drafts[item.menuSetItemId].actualDurationMinutes,
                        instructionSnapshot: item.targetInstruction,
                        note: drafts[item.menuSetItemId].note,
                        performedAtUtc
                      }))
                    });
                    setConfirming(false);
                    onSaved();
                  } catch (saveError) {
                    setStatus(saveError instanceof Error ? saveError.message : 'リカバリー記録の保存に失敗しました。');
                    setConfirming(false);
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                {saving ? '記録中...' : targetDate < today ? 'この日付で記録' : 'この内容で記録'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function getResolvedMenuSetShape() {
  return null as null | {
    trainingMenuSetId: string;
    setName: string;
    setType: 'reusable' | 'temporary';
    source: 'manual' | 'ai';
    isDefault: boolean;
    menuSetKind: 'training' | 'recovery';
  };
}

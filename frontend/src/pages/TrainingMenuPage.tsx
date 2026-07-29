import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppState, useTodayYmd } from '../AppState';
import {
  addTrainingMenuItemToSet,
  createTrainingMenuItem,
  createTrainingMenuSet,
  deleteTrainingMenuItem,
  deleteTrainingMenuSet,
  getDailyTrainingPlan,
  putDailyTrainingPlan,
  removeTrainingMenuItemFromSet,
  reorderTrainingMenuSetItems,
  updateTrainingMenuItem,
  updateTrainingMenuSet,
  updateTrainingMenuSetItem
} from '../api/coreApi';
import {
  formatMuscleTargets,
  lateralityOptions,
  loadModelOptions,
  movementPatternOptions,
  muscleGroups,
  muscles,
  type Laterality,
  type LoadModel,
  type MovementPattern,
  type MuscleId,
  type MuscleRole,
  type MuscleTarget
} from '../muscleTaxonomy';
import type {
  TrainingEquipment,
  TrainingFrequencyDays,
  TrainingMenuItem,
  TrainingMenuSet,
  TrainingMenuSetItem,
  WeightInputMode
} from '../types';
import { formatTrainingLabel } from '../utils/training';

type MenuTab = 'sets' | 'items';
type SetItemDraft = TrainingMenuSetItem;

const equipmentOptions: TrainingEquipment[] = ['マシン', 'フリー', '自重', 'その他'];
const intervalOptions: TrainingFrequencyDays[] = [1, 2, 3, 4, 5, 6, 7, 8];

function intervalLabel(value: TrainingFrequencyDays): string {
  return value === 1 ? '毎日' : value === 8 ? '8日以上' : `${value}日`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function validatePrescription(item: SetItemDraft): string | null {
  if (!Number.isFinite(item.targetWeightKg) || item.targetWeightKg < 0) {
    return '目標重量は0以上で入力してください。';
  }
  if (
    item.targetRepsMin < 1 ||
    item.targetRepsMax < item.targetRepsMin ||
    item.targetSets < 1
  ) {
    return '回数とセット数を確認してください。';
  }
  return null;
}

function enumerateDates(validFromDate: string, validToDate: string): string[] {
  if (!validFromDate || !validToDate || validFromDate > validToDate) {
    return [];
  }
  const start = new Date(`${validFromDate}T00:00:00Z`);
  const dates: string[] = [];
  for (let offset = 0; offset < 31; offset += 1) {
    const current = new Date(start);
    current.setUTCDate(start.getUTCDate() + offset);
    const date = current.toISOString().slice(0, 10);
    if (date > validToDate) return dates;
    dates.push(date);
  }
  return [];
}

async function confirmValidityReplacement(validFromDate: string, validToDate: string, nextSetId?: string): Promise<boolean> {
  const dates = enumerateDates(validFromDate, validToDate);
  if (!dates.length) {
    throw new Error('有効期間は開始日から31日以内で指定してください。');
  }
  const plans = await Promise.all(dates.map((date) => getDailyTrainingPlan(date)));
  const conflicts = plans.filter((plan) => plan && plan.trainingMenuSetId !== nextSetId);
  if (!conflicts.length) return true;
  return window.confirm('指定期間には別の一時メニューがあります。新しいメニューに置き換えますか？');
}

async function confirmDailyPlanReplacement(date: string, nextSetId?: string): Promise<boolean> {
  const current = await getDailyTrainingPlan(date);
  if (!current || current.trainingMenuSetId === nextSetId) {
    return true;
  }
  return window.confirm('指定日のメニューはすでに設定されています。新しいメニューに置き換えますか？');
}

export function TrainingMenuPage() {
  const { data, refreshCoreData, isCoreDataLoading, coreDataError } = useAppState();
  const today = useTodayYmd();
  const [tab, setTab] = useState<MenuTab>('sets');
  const [selectedSetId, setSelectedSetId] = useState('');
  const [status, setStatus] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const menuSets = useMemo(() => [...data.menuSets].sort((a, b) => a.order - b.order), [data.menuSets]);
  const menuItems = useMemo(
    () => [...data.menuItems].sort((a, b) => a.trainingName.localeCompare(b.trainingName)),
    [data.menuItems]
  );
  const selectedSet = menuSets.find((set) => set.id === selectedSetId) ?? menuSets[0] ?? null;

  useEffect(() => {
    if (!selectedSetId && menuSets[0]) {
      setSelectedSetId(menuSets[0].id);
    } else if (selectedSetId && !menuSets.some((set) => set.id === selectedSetId)) {
      setSelectedSetId(menuSets[0]?.id ?? '');
    }
  }, [menuSets, selectedSetId]);

  async function run(action: () => Promise<void>, success: string) {
    setIsSaving(true);
    setStatus('');
    try {
      await action();
      await refreshCoreData();
      setStatus(success);
    } catch (error) {
      setStatus(errorMessage(error, '操作に失敗しました。'));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="stack-lg training-menu-page">
      <section className="card training-menu-header-card stack-md">
        <div className="row-between menu-page-head">
          <div>
            <h1>トレーニングメニュー</h1>
            <p className="muted">セットごとの目標と、共有する種目を分けて管理します。</p>
          </div>
          <Link to="/training-menu/ai-generate" className="btn primary menu-generate-button">
            AIで一時メニューを作る
          </Link>
        </div>
        <div className="menu-management-tabs" role="tablist" aria-label="メニュー管理">
          <button
            type="button"
            className={`btn ${tab === 'sets' ? 'primary' : 'subtle'}`}
            onClick={() => setTab('sets')}
          >
            メニューセット
          </button>
          <button
            type="button"
            className={`btn ${tab === 'items' ? 'primary' : 'subtle'}`}
            onClick={() => setTab('items')}
          >
            種目一覧
          </button>
        </div>
        {(status || coreDataError) && <p className="status-text">{status || coreDataError}</p>}
      </section>

      {tab === 'sets' ? (
        <SetManagement
          sets={menuSets}
          items={menuItems}
          selectedSet={selectedSet}
          today={today}
          disabled={isSaving || isCoreDataLoading}
          onSelect={setSelectedSetId}
          onRun={run}
          onCreated={setSelectedSetId}
        />
      ) : (
        <ItemLibrary items={menuItems} disabled={isSaving || isCoreDataLoading} onRun={run} />
      )}
    </div>
  );
}

function SetManagement({
  sets,
  items,
  selectedSet,
  today,
  disabled,
  onSelect,
  onRun,
  onCreated
}: {
  sets: TrainingMenuSet[];
  items: TrainingMenuItem[];
  selectedSet: TrainingMenuSet | null;
  today: string;
  disabled: boolean;
  onSelect: (id: string) => void;
  onRun: (action: () => Promise<void>, success: string) => Promise<void>;
  onCreated: (id: string) => void;
}) {
  const [newSetName, setNewSetName] = useState('');
  const [newSetType, setNewSetType] = useState<'reusable' | 'temporary'>('reusable');
  const [newValidFromDate, setNewValidFromDate] = useState(today);
  const [newValidToDate, setNewValidToDate] = useState(today);

  return (
    <div className="menu-management-layout">
      <aside className="card stack-md menu-set-sidebar">
        <h2>メニューセット</h2>
        <div className="stack-sm">
          {sets.map((set) => (
            <button
              type="button"
              key={set.id}
              className={`menu-set-list-button${selectedSet?.id === set.id ? ' active' : ''}`}
              onClick={() => onSelect(set.id)}
            >
              <span>{set.setName}</span>
              <small>
                {set.setType === 'temporary' ? '一時' : '恒常'}
                {set.source === 'ai' ? '・AI作成' : ''}
                {set.isDefault ? '・デフォルト' : ''}・{set.items.length}種目
                {set.setType === 'temporary' && set.validFromDate && set.validToDate
                  ? `・${set.validFromDate}〜${set.validToDate}`
                  : ''}
              </small>
            </button>
          ))}
          {sets.length === 0 && <p className="muted">まだメニューセットがありません。</p>}
        </div>
        <form
          className="stack-sm menu-set-create-panel"
          onSubmit={async (event) => {
            event.preventDefault();
            const name = newSetName.trim();
            if (!name) return;
            if (
              newSetType === 'temporary' &&
              !(await confirmValidityReplacement(newValidFromDate, newValidToDate))
            ) {
              return;
            }
            let createdId = '';
            await onRun(async () => {
              const created = await createTrainingMenuSet({
                setName: name,
                setType: newSetType,
                source: 'manual',
                validFromDate: newSetType === 'temporary' ? newValidFromDate : undefined,
                validToDate: newSetType === 'temporary' ? newValidToDate : undefined,
                replaceExistingPlan: newSetType === 'temporary'
              });
              createdId = created.trainingMenuSetId;
            }, newSetType === 'temporary' ? '有効期間付きの一時セットを作成しました。' : 'メニューセットを作成しました。');
            if (createdId) {
              onCreated(createdId);
              setNewSetName('');
            }
          }}
        >
          <strong>新しいセット</strong>
          <input
            value={newSetName}
            onChange={(event) => setNewSetName(event.target.value)}
            placeholder="例: 胸の日 / 回復メニュー"
            maxLength={40}
          />
          <select value={newSetType} onChange={(event) => setNewSetType(event.target.value as 'reusable' | 'temporary')}>
            <option value="reusable">恒常セット</option>
            <option value="temporary">一時セット</option>
          </select>
          {newSetType === 'temporary' && (
            <div className="menu-validity-grid">
              <label>
                有効開始日
                <input type="date" value={newValidFromDate} onChange={(event) => setNewValidFromDate(event.target.value)} />
              </label>
              <label>
                有効終了日
                <input type="date" min={newValidFromDate} value={newValidToDate} onChange={(event) => setNewValidToDate(event.target.value)} />
              </label>
            </div>
          )}
          <button className="btn primary" type="submit" disabled={disabled || !newSetName.trim()}>
            作成
          </button>
        </form>
      </aside>

      <main className="stack-md menu-set-detail">
        {selectedSet ? (
          <SetEditor set={selectedSet} menuItems={items} today={today} disabled={disabled} onRun={onRun} />
        ) : (
          <section className="card">
            <p className="muted">左のフォームからメニューセットを作成してください。</p>
          </section>
        )}
      </main>
    </div>
  );
}

function SetEditor({
  set,
  menuItems,
  today,
  disabled,
  onRun
}: {
  set: TrainingMenuSet;
  menuItems: TrainingMenuItem[];
  today: string;
  disabled: boolean;
  onRun: (action: () => Promise<void>, success: string) => Promise<void>;
}) {
  const [name, setName] = useState(set.setName);
  const [validFromDate, setValidFromDate] = useState(set.validFromDate ?? today);
  const [validToDate, setValidToDate] = useState(set.validToDate ?? today);
  const [draftItems, setDraftItems] = useState<SetItemDraft[]>(set.items);
  const [addItemId, setAddItemId] = useState('');
  const [useDate, setUseDate] = useState(today);

  useEffect(() => {
    setName(set.setName);
    setValidFromDate(set.validFromDate ?? today);
    setValidToDate(set.validToDate ?? today);
    setDraftItems(set.items);
    setAddItemId('');
    setUseDate(today);
  }, [set.id, set.items, set.setName, set.validFromDate, set.validToDate, today]);

  const itemById = useMemo(() => new Map(menuItems.map((item) => [item.id, item])), [menuItems]);
  const assignedIds = new Set(draftItems.map((item) => item.menuItemId));
  const addableItems = menuItems.filter((item) => item.isActive && !assignedIds.has(item.id));
  const dirty =
    name.trim() !== set.setName ||
    (set.setType === 'temporary' &&
      (validFromDate !== set.validFromDate || validToDate !== set.validToDate)) ||
    JSON.stringify(draftItems.map(({ id: _id, ...item }) => item)) !==
      JSON.stringify(set.items.map(({ id: _id, ...item }) => item));

  async function saveAll() {
    const error = draftItems.map(validatePrescription).find(Boolean);
    if (error) {
      throw new Error(error);
    }
    if (
      set.setType === 'temporary' &&
      !(await confirmValidityReplacement(validFromDate, validToDate, set.id))
    ) {
      throw new Error('有効期間の変更をキャンセルしました。');
    }
    await updateTrainingMenuSet(set.id, {
      setName: name.trim(),
      ...(set.setType === 'temporary'
        ? { validFromDate, validToDate, replaceExistingPlan: true }
        : {})
    });
    for (const item of draftItems) {
      const original = set.items.find((entry) => entry.id === item.id);
      if (original && JSON.stringify(original) !== JSON.stringify(item)) {
        await updateTrainingMenuSetItem(set.id, item.id, {
          targetWeightKg: item.targetWeightKg,
          targetRepsMin: item.targetRepsMin,
          targetRepsMax: item.targetRepsMax,
          targetSets: item.targetSets,
          recommendedIntervalDays: item.recommendedIntervalDays,
          instruction: item.instruction
        });
      }
    }
    if (draftItems.some((item, index) => item.order !== index + 1)) {
      await reorderTrainingMenuSetItems(
        set.id,
        draftItems.map((item, index) => ({ trainingMenuSetItemId: item.id, displayOrder: index + 1 }))
      );
    }
  }

  return (
    <>
      <section className="card stack-md">
        <div className="row-between">
          <div>
            <div className="row-wrap">
              <span className="priority-chip">{set.setType === 'temporary' ? '一時' : '恒常'}</span>
              {set.source === 'ai' && <span className="priority-chip">AI作成</span>}
              {set.isDefault && <span className="priority-chip">デフォルト</span>}
            </div>
            <h2>{set.setName}</h2>
          </div>
          <div className="row-wrap menu-set-use-actions">
            <label className="menu-set-use-date">
              利用日
              <input
                type="date"
                value={useDate}
                onChange={(event) => setUseDate(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="btn subtle"
              disabled={disabled || !useDate}
              onClick={() => void onRun(
                async () => {
                  if (!(await confirmDailyPlanReplacement(useDate, set.id))) {
                    throw new Error('指定日のメニュー変更をキャンセルしました。');
                  }
                  await putDailyTrainingPlan(useDate, set.id);
                },
                '指定日のメニューに設定しました。'
              )}
            >
              利用日に設定
            </button>
            {!set.isDefault && (
              <button
                type="button"
                className="btn danger"
                disabled={disabled}
                onClick={() => {
                  if (window.confirm(`「${set.setName}」を削除しますか？ 実施履歴は残ります。`)) {
                    void onRun(() => deleteTrainingMenuSet(set.id), 'メニューセットを削除しました。');
                  }
                }}
              >
                削除
              </button>
            )}
          </div>
        </div>
        <label>
          セット名
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={40} />
        </label>
        {set.setType === 'temporary' && (
          <div className="menu-validity-grid">
            <label>
              有効開始日
              <input type="date" value={validFromDate} onChange={(event) => setValidFromDate(event.target.value)} />
            </label>
            <label>
              有効終了日
              <input type="date" min={validFromDate} value={validToDate} onChange={(event) => setValidToDate(event.target.value)} />
            </label>
          </div>
        )}
        {set.setType === 'reusable' && !set.isDefault && (
          <label className="menu-set-default-check">
            <input
              type="checkbox"
              onChange={(event) => {
                if (event.target.checked) {
                  void onRun(() => updateTrainingMenuSet(set.id, { isDefault: true }).then(() => undefined), 'デフォルトセットを変更しました。');
                }
              }}
            />
            <span>デフォルトセットにする</span>
          </label>
        )}
      </section>

      <section className="card stack-md">
        <h3>既存種目を追加</h3>
        <div className="menu-existing-attach">
          <select value={addItemId} onChange={(event) => setAddItemId(event.target.value)}>
            <option value="">種目を選択</option>
            {addableItems.map((item) => (
              <option key={item.id} value={item.id}>
                {formatTrainingLabel(item.trainingName, item.muscleTargets, item.equipment, item.isAiGenerated)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn subtle"
            disabled={disabled || !addItemId}
            onClick={() => void onRun(
              async () => {
                await addTrainingMenuItemToSet(set.id, {
                  trainingMenuItemId: addItemId,
                  targetWeightKg: 0,
                  targetRepsMin: 8,
                  targetRepsMax: 12,
                  targetSets: 3,
                  recommendedIntervalDays: 3
                });
              },
              '種目をセットへ追加しました。'
            )}
          >
            追加
          </button>
        </div>
        <p className="muted">新しい種目は「種目一覧」タブで登録してから追加できます。</p>
      </section>

      <section className="stack-md">
        {draftItems.map((setItem, index) => {
          const menuItem = itemById.get(setItem.menuItemId);
          if (!menuItem) return null;
          return (
            <article className="card stack-md menu-set-prescription-card" key={setItem.id}>
              <div className="row-between">
                <div>
                  <p className="priority-chip">#{index + 1}</p>
                  <h3>{formatTrainingLabel(menuItem.trainingName, menuItem.muscleTargets, menuItem.equipment, menuItem.isAiGenerated)}</h3>
                </div>
                <div className="row-wrap">
                  <button
                    type="button"
                    className="btn subtle"
                    disabled={index === 0}
                    onClick={() => setDraftItems((current) => {
                      const next = [...current];
                      [next[index - 1], next[index]] = [next[index], next[index - 1]];
                      return next;
                    })}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="btn subtle"
                    disabled={index === draftItems.length - 1}
                    onClick={() => setDraftItems((current) => {
                      const next = [...current];
                      [next[index], next[index + 1]] = [next[index + 1], next[index]];
                      return next;
                    })}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="btn danger"
                    disabled={disabled}
                    onClick={() => void onRun(
                      () => removeTrainingMenuItemFromSet(set.id, setItem.id),
                      '種目をセットから外しました。'
                    )}
                  >
                    セットから外す
                  </button>
                </div>
              </div>
              <div className="menu-prescription-grid">
                <label>
                  目標重量 (kg)
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    value={setItem.targetWeightKg}
                    onChange={(event) => setDraftItems((current) => current.map((item) =>
                      item.id === setItem.id ? { ...item, targetWeightKg: Number(event.target.value) } : item
                    ))}
                  />
                </label>
                <label>
                  回数 最小
                  <input
                    type="number"
                    min={1}
                    value={setItem.targetRepsMin}
                    onChange={(event) => setDraftItems((current) => current.map((item) =>
                      item.id === setItem.id ? { ...item, targetRepsMin: Number(event.target.value) } : item
                    ))}
                  />
                </label>
                <label>
                  回数 最大
                  <input
                    type="number"
                    min={1}
                    value={setItem.targetRepsMax}
                    onChange={(event) => setDraftItems((current) => current.map((item) =>
                      item.id === setItem.id ? { ...item, targetRepsMax: Number(event.target.value) } : item
                    ))}
                  />
                </label>
                <label>
                  セット数
                  <input
                    type="number"
                    min={1}
                    value={setItem.targetSets}
                    onChange={(event) => setDraftItems((current) => current.map((item) =>
                      item.id === setItem.id ? { ...item, targetSets: Number(event.target.value) } : item
                    ))}
                  />
                </label>
                <label>
                  推奨間隔
                  <select
                    value={setItem.recommendedIntervalDays}
                    onChange={(event) => setDraftItems((current) => current.map((item) =>
                      item.id === setItem.id
                        ? { ...item, recommendedIntervalDays: Number(event.target.value) as TrainingFrequencyDays }
                        : item
                    ))}
                  >
                    {intervalOptions.map((value) => <option value={value} key={value}>{intervalLabel(value)}</option>)}
                  </select>
                </label>
              </div>
              <label>
                このセットでの補足
                <textarea
                  value={setItem.instruction}
                  maxLength={500}
                  rows={2}
                  onChange={(event) => setDraftItems((current) => current.map((item) =>
                    item.id === setItem.id ? { ...item, instruction: event.target.value } : item
                  ))}
                />
              </label>
            </article>
          );
        })}
        {draftItems.length === 0 && <article className="card"><p className="muted">このセットにはまだ種目がありません。</p></article>}
      </section>

      <section className="sticky-action">
        <button
          type="button"
          className="btn primary large"
          disabled={disabled || !dirty || !name.trim()}
          onClick={() => void onRun(saveAll, 'メニューセットを保存しました。')}
        >
          変更を保存
        </button>
      </section>
    </>
  );
}

function ItemLibrary({
  items,
  disabled,
  onRun
}: {
  items: TrainingMenuItem[];
  disabled: boolean;
  onRun: (action: () => Promise<void>, success: string) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const filtered = items.filter((item) => {
    const needle = query.trim().toLowerCase();
    return !needle || `${item.trainingName} ${formatMuscleTargets(item.muscleTargets)} ${item.equipment}`.toLowerCase().includes(needle);
  });

  return (
    <div className="stack-md">
      <section className="card stack-md">
        <div className="row-between">
          <div>
            <h2>種目一覧</h2>
            <p className="muted">どのセットにも属していない種目も、ここで管理できます。</p>
          </div>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="種目名・部位・用具で検索"
          />
        </div>
      </section>
      <NewMenuItemForm disabled={disabled} onRun={onRun} />
      {filtered.map((item) => (
        <MenuItemEditor key={item.id} item={item} disabled={disabled} onRun={onRun} />
      ))}
      {filtered.length === 0 && <section className="card"><p className="muted">条件に一致する種目がありません。</p></section>}
    </div>
  );
}

function NewMenuItemForm({
  disabled,
  onRun
}: {
  disabled: boolean;
  onRun: (action: () => Promise<void>, success: string) => Promise<void>;
}) {
  return (
    <details className="card">
      <summary>新しい種目を登録</summary>
      <MenuItemForm
        submitLabel="種目一覧へ登録"
        disabled={disabled}
        onSubmit={(value) => onRun(() => createTrainingMenuItem(value).then(() => undefined), '新しい種目を登録しました。')}
      />
    </details>
  );
}

function MenuItemEditor({
  item,
  disabled,
  onRun
}: {
  item: TrainingMenuItem;
  disabled: boolean;
  onRun: (action: () => Promise<void>, success: string) => Promise<void>;
}) {
  return (
    <details className="card menu-item-library-card">
      <summary>
        <span>{formatTrainingLabel(item.trainingName, item.muscleTargets, item.equipment, item.isAiGenerated)}</span>
        <small>{item.usageCount}セットで使用</small>
      </summary>
      <MenuItemForm
        initial={item}
        submitLabel="種目情報を保存"
        disabled={disabled}
        onSubmit={(value) => onRun(
          () => updateTrainingMenuItem(item.id, value).then(() => undefined),
          '種目情報を保存しました。'
        )}
      />
      <button
        type="button"
        className="btn danger"
        disabled={disabled}
        onClick={() => {
          const text = item.usageCount > 0
            ? `${item.usageCount}個のセットからも外れます。種目を削除しますか？`
            : 'この種目を削除しますか？';
          if (window.confirm(text)) {
            void onRun(() => deleteTrainingMenuItem(item.id), '種目を削除しました。実施履歴は残ります。');
          }
        }}
      >
        種目自体を削除
      </button>
    </details>
  );
}

function MenuItemForm({
  initial,
  submitLabel,
  disabled,
  onSubmit
}: {
  initial?: TrainingMenuItem;
  submitLabel: string;
  disabled: boolean;
  onSubmit: (value: {
    trainingName: string;
    muscleTargets: MuscleTarget[];
    movementPattern: MovementPattern;
    laterality: Laterality;
    loadModel: LoadModel;
    equipment: TrainingEquipment;
    description: string;
    weightInputMode: WeightInputMode;
    loadMultiplier: 1 | 2;
    fixedWeightKg: number;
  }) => Promise<void>;
}) {
  const [muscleTargets, setMuscleTargets] = useState<MuscleTarget[]>(initial?.muscleTargets ?? []);
  const [formError, setFormError] = useState('');
  const firstSelectedMuscle = muscles.find((muscle) =>
    initial?.muscleTargets.some((target) => target.muscleId === muscle.id)
  );
  const [activeMuscleGroupId, setActiveMuscleGroupId] = useState<(typeof muscleGroups)[number]['id']>(
    firstSelectedMuscle?.groupId ?? muscleGroups[0].id
  );

  const setMuscleTarget = (muscleId: MuscleId, enabled: boolean, role?: MuscleRole) => {
    setMuscleTargets((current) => {
      const remaining = current.filter((target) => target.muscleId !== muscleId);
      const resolvedRole = role ?? (current.some((target) => target.role === 'primary') ? 'secondary' : 'primary');
      return enabled ? [...remaining, { muscleId, role: resolvedRole }] : remaining;
    });
  };
  const activeMuscles = muscles.filter((muscle) => muscle.groupId === activeMuscleGroupId);
  const primaryTargets = muscleTargets.filter((target) => target.role === 'primary');
  const secondaryTargets = muscleTargets.filter((target) => target.role === 'secondary');

  return (
    <form
      className="stack-md menu-library-form"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const mode = form.get('weightInputMode') === 'perSide' ? 'perSide' : 'direct';
        if (!muscleTargets.some((target) => target.role === 'primary')) {
          setFormError('主働筋を1つ以上選択してください。');
          return;
        }
        setFormError('');
        void onSubmit({
          trainingName: String(form.get('trainingName') ?? '').trim(),
          muscleTargets,
          movementPattern: String(form.get('movementPattern') ?? 'horizontal_push') as MovementPattern,
          laterality: String(form.get('laterality') ?? 'bilateral') as Laterality,
          loadModel: String(form.get('loadModel') ?? 'external_load') as LoadModel,
          equipment: String(form.get('equipment') ?? 'その他') as TrainingEquipment,
          description: String(form.get('description') ?? '').trim(),
          weightInputMode: mode,
          loadMultiplier: mode === 'perSide' ? 2 : 1,
          fixedWeightKg: mode === 'perSide' ? Number(form.get('fixedWeightKg') ?? 0) : 0
        });
      }}
    >
      <div className="menu-three-fields-row">
        <label>
          種目名
          <input name="trainingName" defaultValue={initial?.trainingName} required />
        </label>
        <label>
          用具
          <select name="equipment" defaultValue={initial?.equipment ?? 'その他'}>
            {equipmentOptions.map((value) => <option value={value} key={value}>{value}</option>)}
          </select>
        </label>
      </div>
      <fieldset className="muscle-target-fieldset">
        <legend>鍛える筋肉</legend>
        <p className="muted muscle-target-help">部位を選び、各筋肉の役割を指定します。主働筋は1つ以上必要です。</p>
        <div className="muscle-target-summary" aria-live="polite">
          {muscleTargets.length === 0 ? (
            <span className="muscle-target-empty">まだ筋肉が選択されていません</span>
          ) : (
            <>
              {primaryTargets.map((target) => (
                <span className="muscle-target-chip is-primary" key={target.muscleId}>
                  <strong>主働</strong>
                  {muscles.find((muscle) => muscle.id === target.muscleId)?.label}
                </span>
              ))}
              {secondaryTargets.map((target) => (
                <span className="muscle-target-chip is-secondary" key={target.muscleId}>
                  <strong>補助</strong>
                  {muscles.find((muscle) => muscle.id === target.muscleId)?.label}
                </span>
              ))}
            </>
          )}
        </div>
        <div className="muscle-group-tabs" role="group" aria-label="筋肉の部位">
          {muscleGroups.map((group) => {
            const selectedCount = muscleTargets.filter((target) =>
              muscles.some((muscle) => muscle.id === target.muscleId && muscle.groupId === group.id)
            ).length;
            const isActive = activeMuscleGroupId === group.id;
            return (
              <button
                aria-pressed={isActive}
                className={`muscle-group-tab${isActive ? ' is-active' : ''}`}
                key={group.id}
                onClick={() => setActiveMuscleGroupId(group.id)}
                type="button"
              >
                {group.label}
                {selectedCount > 0 && <span className="muscle-group-count">{selectedCount}</span>}
              </button>
            );
          })}
        </div>
        <section
          aria-label={`${muscleGroups.find((group) => group.id === activeMuscleGroupId)?.label}の筋肉`}
          className="muscle-target-panel"
        >
          {activeMuscles.map((muscle) => {
            const target = muscleTargets.find((candidate) => candidate.muscleId === muscle.id);
            return (
              <div className={`muscle-target-row${target ? ' is-selected' : ''}`} key={muscle.id}>
                <span className="muscle-target-name">{muscle.label}</span>
                <div className="muscle-role-options" role="group" aria-label={`${muscle.label}の役割`}>
                  <button
                    aria-label={`${muscle.label}を選択解除`}
                    aria-pressed={!target}
                    className={!target ? 'is-active is-none' : ''}
                    onClick={() => setMuscleTarget(muscle.id, false)}
                    type="button"
                  >
                    なし
                  </button>
                  <button
                    aria-label={`${muscle.label}を主働筋にする`}
                    aria-pressed={target?.role === 'primary'}
                    className={target?.role === 'primary' ? 'is-active is-primary' : ''}
                    onClick={() => setMuscleTarget(muscle.id, true, 'primary')}
                    type="button"
                  >
                    主働
                  </button>
                  <button
                    aria-label={`${muscle.label}を補助筋にする`}
                    aria-pressed={target?.role === 'secondary'}
                    className={target?.role === 'secondary' ? 'is-active is-secondary' : ''}
                    onClick={() => setMuscleTarget(muscle.id, true, 'secondary')}
                    type="button"
                  >
                    補助
                  </button>
                </div>
              </div>
            );
          })}
        </section>
      </fieldset>
      <div className="menu-three-fields-row">
        <label>
          動作パターン
          <select name="movementPattern" defaultValue={initial?.movementPattern ?? 'horizontal_push'}>
            {movementPatternOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label>
          左右の実施方式
          <select name="laterality" defaultValue={initial?.laterality ?? 'bilateral'}>
            {lateralityOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label>
          負荷方式
          <select name="loadModel" defaultValue={initial?.loadModel ?? 'external_load'}>
            {loadModelOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="menu-three-fields-row">
        <label>
          重量入力方式
          <select name="weightInputMode" defaultValue={initial?.weightInputMode === 'perSide' ? 'perSide' : 'direct'}>
            <option value="direct">入力値が総重量</option>
            <option value="perSide">片側重量 × 2</option>
          </select>
        </label>
        <label>
          バーなどの固定重量
          <input name="fixedWeightKg" type="number" min={0} step={0.01} defaultValue={initial?.fixedWeightKg ?? 0} />
        </label>
      </div>
      <label>
        種目の説明
        <textarea name="description" rows={2} maxLength={500} defaultValue={initial?.description} />
      </label>
      {formError && <p className="form-error">{formError}</p>}
      <button className="btn primary" type="submit" disabled={disabled}>{submitLabel}</button>
    </form>
  );
}

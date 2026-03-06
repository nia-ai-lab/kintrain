import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppState } from '../AppState';
import type { TrainingEquipment, TrainingFrequencyDays, TrainingMenuItem } from '../types';
import { formatTrainingLabel } from '../utils/training';

const CREATE_NEW_SET_OPTION = '__create_new_set__';
const TRAINING_EQUIPMENT_OPTIONS: TrainingEquipment[] = ['マシン', 'フリー', '自重', 'その他'];
const TRAINING_FREQUENCY_OPTIONS: TrainingFrequencyDays[] = [1, 2, 3, 4, 5, 6, 7, 8];

function frequencyLabel(days: TrainingFrequencyDays): string {
  if (days === 1) {
    return '毎日';
  }
  if (days === 8) {
    return '8日+';
  }
  return `${days}日`;
}

export function TrainingMenuPage() {
  const {
    data,
    addMenuItem,
    updateMenuItem,
    deleteMenuItem,
    createMenuSet,
    renameMenuSet,
    deleteMenuSet,
    setDefaultMenuSet,
    setActiveMenuSet,
    assignMenuItemToSet,
    unassignMenuItemFromSet,
    moveMenuItemInSet,
    coreDataError,
    isCoreDataLoading
  } = useAppState();
  const [statusText, setStatusText] = useState('');
  const [setNameDraft, setSetNameDraft] = useState('');
  const [setDefaultChecked, setSetDefaultChecked] = useState(false);
  const [setAiGeneratedChecked, setSetAiGeneratedChecked] = useState(false);
  const [isCreateSetMode, setIsCreateSetMode] = useState(false);
  const [showDeleteSetConfirm, setShowDeleteSetConfirm] = useState(false);
  const [selectedExistingItemId, setSelectedExistingItemId] = useState('');

  const menuSets = useMemo(() => [...data.menuSets].sort((a, b) => a.order - b.order), [data.menuSets]);
  const activeSet = useMemo(() => {
    return menuSets.find((set) => set.id === data.activeTrainingMenuSetId) ?? menuSets.find((set) => set.isDefault) ?? menuSets[0];
  }, [data.activeTrainingMenuSetId, menuSets]);
  const editingSet = isCreateSetMode ? null : activeSet;
  const isFirstSetCreation = isCreateSetMode && menuSets.length === 0;

  useEffect(() => {
    if (menuSets.length > 0) {
      return;
    }
    if (!isCreateSetMode) {
      setIsCreateSetMode(true);
    }
    if (!setDefaultChecked) {
      setSetDefaultChecked(true);
    }
  }, [isCreateSetMode, menuSets.length, setDefaultChecked]);

  useEffect(() => {
    if (isCreateSetMode) {
      return;
    }
    setSetNameDraft(activeSet?.setName ?? '');
    setSetDefaultChecked(Boolean(activeSet?.isDefault));
    setSetAiGeneratedChecked(Boolean(activeSet?.isAiGenerated));
    setSelectedExistingItemId('');
    setShowDeleteSetConfirm(false);
  }, [activeSet?.id, activeSet?.setName, activeSet?.isDefault, activeSet?.isAiGenerated, isCreateSetMode]);

  const menuItemById = useMemo(() => {
    return new Map(data.menuItems.map((item) => [item.id, item]));
  }, [data.menuItems]);

  const selectedSetItems = useMemo(() => {
    if (!editingSet) {
      return [];
    }
    return editingSet.itemIds
      .map((itemId) => menuItemById.get(itemId))
      .filter((item): item is TrainingMenuItem => item !== undefined);
  }, [editingSet, menuItemById]);

  const selectedSetItemIds = useMemo(() => new Set(selectedSetItems.map((item) => item.id)), [selectedSetItems]);

  const addableExistingItems = useMemo(() => {
    return [...data.menuItems]
      .filter((item) => !selectedSetItemIds.has(item.id))
      .sort((a, b) => a.trainingName.localeCompare(b.trainingName));
  }, [data.menuItems, selectedSetItemIds]);

  function onAdd(formData: FormData, targetSetId: string): boolean {
    const trainingName = String(formData.get('trainingName') ?? '').trim();
    const bodyPart = String(formData.get('bodyPart') ?? '').trim();
    const equipment = String(formData.get('equipment') ?? '').trim() as TrainingEquipment;
    const isAiGenerated = formData.get('isAiGenerated') === 'on';
    const memo = String(formData.get('memo') ?? '').trim();
    const frequency = Number(formData.get('frequency') ?? 0) as TrainingFrequencyDays;
    if (!trainingName) {
      setStatusText('トレーニング名を入力してください。');
      return false;
    }
    addMenuItem(
      {
        trainingName,
        bodyPart,
        equipment: TRAINING_EQUIPMENT_OPTIONS.includes(equipment) ? equipment : 'マシン',
        isAiGenerated,
        memo,
        frequency: TRAINING_FREQUENCY_OPTIONS.includes(frequency) ? frequency : 3,
        defaultWeightKg: Number(formData.get('defaultWeightKg') ?? 0),
        defaultRepsMin: Number(formData.get('defaultRepsMin') ?? 0),
        defaultRepsMax: Number(formData.get('defaultRepsMax') ?? 0),
        defaultSets: Number(formData.get('defaultSets') ?? 0)
      },
      { targetSetId }
    );
    setStatusText('種目追加をリクエストしました。');
    return true;
  }

  const selectedSetOptionValue = isCreateSetMode ? CREATE_NEW_SET_OPTION : activeSet?.id ?? CREATE_NEW_SET_OPTION;

  return (
    <div className="stack-lg">
      <section className="card">
        <div className="row-between menu-page-head">
          <select
            className="menu-set-switch-select"
            value={selectedSetOptionValue}
            onChange={(e) => {
              const nextValue = e.target.value;
              if (nextValue === CREATE_NEW_SET_OPTION) {
                setIsCreateSetMode(true);
                setSetNameDraft('');
                setSetDefaultChecked(menuSets.length === 0);
                setSetAiGeneratedChecked(false);
                setSelectedExistingItemId('');
                return;
              }
              setIsCreateSetMode(false);
              setActiveMenuSet(nextValue);
            }}
          >
            <option value={CREATE_NEW_SET_OPTION}>メニューセット新規作成</option>
            {menuSets.map((set) => (
              <option key={set.id} value={set.id}>
                {set.isDefault ? `${set.setName}（デフォルト）` : set.setName}
              </option>
            ))}
          </select>
          <Link to="/training-menu/ai-generate" className="btn ghost menu-generate-button">
            AIでメニュー生成
          </Link>
        </div>
      </section>

      <section className="card stack-md">
        <h2>メニューセット</h2>
        <form
          className="menu-set-single-form"
          onSubmit={async (e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            const trimmed = setNameDraft.trim();
            if (!trimmed) {
              setStatusText('メニューセット名を入力してください。');
              return;
            }

            if (isCreateSetMode) {
              const createdSetId = await createMenuSet(trimmed, {
                isDefault: isFirstSetCreation || setDefaultChecked,
                isAiGenerated: setAiGeneratedChecked
              });
              if (!createdSetId) {
                setStatusText('メニューセット作成に失敗しました。');
                return;
              }
              setActiveMenuSet(createdSetId);
              setIsCreateSetMode(false);
              setStatusText(`メニューセット「${trimmed}」を作成しました。`);
              return;
            }

            if (!editingSet) {
              return;
            }

            try {
              await renameMenuSet(editingSet.id, trimmed, { isAiGenerated: setAiGeneratedChecked });
              if (setDefaultChecked) {
                await setDefaultMenuSet(editingSet.id);
              }
              setStatusText('メニューセットを更新しました。');
            } catch {
              setStatusText('メニューセット更新に失敗しました。');
            }
          }}
        >
          <div className="menu-set-name-edit-row">
            <div className="row-wrap menu-set-flags-row">
              <label className="menu-set-default-check">
                <input
                  type="checkbox"
                  checked={isFirstSetCreation ? true : setDefaultChecked}
                  onChange={(e) => {
                    if (isFirstSetCreation) {
                      return;
                    }
                    if (editingSet?.isDefault && !e.target.checked) {
                      return;
                    }
                    setSetDefaultChecked(e.target.checked);
                  }}
                />
                <span>デフォルト</span>
              </label>
              <label className="menu-set-default-check">
                <input
                  type="checkbox"
                  checked={setAiGeneratedChecked}
                  onChange={(e) => setSetAiGeneratedChecked(e.target.checked)}
                />
                <span>AI生成</span>
              </label>
            </div>
            <input
              value={setNameDraft}
              onChange={(e) => setSetNameDraft(e.target.value)}
              placeholder="メニューセット名"
              maxLength={40}
            />
          </div>
          <div className="menu-set-submit-row">
            <button type="submit" className="btn subtle">
              {isCreateSetMode ? '作成' : '更新'}
            </button>
            {!isCreateSetMode && editingSet && (
              <button type="button" className="btn danger" onClick={() => setShowDeleteSetConfirm(true)}>
                削除
              </button>
            )}
          </div>
        </form>

        {statusText && <p className="status-text">{statusText}</p>}
        {coreDataError && <p className="status-text">{coreDataError}</p>}
      </section>

      {showDeleteSetConfirm && editingSet && (
        <div className="overlay-modal" role="dialog" aria-modal="true" aria-labelledby="delete-menu-set-title">
          <div className="overlay-modal-card">
            <h3 id="delete-menu-set-title">メニューセットを削除しますか？</h3>
            <p>「{editingSet.setName}」を削除すると、このセットへの紐付けが解除されます。</p>
            <div className="overlay-modal-actions">
              <button type="button" className="btn subtle" onClick={() => setShowDeleteSetConfirm(false)}>
                キャンセル
              </button>
              <button
                type="button"
                className="btn danger"
                onClick={async () => {
                  try {
                    await deleteMenuSet(editingSet.id);
                    setStatusText(`メニューセット「${editingSet.setName}」を削除しました。`);
                    setShowDeleteSetConfirm(false);
                    setIsCreateSetMode(false);
                  } catch {
                    setStatusText('メニューセット削除に失敗しました。');
                    setShowDeleteSetConfirm(false);
                  }
                }}
              >
                削除する
              </button>
            </div>
          </div>
        </div>
      )}

      {editingSet && (
        <section className="card stack-md">
          <h2>「{editingSet.setName}」へ種目追加</h2>
          <form
            className="menu-add-form"
            onSubmit={(e: FormEvent<HTMLFormElement>) => {
              e.preventDefault();
              const form = e.currentTarget;
              if (onAdd(new FormData(form), editingSet.id)) {
                form.reset();
              }
            }}
          >
            <div className="menu-training-name-row">
              <label className="menu-training-name-field">
                トレーニング名
                <input name="trainingName" required />
              </label>
              <label className="menu-ai-generated-check">
                <input name="isAiGenerated" type="checkbox" />
                <span>AI生成</span>
              </label>
            </div>
            <div className="menu-three-fields-row">
              <label>
                鍛える部位
                <input name="bodyPart" placeholder="例: 胸 / 背中 / 脚" />
              </label>
              <label>
                用具
                <select name="equipment" defaultValue="マシン" required>
                  {TRAINING_EQUIPMENT_OPTIONS.map((equipment) => (
                    <option key={equipment} value={equipment}>
                      {equipment}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                頻度
                <select name="frequency" defaultValue="3" required>
                  {TRAINING_FREQUENCY_OPTIONS.map((frequency) => (
                    <option key={frequency} value={String(frequency)}>
                      {frequencyLabel(frequency)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="menu-metrics-row">
              <label>
                重量 (kg)
                <input name="defaultWeightKg" type="number" step="0.01" min="0" required />
              </label>
              <label>
                回数 最小
                <input name="defaultRepsMin" type="number" step="1" min="1" required />
              </label>
              <label>
                回数 最大
                <input name="defaultRepsMax" type="number" step="1" min="1" required />
              </label>
              <label>
                セット
                <input name="defaultSets" type="number" step="1" min="1" required />
              </label>
            </div>
            <label className="menu-training-note-field">
              メモ
              <textarea name="memo" rows={1} maxLength={500} placeholder="任意でメモを入力" />
            </label>
            <button className="btn primary menu-add-button" type="submit" disabled={isCoreDataLoading}>
              {isCoreDataLoading ? '同期中...' : 'このセットへ追加'}
            </button>
          </form>

          <div className="menu-existing-attach">
            <label>
              既存種目を追加
              <select value={selectedExistingItemId} onChange={(e) => setSelectedExistingItemId(e.target.value)}>
                <option value="">種目を選択</option>
                {addableExistingItems.map((item) => (
                  <option key={item.id} value={item.id}>
                    {formatTrainingLabel(item.trainingName, item.bodyPart, item.equipment, item.isAiGenerated)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn subtle"
              disabled={!selectedExistingItemId}
              onClick={async () => {
                try {
                  await assignMenuItemToSet(editingSet.id, selectedExistingItemId);
                  setSelectedExistingItemId('');
                  setStatusText('既存種目をセットへ追加しました。');
                } catch {
                  setStatusText('既存種目の追加に失敗しました。');
                }
              }}
            >
              セットに追加
            </button>
          </div>
        </section>
      )}

      {!editingSet && (
        <section className="card">
          <p className="muted">メニューセットを作成すると、種目を追加できます。</p>
        </section>
      )}

      <section className="stack-md">
        {editingSet && selectedSetItems.length === 0 && <p className="muted">このメニューセットには種目がありません。</p>}
        {editingSet &&
          selectedSetItems.map((item, index) => (
            <MenuItemCard
              key={item.id}
              order={index + 1}
              item={item}
              onUpdate={(patch) => updateMenuItem(item.id, patch)}
              onDelete={() => deleteMenuItem(item.id)}
              onRemoveFromSet={async () => {
                try {
                  await unassignMenuItemFromSet(editingSet.id, item.id);
                  setStatusText(`「${item.trainingName}」をセットから外しました。`);
                } catch {
                  setStatusText(`「${item.trainingName}」をセットから外せませんでした。`);
                }
              }}
              onMoveUp={() => void moveMenuItemInSet(editingSet.id, item.id, -1).catch(() => undefined)}
              onMoveDown={() => void moveMenuItemInSet(editingSet.id, item.id, 1).catch(() => undefined)}
            />
          ))}
      </section>
    </div>
  );
}

function MenuItemCard({
  order,
  item,
  onUpdate,
  onDelete,
  onRemoveFromSet,
  onMoveUp,
  onMoveDown
}: {
  order: number;
  item: TrainingMenuItem;
  onUpdate: (patch: Partial<TrainingMenuItem>) => void;
  onDelete: () => void;
  onRemoveFromSet: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  return (
    <article className="card">
      <div className="menu-item-header-under">
        <p className="priority-chip">#{order}</p>
        <div className="menu-item-actions-under">
          <button type="button" className="btn subtle menu-item-icon-button" onClick={onMoveUp} aria-label="上へ移動">
            ↑
          </button>
          <button type="button" className="btn subtle menu-item-icon-button" onClick={onMoveDown} aria-label="下へ移動">
            ↓
          </button>
          <button type="button" className="btn subtle" onClick={onRemoveFromSet}>
            セットから外す
          </button>
          <button type="button" className="btn danger menu-item-delete-button" onClick={onDelete}>
            種目削除
          </button>
        </div>
      </div>

      <div className="menu-item-editor">
        <div className="menu-training-name-row">
          <label className="menu-training-name-field">
            トレーニング名
            <input value={item.trainingName} onChange={(e) => onUpdate({ trainingName: e.target.value })} />
          </label>
          <label className="menu-ai-generated-check">
            <input
              type="checkbox"
              checked={item.isAiGenerated}
              onChange={(e) => onUpdate({ isAiGenerated: e.target.checked })}
            />
            <span>AI生成</span>
          </label>
        </div>
        <div className="menu-three-fields-row">
          <label>
            鍛える部位
            <input
              value={item.bodyPart}
              onChange={(e) => onUpdate({ bodyPart: e.target.value })}
              placeholder="例: 胸 / 背中 / 脚"
            />
          </label>
          <label>
            用具
            <select
              value={item.equipment}
              onChange={(e) =>
                onUpdate({
                  equipment: e.target.value as TrainingEquipment
                })
              }
            >
              {TRAINING_EQUIPMENT_OPTIONS.map((equipment) => (
                <option key={equipment} value={equipment}>
                  {equipment}
                </option>
              ))}
            </select>
          </label>
          <label>
            頻度
            <select
              value={item.frequency}
              onChange={(e) =>
                onUpdate({
                  frequency: Number(e.target.value) as TrainingFrequencyDays
                })
              }
            >
              {TRAINING_FREQUENCY_OPTIONS.map((frequency) => (
                <option key={frequency} value={String(frequency)}>
                  {frequencyLabel(frequency)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="menu-metrics-row">
          <label>
            重量 (kg)
            <input
              type="number"
              min={0}
              step={0.01}
              value={item.defaultWeightKg}
              onChange={(e) => onUpdate({ defaultWeightKg: Number(e.target.value) })}
            />
          </label>
          <label>
            回数 最小
            <input
              type="number"
              min={1}
              step={1}
              value={item.defaultRepsMin}
              onChange={(e) => onUpdate({ defaultRepsMin: Number(e.target.value) })}
            />
          </label>
          <label>
            回数 最大
            <input
              type="number"
              min={1}
              step={1}
              value={item.defaultRepsMax}
              onChange={(e) => onUpdate({ defaultRepsMax: Number(e.target.value) })}
            />
          </label>
          <label>
            セット
            <input
              type="number"
              min={1}
              step={1}
              value={item.defaultSets}
              onChange={(e) => onUpdate({ defaultSets: Number(e.target.value) })}
            />
          </label>
        </div>
        <label className="menu-training-note-field">
          メモ
          <textarea
            rows={1}
            maxLength={500}
            value={item.memo}
            onChange={(e) => onUpdate({ memo: e.target.value })}
            placeholder="任意でメモを入力"
          />
        </label>
      </div>
    </article>
  );
}

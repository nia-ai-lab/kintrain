import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppState } from '../AppState';
import type { TrainingMenuItem } from '../types';

export function TrainingMenuPage() {
  const { data, addMenuItem, updateMenuItem, deleteMenuItem, moveMenuItem, coreDataError, isCoreDataLoading } = useAppState();
  const [statusText, setStatusText] = useState('');
  const sorted = [...data.menuItems].sort((a, b) => a.order - b.order);

  function onAdd(formData: FormData): boolean {
    const trainingName = String(formData.get('trainingName') ?? '').trim();
    const bodyPart = String(formData.get('bodyPart') ?? '').trim();
    if (!trainingName) {
      setStatusText('トレーニング名を入力してください。');
      return false;
    }
    addMenuItem({
      trainingName,
      bodyPart,
      defaultWeightKg: Number(formData.get('defaultWeightKg') ?? 0),
      defaultRepsMin: Number(formData.get('defaultRepsMin') ?? 0),
      defaultRepsMax: Number(formData.get('defaultRepsMax') ?? 0),
      defaultSets: Number(formData.get('defaultSets') ?? 0)
    });
    setStatusText('追加をリクエストしました。');
    return true;
  }

  return (
    <div className="stack-lg">
      <section className="card">
        <div className="row-between menu-page-head">
          <h1 className="menu-page-title">トレーニングメニュー</h1>
          <Link to="/training-menu/ai-generate" className="btn ghost menu-generate-button">
            AIでメニュー生成
          </Link>
        </div>
      </section>

      <section className="card">
        <h2>新規追加</h2>
        <form
          className="menu-add-form"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            const form = e.currentTarget;
            if (onAdd(new FormData(form))) {
              form.reset();
            }
          }}
        >
          <label className="menu-training-name-field">
            トレーニング名
            <input name="trainingName" required />
          </label>
          <label className="menu-training-name-field">
            鍛える部位
            <input name="bodyPart" placeholder="例: 胸 / 背中 / 脚" />
          </label>
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
          <button className="btn primary menu-add-button" type="submit" disabled={isCoreDataLoading}>
            {isCoreDataLoading ? '同期中...' : '追加'}
          </button>
          {statusText && <p className="status-text">{statusText}</p>}
          {coreDataError && <p className="status-text">{coreDataError}</p>}
        </form>
      </section>

      <section className="stack-md">
        {sorted.map((item) => (
          <MenuItemCard
            key={item.id}
            item={item}
            onUpdate={(patch) => updateMenuItem(item.id, patch)}
            onDelete={() => deleteMenuItem(item.id)}
            onMoveUp={() => moveMenuItem(item.id, -1)}
            onMoveDown={() => moveMenuItem(item.id, 1)}
          />
        ))}
      </section>
    </div>
  );
}

function MenuItemCard({
  item,
  onUpdate,
  onDelete,
  onMoveUp,
  onMoveDown
}: {
  item: TrainingMenuItem;
  onUpdate: (patch: Partial<TrainingMenuItem>) => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  return (
    <article className="card">
      <div className="row-between align-start gap-sm">
        <p className="priority-chip">順序 {item.order}</p>
        <div className="row-wrap">
          <button type="button" className="btn subtle" onClick={onMoveUp}>
            ↑
          </button>
          <button type="button" className="btn subtle" onClick={onMoveDown}>
            ↓
          </button>
          <button type="button" className="btn danger" onClick={onDelete}>
            削除
          </button>
        </div>
      </div>

      <div className="menu-item-editor">
        <label className="menu-training-name-field">
          トレーニング名
          <input value={item.trainingName} onChange={(e) => onUpdate({ trainingName: e.target.value })} />
        </label>
        <label className="menu-training-name-field">
          鍛える部位
          <input
            value={item.bodyPart}
            onChange={(e) => onUpdate({ bodyPart: e.target.value })}
            placeholder="例: 胸 / 背中 / 脚"
          />
        </label>
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
      </div>
    </article>
  );
}

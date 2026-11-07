import { useEffect, useState } from 'react';
import { getGymVisit, updateGymVisit, type GymVisitDto } from '../api/coreApi';
import {
  buildGymVisitUpdate,
  getWeightFieldKind,
  toEntryEdit,
  type GymVisitEntryEdit,
  type WeightFieldKind
} from '../utils/gymVisitEdit';
import { formatTrainingLabel } from '../utils/training';

const weightLabels: Record<Exclude<WeightFieldKind, 'none'>, string> = {
  total: '重量',
  perSide: '片側',
  assistance: 'アシスト',
  additional: '追加重量'
};

type Props = {
  visitId: string;
  onSaved: () => Promise<void> | void;
  onCancel: () => void;
};

/** Corrects the weight, reps and sets of an already recorded workout. */
export function GymVisitEditor({ visitId, onSaved, onCancel }: Props) {
  const [visit, setVisit] = useState<GymVisitDto | null>(null);
  const [edits, setEdits] = useState<GymVisitEntryEdit[]>([]);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    let active = true;
    setVisit(null);
    setLoadError('');
    getGymVisit(visitId)
      .then((loaded) => {
        if (!active) return;
        setVisit(loaded);
        setEdits(loaded.entries.map(toEntryEdit));
      })
      .catch((error) => {
        if (active) setLoadError(error instanceof Error ? error.message : '記録を読み込めませんでした。');
      });
    return () => {
      active = false;
    };
  }, [visitId]);

  const updateEdit = (index: number, patch: Partial<GymVisitEntryEdit>) => {
    setSaveError('');
    setEdits((current) => current.map((edit, i) => (i === index ? { ...edit, ...patch } : edit)));
  };

  const save = async () => {
    if (!visit) return;
    const result = buildGymVisitUpdate(visit, edits);
    if (!result.ok) {
      setSaveError(result.message);
      return;
    }
    setIsSaving(true);
    setSaveError('');
    try {
      await updateGymVisit(visit.visitId, result.input);
      await onSaved();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '記録を修正できませんでした。');
    } finally {
      setIsSaving(false);
    }
  };

  if (loadError) {
    return (
      <div className="visit-editor">
        <p className="form-error">{loadError}</p>
        <div className="visit-editor-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>
            閉じる
          </button>
        </div>
      </div>
    );
  }

  if (!visit) {
    return <p className="muted">記録を読み込み中...</p>;
  }

  return (
    <form
      className="visit-editor"
      aria-label="筋トレ記録の修正"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <ol className="visit-editor-list">
        {visit.entries.map((entry, index) => {
          const edit = edits[index];
          if (!edit) return null;
          const name = formatTrainingLabel(entry.trainingNameSnapshot, entry.muscleTargetsSnapshot, entry.equipmentTypeSnapshot);
          const weightKind = getWeightFieldKind(entry);
          return (
            <li key={`${entry.trainingMenuItemId}-${index}`} className={edit.removed ? 'is-removed' : undefined}>
              <div className="visit-editor-entry-head">
                <strong>{name}</strong>
                <button
                  type="button"
                  className="text-link"
                  aria-label={`${entry.trainingNameSnapshot}を${edit.removed ? '記録に戻す' : '記録から外す'}`}
                  onClick={() => updateEdit(index, { removed: !edit.removed })}
                >
                  {edit.removed ? '戻す' : '外す'}
                </button>
              </div>
              {edit.removed ? (
                <p className="muted">保存するとこの種目は記録から外れます。</p>
              ) : (
                <div className="visit-editor-fields">
                  {weightKind !== 'none' && (
                    <label>
                      <span>
                        {weightLabels[weightKind]}
                        <span className="body-metric-unit"> (kg)</span>
                      </span>
                      <input
                        type="number"
                        min={0}
                        step={0.25}
                        inputMode="decimal"
                        aria-label={`${entry.trainingNameSnapshot}の${weightLabels[weightKind]}`}
                        value={edit.weightKg}
                        onChange={(event) => updateEdit(index, { weightKg: event.target.value })}
                      />
                    </label>
                  )}
                  <label>
                    <span>回数</span>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      inputMode="numeric"
                      aria-label={`${entry.trainingNameSnapshot}の回数`}
                      value={edit.reps}
                      onChange={(event) => updateEdit(index, { reps: event.target.value })}
                    />
                  </label>
                  <label>
                    <span>セット</span>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      inputMode="numeric"
                      aria-label={`${entry.trainingNameSnapshot}のセット数`}
                      value={edit.sets}
                      onChange={(event) => updateEdit(index, { sets: event.target.value })}
                    />
                  </label>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {saveError && (
        <p className="form-error" role="alert">
          {saveError}
        </p>
      )}
      <div className="visit-editor-actions">
        <button type="button" className="btn ghost" onClick={onCancel} disabled={isSaving}>
          キャンセル
        </button>
        <button type="submit" className="btn primary" disabled={isSaving}>
          {isSaving ? '保存中...' : '修正を保存'}
        </button>
      </div>
    </form>
  );
}

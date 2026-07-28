import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  appendCoachingNote,
  type CoachingContextDto,
  type CoachingContextResponse,
  type CoachingNoteCategoryDto,
  type CoachingRevisionDto,
  deleteCoachingNote,
  getCoachingContext,
  putCoachingContext
} from '../api/coreApi';

const categoryLabels: Record<CoachingNoteCategoryDto, string> = {
  observation: '観察',
  decision: '判断',
  'follow-up': '次回確認',
  'temporary-constraint': '一時的な制約'
};

const sourceLabels: Record<string, string> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  kintrain: 'KinTrain AI',
  user: '本人',
  other: 'その他'
};

function linesToList(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    )
  );
}

function formatDateTime(value?: string): string {
  if (!value) {
    return '未更新';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ja-JP');
}

function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function CoachingContextPage() {
  const [data, setData] = useState<CoachingContextResponse | null>(null);
  const [goalSummary, setGoalSummary] = useState('');
  const [constraints, setConstraints] = useState('');
  const [preferences, setPreferences] = useState('');
  const [trainingPolicy, setTrainingPolicy] = useState('');
  const [nextReviewDate, setNextReviewDate] = useState('');
  const [changeReason, setChangeReason] = useState('');
  const [noteCategory, setNoteCategory] = useState<CoachingNoteCategoryDto>('observation');
  const [noteContent, setNoteContent] = useState('');
  const [noteValidFrom, setNoteValidFrom] = useState('');
  const [noteValidTo, setNoteValidTo] = useState('');
  const [status, setStatus] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const applyContextToForm = useCallback((context: CoachingContextDto) => {
    setGoalSummary(context.goalSummary);
    setConstraints(context.constraints.join('\n'));
    setPreferences(context.preferences.join('\n'));
    setTrainingPolicy(context.trainingPolicy);
    setNextReviewDate(context.nextReviewDate ?? '');
  }, []);

  const reload = useCallback(async () => {
    setIsLoading(true);
    try {
      const loaded = await getCoachingContext();
      setData(loaded);
      applyContextToForm(loaded.context);
      setStatus('');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'コーチング方針の取得に失敗しました。');
    } finally {
      setIsLoading(false);
    }
  }, [applyContextToForm]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const activeNoteCount = data?.notes.length ?? 0;
  const canSaveContext = Boolean(data && changeReason.trim() && !isSaving);
  const canAddNote = Boolean(noteContent.trim() && !isSaving);
  const noteCapacityLabel = useMemo(() => {
    if (!data) {
      return '';
    }
    return `${activeNoteCount} / ${data.limits.activeNotes}件`;
  }, [activeNoteCount, data]);

  const saveContext = async (
    source: CoachingContextDto = {
      goalSummary,
      constraints: linesToList(constraints),
      preferences: linesToList(preferences),
      trainingPolicy,
      ...(nextReviewDate ? { nextReviewDate } : {}),
      version: data?.context.version ?? 0
    },
    reason = changeReason
  ) => {
    if (!data || !reason.trim()) {
      setStatus('変更理由を入力してください。');
      return;
    }
    setIsSaving(true);
    setStatus('');
    try {
      await putCoachingContext({
        goalSummary: source.goalSummary.trim(),
        constraints: source.constraints,
        preferences: source.preferences,
        trainingPolicy: source.trainingPolicy.trim(),
        ...(source.nextReviewDate ? { nextReviewDate: source.nextReviewDate } : {}),
        expectedVersion: data.context.version,
        changeReason: reason.trim()
      });
      await reload();
      setChangeReason('');
      setStatus('コーチング方針を保存しました。次のAI相談から共有されます。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'コーチング方針の保存に失敗しました。');
    } finally {
      setIsSaving(false);
    }
  };

  const restoreRevision = async (revision: CoachingRevisionDto) => {
    await saveContext(revision, `版${revision.version}の方針を復元`);
  };

  return (
    <div className="stack-lg coaching-context-page">
      <section className="card coaching-context-hero">
        <p className="eyebrow">SHARED COACHING CONTEXT</p>
        <h1>コーチング方針</h1>
        <p className="muted">
          ChatGPT、Claude、KinTrain AIが共通で参照する引き継ぎ情報です。AIによる更新も、あなたが承認した場合だけ保存されます。
        </p>
        {data && (
          <div className="coaching-context-meta">
            <span>現在の版: {data.context.version}</span>
            <span>最終更新: {formatDateTime(data.context.updatedAt)}</span>
            <span>更新元: {sourceLabels[data.context.updatedBySource ?? ''] ?? '未設定'}</span>
          </div>
        )}
      </section>

      <section className="card">
        <h2>現在の目標と指導方針</h2>
        <p className="muted">恒久的に共有したい内容を記録します。制約と好みは1行に1件入力してください。</p>
        <div className="coaching-context-form">
          <label>
            目標
            <textarea
              rows={3}
              maxLength={1000}
              value={goalSummary}
              disabled={isLoading || isSaving}
              onChange={(event) => setGoalSummary(event.currentTarget.value)}
              placeholder="例: 筋力を維持しながら体脂肪率を下げる"
            />
          </label>
          <div className="coaching-context-columns">
            <label>
              制約
              <textarea
                rows={5}
                value={constraints}
                disabled={isLoading || isSaving}
                onChange={(event) => setConstraints(event.currentTarget.value)}
                placeholder={'例: 腰に違和感がある日は高負荷スクワットを避ける\n平日は60分以内'}
              />
            </label>
            <label>
              好み
              <textarea
                rows={5}
                value={preferences}
                disabled={isLoading || isSaving}
                onChange={(event) => setPreferences(event.currentTarget.value)}
                placeholder={'例: フリーウェイトを優先\n助言は短く具体的に'}
              />
            </label>
          </div>
          <label>
            現在のトレーニング方針
            <textarea
              rows={6}
              maxLength={2000}
              value={trainingPolicy}
              disabled={isLoading || isSaving}
              onChange={(event) => setTrainingPolicy(event.currentTarget.value)}
              placeholder="例: 4週間はフォームを崩さず完遂できる重量を優先し、上限回数を全セット達成したら増量する"
            />
          </label>
          <div className="coaching-context-columns">
            <label>
              次回見直し日
              <input
                type="date"
                value={nextReviewDate}
                disabled={isLoading || isSaving}
                onChange={(event) => setNextReviewDate(event.currentTarget.value)}
              />
            </label>
            <label>
              変更理由（必須）
              <input
                value={changeReason}
                maxLength={500}
                disabled={isLoading || isSaving}
                onChange={(event) => setChangeReason(event.currentTarget.value)}
                placeholder="例: 直近4週間の振り返りを反映"
              />
            </label>
          </div>
        </div>
        <div className="row-wrap">
          <button type="button" className="btn primary" disabled={!canSaveContext} onClick={() => void saveContext()}>
            {isSaving ? '保存中...' : 'この内容で更新'}
          </button>
        </div>
      </section>

      <section className="card">
        <div className="coaching-section-heading">
          <div>
            <h2>短期の引き継ぎメモ</h2>
            <p className="muted">
              一時的な観察や次回確認事項です。保存から{data?.limits.noteRetentionDays ?? 90}日後に自動削除されます。
            </p>
          </div>
          <span className="coaching-count-badge">{noteCapacityLabel}</span>
        </div>

        <div className="coaching-note-form">
          <label>
            分類
            <select
              value={noteCategory}
              disabled={isLoading || isSaving}
              onChange={(event) => setNoteCategory(event.currentTarget.value as CoachingNoteCategoryDto)}
            >
              {Object.entries(categoryLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="coaching-note-content">
            内容
            <textarea
              rows={3}
              maxLength={1000}
              value={noteContent}
              disabled={isLoading || isSaving}
              onChange={(event) => setNoteContent(event.currentTarget.value)}
              placeholder="例: 次回はベンチプレス60kgで肩の違和感が出ないか確認する"
            />
          </label>
          <label>
            有効開始日
            <input
              type="date"
              value={noteValidFrom}
              max={noteValidTo || undefined}
              disabled={isLoading || isSaving}
              onChange={(event) => setNoteValidFrom(event.currentTarget.value)}
            />
          </label>
          <label>
            有効終了日
            <input
              type="date"
              value={noteValidTo}
              min={noteValidFrom || undefined}
              disabled={isLoading || isSaving}
              onChange={(event) => setNoteValidTo(event.currentTarget.value)}
            />
          </label>
        </div>
        <div className="row-wrap">
          <button
            type="button"
            className="btn primary"
            disabled={!canAddNote}
            onClick={async () => {
              if (noteValidFrom && noteValidTo && noteValidFrom > noteValidTo) {
                setStatus('メモの終了日は開始日以降にしてください。');
                return;
              }
              setIsSaving(true);
              setStatus('');
              try {
                await appendCoachingNote({
                  idempotencyKey: newIdempotencyKey(),
                  category: noteCategory,
                  content: noteContent.trim(),
                  ...(noteValidFrom ? { validFromDate: noteValidFrom } : {}),
                  ...(noteValidTo ? { validToDate: noteValidTo } : {})
                });
                setNoteContent('');
                setNoteValidFrom('');
                setNoteValidTo('');
                await reload();
                setStatus('引き継ぎメモを追加しました。');
              } catch (error) {
                setStatus(error instanceof Error ? error.message : '引き継ぎメモの追加に失敗しました。');
              } finally {
                setIsSaving(false);
              }
            }}
          >
            メモを追加
          </button>
        </div>

        <div className="coaching-note-list">
          {data?.notes.map((note) => (
            <article className="coaching-note-item" key={note.noteId}>
              <div className="coaching-note-item-heading">
                <span className="coaching-note-category">{categoryLabels[note.category]}</span>
                <span className="muted">{sourceLabels[note.source] ?? note.source}</span>
              </div>
              <p>{note.content}</p>
              <div className="coaching-note-dates">
                <span>
                  有効期間: {note.validFromDate ?? '登録時'} ～ {note.validToDate ?? '指定なし'}
                </span>
                <span>自動削除: {note.expiresAt.slice(0, 10)}</span>
              </div>
              <button
                type="button"
                className="btn danger"
                disabled={isSaving}
                onClick={async () => {
                  setIsSaving(true);
                  setStatus('');
                  try {
                    await deleteCoachingNote(note.noteId);
                    await reload();
                    setStatus('引き継ぎメモを削除しました。');
                  } catch (error) {
                    setStatus(error instanceof Error ? error.message : '引き継ぎメモの削除に失敗しました。');
                  } finally {
                    setIsSaving(false);
                  }
                }}
              >
                削除
              </button>
            </article>
          ))}
          {!isLoading && data?.notes.length === 0 && <p className="muted">有効な引き継ぎメモはありません。</p>}
        </div>
      </section>

      <section className="card">
        <h2>変更履歴</h2>
        <p className="muted">
          最大{data?.limits.revisions ?? 50}版・{data?.limits.revisionRetentionDays ?? 365}日間保存します。復元しても過去の版は消えず、新しい版として保存されます。
        </p>
        <div className="coaching-revision-list">
          {data?.revisions.map((revision) => (
            <details key={revision.revisionId} className="coaching-revision-item">
              <summary>
                版{revision.version}・{formatDateTime(revision.createdAt)}・
                {sourceLabels[revision.source] ?? revision.source}
              </summary>
              <p>{revision.changeReason}</p>
              <dl>
                <dt>目標</dt>
                <dd>{revision.goalSummary || '未設定'}</dd>
                <dt>方針</dt>
                <dd>{revision.trainingPolicy || '未設定'}</dd>
              </dl>
              {revision.version !== data.context.version && (
                <button
                  type="button"
                  className="btn subtle"
                  disabled={isSaving}
                  onClick={() => void restoreRevision(revision)}
                >
                  この版を復元
                </button>
              )}
            </details>
          ))}
          {!isLoading && data?.revisions.length === 0 && <p className="muted">変更履歴はまだありません。</p>}
        </div>
      </section>

      {status && (
        <p className="status-text coaching-context-status" role="status">
          {status}
        </p>
      )}
    </div>
  );
}

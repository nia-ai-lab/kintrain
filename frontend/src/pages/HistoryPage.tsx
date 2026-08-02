import { useEffect, useMemo, useState } from 'react';
import { listGymVisits, listRecoveryExecutions } from '../api/coreApi';
import type { GymVisitDto, RecoveryExecutionDto } from '../api/coreApi';
import { ymdToDisplay } from '../utils/date';

type HistoryFilter = 'all' | 'training' | 'recovery';
type HistoryEntry =
  | { kind: 'training'; id: string; date: string; createdAt: string; value: GymVisitDto }
  | { kind: 'recovery'; id: string; date: string; createdAt: string; value: RecoveryExecutionDto };

export function HistoryPage() {
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [items, setItems] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    void Promise.all([listGymVisits({ limit: 200 }), listRecoveryExecutions()])
      .then(([training, recovery]) => {
        if (!active) return;
        setItems([
          ...training.items.map((value) => ({
            kind: 'training' as const,
            id: value.visitId,
            date: value.visitDateLocal,
            createdAt: value.createdAt,
            value
          })),
          ...recovery.map((value) => ({
            kind: 'recovery' as const,
            id: value.executionId,
            date: value.executionDateLocal,
            createdAt: value.createdAt,
            value
          }))
        ].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)));
      })
      .catch((loadError) => {
        if (active) setError(loadError instanceof Error ? loadError.message : '実施履歴の取得に失敗しました。');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  const visibleItems = useMemo(
    () => filter === 'all' ? items : items.filter((item) => item.kind === filter),
    [filter, items]
  );

  return (
    <div className="stack-lg">
      <section className="card card-highlight">
        <h1>実施履歴</h1>
        <p className="muted">トレーニングとリカバリーの記録を同じ一覧で確認できます。</p>
        <div className="row-wrap" role="group" aria-label="履歴の種類">
          {([
            ['all', 'すべて'],
            ['training', 'トレーニング'],
            ['recovery', 'リカバリー']
          ] as const).map(([value, label]) => (
            <button
              type="button"
              className={filter === value ? 'btn primary' : 'btn subtle'}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              key={value}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      {loading && <section className="card"><p className="muted">履歴を読み込み中です。</p></section>}
      {!loading && error && <section className="card"><p className="status-text">{error}</p></section>}
      {!loading && !error && visibleItems.map((item) => (
        <article className="card stack-md" key={`${item.kind}-${item.id}`}>
          <div className="row-wrap">
            <strong>{ymdToDisplay(item.date)}</strong>
            <span className="priority-chip">{item.kind === 'recovery' ? 'リカバリー' : 'トレーニング'}</span>
          </div>
          {item.kind === 'training' ? (
            <>
              <h2>{item.value.entries[0]?.sourceTrainingMenuSetNameSnapshot ?? 'トレーニング'}</h2>
              <ul className="simple-list">
                {item.value.entries.map((entry, index) => (
                  <li key={`${entry.trainingMenuItemId}-${index}`}>
                    {entry.trainingNameSnapshot}・{entry.weightKg}kg × {entry.reps}回 × {entry.sets}セット
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <h2>{item.value.sourceMenuSetNameSnapshot}</h2>
              <ul className="simple-list">
                {item.value.entries.map((entry, index) => (
                  <li key={`${entry.menuItemId}-${index}`}>
                    {entry.activityNameSnapshot}{entry.actualDurationMinutes ? `・${entry.actualDurationMinutes}分` : ''}
                  </li>
                ))}
              </ul>
            </>
          )}
        </article>
      ))}
      {!loading && !error && visibleItems.length === 0 && (
        <section className="card"><p className="muted">該当する実施履歴はありません。</p></section>
      )}
    </div>
  );
}

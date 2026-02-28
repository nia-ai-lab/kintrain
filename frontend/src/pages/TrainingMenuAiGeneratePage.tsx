import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppState } from '../AppState';

interface Candidate {
  trainingName: string;
  defaultWeightKg: number;
  defaultReps: number;
  defaultSets: number;
}

export function TrainingMenuAiGeneratePage() {
  const { data, replaceMenuItems } = useAppState();
  const navigate = useNavigate();
  const [machinePolicy, setMachinePolicy] = useState<'machine-only' | 'machine-and-free'>('machine-only');
  const [goal, setGoal] = useState<'muscle' | 'diet' | 'maintain'>('muscle');
  const [timesPerWeek, setTimesPerWeek] = useState(4);

  const candidates = useMemo<Candidate[]>(() => {
    const base = [
      { trainingName: 'チェストプレス', defaultWeightKg: 25, defaultReps: 12, defaultSets: 3 },
      { trainingName: 'ラットプルダウン', defaultWeightKg: 30, defaultReps: 10, defaultSets: 3 },
      { trainingName: 'レッグプレス', defaultWeightKg: 80, defaultReps: 12, defaultSets: 3 },
      { trainingName: 'ショルダープレス', defaultWeightKg: 15, defaultReps: 10, defaultSets: 3 },
      { trainingName: 'シーテッドロー', defaultWeightKg: 27.5, defaultReps: 12, defaultSets: 3 }
    ];
    if (machinePolicy === 'machine-and-free') {
      base.push({ trainingName: 'ダンベルベンチプレス', defaultWeightKg: 16, defaultReps: 10, defaultSets: 3 });
      base.push({ trainingName: 'ルーマニアンデッドリフト', defaultWeightKg: 40, defaultReps: 8, defaultSets: 3 });
    }
    if (goal === 'diet') {
      return base.map((item) => ({ ...item, defaultReps: Math.max(12, item.defaultReps), defaultSets: 3 }));
    }
    if (goal === 'muscle') {
      return base.map((item) => ({ ...item, defaultReps: Math.min(10, item.defaultReps), defaultSets: 4 }));
    }
    return base;
  }, [machinePolicy, goal]);

  return (
    <div className="stack-lg">
      <section className="card">
        <h1>AIメニュー生成（モック）</h1>
        <p className="muted">本番では AgentCore Runtime から提案生成。現在は要件検討用のモックロジックです。</p>

        <div className="input-grid">
          <label>
            方針
            <select value={machinePolicy} onChange={(e) => setMachinePolicy(e.target.value as typeof machinePolicy)}>
              <option value="machine-only">マシンのみ</option>
              <option value="machine-and-free">マシン + フリーウェイト</option>
            </select>
          </label>
          <label>
            目標
            <select value={goal} onChange={(e) => setGoal(e.target.value as typeof goal)}>
              <option value="muscle">筋肥大</option>
              <option value="diet">減量</option>
              <option value="maintain">維持</option>
            </select>
          </label>
          <label>
            週間頻度
            <input type="number" min={1} max={7} value={timesPerWeek} onChange={(e) => setTimesPerWeek(Number(e.target.value))} />
          </label>
        </div>
      </section>

      <section className="card">
          <h2>提案プレビュー</h2>
        <ul className="simple-list">
          {candidates.map((item) => (
            <li key={item.trainingName}>
              {item.trainingName} {item.defaultWeightKg}kg x {item.defaultReps}回 x {item.defaultSets}set
            </li>
          ))}
        </ul>

        <div className="row-wrap">
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              replaceMenuItems(
                candidates.map((item, index) => ({
                  id: `ai-${index + 1}`,
                  trainingName: item.trainingName,
                  defaultWeightKg: item.defaultWeightKg,
                  defaultReps: item.defaultReps,
                  defaultSets: item.defaultSets,
                  order: index + 1,
                  isActive: true
                }))
              );
              navigate('/training-menu');
            }}
          >
            この提案でメニュー更新
          </button>
          <button type="button" className="btn ghost" onClick={() => navigate('/training-menu')}>
            戻る
          </button>
        </div>

        <p className="muted">推定: 1回あたり {Math.max(40, timesPerWeek * 12)} 分</p>
      </section>

      <section className="card">
        <h2>現行メニュー</h2>
        <ul className="simple-list">
          {data.menuItems
            .sort((a, b) => a.order - b.order)
            .map((item) => (
              <li key={item.id}>
                {item.order}. {item.trainingName}
              </li>
            ))}
        </ul>
      </section>
    </div>
  );
}

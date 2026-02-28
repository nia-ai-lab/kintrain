import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppState } from '../AppState';
import { useAuth } from '../AuthState';
import type { TonePreset } from '../types';

const timeZoneCandidates = [
  'Asia/Tokyo',
  'UTC',
  'Asia/Seoul',
  'Asia/Singapore',
  'America/Los_Angeles',
  'America/New_York',
  'Europe/London'
];

export function SettingsPage() {
  const navigate = useNavigate();
  const { logout } = useAuth();
  const { data, updateUserProfile, saveUserProfile, updateAiCharacterProfile, coreDataError, isCoreDataLoading } = useAppState();
  const [userStatus, setUserStatus] = useState('');
  const [aiStatus, setAiStatus] = useState('');
  const [aiCharacterName, setAiCharacterName] = useState(data.aiCharacterProfile.characterName);
  const [aiTonePreset, setAiTonePreset] = useState<TonePreset>(data.aiCharacterProfile.tonePreset);

  const profile = data.userProfile;
  const ageHint = useMemo(() => {
    if (!profile.birthDate) {
      return '';
    }
    const birth = new Date(profile.birthDate);
    if (Number.isNaN(birth.getTime())) {
      return '';
    }
    const now = new Date();
    let age = now.getFullYear() - birth.getFullYear();
    const monthDiff = now.getMonth() - birth.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < birth.getDate())) {
      age -= 1;
    }
    return `${age}歳`;
  }, [profile.birthDate]);

  useEffect(() => {
    setAiCharacterName(data.aiCharacterProfile.characterName);
    setAiTonePreset(data.aiCharacterProfile.tonePreset);
  }, [data.aiCharacterProfile.characterName, data.aiCharacterProfile.tonePreset]);

  return (
    <div className="stack-lg">
      <section className="card">
        <h1>ユーザ設定</h1>
        <div className="input-grid settings-grid">
          <label>
            ユーザ名
            <input
              value={profile.userName}
              onChange={(e) => updateUserProfile({ userName: e.target.value })}
              placeholder="表示名"
            />
          </label>

          <label>
            性別
            <select value={profile.sex} onChange={(e) => updateUserProfile({ sex: e.target.value as typeof profile.sex })}>
              <option value="no-answer">未回答</option>
              <option value="male">男性</option>
              <option value="female">女性</option>
              <option value="other">その他</option>
            </select>
          </label>

          <label>
            生年月日
            <input type="date" value={profile.birthDate} onChange={(e) => updateUserProfile({ birthDate: e.target.value })} />
            {ageHint && <small className="muted">{ageHint}</small>}
          </label>

          <label>
            身長 (cm)
            <input
              type="number"
              min={0}
              step={0.1}
              value={profile.heightCm ?? ''}
              onChange={(e) =>
                updateUserProfile({
                  heightCm: e.target.value ? Number(e.target.value) : null
                })
              }
            />
          </label>

          <label>
            タイムゾーン
            <input
              list="time-zone-options"
              value={profile.timeZoneId}
              onChange={(e) => updateUserProfile({ timeZoneId: e.target.value.trim() || 'Asia/Tokyo' })}
              placeholder="例: Asia/Tokyo"
            />
            <datalist id="time-zone-options">
              {timeZoneCandidates.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
          </label>
        </div>

        <div className="row-wrap">
          <button
            type="button"
            className="btn primary"
            onClick={async () => {
              const result = await saveUserProfile();
              setUserStatus(result.ok ? 'ユーザ設定を保存しました。' : result.message ?? '保存に失敗しました。');
            }}
            disabled={isCoreDataLoading}
          >
            {isCoreDataLoading ? '保存中...' : '保存'}
          </button>
          {userStatus && <p className="status-text">{userStatus}</p>}
          {!userStatus && coreDataError && <p className="status-text">{coreDataError}</p>}
        </div>
      </section>

      <section className="card">
        <h2>AIコーチキャラクター設定</h2>
        <div className="input-grid settings-grid">
          <label>
            キャラクター名
            <input value={aiCharacterName} onChange={(e) => setAiCharacterName(e.target.value)} />
          </label>
          <label>
            口調プリセット
            <select value={aiTonePreset} onChange={(e) => setAiTonePreset(e.target.value as TonePreset)}>
              <option value="friendly-coach">フレンドリー</option>
              <option value="polite">丁寧</option>
              <option value="strict-coach">コーチ強め</option>
            </select>
          </label>
        </div>
        <div className="row-wrap">
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              updateAiCharacterProfile({
                characterName: aiCharacterName.trim() || data.aiCharacterProfile.characterName,
                tonePreset: aiTonePreset
              });
              setAiStatus('AIコーチキャラクター設定を反映しました。');
            }}
          >
            AI設定を反映
          </button>
          {aiStatus && <p className="status-text">{aiStatus}</p>}
        </div>
      </section>

      <section className="card">
        <h2>アカウント</h2>
        <div className="row-wrap">
          <button
            type="button"
            className="btn danger"
            onClick={async () => {
              await logout();
              navigate('/login', { replace: true });
            }}
          >
            ログアウト
          </button>
        </div>
      </section>
    </div>
  );
}

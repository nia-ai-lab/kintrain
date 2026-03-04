import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { uploadAvatarImage } from '../api/coreApi';
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

const maxAvatarImageBytes = 2 * 1024 * 1024;
const allowedAvatarMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);

function validateAvatarFile(file: File): string | null {
  if (!allowedAvatarMimeTypes.has(file.type)) {
    return '画像形式は PNG / JPEG / WEBP のみ対応です。';
  }
  if (file.size > maxAvatarImageBytes) {
    return '画像サイズは 2MB 以下にしてください。';
  }
  return null;
}

export function SettingsPage() {
  const navigate = useNavigate();
  const { logout } = useAuth();
  const { data, updateUserProfile, saveUserProfile, saveAiCharacterProfile, coreDataError, isCoreDataLoading } = useAppState();
  const [userStatus, setUserStatus] = useState('');
  const [aiStatus, setAiStatus] = useState('');
  const [isSavingUser, setIsSavingUser] = useState(false);
  const [isSavingAi, setIsSavingAi] = useState(false);
  const [userAvatarFile, setUserAvatarFile] = useState<File | null>(null);
  const [userAvatarPreviewUrl, setUserAvatarPreviewUrl] = useState<string | null>(null);
  const [aiAvatarFile, setAiAvatarFile] = useState<File | null>(null);
  const [aiAvatarPreviewUrl, setAiAvatarPreviewUrl] = useState<string | null>(null);
  const [aiCharacterName, setAiCharacterName] = useState(data.aiCharacterProfile.characterName);
  const [aiTonePreset, setAiTonePreset] = useState<TonePreset>(data.aiCharacterProfile.tonePreset);
  const [aiCharacterDescription, setAiCharacterDescription] = useState(data.aiCharacterProfile.characterDescription);
  const [aiSpeechEnding, setAiSpeechEnding] = useState(data.aiCharacterProfile.speechEnding);
  const [deleteAvatarTarget, setDeleteAvatarTarget] = useState<'user' | 'coach' | null>(null);
  const [isDeletingAvatar, setIsDeletingAvatar] = useState(false);

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
    setAiCharacterDescription(data.aiCharacterProfile.characterDescription);
    setAiSpeechEnding(data.aiCharacterProfile.speechEnding);
  }, [
    data.aiCharacterProfile.characterDescription,
    data.aiCharacterProfile.characterName,
    data.aiCharacterProfile.speechEnding,
    data.aiCharacterProfile.tonePreset
  ]);

  useEffect(() => {
    return () => {
      if (userAvatarPreviewUrl) {
        URL.revokeObjectURL(userAvatarPreviewUrl);
      }
      if (aiAvatarPreviewUrl) {
        URL.revokeObjectURL(aiAvatarPreviewUrl);
      }
    };
  }, [aiAvatarPreviewUrl, userAvatarPreviewUrl]);

  const userAvatarUrl = userAvatarPreviewUrl || profile.userAvatarImageUrl || '';
  const aiAvatarUrl = aiAvatarPreviewUrl || data.aiCharacterProfile.avatarImageUrl || '/assets/characters/default.png';
  const hasUserAvatar = Boolean(profile.userAvatarObjectKey || userAvatarPreviewUrl || userAvatarFile);
  const hasCoachAvatar = Boolean(data.aiCharacterProfile.coachAvatarObjectKey || aiAvatarPreviewUrl || aiAvatarFile);

  return (
    <div className="stack-lg">
      <section className="card">
        <h1>ユーザ設定</h1>
        <div className="settings-avatar-row">
          <div className="settings-avatar-preview">
            {userAvatarUrl ? (
              <img src={userAvatarUrl} alt="ユーザアイコン" className="avatar-large" />
            ) : (
              <span className="settings-avatar-fallback" aria-hidden="true">
                👤
              </span>
            )}
            <button
              type="button"
              className="settings-avatar-delete-button"
              aria-label="ユーザアイコン画像を削除"
              disabled={!hasUserAvatar || isSavingUser || isDeletingAvatar}
              onClick={() => setDeleteAvatarTarget('user')}
            >
              ×
            </button>
          </div>
          <div className="settings-avatar-actions">
            <label className="btn subtle" htmlFor="user-avatar-upload">
              ユーザ画像を選択
            </label>
            <input
              id="user-avatar-upload"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="visually-hidden-input"
              onChange={(e) => {
                const file = e.currentTarget.files?.[0] ?? null;
                e.currentTarget.value = '';
                if (!file) {
                  return;
                }
                const error = validateAvatarFile(file);
                if (error) {
                  setUserStatus(error);
                  return;
                }
                if (userAvatarPreviewUrl) {
                  URL.revokeObjectURL(userAvatarPreviewUrl);
                }
                setUserAvatarFile(file);
                setUserAvatarPreviewUrl(URL.createObjectURL(file));
                setUserStatus(`${file.name} を選択しました。保存で反映されます。`);
              }}
            />
            <small className="muted">PNG / JPEG / WEBP、最大 2MB</small>
          </div>
        </div>
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

          <label className="birth-date-field">
            生年月日
            <span className="birth-date-input-wrap">
              <input
                className="birth-date-input"
                type="date"
                value={profile.birthDate}
                onChange={(e) => updateUserProfile({ birthDate: e.target.value })}
              />
            </span>
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
              setIsSavingUser(true);
              try {
                let userAvatarObjectKey: string | undefined;
                if (userAvatarFile) {
                  const uploaded = await uploadAvatarImage('user', userAvatarFile);
                  userAvatarObjectKey = uploaded.objectKey;
                }
                const result = await saveUserProfile(
                  userAvatarObjectKey
                    ? {
                        userAvatarObjectKey
                      }
                    : undefined
                );
                if (result.ok) {
                  setUserStatus('ユーザ設定を保存しました。');
                  setUserAvatarFile(null);
                  if (userAvatarPreviewUrl) {
                    URL.revokeObjectURL(userAvatarPreviewUrl);
                  }
                  setUserAvatarPreviewUrl(null);
                } else {
                  setUserStatus(result.message ?? '保存に失敗しました。');
                }
              } catch (error) {
                setUserStatus(error instanceof Error ? error.message : 'ユーザ設定の保存に失敗しました。');
              } finally {
                setIsSavingUser(false);
              }
            }}
            disabled={isCoreDataLoading || isSavingUser}
          >
            {isCoreDataLoading || isSavingUser ? '保存中...' : '保存'}
          </button>
          {userStatus && <p className="status-text">{userStatus}</p>}
          {!userStatus && coreDataError && <p className="status-text">{coreDataError}</p>}
        </div>
      </section>

      <section className="card">
        <h2>AIコーチキャラクター設定</h2>
        <div className="settings-avatar-row">
          <div className="settings-avatar-preview">
            <img src={aiAvatarUrl} alt="AIコーチアイコン" className="avatar-large" />
            <button
              type="button"
              className="settings-avatar-delete-button"
              aria-label="AIコーチアイコン画像を削除"
              disabled={!hasCoachAvatar || isSavingAi || isDeletingAvatar}
              onClick={() => setDeleteAvatarTarget('coach')}
            >
              ×
            </button>
          </div>
          <div className="settings-avatar-actions">
            <label className="btn subtle" htmlFor="coach-avatar-upload">
              AIコーチ画像を選択
            </label>
            <input
              id="coach-avatar-upload"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="visually-hidden-input"
              onChange={(e) => {
                const file = e.currentTarget.files?.[0] ?? null;
                e.currentTarget.value = '';
                if (!file) {
                  return;
                }
                const error = validateAvatarFile(file);
                if (error) {
                  setAiStatus(error);
                  return;
                }
                if (aiAvatarPreviewUrl) {
                  URL.revokeObjectURL(aiAvatarPreviewUrl);
                }
                setAiAvatarFile(file);
                setAiAvatarPreviewUrl(URL.createObjectURL(file));
                setAiStatus(`${file.name} を選択しました。AI設定を反映で保存されます。`);
              }}
            />
            <small className="muted">PNG / JPEG / WEBP、最大 2MB</small>
          </div>
        </div>
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
          <label>
            キャラクター説明
            <input
              value={aiCharacterDescription}
              onChange={(e) => setAiCharacterDescription(e.target.value)}
              placeholder="例: 優しく見守りAIコーチロボ"
            />
          </label>
          <label>
            語尾
            <input value={aiSpeechEnding} onChange={(e) => setAiSpeechEnding(e.target.value)} placeholder="例: です。ます。" />
          </label>
        </div>
        <div className="row-wrap">
          <button
            type="button"
            className="btn primary"
            onClick={async () => {
              setIsSavingAi(true);
              try {
                let coachAvatarObjectKey: string | undefined;
                if (aiAvatarFile) {
                  const uploaded = await uploadAvatarImage('coach', aiAvatarFile);
                  coachAvatarObjectKey = uploaded.objectKey;
                }
                const result = await saveAiCharacterProfile({
                  characterName: aiCharacterName.trim() || data.aiCharacterProfile.characterName,
                  tonePreset: aiTonePreset,
                  characterDescription: aiCharacterDescription.trim(),
                  speechEnding: aiSpeechEnding.trim(),
                  ...(coachAvatarObjectKey
                    ? {
                        coachAvatarObjectKey
                      }
                    : {})
                });
                if (result.ok) {
                  setAiStatus('AIコーチキャラクター設定を保存しました。');
                  setAiAvatarFile(null);
                  if (aiAvatarPreviewUrl) {
                    URL.revokeObjectURL(aiAvatarPreviewUrl);
                  }
                  setAiAvatarPreviewUrl(null);
                } else {
                  setAiStatus(result.message ?? '保存に失敗しました。');
                }
              } catch (error) {
                setAiStatus(error instanceof Error ? error.message : 'AI設定の保存に失敗しました。');
              } finally {
                setIsSavingAi(false);
              }
            }}
            disabled={isSavingAi}
          >
            {isSavingAi ? '保存中...' : 'AI設定を反映'}
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

      {deleteAvatarTarget && (
        <div className="overlay-modal" role="dialog" aria-modal="true" aria-labelledby="avatar-delete-title">
          <div className="overlay-modal-card">
            <h3 id="avatar-delete-title">
              {deleteAvatarTarget === 'user' ? 'ユーザアイコン画像を削除しますか？' : 'AIコーチアイコン画像を削除しますか？'}
            </h3>
            <p>削除するともとに戻せません。</p>
            <div className="overlay-modal-actions">
              <button
                type="button"
                className="btn subtle"
                disabled={isDeletingAvatar}
                onClick={() => setDeleteAvatarTarget(null)}
              >
                キャンセル
              </button>
              <button
                type="button"
                className="btn danger"
                disabled={isDeletingAvatar}
                onClick={async () => {
                  setIsDeletingAvatar(true);
                  try {
                    if (deleteAvatarTarget === 'user') {
                      if (userAvatarPreviewUrl) {
                        URL.revokeObjectURL(userAvatarPreviewUrl);
                        setUserAvatarPreviewUrl(null);
                      }
                      setUserAvatarFile(null);
                      if (profile.userAvatarObjectKey) {
                        const result = await saveUserProfile({ userAvatarObjectKey: null });
                        setUserStatus(result.ok ? 'ユーザアイコン画像を削除しました。' : result.message ?? '削除に失敗しました。');
                      } else {
                        setUserStatus('選択中のユーザ画像をクリアしました。');
                      }
                    } else {
                      if (aiAvatarPreviewUrl) {
                        URL.revokeObjectURL(aiAvatarPreviewUrl);
                        setAiAvatarPreviewUrl(null);
                      }
                      setAiAvatarFile(null);
                      if (data.aiCharacterProfile.coachAvatarObjectKey) {
                        const result = await saveAiCharacterProfile({ coachAvatarObjectKey: null });
                        setAiStatus(result.ok ? 'AIコーチアイコン画像を削除しました。' : result.message ?? '削除に失敗しました。');
                      } else {
                        setAiStatus('選択中のAIコーチ画像をクリアしました。');
                      }
                    }
                  } catch (error) {
                    const message = error instanceof Error ? error.message : '画像削除に失敗しました。';
                    if (deleteAvatarTarget === 'user') {
                      setUserStatus(message);
                    } else {
                      setAiStatus(message);
                    }
                  } finally {
                    setIsDeletingAvatar(false);
                    setDeleteAvatarTarget(null);
                  }
                }}
              >
                削除する
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

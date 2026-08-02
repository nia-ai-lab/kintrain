import { useEffect, useMemo, useState } from 'react';
import Cropper, { type Area } from 'react-easy-crop';
import { Link, useNavigate } from 'react-router-dom';
import { uploadAvatarImage } from '../api/coreApi';
import { useAppState } from '../AppState';
import { useAuth } from '../AuthState';
import type { TonePreset } from '../types';
import {
  analysisExportFileName,
  createAnalysisExport,
  isValidAnalysisDate,
  type AnalysisExportProgress
} from '../utils/analysisExport';
import { toYmd } from '../utils/date';

const timeZoneCandidates = [
  'Asia/Tokyo',
  'UTC',
  'Asia/Seoul',
  'Asia/Singapore',
  'America/Los_Angeles',
  'America/New_York',
  'Europe/London'
];

const maxAvatarSourceImageBytes = 20 * 1024 * 1024;
const maxAvatarUploadBytes = 2 * 1024 * 1024;
const avatarOutputSize = 512;
const avatarCompressionQualities = [0.92, 0.84, 0.76, 0.68, 0.6, 0.52];
const allowedAvatarMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);

function defaultExportFromDate(): string {
  const date = new Date();
  date.setFullYear(date.getFullYear() - 1);
  return toYmd(date);
}

function exportProgressLabel(progress: AnalysisExportProgress): string {
  if (progress.section === 'profile') {
    return 'プロフィールと目標を取得しています...';
  }
  if (progress.section === 'trainingMenus') {
    return `トレーニングメニューを取得しています... ${progress.fetched}件`;
  }
  if (progress.section === 'dailyRecords') {
    return `デイリー記録を取得しています... ${progress.fetched}件`;
  }
  if (progress.section === 'gymVisits') {
    return `ジム記録を取得しています... ${progress.fetched}件`;
  }
  return 'ダウンロードファイルを作成しています...';
}

function validateAvatarFile(file: File): string | null {
  if (!allowedAvatarMimeTypes.has(file.type)) {
    return '画像形式は PNG / JPEG / WEBP のみ対応です。';
  }
  if (file.size > maxAvatarSourceImageBytes) {
    return '元画像サイズは 20MB 以下にしてください。';
  }
  return null;
}

function mimeTypeToExtension(mimeType: string): string {
  if (mimeType === 'image/png') {
    return 'png';
  }
  if (mimeType === 'image/webp') {
    return 'webp';
  }
  return 'jpg';
}

function outputMimeTypes(preferredMimeType: string): string[] {
  const normalized = preferredMimeType === 'image/png' || preferredMimeType === 'image/jpeg' || preferredMimeType === 'image/webp'
    ? preferredMimeType
    : 'image/jpeg';
  const candidates = [normalized, 'image/webp', 'image/jpeg', 'image/png'];
  return candidates.filter((value, index, array) => array.indexOf(value) === index);
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('画像の変換に失敗しました。'));
          return;
        }
        resolve(blob);
      },
      mimeType,
      quality
    );
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('画像の読み込みに失敗しました。'));
    image.src = src;
  });
}

async function buildAvatarFileFromCrop(args: {
  sourceUrl: string;
  croppedAreaPixels: Area;
  preferredMimeType: string;
}): Promise<File> {
  const image = await loadImage(args.sourceUrl);
  const canvas = document.createElement('canvas');
  canvas.width = avatarOutputSize;
  canvas.height = avatarOutputSize;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('画像編集コンテキストを取得できませんでした。');
  }

  context.drawImage(
    image,
    args.croppedAreaPixels.x,
    args.croppedAreaPixels.y,
    args.croppedAreaPixels.width,
    args.croppedAreaPixels.height,
    0,
    0,
    avatarOutputSize,
    avatarOutputSize
  );

  let smallestBlob: Blob | null = null;
  let selectedBlob: Blob | null = null;
  let selectedMimeType = 'image/jpeg';

  for (const mimeType of outputMimeTypes(args.preferredMimeType)) {
    if (mimeType === 'image/png') {
      const blob = await canvasToBlob(canvas, mimeType);
      if (!smallestBlob || blob.size < smallestBlob.size) {
        smallestBlob = blob;
      }
      if (blob.size <= maxAvatarUploadBytes) {
        selectedBlob = blob;
        selectedMimeType = mimeType;
        break;
      }
      continue;
    }

    for (const quality of avatarCompressionQualities) {
      const blob = await canvasToBlob(canvas, mimeType, quality);
      if (!smallestBlob || blob.size < smallestBlob.size) {
        smallestBlob = blob;
      }
      if (blob.size <= maxAvatarUploadBytes) {
        selectedBlob = blob;
        selectedMimeType = mimeType;
        break;
      }
    }
    if (selectedBlob) {
      break;
    }
  }

  if (!selectedBlob) {
    throw new Error(
      `画像の圧縮後サイズが上限を超えています。2MB以下に収まるように切り抜き範囲を調整してください。（現在: ${(
        (smallestBlob?.size ?? 0) /
        1024 /
        1024
      ).toFixed(2)}MB）`
    );
  }

  const extension = mimeTypeToExtension(selectedMimeType);
  return new File([selectedBlob], `avatar-${Date.now()}.${extension}`, {
    type: selectedMimeType
  });
}

type AvatarTarget = 'user' | 'coach';

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
  const [cropTarget, setCropTarget] = useState<AvatarTarget | null>(null);
  const [cropSourceUrl, setCropSourceUrl] = useState<string | null>(null);
  const [cropSourceFileName, setCropSourceFileName] = useState('');
  const [cropSourceMimeType, setCropSourceMimeType] = useState('image/jpeg');
  const [cropPosition, setCropPosition] = useState({ x: 0, y: 0 });
  const [cropZoom, setCropZoom] = useState(1);
  const [cropPixels, setCropPixels] = useState<Area | null>(null);
  const [isApplyingCrop, setIsApplyingCrop] = useState(false);
  const [exportRangeMode, setExportRangeMode] = useState<'dateRange' | 'allAvailable'>('dateRange');
  const [exportFrom, setExportFrom] = useState(defaultExportFromDate);
  const [exportTo, setExportTo] = useState(() => toYmd(new Date()));
  const [isExporting, setIsExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState('');

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
      if (cropSourceUrl) {
        URL.revokeObjectURL(cropSourceUrl);
      }
    };
  }, [aiAvatarPreviewUrl, cropSourceUrl, userAvatarPreviewUrl]);

  const closeCropModal = () => {
    if (cropSourceUrl) {
      URL.revokeObjectURL(cropSourceUrl);
    }
    setCropSourceUrl(null);
    setCropTarget(null);
    setCropSourceFileName('');
    setCropSourceMimeType('image/jpeg');
    setCropPosition({ x: 0, y: 0 });
    setCropZoom(1);
    setCropPixels(null);
    setIsApplyingCrop(false);
  };

  const openCropModal = (target: AvatarTarget, file: File) => {
    const error = validateAvatarFile(file);
    if (error) {
      if (target === 'user') {
        setUserStatus(error);
      } else {
        setAiStatus(error);
      }
      return;
    }

    if (cropSourceUrl) {
      URL.revokeObjectURL(cropSourceUrl);
    }
    setCropSourceUrl(URL.createObjectURL(file));
    setCropTarget(target);
    setCropSourceFileName(file.name);
    setCropSourceMimeType(file.type || 'image/jpeg');
    setCropPosition({ x: 0, y: 0 });
    setCropZoom(1);
    setCropPixels(null);
  };

  const userAvatarUrl = userAvatarPreviewUrl || profile.userAvatarImageUrl || '';
  const aiAvatarUrl = aiAvatarPreviewUrl || data.aiCharacterProfile.avatarImageUrl || '/assets/characters/default.png';
  const hasUserAvatar = Boolean(profile.userAvatarObjectKey || userAvatarPreviewUrl || userAvatarFile);
  const hasCoachAvatar = Boolean(data.aiCharacterProfile.coachAvatarObjectKey || aiAvatarPreviewUrl || aiAvatarFile);

  return (
    <div className="stack-lg settings-page">
      <section className="card settings-section-card settings-user-card">
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
                openCropModal('user', file);
              }}
            />
            <small className="muted">PNG / JPEG / WEBP、元画像は最大20MB（保存時に自動圧縮）</small>
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

      <section className="card settings-section-card settings-ai-card">
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
                openCropModal('coach', file);
              }}
            />
            <small className="muted">PNG / JPEG / WEBP、元画像は最大20MB（保存時に自動圧縮）</small>
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

      <section className="card settings-section-card settings-coaching-card">
        <h2>コーチング方針</h2>
        <p className="muted">
          ChatGPT、Claude、KinTrain AIで共有する目標・制約・指導方針と、短期の引き継ぎメモを管理します。
        </p>
        <Link className="btn subtle" to="/coaching-context">
          コーチング方針を管理
        </Link>
      </section>

      <section className="card settings-section-card settings-export-card">
        <h2>分析用データの出力</h2>
        <p className="muted">
          保存済みのデイリー記録、ジム記録、現在の目標、プロフィール、トレーニングメニューをAI分析用のJSON形式で出力します。
        </p>
        <div className="settings-export-mode" role="radiogroup" aria-label="出力期間">
          <label>
            <input
              type="radio"
              name="analysis-export-range"
              value="dateRange"
              checked={exportRangeMode === 'dateRange'}
              disabled={isExporting}
              onChange={() => {
                setExportRangeMode('dateRange');
                setExportStatus('');
              }}
            />
            期間を指定
          </label>
          <label>
            <input
              type="radio"
              name="analysis-export-range"
              value="allAvailable"
              checked={exportRangeMode === 'allAvailable'}
              disabled={isExporting}
              onChange={() => {
                setExportRangeMode('allAvailable');
                setExportStatus('');
              }}
            />
            保存されている全期間
          </label>
        </div>
        {exportRangeMode === 'dateRange' && (
          <div className="input-grid settings-export-range">
            <label>
              開始日
              <input
                type="date"
                value={exportFrom}
                max={exportTo || undefined}
                disabled={isExporting}
                onChange={(event) => {
                  setExportFrom(event.currentTarget.value);
                  setExportStatus('');
                }}
              />
            </label>
            <label>
              終了日
              <input
                type="date"
                value={exportTo}
                min={exportFrom || undefined}
                disabled={isExporting}
                onChange={(event) => {
                  setExportTo(event.currentTarget.value);
                  setExportStatus('');
                }}
              />
            </label>
          </div>
        )}
        <p className="settings-export-warning">
          出力ファイルには、生年月日、身体情報、日記などの個人情報が含まれます。共有先を確認してから利用してください。
        </p>
        <div className="row-wrap">
          <button
            type="button"
            className="btn primary"
            disabled={isExporting || isCoreDataLoading}
            onClick={async () => {
              if (
                exportRangeMode === 'dateRange' &&
                (!isValidAnalysisDate(exportFrom) || !isValidAnalysisDate(exportTo) || exportFrom > exportTo)
              ) {
                setExportStatus('開始日と終了日を正しく指定してください。');
                return;
              }
              setIsExporting(true);
              setExportStatus('データを準備しています...');
              try {
                const exportData = await createAnalysisExport(
                  exportRangeMode === 'dateRange'
                    ? {
                        rangeMode: 'dateRange',
                        from: exportFrom,
                        to: exportTo
                      }
                    : {
                        rangeMode: 'allAvailable'
                      },
                  (progress) => setExportStatus(exportProgressLabel(progress))
                );
                const blob = new Blob([JSON.stringify(exportData, null, 2)], {
                  type: 'application/json;charset=utf-8'
                });
                const downloadUrl = URL.createObjectURL(blob);
                const anchor = document.createElement('a');
                anchor.href = downloadUrl;
                anchor.download = analysisExportFileName(exportData);
                document.body.appendChild(anchor);
                anchor.click();
                anchor.remove();
                URL.revokeObjectURL(downloadUrl);
                setExportStatus(
                  `ダウンロードしました。デイリー記録 ${exportData.coverage.dailyRecordCount}件、トレーニング記録 ${exportData.coverage.gymVisitCount}件、リカバリー記録 ${exportData.coverage.recoveryExecutionCount}件`
                );
              } catch (error) {
                setExportStatus(error instanceof Error ? error.message : '分析用データの出力に失敗しました。');
              } finally {
                setIsExporting(false);
              }
            }}
          >
            {isExporting ? 'データを取得中...' : '分析用JSONをダウンロード'}
          </button>
          {exportStatus && (
            <p className="status-text" role="status">
              {exportStatus}
            </p>
          )}
        </div>
      </section>

      <section className="card settings-section-card settings-account-card">
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

      {cropTarget && cropSourceUrl && (
        <div className="overlay-modal" role="dialog" aria-modal="true" aria-labelledby="avatar-crop-title">
          <div className="overlay-modal-card avatar-crop-modal-card">
            <h3 id="avatar-crop-title">{cropTarget === 'user' ? 'ユーザ画像を調整' : 'AIコーチ画像を調整'}</h3>
            <p>{cropSourceFileName || '画像'} の表示位置を調整し、保存用アイコンを作成します。</p>
            <div className="avatar-crop-area" aria-label="アイコントリミングエリア">
              <Cropper
                image={cropSourceUrl}
                crop={cropPosition}
                zoom={cropZoom}
                aspect={1}
                restrictPosition={false}
                showGrid={false}
                onCropChange={setCropPosition}
                onZoomChange={setCropZoom}
                onCropComplete={(_, croppedAreaPixels) => setCropPixels(croppedAreaPixels)}
              />
            </div>
            <label className="avatar-crop-zoom">
              拡大率
              <input
                type="range"
                min={1}
                max={3}
                step={0.01}
                value={cropZoom}
                disabled={isApplyingCrop}
                onChange={(event) => setCropZoom(Number(event.currentTarget.value))}
              />
            </label>
            <small className="muted">出力は自動で 512x512 に最適化し、2MB以下に圧縮します。</small>
            <div className="overlay-modal-actions">
              <button type="button" className="btn subtle" disabled={isApplyingCrop} onClick={closeCropModal}>
                キャンセル
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={isApplyingCrop || !cropPixels}
                onClick={async () => {
                  if (!cropPixels || !cropSourceUrl) {
                    return;
                  }
                  setIsApplyingCrop(true);
                  try {
                    const preparedFile = await buildAvatarFileFromCrop({
                      sourceUrl: cropSourceUrl,
                      croppedAreaPixels: cropPixels,
                      preferredMimeType: cropSourceMimeType
                    });
                    const previewUrl = URL.createObjectURL(preparedFile);
                    if (cropTarget === 'user') {
                      if (userAvatarPreviewUrl) {
                        URL.revokeObjectURL(userAvatarPreviewUrl);
                      }
                      setUserAvatarFile(preparedFile);
                      setUserAvatarPreviewUrl(previewUrl);
                      setUserStatus(`${cropSourceFileName || '画像'} を調整しました。保存で反映されます。`);
                    } else {
                      if (aiAvatarPreviewUrl) {
                        URL.revokeObjectURL(aiAvatarPreviewUrl);
                      }
                      setAiAvatarFile(preparedFile);
                      setAiAvatarPreviewUrl(previewUrl);
                      setAiStatus(`${cropSourceFileName || '画像'} を調整しました。AI設定を反映で保存されます。`);
                    }
                    closeCropModal();
                  } catch (error) {
                    const message = error instanceof Error ? error.message : '画像調整に失敗しました。';
                    if (cropTarget === 'user') {
                      setUserStatus(message);
                    } else {
                      setAiStatus(message);
                    }
                    setIsApplyingCrop(false);
                  }
                }}
              >
                {isApplyingCrop ? '処理中...' : 'この範囲で確定'}
              </button>
            </div>
          </div>
        </div>
      )}

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

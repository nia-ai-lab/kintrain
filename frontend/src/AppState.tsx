import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  addTrainingMenuItemToSet as addTrainingMenuItemToSetApi,
  createTrainingMenuSet as createTrainingMenuSetApi,
  createGymVisit,
  createTrainingMenuItem,
  deleteTrainingMenuSet as deleteTrainingMenuSetApi,
  deleteTrainingMenuItem as deleteTrainingMenuItemApi,
  getAiCharacterProfile as getAiCharacterProfileApi,
  getDailyRecord as getDailyRecordApi,
  getGoal as getGoalApi,
  getProfile,
  listGymVisits,
  listTrainingMenuItems,
  listTrainingMenuSets,
  putAiCharacterProfile as putAiCharacterProfileApi,
  putDailyRecord as putDailyRecordApi,
  putGoal as putGoalApi,
  putProfile,
  removeTrainingMenuItemFromSet as removeTrainingMenuItemFromSetApi,
  reorderTrainingMenuSetItems as reorderTrainingMenuSetItemsApi,
  reorderTrainingMenuItems,
  TrainingMenuSetDto,
  updateTrainingMenuSet as updateTrainingMenuSetApi,
  updateTrainingMenuItem as updateTrainingMenuItemApi
} from './api/coreApi';
import { useAuth } from './AuthState';
import { initialAppData } from './data/mock-data';
import { toLocalIsoWithOffset, toYmd } from './utils/date';
import { loadFromStorage, saveToStorage } from './utils/storage';
import type {
  AiCharacterProfile,
  AppData,
  ChatMessage,
  ConditionRating,
  DailyRecord,
  DraftEntry,
  ExerciseEntry,
  Goal,
  MoodRating,
  SetDetail,
  TrainingEquipment,
  TrainingFrequencyDays,
  TrainingMenuSet,
  TrainingMenuItem,
  UserProfile
} from './types';

type DailySaveStatus = {
  isDirty: boolean;
  isSaving: boolean;
  lastSavedAtLocal?: string;
  error?: string;
};

interface AppStateContextValue {
  data: AppData;
  isCoreDataLoading: boolean;
  coreDataError: string;
  refreshCoreData: () => Promise<void>;
  refreshDailyRecord: (date: string) => Promise<void>;
  setDraftEntry: (menuItemId: string, patch: Partial<DraftEntry>) => void;
  setDraftSetDetails: (menuItemId: string, setDetails: SetDetail[]) => void;
  clearDraftEntry: (menuItemId: string) => void;
  clearDraft: () => void;
  finalizeTrainingSession: (date: string) => Promise<{ savedCount: number; ok: boolean; message?: string }>;
  saveDailyRecord: (date: string, patch: Partial<DailyRecord>) => void;
  setConditionRating: (date: string, rating: ConditionRating) => void;
  setMoodRating: (date: string, rating: MoodRating) => void;
  addOtherActivity: (date: string, value: string) => void;
  removeOtherActivity: (date: string, index: number) => void;
  flushDailyRecord: (date: string) => Promise<{ ok: boolean; message?: string }>;
  getDailySaveStatus: (date: string) => DailySaveStatus;
  addMenuItem: (item: Omit<TrainingMenuItem, 'id' | 'order' | 'isActive'>, options?: { targetSetId?: string }) => void;
  updateMenuItem: (itemId: string, patch: Partial<TrainingMenuItem>) => void;
  deleteMenuItem: (itemId: string) => void;
  moveMenuItem: (itemId: string, direction: -1 | 1) => void;
  createMenuSet: (setName: string, options?: { isDefault?: boolean; isAiGenerated?: boolean }) => Promise<string | null>;
  renameMenuSet: (setId: string, setName: string, options?: { isAiGenerated?: boolean }) => Promise<void>;
  deleteMenuSet: (setId: string) => Promise<void>;
  setDefaultMenuSet: (setId: string) => Promise<void>;
  setActiveMenuSet: (setId: string) => void;
  assignMenuItemToSet: (setId: string, itemId: string) => Promise<void>;
  unassignMenuItemFromSet: (setId: string, itemId: string) => Promise<void>;
  moveMenuItemInSet: (setId: string, itemId: string, direction: -1 | 1) => Promise<void>;
  replaceMenuItems: (items: TrainingMenuItem[]) => void;
  updateGoal: (patch: Partial<Goal>) => void;
  saveGoal: (patch?: Partial<Goal>) => Promise<{ ok: boolean; message?: string }>;
  updateUserProfile: (patch: Partial<UserProfile>) => void;
  saveUserProfile: (
    patch?: Omit<Partial<UserProfile>, 'userAvatarObjectKey'> & { userAvatarObjectKey?: string | null }
  ) => Promise<{ ok: boolean; message?: string }>;
  updateAiCharacterProfile: (patch: Partial<AiCharacterProfile>) => void;
  saveAiCharacterProfile: (
    patch?: Omit<Partial<AiCharacterProfile>, 'coachAvatarObjectKey'> & { coachAvatarObjectKey?: string | null }
  ) => Promise<{ ok: boolean; message?: string }>;
  restartActiveAiChatSession: () => void;
  appendUserMessage: (content: string) => void;
  createAssistantMessage: () => string;
  appendAssistantChunk: (messageId: string, chunk: string) => void;
  finalizeAssistantMessage: (messageId: string) => void;
}

const AppStateContext = createContext<AppStateContextValue | null>(null);

const defaultTrainingEquipment: TrainingEquipment = 'マシン';
const trainingEquipmentValues: TrainingEquipment[] = ['マシン', 'フリー', '自重', 'その他'];
const defaultTrainingFrequency: TrainingFrequencyDays = 3;
const trainingFrequencyValues: TrainingFrequencyDays[] = [1, 2, 3, 4, 5, 6, 7, 8];
const maxTrainingSessionEntryCount = 12;

function normalizeTrainingEquipment(value: unknown): TrainingEquipment {
  if (typeof value === 'string' && trainingEquipmentValues.includes(value as TrainingEquipment)) {
    return value as TrainingEquipment;
  }
  if (typeof value === 'string') {
    const legacy = value.trim();
    if (legacy === 'バーベル' || legacy === 'ダンベル' || legacy === 'ケトルベル') {
      return 'フリー';
    }
  }
  return defaultTrainingEquipment;
}

function normalizeTrainingMemo(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function normalizeAiGeneratedFlag(value: unknown): boolean {
  return value === true;
}

function normalizeTrainingFrequency(value: unknown): TrainingFrequencyDays {
  if (typeof value === 'number' && Number.isInteger(value) && trainingFrequencyValues.includes(value as TrainingFrequencyDays)) {
    return value as TrainingFrequencyDays;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '毎日') {
      return 1;
    }
    if (trimmed === '8日+' || trimmed === '8+') {
      return 8;
    }
    const numeric = Number(trimmed.replace(/[^\d]/g, ''));
    if (Number.isInteger(numeric) && trainingFrequencyValues.includes(numeric as TrainingFrequencyDays)) {
      return numeric as TrainingFrequencyDays;
    }
  }
  return defaultTrainingFrequency;
}

function getDefaultDailySaveStatus(): DailySaveStatus {
  return {
    isDirty: false,
    isSaving: false
  };
}

function isTenPointRating(value: unknown): value is ConditionRating {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 10;
}

function ensureDailyRecord(data: AppData, date: string): DailyRecord {
  return (
    data.dailyRecords[date] ?? {
      date,
      timeZoneId: data.userProfile.timeZoneId,
      otherActivities: []
    }
  );
}

function normalizeMeasuredTime(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  if (/^\d{2}:\d{2}$/.test(value)) {
    return value;
  }
  const fromLegacy = value.match(/T(\d{2}:\d{2})/);
  return fromLegacy?.[1];
}

function normalizeRepsRange(input: {
  defaultRepsMin?: number;
  defaultRepsMax?: number;
  defaultReps?: number;
}): { defaultRepsMin: number; defaultRepsMax: number } {
  const legacy = Number(input.defaultReps);
  const minCandidate = Number(input.defaultRepsMin ?? legacy);
  const maxCandidate = Number(input.defaultRepsMax ?? legacy);
  const min = Number.isFinite(minCandidate) && minCandidate > 0 ? Math.floor(minCandidate) : 1;
  const maxBase = Number.isFinite(maxCandidate) && maxCandidate > 0 ? Math.floor(maxCandidate) : min;
  return {
    defaultRepsMin: Math.min(min, maxBase),
    defaultRepsMax: Math.max(min, maxBase)
  };
}

function getDefaultMenuSetId(menuSets: TrainingMenuSet[]): string {
  return menuSets.find((set) => set.isDefault)?.id ?? menuSets[0]?.id ?? '';
}

function normalizeMenuSets(menuItems: TrainingMenuItem[], rawSets?: TrainingMenuSet[], activeSetId?: string): {
  menuSets: TrainingMenuSet[];
  activeTrainingMenuSetId: string;
} {
  const validItemIds = new Set(menuItems.map((item) => item.id));
  const sourceSets = Array.isArray(rawSets) ? rawSets : [];

  const normalized = sourceSets
    .filter((set) => set && set.isActive !== false)
    .sort((a, b) => a.order - b.order)
    .map((set, idx) => {
      const uniqueItemIds = Array.from(new Set((set.itemIds ?? []).filter((itemId) => validItemIds.has(itemId))));
      return {
        id: set.id || `menu-set-${idx + 1}`,
        setName: (set.setName ?? '').trim() || `メニューセット ${idx + 1}`,
        order: idx + 1,
        isDefault: Boolean(set.isDefault),
        isAiGenerated: set.isAiGenerated === true,
        isActive: true,
        itemIds: uniqueItemIds
      } as TrainingMenuSet;
    });

  const menuSets = normalized;
  if (menuSets.length === 0) {
    return {
      menuSets: [],
      activeTrainingMenuSetId: ''
    };
  }

  const orphanItemIds = menuItems.map((item) => item.id).filter((itemId) => !menuSets.some((set) => set.itemIds.includes(itemId)));

  const defaultId = getDefaultMenuSetId(menuSets);
  if (orphanItemIds.length > 0) {
    const fallbackDefaultId = defaultId || menuSets[0].id;
    const defaultSetIndex = menuSets.findIndex((set) => set.id === fallbackDefaultId);
    const targetIndex = defaultSetIndex >= 0 ? defaultSetIndex : 0;
    menuSets[targetIndex] = {
      ...menuSets[targetIndex],
      itemIds: [...menuSets[targetIndex].itemIds, ...orphanItemIds]
    };
  }

  const normalizedDefaultId = getDefaultMenuSetId(menuSets) || menuSets[0].id;
  const withSingleDefault = menuSets.map((set) => ({
    ...set,
    isDefault: set.id === normalizedDefaultId
  }));

  const resolvedActive =
    (activeSetId && withSingleDefault.some((set) => set.id === activeSetId) ? activeSetId : '') || normalizedDefaultId;

  return {
    menuSets: withSingleDefault,
    activeTrainingMenuSetId: resolvedActive
  };
}

function normalizeAppData(rawData: AppData): AppData {
  const legacy = rawData as AppData & {
    timeZoneId?: string;
    userProfile?: Partial<UserProfile>;
    menuItems?: Array<TrainingMenuItem & { machineName?: string; defaultReps?: number }>;
    menuSets?: TrainingMenuSet[];
    activeTrainingMenuSetId?: string;
    gymVisits?: Array<{
      id: string;
      date: string;
      startedAtLocal: string;
      endedAtLocal: string;
      timeZoneId: string;
      entries: Array<ExerciseEntry & { machineName?: string }>;
    }>;
    dailyRecords?: Record<string, DailyRecord & { bodyMetricRecordedAtLocal?: string }>;
  };
  const { timeZoneId: _legacyTimeZoneId, ...legacyWithoutTimeZone } = legacy;

  const timeZoneId = legacy.userProfile?.timeZoneId ?? legacy.timeZoneId ?? initialAppData.userProfile.timeZoneId;
  const userProfile: UserProfile = {
    userName: legacy.userProfile?.userName ?? initialAppData.userProfile.userName,
    sex: legacy.userProfile?.sex ?? initialAppData.userProfile.sex,
    birthDate: legacy.userProfile?.birthDate ?? initialAppData.userProfile.birthDate,
    heightCm: legacy.userProfile?.heightCm ?? initialAppData.userProfile.heightCm,
    timeZoneId,
    userAvatarObjectKey: legacy.userProfile?.userAvatarObjectKey ?? initialAppData.userProfile.userAvatarObjectKey,
    userAvatarImageUrl: legacy.userProfile?.userAvatarImageUrl ?? initialAppData.userProfile.userAvatarImageUrl
  };

  const sourceDailyRecords = legacy.dailyRecords ?? initialAppData.dailyRecords;
  const normalizedDailyRecords = Object.fromEntries(
    Object.entries(sourceDailyRecords).map(([date, record]) => {
      const normalizedRecord = record as DailyRecord & { bodyMetricRecordedAtLocal?: string };
      return [
        date,
        {
          ...normalizedRecord,
          timeZoneId: normalizedRecord.timeZoneId ?? timeZoneId,
          bodyMetricMeasuredTime: normalizeMeasuredTime(
            normalizedRecord.bodyMetricMeasuredTime ?? normalizedRecord.bodyMetricRecordedAtLocal
          )
        } as DailyRecord
      ];
    })
  );

  const sourceMenuItems = (legacy.menuItems ?? initialAppData.menuItems) as Array<
    TrainingMenuItem & { machineName?: string; defaultReps?: number; frequency?: unknown; memo?: unknown; isAiGenerated?: unknown }
  >;
  const normalizedMenuItems = sourceMenuItems.map((item) => ({
    ...item,
    trainingName: item.trainingName ?? item.machineName ?? '未設定トレーニング',
    bodyPart: item.bodyPart ?? '',
    equipment: normalizeTrainingEquipment((item as TrainingMenuItem & { equipment?: unknown }).equipment),
    isAiGenerated: normalizeAiGeneratedFlag(item.isAiGenerated),
    memo: normalizeTrainingMemo(item.memo),
    frequency: normalizeTrainingFrequency(item.frequency),
    ...normalizeRepsRange(item)
  }));
  const normalizedMenuSetState = normalizeMenuSets(normalizedMenuItems, legacy.menuSets, legacy.activeTrainingMenuSetId);

  const sourceGymVisits = (legacy.gymVisits ?? initialAppData.gymVisits) as Array<{
    id: string;
    date: string;
    startedAtLocal: string;
    endedAtLocal: string;
    timeZoneId: string;
    entries: Array<ExerciseEntry & { machineName?: string }>;
  }>;
  const normalizedGymVisits = sourceGymVisits.map((visit) => ({
    ...visit,
    entries: visit.entries.map((entry) => ({
      ...entry,
      trainingName: entry.trainingName ?? entry.machineName ?? '未設定トレーニング',
      bodyPart: entry.bodyPart ?? '',
      equipment: typeof (entry as ExerciseEntry & { equipment?: unknown }).equipment === 'string'
        ? ((entry as ExerciseEntry & { equipment?: string }).equipment ?? '')
        : ''
    }))
  }));

  const normalizedAiCharacterProfile: AiCharacterProfile = {
    ...initialAppData.aiCharacterProfile,
    ...(legacy.aiCharacterProfile ?? {})
  };

  return {
    ...initialAppData,
    ...legacyWithoutTimeZone,
    userProfile,
    menuItems: normalizedMenuItems,
    menuSets: normalizedMenuSetState.menuSets,
    activeTrainingMenuSetId: normalizedMenuSetState.activeTrainingMenuSetId,
    gymVisits: normalizedGymVisits,
    dailyRecords: normalizedDailyRecords,
    aiCharacterProfile: normalizedAiCharacterProfile
  };
}

function id(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

function toUtcIsoSeconds(localIso: string): string {
  const date = new Date(localIso);
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function mapRemoteMenuItem(item: {
  trainingMenuItemId: string;
  trainingName: string;
  bodyPart?: string;
  equipment?: string;
  isAiGenerated?: boolean;
  memo?: string;
  frequency?: number | string;
  defaultWeightKg: number;
  defaultRepsMin: number;
  defaultRepsMax: number;
  defaultReps?: number;
  defaultSets: number;
  displayOrder: number;
  isActive: boolean;
}): TrainingMenuItem {
  const repsRange = normalizeRepsRange(item);
  return {
    id: item.trainingMenuItemId,
    trainingName: item.trainingName,
    bodyPart: item.bodyPart ?? '',
    equipment: normalizeTrainingEquipment(item.equipment),
    isAiGenerated: normalizeAiGeneratedFlag(item.isAiGenerated),
    memo: normalizeTrainingMemo(item.memo),
    frequency: normalizeTrainingFrequency(item.frequency),
    defaultWeightKg: Number(item.defaultWeightKg),
    defaultRepsMin: repsRange.defaultRepsMin,
    defaultRepsMax: repsRange.defaultRepsMax,
    defaultSets: Number(item.defaultSets),
    order: Number(item.displayOrder),
    isActive: Boolean(item.isActive)
  };
}

function mapRemoteMenuSet(item: TrainingMenuSetDto): TrainingMenuSet {
  return {
    id: item.trainingMenuSetId,
    setName: item.setName,
    order: Number(item.menuSetOrder),
    isDefault: Boolean(item.isDefault),
    isAiGenerated: item.isAiGenerated === true,
    isActive: item.isActive !== false,
    itemIds: Array.isArray(item.itemIds) ? item.itemIds.filter((id): id is string => typeof id === 'string') : []
  };
}

function utcToLocalIsoWithOffset(utcIso: string): string {
  const date = new Date(utcIso);
  if (Number.isNaN(date.getTime())) {
    return utcIso;
  }
  return toLocalIsoWithOffset(date);
}

function mapRemoteGymVisit(visit: {
  visitId: string;
  visitDateLocal: string;
  startedAtUtc: string;
  endedAtUtc: string;
  timeZoneId?: string;
  entries?: Array<{
    trainingMenuItemId?: string;
    trainingNameSnapshot?: string;
    bodyPartSnapshot?: string;
    equipmentSnapshot?: string;
    note?: string;
    weightKg?: number;
    reps?: number;
    sets?: number;
  }>;
}) {
  const startedDate = new Date(visit.startedAtUtc);
  const fallbackYmd = toYmd(Number.isNaN(startedDate.getTime()) ? new Date() : startedDate);
  const date =
    typeof visit.visitDateLocal === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(visit.visitDateLocal)
      ? visit.visitDateLocal
      : fallbackYmd;

  const entries: ExerciseEntry[] = (visit.entries ?? []).map((entry, index) => ({
    id: `${visit.visitId}-entry-${index + 1}`,
    menuItemId: entry.trainingMenuItemId ?? '',
    trainingName: entry.trainingNameSnapshot ?? '不明トレーニング',
    bodyPart: entry.bodyPartSnapshot ?? '',
    equipment: typeof entry.equipmentSnapshot === 'string' ? entry.equipmentSnapshot : '',
    note: typeof entry.note === 'string' ? entry.note : undefined,
    weightKg: Number(entry.weightKg ?? 0),
    reps: Number(entry.reps ?? 0),
    sets: Number(entry.sets ?? 0)
  }));

  return {
    id: visit.visitId,
    date,
    startedAtLocal: utcToLocalIsoWithOffset(visit.startedAtUtc),
    endedAtLocal: utcToLocalIsoWithOffset(visit.endedAtUtc),
    timeZoneId: visit.timeZoneId ?? 'Asia/Tokyo',
    entries
  };
}

function mapRemoteDailyRecord(
  item: {
    recordDate?: string;
    timeZoneId?: string;
    bodyWeightKg?: number;
    bodyFatPercent?: number;
    bodyMetricMeasuredTimeLocal?: string;
    conditionRating?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
    moodRating?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
    conditionComment?: string;
    diary?: string;
    otherActivities?: string[];
  },
  fallbackTimeZoneId: string
): DailyRecord | null {
  const date = typeof item.recordDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.recordDate) ? item.recordDate : '';
  if (!date) {
    return null;
  }
  const normalizedConditionRating = isTenPointRating(item.conditionRating) ? item.conditionRating : undefined;
  const normalizedMoodRating = isTenPointRating(item.moodRating) ? item.moodRating : undefined;
  return {
    date,
    timeZoneId: item.timeZoneId ?? fallbackTimeZoneId,
    bodyWeightKg: typeof item.bodyWeightKg === 'number' ? item.bodyWeightKg : undefined,
    bodyFatPercent: typeof item.bodyFatPercent === 'number' ? item.bodyFatPercent : undefined,
    bodyMetricMeasuredTime: normalizeMeasuredTime(item.bodyMetricMeasuredTimeLocal),
    conditionRating: normalizedConditionRating,
    moodRating: normalizedMoodRating,
    conditionComment: typeof item.conditionComment === 'string' ? item.conditionComment : undefined,
    diary: typeof item.diary === 'string' ? item.diary : undefined,
    otherActivities: Array.isArray(item.otherActivities) ? item.otherActivities : []
  };
}

function mapRemoteGoal(
  item: {
    targetWeightKg?: number;
    targetBodyFatPercent?: number;
    deadlineDate?: string;
    comment?: string;
    updatedAt?: string;
  },
  fallback: Goal
): Goal {
  return {
    targetWeightKg: typeof item.targetWeightKg === 'number' ? item.targetWeightKg : fallback.targetWeightKg,
    targetBodyFatPercent:
      typeof item.targetBodyFatPercent === 'number' ? item.targetBodyFatPercent : fallback.targetBodyFatPercent,
    deadlineDate:
      typeof item.deadlineDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.deadlineDate) ? item.deadlineDate : undefined,
    comment: typeof item.comment === 'string' ? item.comment : '',
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : fallback.updatedAt
  };
}

function mapRemoteAiCharacterProfile(item: {
  characterId?: string;
  characterName?: string;
  coachAvatarObjectKey?: string;
  avatarImageUrl?: string;
  tonePreset?: string;
  characterDescription?: string;
  speechEnding?: string;
}): AiCharacterProfile {
  return {
    ...initialAppData.aiCharacterProfile,
    characterId:
      typeof item.characterId === 'string' && item.characterId.trim() ? item.characterId : initialAppData.aiCharacterProfile.characterId,
    characterName:
      typeof item.characterName === 'string' && item.characterName.trim()
        ? item.characterName
        : initialAppData.aiCharacterProfile.characterName,
    coachAvatarObjectKey:
      typeof item.coachAvatarObjectKey === 'string' && item.coachAvatarObjectKey.trim()
        ? item.coachAvatarObjectKey
        : initialAppData.aiCharacterProfile.coachAvatarObjectKey,
    avatarImageUrl:
      typeof item.avatarImageUrl === 'string' && item.avatarImageUrl.trim()
        ? item.avatarImageUrl
        : initialAppData.aiCharacterProfile.avatarImageUrl,
    tonePreset:
      item.tonePreset === 'polite' || item.tonePreset === 'friendly-coach' || item.tonePreset === 'strict-coach'
        ? item.tonePreset
        : initialAppData.aiCharacterProfile.tonePreset,
    characterDescription:
      typeof item.characterDescription === 'string' ? item.characterDescription : initialAppData.aiCharacterProfile.characterDescription,
    speechEnding: typeof item.speechEnding === 'string' ? item.speechEnding : initialAppData.aiCharacterProfile.speechEnding
  };
}

function toDailyRecordPayload(record: DailyRecord): {
  bodyWeightKg?: number;
  bodyFatPercent?: number;
  bodyMetricMeasuredTimeLocal?: string;
  timeZoneId: string;
  conditionRating?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  moodRating?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  conditionComment?: string;
  diary?: string;
  otherActivities: string[];
} {
  return {
    bodyWeightKg: record.bodyWeightKg,
    bodyFatPercent: record.bodyFatPercent,
    bodyMetricMeasuredTimeLocal: record.bodyMetricMeasuredTime,
    timeZoneId: record.timeZoneId,
    conditionRating: record.conditionRating,
    moodRating: record.moodRating,
    conditionComment: record.conditionComment,
    diary: record.diary,
    otherActivities: record.otherActivities
  };
}

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  const [data, setData] = useState<AppData>(() => normalizeAppData(loadFromStorage(initialAppData)));
  const [isCoreDataLoading, setIsCoreDataLoading] = useState(false);
  const [coreDataError, setCoreDataError] = useState('');
  const [dailySaveStatusByDate, setDailySaveStatusByDate] = useState<Record<string, DailySaveStatus>>({});
  const dailyPersistTimerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const pendingDailyRecordRef = useRef<Record<string, DailyRecord>>({});
  const dailySaveStatusRef = useRef<Record<string, DailySaveStatus>>({});

  useEffect(() => {
    dailySaveStatusRef.current = dailySaveStatusByDate;
  }, [dailySaveStatusByDate]);

  useEffect(() => {
    saveToStorage(data);
  }, [data]);

  const refreshCoreData = useCallback(async () => {
    if (!isAuthenticated) {
      return;
    }
    setIsCoreDataLoading(true);
    try {
      const [profile, menu, menuSetsResponse, visits, aiCharacterProfileResponse, goalResponse] =
        await Promise.all([
        getProfile(),
        listTrainingMenuItems(),
        listTrainingMenuSets(),
        listGymVisits({ limit: 200 }),
        getAiCharacterProfileApi(),
        getGoalApi()
      ]);
      const menuItems = menu.items
        .filter((item) => item.isActive)
        .map((item) => mapRemoteMenuItem(item))
        .sort((a, b) => a.order - b.order);
      const remoteMenuSets = menuSetsResponse.items
        .map((item) => mapRemoteMenuSet(item))
        .filter((set) => set.isActive)
        .sort((a, b) => a.order - b.order);
      const gymVisits = visits.items
        .map((item) => mapRemoteGymVisit(item))
        .sort((a, b) => a.startedAtLocal.localeCompare(b.startedAtLocal));
      setData((prev) => ({
        ...(() => {
          const nextMenuSetState = normalizeMenuSets(menuItems, remoteMenuSets, prev.activeTrainingMenuSetId);
          return {
            ...prev,
            userProfile: {
              ...prev.userProfile,
              ...profile
            },
            menuItems,
            menuSets: nextMenuSetState.menuSets,
            activeTrainingMenuSetId: nextMenuSetState.activeTrainingMenuSetId,
            gymVisits,
            aiCharacterProfile: mapRemoteAiCharacterProfile(aiCharacterProfileResponse),
            goal: mapRemoteGoal(goalResponse, prev.goal)
          };
        })()
      }));
      setCoreDataError('');
    } catch (error) {
      setCoreDataError(toErrorMessage(error, 'Core APIからのデータ取得に失敗しました。'));
    } finally {
      setIsCoreDataLoading(false);
    }
  }, [isAuthenticated]);

  const refreshDailyRecord = useCallback(
    async (date: string) => {
      if (!isAuthenticated) {
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return;
      }
      if (dailySaveStatusRef.current[date]?.isDirty) {
        return;
      }

      try {
        const remote = await getDailyRecordApi(date);
        const remoteUpdatedAt = typeof remote.updatedAt === 'string' ? remote.updatedAt : undefined;
        const mapped = mapRemoteDailyRecord(
          {
            ...remote,
            recordDate: typeof remote.recordDate === 'string' ? remote.recordDate : date
          },
          data.userProfile.timeZoneId
        );
        if (!mapped) {
          return;
        }
        setData((prev) => ({
          ...prev,
          dailyRecords: {
            ...prev.dailyRecords,
            [mapped.date]: mapped
          }
        }));
        setDailySaveStatusByDate((prev) => {
          const previous = prev[date] ?? getDefaultDailySaveStatus();
          const nextSavedAt = remoteUpdatedAt ? utcToLocalIsoWithOffset(remoteUpdatedAt) : undefined;
          if (previous.isDirty || previous.isSaving) {
            return prev;
          }
          if (!previous.error && !previous.isDirty && !previous.isSaving && previous.lastSavedAtLocal === nextSavedAt) {
            return prev;
          }
          return {
            ...prev,
            [date]: {
              ...previous,
              isDirty: false,
              isSaving: false,
              error: undefined,
              lastSavedAtLocal: nextSavedAt
            }
          };
        });
      } catch {
        // Dailyは対象日だけ遅延取得する。失敗時は現状表示を維持。
      }
    },
    [data.userProfile.timeZoneId, isAuthenticated]
  );

  const persistDailyRecordNow = useCallback(
    async (date: string, record: DailyRecord): Promise<{ ok: boolean; message?: string }> => {
      if (!isAuthenticated) {
        return { ok: false, message: 'ログイン後に保存してください。' };
      }
      setDailySaveStatusByDate((prev) => ({
        ...prev,
        [date]: {
          ...(prev[date] ?? getDefaultDailySaveStatus()),
          isSaving: true,
          error: undefined
        }
      }));
      try {
        await putDailyRecordApi(date, toDailyRecordPayload(record));
        setCoreDataError('');
        setDailySaveStatusByDate((prev) => ({
          ...prev,
          [date]: {
            ...(prev[date] ?? getDefaultDailySaveStatus()),
            isDirty: false,
            isSaving: false,
            error: undefined,
            lastSavedAtLocal: toLocalIsoWithOffset(new Date())
          }
        }));
        return { ok: true };
      } catch (error) {
        const message = toErrorMessage(error, 'Daily記録の保存に失敗しました。');
        setCoreDataError(message);
        setDailySaveStatusByDate((prev) => ({
          ...prev,
          [date]: {
            ...(prev[date] ?? getDefaultDailySaveStatus()),
            isDirty: true,
            isSaving: false,
            error: message
          }
        }));
        return { ok: false, message };
      }
    },
    [isAuthenticated]
  );

  const scheduleDailyRecordPersist = useCallback(
    (date: string, record: DailyRecord) => {
      if (!isAuthenticated) {
        return;
      }
      pendingDailyRecordRef.current[date] = record;
      setDailySaveStatusByDate((prev) => ({
        ...prev,
        [date]: {
          ...(prev[date] ?? getDefaultDailySaveStatus()),
          isDirty: true,
          error: undefined
        }
      }));

      const previous = dailyPersistTimerRef.current[date];
      if (previous) {
        clearTimeout(previous);
      }

      dailyPersistTimerRef.current[date] = setTimeout(() => {
        const latest = pendingDailyRecordRef.current[date];
        if (!latest) {
          return;
        }
        delete pendingDailyRecordRef.current[date];
        delete dailyPersistTimerRef.current[date];
        void persistDailyRecordNow(date, latest);
      }, 3000);
    },
    [isAuthenticated, persistDailyRecordNow]
  );

  useEffect(() => {
    return () => {
      Object.values(dailyPersistTimerRef.current).forEach((timerId) => clearTimeout(timerId));
      dailyPersistTimerRef.current = {};
      pendingDailyRecordRef.current = {};
    };
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }
    void refreshCoreData();
    void refreshDailyRecord(toYmd(new Date()));
  }, [isAuthenticated, refreshCoreData, refreshDailyRecord]);

  const value = useMemo<AppStateContextValue>(() => {
    return {
      data,
      isCoreDataLoading,
      coreDataError,
      refreshCoreData,
      refreshDailyRecord,
      setDraftEntry: (menuItemId, patch) => {
        setData((prev) => {
          const now = toLocalIsoWithOffset(new Date());
          const currentDraft =
            prev.trainingDraft ??
            ({
              startedAtLocal: now,
              updatedAtLocal: now,
              entriesByItemId: {}
            } as AppData['trainingDraft']);

          const nextEntry = {
            ...(currentDraft?.entriesByItemId[menuItemId] ?? { menuItemId }),
            ...patch
          };

          const hasMemoField = Object.prototype.hasOwnProperty.call(nextEntry, 'memo');
          const hasAnyMetric =
            nextEntry.weightKg !== undefined ||
            nextEntry.reps !== undefined ||
            nextEntry.sets !== undefined ||
            hasMemoField ||
            (Array.isArray(nextEntry.setDetails) && nextEntry.setDetails.length > 0);
          const nextEntries = { ...(currentDraft?.entriesByItemId ?? {}) };

          if (!hasAnyMetric) {
            delete nextEntries[menuItemId];
          } else {
            nextEntries[menuItemId] = nextEntry;
          }

          if (Object.keys(nextEntries).length === 0) {
            return {
              ...prev,
              trainingDraft: null
            };
          }

          return {
            ...prev,
            trainingDraft: {
              startedAtLocal: currentDraft?.startedAtLocal ?? now,
              updatedAtLocal: now,
              entriesByItemId: nextEntries
            }
          };
        });
      },
      setDraftSetDetails: (menuItemId, setDetails) => {
        setData((prev) => {
          const now = toLocalIsoWithOffset(new Date());
          const currentDraft =
            prev.trainingDraft ?? {
              startedAtLocal: now,
              updatedAtLocal: now,
              entriesByItemId: {}
            };
          const nextEntry = {
            ...(currentDraft.entriesByItemId[menuItemId] ?? { menuItemId }),
            setDetails
          };
          return {
            ...prev,
            trainingDraft: {
              ...currentDraft,
              updatedAtLocal: now,
              entriesByItemId: {
                ...currentDraft.entriesByItemId,
                [menuItemId]: nextEntry
              }
            }
          };
        });
      },
      clearDraftEntry: (menuItemId) => {
        setData((prev) => {
          if (!prev.trainingDraft) {
            return prev;
          }
          const nextEntries = { ...prev.trainingDraft.entriesByItemId };
          if (!nextEntries[menuItemId]) {
            return prev;
          }
          delete nextEntries[menuItemId];
          if (Object.keys(nextEntries).length === 0) {
            return {
              ...prev,
              trainingDraft: null
            };
          }
          return {
            ...prev,
            trainingDraft: {
              ...prev.trainingDraft,
              updatedAtLocal: toLocalIsoWithOffset(new Date()),
              entriesByItemId: nextEntries
            }
          };
        });
      },
      clearDraft: () => {
        setData((prev) => ({ ...prev, trainingDraft: null }));
      },
      finalizeTrainingSession: async (date) => {
        if (!isAuthenticated) {
          return { savedCount: 0, ok: false, message: 'ログイン後に保存してください。' };
        }

        const draft = data.trainingDraft;
        if (!draft) {
          return { savedCount: 0, ok: false, message: '入力がないため保存できません。' };
        }

        const entries: ExerciseEntry[] = Object.values(draft.entriesByItemId)
          .filter((entry) => (entry.weightKg ?? 0) > 0 && (entry.reps ?? 0) > 0 && (entry.sets ?? 0) > 0)
          .map((entry) => {
            const menuItem = data.menuItems.find((item) => item.id === entry.menuItemId);
            return {
              id: id('entry'),
              menuItemId: entry.menuItemId,
              trainingName: menuItem?.trainingName ?? '不明トレーニング',
              bodyPart: menuItem?.bodyPart ?? '',
              equipment: menuItem?.equipment ?? '',
              note: typeof entry.memo === 'string' ? entry.memo.trim() || undefined : undefined,
              weightKg: entry.weightKg ?? 0,
              reps: entry.reps ?? 0,
              sets: entry.sets ?? 0,
              setDetails: entry.setDetails
            };
          });

        const savedCount = entries.length;
        if (savedCount === 0) {
          return {
            savedCount: 0,
            ok: false,
            message: '有効な入力がありません。数値を入力するか「前回と同じ」を押してください。'
          };
        }
        if (savedCount > maxTrainingSessionEntryCount) {
          return {
            savedCount: 0,
            ok: false,
            message: `1回の記録で保存できる種目数は最大${maxTrainingSessionEntryCount}件です。`
          };
        }

        const endedAtLocal = toLocalIsoWithOffset(new Date());
        const startedAtUtc = toUtcIsoSeconds(draft.startedAtLocal);
        const endedAtUtc = toUtcIsoSeconds(endedAtLocal);

        try {
          const created = await createGymVisit({
            startedAtUtc,
            endedAtUtc,
            timeZoneId: data.userProfile.timeZoneId,
            visitDateLocal: date,
            entries: entries.map((entry) => {
              const menuItem = data.menuItems.find((item) => item.id === entry.menuItemId);
              return {
                trainingMenuItemId: entry.menuItemId,
                trainingNameSnapshot: entry.trainingName,
                bodyPartSnapshot: entry.bodyPart.trim() || undefined,
                equipmentSnapshot: entry.equipment.trim() || undefined,
                isAiGeneratedSnapshot: menuItem?.isAiGenerated === true,
                frequencySnapshot: menuItem?.frequency,
                note: entry.note?.trim() || undefined,
                weightKg: entry.weightKg,
                reps: entry.reps,
                sets: entry.sets,
                performedAtUtc: endedAtUtc
              };
            })
          });

          setData((prev) => {
            const dailyRecord = ensureDailyRecord(prev, date);
            return {
              ...prev,
              gymVisits: [
                ...prev.gymVisits,
                {
                  id: created.visitId,
                  date,
                  startedAtLocal: draft.startedAtLocal,
                  endedAtLocal,
                  timeZoneId: data.userProfile.timeZoneId,
                  entries
                }
              ],
              trainingDraft: null,
              dailyRecords: {
                ...prev.dailyRecords,
                [date]: {
                  ...dailyRecord,
                  date,
                  timeZoneId: prev.userProfile.timeZoneId
                }
              }
            };
          });
          setCoreDataError('');
          return { savedCount, ok: true };
        } catch (error) {
          const message = toErrorMessage(error, 'トレーニング記録の保存に失敗しました。');
          setCoreDataError(message);
          return { savedCount: 0, ok: false, message };
        }
      },
      saveDailyRecord: (date, patch) => {
        const current = ensureDailyRecord(data, date);
        const nextRecord: DailyRecord = {
          ...current,
          ...patch,
          date,
          timeZoneId: data.userProfile.timeZoneId,
          otherActivities: patch.otherActivities ?? current.otherActivities
        };
        setData((prev) => {
          const prevCurrent = ensureDailyRecord(prev, date);
          return {
            ...prev,
            dailyRecords: {
              ...prev.dailyRecords,
              [date]: {
                ...prevCurrent,
                ...patch,
                date,
                timeZoneId: prev.userProfile.timeZoneId,
                otherActivities: patch.otherActivities ?? prevCurrent.otherActivities
              }
            }
          };
        });
        void scheduleDailyRecordPersist(date, nextRecord);
      },
      setConditionRating: (date, rating) => {
        const current = ensureDailyRecord(data, date);
        const nextRecord: DailyRecord = {
          ...current,
          conditionRating: rating,
          date,
          timeZoneId: data.userProfile.timeZoneId
        };
        setData((prev) => {
          const prevCurrent = ensureDailyRecord(prev, date);
          return {
            ...prev,
            dailyRecords: {
              ...prev.dailyRecords,
              [date]: {
                ...prevCurrent,
                conditionRating: rating,
                date,
                timeZoneId: prev.userProfile.timeZoneId
              }
            }
          };
        });
        void scheduleDailyRecordPersist(date, nextRecord);
      },
      setMoodRating: (date, rating) => {
        const current = ensureDailyRecord(data, date);
        const nextRecord: DailyRecord = {
          ...current,
          moodRating: rating,
          date,
          timeZoneId: data.userProfile.timeZoneId
        };
        setData((prev) => {
          const prevCurrent = ensureDailyRecord(prev, date);
          return {
            ...prev,
            dailyRecords: {
              ...prev.dailyRecords,
              [date]: {
                ...prevCurrent,
                moodRating: rating,
                date,
                timeZoneId: prev.userProfile.timeZoneId
              }
            }
          };
        });
        void scheduleDailyRecordPersist(date, nextRecord);
      },
      addOtherActivity: (date, value) => {
        if (!value.trim()) {
          return;
        }
        const current = ensureDailyRecord(data, date);
        const nextRecord: DailyRecord = {
          ...current,
          otherActivities: [...current.otherActivities, value.trim()]
        };
        setData((prev) => {
          const prevCurrent = ensureDailyRecord(prev, date);
          return {
            ...prev,
            dailyRecords: {
              ...prev.dailyRecords,
              [date]: {
                ...prevCurrent,
                otherActivities: [...prevCurrent.otherActivities, value.trim()]
              }
            }
          };
        });
        void scheduleDailyRecordPersist(date, nextRecord);
      },
      removeOtherActivity: (date, index) => {
        const current = ensureDailyRecord(data, date);
        const nextRecord: DailyRecord = {
          ...current,
          otherActivities: current.otherActivities.filter((_, i) => i !== index)
        };
        setData((prev) => {
          const prevCurrent = ensureDailyRecord(prev, date);
          return {
            ...prev,
            dailyRecords: {
              ...prev.dailyRecords,
              [date]: {
                ...prevCurrent,
                otherActivities: prevCurrent.otherActivities.filter((_, i) => i !== index)
              }
            }
          };
        });
        void scheduleDailyRecordPersist(date, nextRecord);
      },
      flushDailyRecord: async (date) => {
        if (!isAuthenticated) {
          return { ok: false, message: 'ログイン後に保存してください。' };
        }

        const timer = dailyPersistTimerRef.current[date];
        if (timer) {
          clearTimeout(timer);
          delete dailyPersistTimerRef.current[date];
        }

        const latest = pendingDailyRecordRef.current[date] ?? ensureDailyRecord(data, date);
        delete pendingDailyRecordRef.current[date];

        setDailySaveStatusByDate((prev) => ({
          ...prev,
          [date]: {
            ...(prev[date] ?? getDefaultDailySaveStatus()),
            isDirty: true,
            error: undefined
          }
        }));

        return persistDailyRecordNow(date, latest);
      },
      getDailySaveStatus: (date) => {
        return dailySaveStatusByDate[date] ?? getDefaultDailySaveStatus();
      },
      addMenuItem: (item, options) => {
        if (!isAuthenticated) {
          return;
        }
        const payload = {
          trainingName: item.trainingName.trim(),
          bodyPart: item.bodyPart.trim(),
          equipment: normalizeTrainingEquipment(item.equipment),
          isAiGenerated: normalizeAiGeneratedFlag(item.isAiGenerated),
          memo: normalizeTrainingMemo(item.memo),
          frequency: normalizeTrainingFrequency(item.frequency),
          defaultWeightKg: Math.round(item.defaultWeightKg * 100) / 100,
          defaultRepsMin: Math.floor(item.defaultRepsMin),
          defaultRepsMax: Math.floor(item.defaultRepsMax),
          defaultReps: Math.floor(item.defaultRepsMax),
          defaultSets: Math.floor(item.defaultSets)
        };
        if (
          !payload.trainingName ||
          payload.defaultWeightKg <= 0 ||
          payload.defaultRepsMin <= 0 ||
          payload.defaultRepsMax <= 0 ||
          payload.defaultRepsMin > payload.defaultRepsMax ||
          payload.defaultSets <= 0
        ) {
          setCoreDataError('トレーニング名と重量/回数（最小/最大）/セットは正しい値で入力してください。');
          return;
        }
        const fallbackSetId = options?.targetSetId || data.activeTrainingMenuSetId || getDefaultMenuSetId(data.menuSets);
        void createTrainingMenuItem(payload)
          .then(async (created) => {
            const targetSetId =
              options?.targetSetId || data.activeTrainingMenuSetId || getDefaultMenuSetId(data.menuSets) || fallbackSetId;
            if (targetSetId) {
              await addTrainingMenuItemToSetApi(targetSetId, created.trainingMenuItemId);
            }
            await refreshCoreData();
            setCoreDataError('');
          })
          .catch((error) => {
            setCoreDataError(toErrorMessage(error, 'トレーニングメニュー追加に失敗しました。'));
            void refreshCoreData();
          });
      },
      updateMenuItem: (itemId, patch) => {
        const currentItem = data.menuItems.find((item) => item.id === itemId);
        if (!currentItem) {
          return;
        }
        const nextItem: TrainingMenuItem = { ...currentItem, ...patch };

        setData((prev) => {
          const nextMenuItems = prev.menuItems.map((item) => (item.id === itemId ? { ...item, ...patch } : item));
          return {
            ...prev,
            menuItems: nextMenuItems
          };
        });
        if (!isAuthenticated) {
          return;
        }
        if (
          !nextItem.trainingName.trim() ||
          nextItem.defaultWeightKg <= 0 ||
          nextItem.defaultRepsMin <= 0 ||
          nextItem.defaultRepsMax <= 0 ||
          nextItem.defaultRepsMin > nextItem.defaultRepsMax ||
          nextItem.defaultSets <= 0
        ) {
          return;
        }
        void updateTrainingMenuItemApi(itemId, {
          trainingName: nextItem.trainingName.trim(),
          bodyPart: nextItem.bodyPart.trim(),
          equipment: normalizeTrainingEquipment(nextItem.equipment),
          isAiGenerated: normalizeAiGeneratedFlag(nextItem.isAiGenerated),
          memo: normalizeTrainingMemo(nextItem.memo),
          frequency: normalizeTrainingFrequency(nextItem.frequency),
          defaultWeightKg: Math.round(nextItem.defaultWeightKg * 100) / 100,
          defaultRepsMin: Math.floor(nextItem.defaultRepsMin),
          defaultRepsMax: Math.floor(nextItem.defaultRepsMax),
          defaultReps: Math.floor(nextItem.defaultRepsMax),
          defaultSets: Math.floor(nextItem.defaultSets)
        })
          .then(() => {
            setCoreDataError('');
          })
          .catch((error) => {
            setCoreDataError(toErrorMessage(error, 'トレーニングメニュー更新に失敗しました。'));
          });
      },
      deleteMenuItem: (itemId) => {
        setData((prev) => {
          const nextMenuItems = prev.menuItems.filter((item) => item.id !== itemId);
          const nextMenuSets = prev.menuSets.map((set) => ({
            ...set,
            itemIds: set.itemIds.filter((menuItemId) => menuItemId !== itemId)
          }));
          const nextMenuSetState = normalizeMenuSets(nextMenuItems, nextMenuSets, prev.activeTrainingMenuSetId);
          return {
            ...prev,
            menuItems: nextMenuItems,
            menuSets: nextMenuSetState.menuSets,
            activeTrainingMenuSetId: nextMenuSetState.activeTrainingMenuSetId
          };
        });
        if (!isAuthenticated) {
          return;
        }
        void deleteTrainingMenuItemApi(itemId).catch((error) => {
          setCoreDataError(toErrorMessage(error, 'トレーニングメニュー削除に失敗しました。'));
          void refreshCoreData();
        });
      },
      moveMenuItem: (itemId, direction) => {
        const sorted = [...data.menuItems].sort((a, b) => a.order - b.order);
        const index = sorted.findIndex((item) => item.id === itemId);
        const nextIndex = index + direction;
        if (index < 0 || nextIndex < 0 || nextIndex >= sorted.length) {
          return;
        }
        [sorted[index], sorted[nextIndex]] = [sorted[nextIndex], sorted[index]];
        const reOrdered: TrainingMenuItem[] = sorted.map((item, idx) => ({ ...item, order: idx + 1 }));

        setData((prev) => {
          return { ...prev, menuItems: reOrdered };
        });
        if (!isAuthenticated) {
          return;
        }
        void reorderTrainingMenuItems(
          reOrdered.map((item) => ({
            trainingMenuItemId: item.id,
            displayOrder: item.order
          }))
        )
          .then(() => {
            setCoreDataError('');
          })
          .catch((error) => {
            setCoreDataError(toErrorMessage(error, 'トレーニングメニュー並び替えの保存に失敗しました。'));
            void refreshCoreData();
          });
      },
      createMenuSet: async (setName, options) => {
        if (!isAuthenticated) {
          return null;
        }
        const trimmedName = setName.trim();
        if (!trimmedName) {
          return null;
        }
        try {
          const created = await createTrainingMenuSetApi({
            setName: trimmedName,
            isDefault: options?.isDefault,
            isAiGenerated: options?.isAiGenerated
          });
          await refreshCoreData();
          setData((prev) => ({
            ...prev,
            activeTrainingMenuSetId: created.trainingMenuSetId
          }));
          setCoreDataError('');
          return created.trainingMenuSetId;
        } catch (error) {
          setCoreDataError(toErrorMessage(error, 'メニューセット作成に失敗しました。'));
          return null;
        }
      },
      renameMenuSet: async (setId, setName, options) => {
        if (!isAuthenticated) {
          return;
        }
        const trimmedName = setName.trim();
        if (!trimmedName) {
          return;
        }
        try {
          await updateTrainingMenuSetApi(setId, {
            setName: trimmedName,
            isAiGenerated: options?.isAiGenerated
          });
          setData((prev) => ({
            ...prev,
            menuSets: prev.menuSets.map((set) =>
              set.id === setId ? { ...set, setName: trimmedName, isAiGenerated: options?.isAiGenerated ?? set.isAiGenerated } : set
            )
          }));
          setCoreDataError('');
        } catch (error) {
          setCoreDataError(toErrorMessage(error, 'メニューセット名更新に失敗しました。'));
          void refreshCoreData();
          throw error;
        }
      },
      deleteMenuSet: async (setId) => {
        if (!isAuthenticated) {
          return;
        }
        try {
          await deleteTrainingMenuSetApi(setId);
          setData((prev) => {
            const target = prev.menuSets.find((set) => set.id === setId);
            if (!target) {
              return prev;
            }
            const remaining = prev.menuSets.filter((set) => set.id !== setId).map((set, idx) => ({ ...set, order: idx + 1 }));
            const nextDefaultId = getDefaultMenuSetId(remaining);
            const normalized = remaining.map((set) => ({
              ...set,
              isDefault: set.id === nextDefaultId
            }));
            const nextActiveId =
              prev.activeTrainingMenuSetId === setId ? nextDefaultId || normalized[0]?.id || '' : prev.activeTrainingMenuSetId;
            return {
              ...prev,
              menuSets: normalized,
              activeTrainingMenuSetId: nextActiveId
            };
          });
          setCoreDataError('');
        } catch (error) {
          setCoreDataError(toErrorMessage(error, 'メニューセット削除に失敗しました。'));
          void refreshCoreData();
          throw error;
        }
      },
      setDefaultMenuSet: async (setId) => {
        if (!isAuthenticated) {
          return;
        }
        try {
          await updateTrainingMenuSetApi(setId, { isDefault: true });
          setData((prev) => ({
            ...prev,
            menuSets: prev.menuSets.map((set) => ({
              ...set,
              isDefault: set.id === setId
            }))
          }));
          setCoreDataError('');
        } catch (error) {
          setCoreDataError(toErrorMessage(error, 'デフォルトメニューセット更新に失敗しました。'));
          void refreshCoreData();
          throw error;
        }
      },
      setActiveMenuSet: (setId) => {
        setData((prev) => {
          if (!prev.menuSets.some((set) => set.id === setId)) {
            return prev;
          }
          return {
            ...prev,
            activeTrainingMenuSetId: setId
          };
        });
      },
      assignMenuItemToSet: async (setId, itemId) => {
        if (!isAuthenticated) {
          return;
        }
        try {
          await addTrainingMenuItemToSetApi(setId, itemId);
          setData((prev) => ({
            ...prev,
            menuSets: prev.menuSets.map((set) => {
              if (set.id !== setId || set.itemIds.includes(itemId)) {
                return set;
              }
              return {
                ...set,
                itemIds: [...set.itemIds, itemId]
              };
            })
          }));
          setCoreDataError('');
        } catch (error) {
          setCoreDataError(toErrorMessage(error, 'メニューセットへの種目追加に失敗しました。'));
          void refreshCoreData();
          throw error;
        }
      },
      unassignMenuItemFromSet: async (setId, itemId) => {
        if (!isAuthenticated) {
          return;
        }
        try {
          await removeTrainingMenuItemFromSetApi(setId, itemId);
          setData((prev) => ({
            ...prev,
            menuSets: prev.menuSets.map((set) =>
              set.id === setId
                ? {
                    ...set,
                    itemIds: set.itemIds.filter((id) => id !== itemId)
                  }
                : set
            )
          }));
          setCoreDataError('');
        } catch (error) {
          setCoreDataError(toErrorMessage(error, 'メニューセットからの種目削除に失敗しました。'));
          void refreshCoreData();
          throw error;
        }
      },
      moveMenuItemInSet: async (setId, itemId, direction) => {
        const targetSet = data.menuSets.find((set) => set.id === setId);
        if (!targetSet) {
          return;
        }
        const index = targetSet.itemIds.findIndex((id) => id === itemId);
        const nextIndex = index + direction;
        if (index < 0 || nextIndex < 0 || nextIndex >= targetSet.itemIds.length) {
          return;
        }
        const reordered = [...targetSet.itemIds];
        [reordered[index], reordered[nextIndex]] = [reordered[nextIndex], reordered[index]];

        setData((prev) => ({
          ...prev,
          menuSets: prev.menuSets.map((set) =>
            set.id === setId
              ? {
                  ...set,
                  itemIds: reordered
                }
              : set
          )
        }));

        if (!isAuthenticated) {
          return;
        }

        try {
          await reorderTrainingMenuSetItemsApi(
            setId,
            reordered.map((menuItemId, idx) => ({
              trainingMenuItemId: menuItemId,
              displayOrder: idx + 1
            }))
          );
          setCoreDataError('');
        } catch (error) {
          setCoreDataError(toErrorMessage(error, 'メニューセット内の並び替え保存に失敗しました。'));
          void refreshCoreData();
          throw error;
        }
      },
      replaceMenuItems: (items) => {
        setData((prev) => {
          const nextMenuItems = items
            .map((item, idx) => ({ ...item, order: idx + 1 }))
            .sort((a, b) => a.order - b.order);
          const nextMenuSetState = normalizeMenuSets(nextMenuItems, prev.menuSets, prev.activeTrainingMenuSetId);
          return {
            ...prev,
            menuItems: nextMenuItems,
            menuSets: nextMenuSetState.menuSets,
            activeTrainingMenuSetId: nextMenuSetState.activeTrainingMenuSetId
          };
        });
      },
      updateGoal: (patch) => {
        setData((prev) => ({
          ...prev,
          goal: {
            ...prev.goal,
            ...patch
          }
        }));
      },
      saveGoal: async (patch) => {
        if (!isAuthenticated) {
          return { ok: false, message: 'ログイン後に保存してください。' };
        }
        const nextGoal = {
          ...data.goal,
          ...(patch ?? {})
        };
        const targetWeightKg = Number(nextGoal.targetWeightKg);
        const targetBodyFatPercent = Number(nextGoal.targetBodyFatPercent);
        if (!Number.isFinite(targetWeightKg) || targetWeightKg <= 0 || !Number.isFinite(targetBodyFatPercent) || targetBodyFatPercent <= 0) {
          return { ok: false, message: '目標体重・体脂肪率は0より大きい数値を入力してください。' };
        }
        try {
          const saved = await putGoalApi({
            targetWeightKg: Math.round(targetWeightKg * 100) / 100,
            targetBodyFatPercent: Math.round(targetBodyFatPercent * 100) / 100,
            deadlineDate: nextGoal.deadlineDate?.trim() || undefined,
            comment: nextGoal.comment?.trim() || undefined
          });
          setData((prev) => ({
            ...prev,
            goal: mapRemoteGoal(saved, prev.goal)
          }));
          setCoreDataError('');
          return { ok: true };
        } catch (error) {
          const message = toErrorMessage(error, 'ゴール設定の保存に失敗しました。');
          setCoreDataError(message);
          return { ok: false, message };
        }
      },
      updateUserProfile: (patch) => {
        setData((prev) => ({
          ...prev,
          userProfile: {
            ...prev.userProfile,
            ...patch
          }
        }));
      },
      saveUserProfile: async (patch) => {
        if (!isAuthenticated) {
          return { ok: false, message: 'ログイン後に保存してください。' };
        }
        const nextProfile = {
          ...data.userProfile,
          ...(patch ?? {})
        };
        try {
          const saved = await putProfile({
            userName: nextProfile.userName,
            sex: nextProfile.sex,
            birthDate: nextProfile.birthDate,
            heightCm: nextProfile.heightCm,
            timeZoneId: nextProfile.timeZoneId,
            userAvatarObjectKey: nextProfile.userAvatarObjectKey
          });
          setData((prev) => ({
            ...prev,
            userProfile: {
              ...prev.userProfile,
              ...saved
            }
          }));
          setCoreDataError('');
          return { ok: true };
        } catch (error) {
          const message = toErrorMessage(error, 'ユーザ設定の保存に失敗しました。');
          setCoreDataError(message);
          return { ok: false, message };
        }
      },
      updateAiCharacterProfile: (patch) => {
        setData((prev) => ({
          ...prev,
          aiCharacterProfile: {
            ...prev.aiCharacterProfile,
            ...patch
          }
        }));
      },
      saveAiCharacterProfile: async (patch) => {
        if (!isAuthenticated) {
          return { ok: false, message: 'ログイン後に保存してください。' };
        }
        const nextProfile = {
          ...data.aiCharacterProfile,
          ...(patch ?? {})
        };
        try {
          const saved = await putAiCharacterProfileApi({
            characterId: nextProfile.characterId,
            characterName: nextProfile.characterName,
            coachAvatarObjectKey: nextProfile.coachAvatarObjectKey,
            tonePreset: nextProfile.tonePreset,
            characterDescription: nextProfile.characterDescription,
            speechEnding: nextProfile.speechEnding
          });
          setData((prev) => ({
            ...prev,
            aiCharacterProfile: mapRemoteAiCharacterProfile(saved)
          }));
          setCoreDataError('');
          return { ok: true };
        } catch (error) {
          const message = toErrorMessage(error, 'AI設定の保存に失敗しました。');
          setCoreDataError(message);
          return { ok: false, message };
        }
      },
      restartActiveAiChatSession: () => {
        setData((prev) => {
          const now = toLocalIsoWithOffset(new Date());
          const newSession = {
            id: id('chat-session'),
            title: '新規チャット',
            messages: [],
            updatedAtLocal: now
          };
          return {
            ...prev,
            aiChatSessions: prev.aiChatSessions.map((session) =>
              session.id === prev.activeAiChatSessionId ? newSession : session
            ),
            activeAiChatSessionId: newSession.id
          };
        });
      },
      appendUserMessage: (content) => {
        setData((prev) => {
          const sessionId = prev.activeAiChatSessionId;
          return {
            ...prev,
            aiChatSessions: prev.aiChatSessions.map((session) => {
              if (session.id !== sessionId) {
                return session;
              }
              const message: ChatMessage = {
                id: id('chat-user'),
                role: 'user',
                content,
                createdAtLocal: toLocalIsoWithOffset(new Date())
              };
              return {
                ...session,
                messages: [...session.messages, message],
                updatedAtLocal: message.createdAtLocal
              };
            })
          };
        });
      },
      createAssistantMessage: () => {
        const messageId = id('chat-ai');
        setData((prev) => {
          const sessionId = prev.activeAiChatSessionId;
          return {
            ...prev,
            aiChatSessions: prev.aiChatSessions.map((session) => {
              if (session.id !== sessionId) {
                return session;
              }
              const message: ChatMessage = {
                id: messageId,
                role: 'assistant',
                content: '',
                createdAtLocal: toLocalIsoWithOffset(new Date())
              };
              return {
                ...session,
                messages: [...session.messages, message],
                updatedAtLocal: message.createdAtLocal
              };
            })
          };
        });
        return messageId;
      },
      appendAssistantChunk: (messageId, chunk) => {
        setData((prev) => {
          const sessionId = prev.activeAiChatSessionId;
          return {
            ...prev,
            aiChatSessions: prev.aiChatSessions.map((session) => {
              if (session.id !== sessionId) {
                return session;
              }
              return {
                ...session,
                messages: session.messages.map((message) =>
                  message.id === messageId ? { ...message, content: `${message.content}${chunk}` } : message
                ),
                updatedAtLocal: toLocalIsoWithOffset(new Date())
              };
            })
          };
        });
      },
      finalizeAssistantMessage: (messageId) => {
        setData((prev) => {
          const sessionId = prev.activeAiChatSessionId;
          return {
            ...prev,
            aiChatSessions: prev.aiChatSessions.map((session) => {
              if (session.id !== sessionId) {
                return session;
              }
              const exists = session.messages.some((message) => message.id === messageId);
              if (!exists) {
                return session;
              }
              return {
                ...session,
                messages: session.messages,
                updatedAtLocal: toLocalIsoWithOffset(new Date())
              };
            })
          };
        });
      }
    };
  }, [
    coreDataError,
    dailySaveStatusByDate,
    data,
    isAuthenticated,
    isCoreDataLoading,
    persistDailyRecordNow,
    refreshCoreData,
    refreshDailyRecord,
    scheduleDailyRecordPersist
  ]);

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateContextValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) {
    throw new Error('useAppState must be used within AppStateProvider');
  }
  return ctx;
}

export function useTodayYmd(): string {
  return toYmd(new Date());
}

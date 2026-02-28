import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  createGymVisit,
  createTrainingMenuItem,
  deleteTrainingMenuItem as deleteTrainingMenuItemApi,
  getProfile,
  listTrainingMenuItems,
  putProfile,
  reorderTrainingMenuItems,
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
  SetDetail,
  TrainingMenuItem,
  UserProfile
} from './types';

interface AppStateContextValue {
  data: AppData;
  isCoreDataLoading: boolean;
  coreDataError: string;
  refreshCoreData: () => Promise<void>;
  setDraftEntry: (menuItemId: string, patch: Partial<DraftEntry>) => void;
  setDraftSetDetails: (menuItemId: string, setDetails: SetDetail[]) => void;
  clearDraftEntry: (menuItemId: string) => void;
  clearDraft: () => void;
  finalizeTrainingSession: (date: string) => Promise<{ savedCount: number; ok: boolean; message?: string }>;
  saveDailyRecord: (date: string, patch: Partial<DailyRecord>) => void;
  setConditionRating: (date: string, rating: ConditionRating) => void;
  addOtherActivity: (date: string, value: string) => void;
  removeOtherActivity: (date: string, index: number) => void;
  addMenuItem: (item: Omit<TrainingMenuItem, 'id' | 'order' | 'isActive'>) => void;
  updateMenuItem: (itemId: string, patch: Partial<TrainingMenuItem>) => void;
  deleteMenuItem: (itemId: string) => void;
  moveMenuItem: (itemId: string, direction: -1 | 1) => void;
  replaceMenuItems: (items: TrainingMenuItem[]) => void;
  updateUserProfile: (patch: Partial<UserProfile>) => void;
  saveUserProfile: () => Promise<{ ok: boolean; message?: string }>;
  updateAiCharacterProfile: (patch: Partial<AiCharacterProfile>) => void;
  appendUserMessage: (content: string) => void;
  createAssistantMessage: () => string;
  appendAssistantChunk: (messageId: string, chunk: string) => void;
  finalizeAssistantMessage: (messageId: string) => void;
}

const AppStateContext = createContext<AppStateContextValue | null>(null);

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

function normalizeAppData(rawData: AppData): AppData {
  const legacy = rawData as AppData & {
    timeZoneId?: string;
    userProfile?: Partial<UserProfile>;
    menuItems?: Array<TrainingMenuItem & { machineName?: string; defaultReps?: number }>;
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
    timeZoneId
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
    TrainingMenuItem & { machineName?: string; defaultReps?: number }
  >;
  const normalizedMenuItems = sourceMenuItems.map((item) => ({
    ...item,
    trainingName: item.trainingName ?? item.machineName ?? '未設定トレーニング',
    ...normalizeRepsRange(item)
  }));

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
      trainingName: entry.trainingName ?? entry.machineName ?? '未設定トレーニング'
    }))
  }));

  const normalizedAiCharacterProfile: AiCharacterProfile = {
    ...initialAppData.aiCharacterProfile,
    ...(legacy.aiCharacterProfile ?? {}),
    avatarImageUrl: initialAppData.aiCharacterProfile.avatarImageUrl
  };

  return {
    ...initialAppData,
    ...legacyWithoutTimeZone,
    userProfile,
    menuItems: normalizedMenuItems,
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
    defaultWeightKg: Number(item.defaultWeightKg),
    defaultRepsMin: repsRange.defaultRepsMin,
    defaultRepsMax: repsRange.defaultRepsMax,
    defaultSets: Number(item.defaultSets),
    order: Number(item.displayOrder),
    isActive: Boolean(item.isActive)
  };
}

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  const [data, setData] = useState<AppData>(() => normalizeAppData(loadFromStorage(initialAppData)));
  const [isCoreDataLoading, setIsCoreDataLoading] = useState(false);
  const [coreDataError, setCoreDataError] = useState('');

  useEffect(() => {
    saveToStorage(data);
  }, [data]);

  const refreshCoreData = useCallback(async () => {
    if (!isAuthenticated) {
      return;
    }
    setIsCoreDataLoading(true);
    try {
      const [profile, menu] = await Promise.all([getProfile(), listTrainingMenuItems()]);
      const menuItems = menu.items
        .filter((item) => item.isActive)
        .map((item) => mapRemoteMenuItem(item))
        .sort((a, b) => a.order - b.order);
      setData((prev) => ({
        ...prev,
        userProfile: {
          ...prev.userProfile,
          ...profile
        },
        menuItems
      }));
      setCoreDataError('');
    } catch (error) {
      setCoreDataError(toErrorMessage(error, 'Core APIからのデータ取得に失敗しました。'));
    } finally {
      setIsCoreDataLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }
    void refreshCoreData();
  }, [isAuthenticated, refreshCoreData]);

  const value = useMemo<AppStateContextValue>(() => {
    return {
      data,
      isCoreDataLoading,
      coreDataError,
      refreshCoreData,
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

          const hasAnyMetric =
            nextEntry.weightKg !== undefined || nextEntry.reps !== undefined || nextEntry.sets !== undefined;
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

        const endedAtLocal = toLocalIsoWithOffset(new Date());
        const startedAtUtc = toUtcIsoSeconds(draft.startedAtLocal);
        const endedAtUtc = toUtcIsoSeconds(endedAtLocal);

        try {
          const created = await createGymVisit({
            startedAtUtc,
            endedAtUtc,
            timeZoneId: data.userProfile.timeZoneId,
            visitDateLocal: date,
            entries: entries.map((entry) => ({
              trainingMenuItemId: entry.menuItemId,
              trainingNameSnapshot: entry.trainingName,
              weightKg: entry.weightKg,
              reps: entry.reps,
              sets: entry.sets,
              performedAtUtc: endedAtUtc
            }))
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
        setData((prev) => {
          const current = ensureDailyRecord(prev, date);
          return {
            ...prev,
            dailyRecords: {
              ...prev.dailyRecords,
              [date]: {
                ...current,
                ...patch,
                date,
                timeZoneId: prev.userProfile.timeZoneId,
                otherActivities: patch.otherActivities ?? current.otherActivities
              }
            }
          };
        });
      },
      setConditionRating: (date, rating) => {
        setData((prev) => {
          const current = ensureDailyRecord(prev, date);
          return {
            ...prev,
            dailyRecords: {
              ...prev.dailyRecords,
              [date]: {
                ...current,
                conditionRating: rating,
                date,
                timeZoneId: prev.userProfile.timeZoneId
              }
            }
          };
        });
      },
      addOtherActivity: (date, value) => {
        if (!value.trim()) {
          return;
        }
        setData((prev) => {
          const current = ensureDailyRecord(prev, date);
          return {
            ...prev,
            dailyRecords: {
              ...prev.dailyRecords,
              [date]: {
                ...current,
                otherActivities: [...current.otherActivities, value.trim()]
              }
            }
          };
        });
      },
      removeOtherActivity: (date, index) => {
        setData((prev) => {
          const current = ensureDailyRecord(prev, date);
          return {
            ...prev,
            dailyRecords: {
              ...prev.dailyRecords,
              [date]: {
                ...current,
                otherActivities: current.otherActivities.filter((_, i) => i !== index)
              }
            }
          };
        });
      },
      addMenuItem: (item) => {
        if (!isAuthenticated) {
          return;
        }
        const payload = {
          trainingName: item.trainingName.trim(),
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
        void createTrainingMenuItem(payload)
          .then((created) => {
            setData((prev) => {
              const withoutDup = prev.menuItems.filter((m) => m.id !== created.trainingMenuItemId);
              return {
                ...prev,
                menuItems: [...withoutDup, mapRemoteMenuItem(created)].sort((a, b) => a.order - b.order)
              };
            });
            setCoreDataError('');
          })
          .catch((error) => {
            setCoreDataError(toErrorMessage(error, 'トレーニングメニュー追加に失敗しました。'));
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
        setData((prev) => ({
          ...prev,
          menuItems: prev.menuItems.filter((item) => item.id !== itemId)
        }));
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
      replaceMenuItems: (items) => {
        setData((prev) => ({
          ...prev,
          menuItems: items
            .map((item, idx) => ({ ...item, order: idx + 1 }))
            .sort((a, b) => a.order - b.order)
        }));
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
      saveUserProfile: async () => {
        if (!isAuthenticated) {
          return { ok: false, message: 'ログイン後に保存してください。' };
        }
        try {
          const saved = await putProfile(data.userProfile);
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
  }, [coreDataError, data, isAuthenticated, isCoreDataLoading, refreshCoreData]);

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

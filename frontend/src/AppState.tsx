import { createContext, useContext, useEffect, useMemo, useState } from 'react';
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
  setDraftEntry: (menuItemId: string, patch: Partial<DraftEntry>) => void;
  setDraftSetDetails: (menuItemId: string, setDetails: SetDetail[]) => void;
  clearDraftEntry: (menuItemId: string) => void;
  clearDraft: () => void;
  finalizeTrainingSession: (date: string) => { savedCount: number };
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

function normalizeAppData(rawData: AppData): AppData {
  const legacy = rawData as AppData & {
    timeZoneId?: string;
    userProfile?: Partial<UserProfile>;
    menuItems?: Array<TrainingMenuItem & { machineName?: string }>;
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
    TrainingMenuItem & { machineName?: string }
  >;
  const normalizedMenuItems = sourceMenuItems.map((item) => ({
    ...item,
    trainingName: item.trainingName ?? item.machineName ?? '未設定トレーニング'
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

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState<AppData>(() => normalizeAppData(loadFromStorage(initialAppData)));

  useEffect(() => {
    saveToStorage(data);
  }, [data]);

  const value = useMemo<AppStateContextValue>(() => {
    return {
      data,
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
      finalizeTrainingSession: (date) => {
        let savedCount = 0;
        setData((prev) => {
          const draft = prev.trainingDraft;
          if (!draft) {
            return prev;
          }

          const entries: ExerciseEntry[] = Object.values(draft.entriesByItemId)
            .filter((entry) => (entry.weightKg ?? 0) > 0 && (entry.reps ?? 0) > 0 && (entry.sets ?? 0) > 0)
            .map((entry) => {
              const menuItem = prev.menuItems.find((item) => item.id === entry.menuItemId);
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

          savedCount = entries.length;
          if (savedCount === 0) {
            return prev;
          }

          const nowLocal = toLocalIsoWithOffset(new Date());
          const gymVisit = {
            id: id('visit'),
            date,
            startedAtLocal: draft.startedAtLocal,
            endedAtLocal: nowLocal,
            timeZoneId: prev.userProfile.timeZoneId,
            entries
          };

          const dailyRecord = ensureDailyRecord(prev, date);

          return {
            ...prev,
            gymVisits: [...prev.gymVisits, gymVisit],
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

        return { savedCount };
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
        setData((prev) => {
          const maxOrder = prev.menuItems.reduce((max, m) => Math.max(max, m.order), 0);
          return {
            ...prev,
            menuItems: [
              ...prev.menuItems,
              {
                ...item,
                id: id('menu'),
                order: maxOrder + 1,
                isActive: true
              }
            ]
          };
        });
      },
      updateMenuItem: (itemId, patch) => {
        setData((prev) => ({
          ...prev,
          menuItems: prev.menuItems.map((item) => (item.id === itemId ? { ...item, ...patch } : item))
        }));
      },
      deleteMenuItem: (itemId) => {
        setData((prev) => ({
          ...prev,
          menuItems: prev.menuItems.filter((item) => item.id !== itemId)
        }));
      },
      moveMenuItem: (itemId, direction) => {
        setData((prev) => {
          const sorted = [...prev.menuItems].sort((a, b) => a.order - b.order);
          const index = sorted.findIndex((item) => item.id === itemId);
          const nextIndex = index + direction;
          if (index < 0 || nextIndex < 0 || nextIndex >= sorted.length) {
            return prev;
          }
          [sorted[index], sorted[nextIndex]] = [sorted[nextIndex], sorted[index]];
          const reOrdered = sorted.map((item, idx) => ({ ...item, order: idx + 1 }));
          return { ...prev, menuItems: reOrdered };
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
  }, [data]);

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

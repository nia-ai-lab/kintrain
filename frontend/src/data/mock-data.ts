import type {
  AiCharacterProfile,
  AppData,
  DailyRecord,
  GymVisit,
  TrainingMenuItem
} from '../types';

const menuItems: TrainingMenuItem[] = [
  { id: 'm-1', trainingName: 'チェストプレス', defaultWeightKg: 25, defaultReps: 12, defaultSets: 3, order: 1, isActive: true },
  { id: 'm-2', trainingName: 'ラットプルダウン', defaultWeightKg: 30, defaultReps: 10, defaultSets: 3, order: 2, isActive: true },
  { id: 'm-3', trainingName: 'レッグプレス', defaultWeightKg: 80, defaultReps: 12, defaultSets: 3, order: 3, isActive: true },
  { id: 'm-4', trainingName: 'ショルダープレス', defaultWeightKg: 15, defaultReps: 10, defaultSets: 3, order: 4, isActive: true },
  { id: 'm-5', trainingName: 'シーテッドロー', defaultWeightKg: 27.5, defaultReps: 12, defaultSets: 3, order: 5, isActive: true }
];

const gymVisits: GymVisit[] = [
  {
    id: 'visit-2026-02-25',
    date: '2026-02-25',
    startedAtLocal: '2026-02-25T19:00:00+09:00',
    endedAtLocal: '2026-02-25T20:00:00+09:00',
    timeZoneId: 'Asia/Tokyo',
    entries: [
      { id: 'e-251', menuItemId: 'm-1', trainingName: 'チェストプレス', weightKg: 25, reps: 12, sets: 3 },
      { id: 'e-252', menuItemId: 'm-2', trainingName: 'ラットプルダウン', weightKg: 30, reps: 10, sets: 3 }
    ]
  },
  {
    id: 'visit-2026-02-27',
    date: '2026-02-27',
    startedAtLocal: '2026-02-27T19:10:00+09:00',
    endedAtLocal: '2026-02-27T20:20:00+09:00',
    timeZoneId: 'Asia/Tokyo',
    entries: [
      { id: 'e-271', menuItemId: 'm-3', trainingName: 'レッグプレス', weightKg: 85, reps: 10, sets: 4 },
      { id: 'e-272', menuItemId: 'm-4', trainingName: 'ショルダープレス', weightKg: 15, reps: 10, sets: 3 }
    ]
  }
];

const dailyRecords: Record<string, DailyRecord> = {
  '2026-02-25': {
    date: '2026-02-25',
    timeZoneId: 'Asia/Tokyo',
    bodyWeightKg: 70.2,
    bodyFatPercent: 18.1,
    bodyMetricMeasuredTime: '18:40',
    conditionRating: 4,
    conditionComment: '肩は軽めが良い。',
    diary: '混雑していたが2種目は確実に実施。',
    otherActivities: []
  },
  '2026-02-27': {
    date: '2026-02-27',
    timeZoneId: 'Asia/Tokyo',
    bodyWeightKg: 70.1,
    bodyFatPercent: 17.9,
    bodyMetricMeasuredTime: '18:50',
    conditionRating: 3,
    conditionComment: '少し疲れ気味。',
    diary: '脚トレ中心に実施。',
    otherActivities: ['ウォーキング 20分']
  }
};

export const defaultCharacterProfile: AiCharacterProfile = {
  characterId: 'nyaruko',
  characterName: 'ニャル子',
  avatarImageUrl: '/assets/characters/nyaruko/expressions/default.png',
  tonePreset: 'friendly-coach'
};

export const initialAppData: AppData = {
  userProfile: {
    userName: 'Nijot',
    sex: 'no-answer',
    birthDate: '1990-01-01',
    heightCm: 170,
    timeZoneId: 'Asia/Tokyo'
  },
  menuItems,
  gymVisits,
  dailyRecords,
  trainingDraft: null,
  goal: {
    targetWeightKg: 68,
    targetBodyFatPercent: 15
  },
  aiAgentRoleName: 'AIコーチ',
  aiCharacterProfile: defaultCharacterProfile,
  aiChatSessions: [
    {
      id: 'chat-main',
      title: 'トレーニング相談',
      updatedAtLocal: '2026-02-28T10:00:00+09:00',
      messages: [
        {
          id: 'c-1',
          role: 'assistant',
          createdAtLocal: '2026-02-28T10:00:00+09:00',
          content: 'こんにちは、ニャル子です。今日のジム状況に合わせて一緒に進めましょう。'
        }
      ]
    }
  ],
  activeAiChatSessionId: 'chat-main'
};

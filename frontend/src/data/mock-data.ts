import type {
  AiCharacterProfile,
  AppData
} from '../types';

export const defaultCharacterProfile: AiCharacterProfile = {
  characterId: 'nyaruko',
  characterName: 'ニャル子',
  avatarImageUrl: '/assets/characters/nyaruko/expressions/default.png',
  tonePreset: 'friendly-coach'
};

export const initialAppData: AppData = {
  userProfile: {
    userName: '',
    sex: 'no-answer',
    birthDate: '',
    heightCm: null,
    timeZoneId: 'Asia/Tokyo'
  },
  menuItems: [],
  menuSets: [
    {
      id: 'menu-set-main',
      setName: 'メインメニュー',
      order: 1,
      isDefault: true,
      isActive: true,
      itemIds: []
    }
  ],
  activeTrainingMenuSetId: 'menu-set-main',
  gymVisits: [],
  dailyRecords: {},
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

import type {
  AiCharacterProfile,
  AppData
} from '../types';

export const defaultCharacterProfile: AiCharacterProfile = {
  characterId: 'ai-coach-default',
  characterName: 'AIコーチ',
  coachAvatarObjectKey: undefined,
  avatarImageUrl: '/assets/characters/default.png',
  tonePreset: 'friendly-coach',
  characterDescription: '優しく見守りAIコーチロボ',
  speechEnding: 'です。ます。'
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
  menuSets: [],
  activeTrainingMenuSetId: '',
  gymVisits: [],
  dailyRecords: {},
  trainingDraft: null,
  goal: {
    targetWeightKg: undefined,
    targetBodyFatPercent: undefined,
    deadlineDate: undefined,
    comment: ''
  },
  aiAgentRoleName: 'AIコーチ',
  aiCharacterProfile: defaultCharacterProfile,
  aiChatSessions: [
    {
      id: 'chat-main',
      title: 'トレーニング相談',
      updatedAtLocal: '2026-02-28T10:00:00+09:00',
      messages: []
    }
  ],
  activeAiChatSessionId: 'chat-main'
};

export type ConditionRating = 1 | 2 | 3 | 4 | 5;

export interface SetDetail {
  setIndex: number;
  weightKg: number;
  reps: number;
}

export interface TrainingMenuItem {
  id: string;
  trainingName: string;
  defaultWeightKg: number;
  defaultReps: number;
  defaultSets: number;
  order: number;
  isActive: boolean;
}

export interface ExerciseEntry {
  id: string;
  menuItemId: string;
  trainingName: string;
  weightKg: number;
  reps: number;
  sets: number;
  setDetails?: SetDetail[];
}

export interface GymVisit {
  id: string;
  date: string;
  startedAtLocal: string;
  endedAtLocal: string;
  timeZoneId: string;
  entries: ExerciseEntry[];
}

export interface DraftEntry {
  menuItemId: string;
  weightKg?: number;
  reps?: number;
  sets?: number;
  setDetails?: SetDetail[];
}

export interface TrainingSessionDraft {
  startedAtLocal: string;
  updatedAtLocal: string;
  entriesByItemId: Record<string, DraftEntry>;
}

export interface DailyRecord {
  date: string;
  timeZoneId: string;
  bodyWeightKg?: number;
  bodyFatPercent?: number;
  bodyMetricMeasuredTime?: string;
  conditionRating?: ConditionRating;
  conditionComment?: string;
  diary?: string;
  otherActivities: string[];
}

export interface Goal {
  targetWeightKg: number;
  targetBodyFatPercent: number;
}

export type UserSex = 'male' | 'female' | 'other' | 'no-answer';

export interface UserProfile {
  userName: string;
  sex: UserSex;
  birthDate: string;
  heightCm: number | null;
  timeZoneId: string;
}

export type TonePreset = 'polite' | 'friendly-coach' | 'strict-coach';

export interface AiCharacterProfile {
  characterId: string;
  characterName: string;
  avatarImageUrl: string;
  tonePreset: TonePreset;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAtLocal: string;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAtLocal: string;
}

export interface AppData {
  userProfile: UserProfile;
  menuItems: TrainingMenuItem[];
  gymVisits: GymVisit[];
  dailyRecords: Record<string, DailyRecord>;
  trainingDraft: TrainingSessionDraft | null;
  goal: Goal;
  aiAgentRoleName: string;
  aiCharacterProfile: AiCharacterProfile;
  aiChatSessions: ChatSession[];
  activeAiChatSessionId: string;
}

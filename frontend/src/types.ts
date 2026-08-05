import type {
  AttachmentType,
  CableSides,
  EquipmentType,
  JointAction,
  Laterality,
  LoadModel,
  MovementFamily,
  MuscleTarget,
  PulleyPosition
} from './muscleTaxonomy';

export type ConditionRating = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
export type MoodRating = ConditionRating;

export interface SetDetail {
  setIndex: number;
  weightKg: number;
  reps: number;
  side?: 'left' | 'right' | 'bilateral';
}

export interface TrainingMenuItem {
  id: string;
  trainingName: string;
  itemKind: 'training' | 'recovery';
  standardDurationMinutes?: number;
  isSystemProvided?: boolean;
  exerciseFamilyId: string;
  muscleTargets: MuscleTarget[];
  movementFamily: MovementFamily;
  jointActions: JointAction[];
  laterality: Laterality;
  loadModel: LoadModel;
  classificationVersion: number;
  equipmentType: EquipmentType;
  equipmentProfileId?: string;
  cableSettings?: CableSettings;
  isAiGenerated: boolean;
  description: string;
  frequency: TrainingFrequencyDays;
  defaultWeightKg: number;
  weightInputMode: WeightInputMode;
  loadMultiplier: WeightLoadMultiplier;
  fixedWeightKg: number;
  defaultRepsMin: number;
  defaultRepsMax: number;
  defaultSets: number;
  order: number;
  isActive: boolean;
  version?: number;
  usageCount: number;
}

export interface CableSettings {
  pulleyPosition: PulleyPosition;
  attachmentType: AttachmentType;
  cableSides: CableSides;
}

export type TrainingFrequencyDays = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type WeightInputMode = 'direct' | 'perSide' | 'legacyUnspecified';
export type WeightLoadMultiplier = 1 | 2;

export interface TrainingMenuSet {
  id: string;
  setName: string;
  order: number;
  isDefault: boolean;
  isAiGenerated: boolean;
  setType: 'reusable' | 'temporary';
  source: 'manual' | 'ai';
  menuSetKind: 'training' | 'recovery';
  validFromDate?: string;
  validToDate?: string;
  isActive: boolean;
  version: number;
  itemIds: string[];
  items: TrainingMenuSetItem[];
}

export interface TrainingMenuSetItem {
  id: string;
  menuSetId: string;
  menuItemId: string;
  order: number;
  targetWeightKg: number;
  targetRepsMin: number;
  targetRepsMax: number;
  targetSets: number;
  recommendedIntervalDays: TrainingFrequencyDays;
  instruction: string;
  targetDurationMinutes?: number;
  createdBy: 'manual' | 'ai';
}

export interface ExerciseEntry {
  id: string;
  menuItemId: string;
  trainingName: string;
  muscleTargetsSnapshot: MuscleTarget[];
  movementFamilySnapshot: MovementFamily;
  jointActionsSnapshot: JointAction[];
  lateralitySnapshot: Laterality;
  loadModelSnapshot: LoadModel;
  classificationVersionSnapshot: number;
  bodyWeightKgSnapshot?: number;
  equipmentTypeSnapshot: EquipmentType;
  equipmentProfileIdSnapshot?: string;
  cableSettingsSnapshot?: CableSettings;
  note?: string;
  weightKg: number;
  additionalLoadKg?: number;
  assistanceKg?: number | null;
  weightInputModeSnapshot: WeightInputMode;
  loadMultiplierSnapshot?: WeightLoadMultiplier;
  fixedWeightKgSnapshot?: number;
  calculatedTotalWeightKg?: number;
  reps: number;
  sets: number;
  setDetails?: SetDetail[];
  sourceTrainingMenuSetId?: string;
  sourceTrainingMenuSetNameSnapshot?: string;
  sourceTrainingMenuSetItemId?: string;
  sourceTrainingMenuSetTypeSnapshot?: 'reusable' | 'temporary';
  targetWeightKgSnapshot?: number;
  targetRepsMinSnapshot?: number;
  targetRepsMaxSnapshot?: number;
  targetSetsSnapshot?: number;
  targetInstructionSnapshot?: string;
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
  menuSetId?: string;
  menuSetItemId?: string;
  menuSetName?: string;
  menuSetType?: 'reusable' | 'temporary';
  targetWeightKg?: number;
  targetRepsMin?: number;
  targetRepsMax?: number;
  targetSets?: number;
  targetInstruction?: string;
  weightKg?: number;
  reps?: number;
  sets?: number;
  memo?: string;
  setDetails?: SetDetail[];
}

export interface TrainingSessionDraft {
  targetDate: string;
  startedAtLocal: string;
  updatedAtLocal: string;
  entriesByItemId: Record<string, DraftEntry>;
}

export interface DailyRecord {
  date: string;
  timeZoneId: string;
  bodyWeightKg?: number | null;
  bodyFatPercent?: number | null;
  muscleMassKg?: number | null;
  bodyMetricMeasuredTime?: string | null;
  conditionRating?: ConditionRating;
  moodRating?: MoodRating;
  conditionComment?: string;
  sleepHours?: number;
  sleepQuality?: ConditionRating;
  fatigueLevel?: ConditionRating;
  motivationLevel?: ConditionRating;
  muscleSorenessLevel?: ConditionRating;
  painAreas?: PainArea[];
  restingHeartRate?: number;
  mealNotes?: string;
  diary?: string;
  otherActivities: string[];
}

export interface PainArea {
  area: string;
  severity: ConditionRating;
  occursAtRest: boolean;
  occursDuringMovement: boolean;
  numbness: boolean;
  weakness: boolean;
}

export interface Goal {
  targetWeightKg?: number;
  targetBodyFatPercent?: number;
  deadlineDate?: string;
  comment?: string;
  updatedAt?: string;
}

export type UserSex = 'male' | 'female' | 'other' | 'no-answer';

export interface UserProfile {
  userName: string;
  sex: UserSex;
  birthDate: string;
  heightCm: number | null;
  timeZoneId: string;
  userAvatarObjectKey?: string;
  userAvatarImageUrl?: string;
}

export type TonePreset = 'polite' | 'friendly-coach' | 'strict-coach';

export interface AiCharacterProfile {
  characterId: string;
  characterName: string;
  coachAvatarObjectKey?: string;
  avatarImageUrl: string;
  tonePreset: TonePreset;
  characterDescription: string;
  speechEnding: string;
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
  menuSets: TrainingMenuSet[];
  activeTrainingMenuSetId: string;
  gymVisits: GymVisit[];
  dailyRecords: Record<string, DailyRecord>;
  trainingDraft: TrainingSessionDraft | null;
  goal: Goal;
  aiAgentRoleName: string;
  aiCharacterProfile: AiCharacterProfile;
  aiChatSessions: ChatSession[];
  activeAiChatSessionId: string;
}

import { fetchAuthSession } from 'aws-amplify/auth';
import amplifyOutputs from '../amplify_outputs.json';
import type {
  EquipmentType,
  JointAction,
  Laterality,
  LoadModel,
  MovementFamily,
  MuscleTarget
} from '../muscleTaxonomy';
import type { CableSettings, Goal, UserProfile, WeightInputMode, WeightLoadMultiplier } from '../types';

type CoreEndpointOutput = {
  custom?: {
    endpoints?: {
      coreApiEndpoint?: string;
    };
  };
};

export type TrainingMenuItemDto = {
  trainingMenuItemId: string;
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
  isAiGenerated?: boolean;
  description?: string;
  weightInputMode?: WeightInputMode;
  loadMultiplier?: WeightLoadMultiplier;
  fixedWeightKg?: number;
  isActive: boolean;
  version: number;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
  updateReason?: string;
};

export type ListTrainingMenuItemsResponse = {
  items: TrainingMenuItemDto[];
  nextToken?: string;
};

export type TrainingMenuSetDto = {
  trainingMenuSetId: string;
  setName: string;
  menuSetOrder: number;
  isDefault: boolean;
  setType: 'reusable' | 'temporary';
  source: 'manual' | 'ai';
  menuSetKind: 'training' | 'recovery';
  validFromDate?: string;
  validToDate?: string;
  isActive: boolean;
  version: number;
  items: TrainingMenuSetItemDto[];
  createdAt?: string;
  updatedAt?: string;
};

export type TrainingMenuSetItemDto = {
  trainingMenuSetItemId: string;
  trainingMenuSetId: string;
  trainingMenuItemId: string;
  itemKind: 'training' | 'recovery';
  displayOrder: number;
  targetWeightKg: number;
  targetRepsMin: number;
  targetRepsMax: number;
  targetSets: number;
  recommendedIntervalDays: number;
  instruction: string;
  targetDurationMinutes?: number;
  createdBy: 'manual' | 'ai';
  createdAt?: string;
  updatedAt?: string;
};

type ListTrainingMenuSetsResponse = {
  items: TrainingMenuSetDto[];
};

type GymVisitEntryInput = {
  trainingMenuItemId: string;
  trainingNameSnapshot: string;
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
  isAiGeneratedSnapshot?: boolean;
  frequencySnapshot?: number;
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
  performedAtUtc: string;
  sourceTrainingMenuSetId?: string;
  sourceTrainingMenuSetNameSnapshot?: string;
  sourceTrainingMenuSetItemId?: string;
  sourceTrainingMenuSetTypeSnapshot?: 'reusable' | 'temporary';
  targetWeightKgSnapshot?: number;
  targetRepsMinSnapshot?: number;
  targetRepsMaxSnapshot?: number;
  targetSetsSnapshot?: number;
  targetInstructionSnapshot?: string;
};

type CreateGymVisitInput = {
  startedAtUtc: string;
  endedAtUtc: string;
  timeZoneId: string;
  visitDateLocal: string;
  entries: GymVisitEntryInput[];
  note?: string;
};

export type GymVisitDto = {
  visitId: string;
  startedAtUtc: string;
  endedAtUtc: string;
  timeZoneId: string;
  visitDateLocal: string;
  entries: GymVisitEntryInput[];
  note?: string;
  createdAt: string;
  updatedAt: string;
};

type ListGymVisitsResponse = {
  items: GymVisitDto[];
  nextToken?: string;
};

export type TrainingSessionViewItemDto = {
  trainingMenuItemId: string;
  trainingName: string;
  itemKind: 'training' | 'recovery';
  standardDurationMinutes?: number;
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
  isAiGenerated?: boolean;
  description?: string;
  trainingMenuSetItemId: string;
  targetWeightKg: number;
  targetRepsMin: number;
  targetRepsMax: number;
  targetSets: number;
  recommendedIntervalDays: number;
  instruction: string;
  targetDurationMinutes?: number;
  createdBy: 'manual' | 'ai';
  weightInputMode?: WeightInputMode;
  loadMultiplier?: WeightLoadMultiplier;
  fixedWeightKg?: number;
  displayOrder: number;
  isActive: boolean;
  lastPerformanceSnapshot?: {
    performedAtUtc: string;
    weightKg: number;
    weightInputModeSnapshot?: WeightInputMode;
    loadMultiplierSnapshot?: WeightLoadMultiplier;
    fixedWeightKgSnapshot?: number;
    calculatedTotalWeightKg?: number;
    reps: number;
    sets: number;
    muscleTargetsSnapshot: MuscleTarget[];
    movementFamilySnapshot: MovementFamily;
    jointActionsSnapshot: JointAction[];
    lateralitySnapshot: Laterality;
    loadModelSnapshot: LoadModel;
    classificationVersionSnapshot: number;
    bodyWeightKgSnapshot?: number;
    equipmentTypeSnapshot: EquipmentType;
    note?: string;
    visitDateLocal: string;
  };
};

export type TrainingSessionViewResponse = {
  menuSetKind: 'training' | 'recovery';
  resolvedMenuSet: {
    trainingMenuSetId: string;
    setName: string;
    setType: 'reusable' | 'temporary';
    source: 'manual' | 'ai';
    isDefault: boolean;
    menuSetKind: 'training' | 'recovery';
  } | null;
  resolvedFromDailyPlan: boolean;
  items: TrainingSessionViewItemDto[];
  todayDoneTrainingMenuItemIds: string[];
};

export type DailyRecordDto = {
  recordDate?: string;
  timeZoneId?: string;
  bodyWeightKg?: number;
  bodyFatPercent?: number;
  muscleMassKg?: number;
  bodyMetricMeasuredTimeLocal?: string;
  conditionRating?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  moodRating?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  conditionComment?: string;
  sleepHours?: number;
  sleepQuality?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  fatigueLevel?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  motivationLevel?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  muscleSorenessLevel?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  painAreas?: Array<{
    area: string;
    severity: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
    occursAtRest: boolean;
    occursDuringMovement: boolean;
    numbness: boolean;
    weakness: boolean;
  }>;
  restingHeartRate?: number;
  mealNotes?: string;
  diary?: string;
  otherActivities?: string[];
  createdAt?: string;
  updatedAt?: string;
};

type ListDailyRecordsResponse = {
  items: DailyRecordDto[];
  nextToken?: string;
};

type CalendarDayDto = {
  date?: string;
  trained?: boolean;
  recovered?: boolean;
  plannedMenuSetName?: string;
  plannedMenuSetKind?: 'training' | 'recovery';
  planStatus?: 'none' | 'planned' | 'as_planned' | 'changed' | 'additional';
  conditionRating?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | null;
  moodRating?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | null;
};

type CalendarMonthResponse = {
  month?: string;
  days?: CalendarDayDto[];
};

type GoalDto = {
  targetWeightKg?: number;
  targetBodyFatPercent?: number;
  deadlineDate?: string;
  comment?: string;
  updatedAt?: string;
};

type AiCharacterProfileDto = {
  characterId?: string;
  characterName?: string;
  coachAvatarObjectKey?: string;
  avatarImageUrl?: string;
  tonePreset?: string;
  characterDescription?: string;
  speechEnding?: string;
  updatedAt?: string;
};

type AvatarUploadTarget = 'user' | 'coach';

export type CoachingSourceDto = 'chatgpt' | 'claude' | 'kintrain' | 'user' | 'other';
export type CoachingNoteCategoryDto = 'observation' | 'decision' | 'follow-up' | 'temporary-constraint';

export type CoachingContextDto = {
  goalSummary: string;
  constraints: string[];
  preferences: string[];
  trainingPolicy: string;
  nextReviewDate?: string;
  version: number;
  updatedAt?: string;
  updatedBySource?: CoachingSourceDto;
  changeReason?: string;
};

export type CoachingNoteDto = {
  noteId: string;
  category: CoachingNoteCategoryDto;
  content: string;
  validFromDate?: string;
  validToDate?: string;
  source: CoachingSourceDto;
  createdAt: string;
  expiresAt: string;
};

export type CoachingRevisionDto = CoachingContextDto & {
  revisionId: string;
  source: CoachingSourceDto;
  changeReason: string;
  createdAt: string;
};

export type CoachingContextResponse = {
  context: CoachingContextDto;
  notes: CoachingNoteDto[];
  revisions: CoachingRevisionDto[];
  limits: {
    activeNotes: number;
    returnedToAi: number;
    noteRetentionDays: number;
    revisions: number;
    revisionRetentionDays: number;
  };
};

type AvatarUploadPresignResponse = {
  uploadUrl: string;
  fields: Record<string, string>;
  objectKey: string;
  expiresInSeconds: number;
  maxSizeBytes: number;
};

const coreApiEndpoint = (amplifyOutputs as CoreEndpointOutput).custom?.endpoints?.coreApiEndpoint ?? '';
const baseUrl = coreApiEndpoint.replace(/\/+$/, '');

function assertApiConfigured(): void {
  if (!baseUrl) {
    throw new Error('Core API endpoint is not configured. Run ampx generate outputs.');
  }
}

async function getAccessToken(): Promise<string> {
  const session = await fetchAuthSession();
  const token = session.tokens?.accessToken?.toString();
  if (!token) {
    throw new Error('Cognito access token is not available.');
  }
  return token;
}

async function coreApiFetch<T>(path: string, init: RequestInit): Promise<T> {
  assertApiConfigured();
  const token = await getAccessToken();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {})
    }
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const json = (await response.json().catch(() => null)) as { message?: string } | null;
  if (!response.ok) {
    throw new Error(json?.message ?? `Core API request failed (${response.status}).`);
  }

  return json as T;
}

export async function getProfile(): Promise<UserProfile> {
  const profile = await coreApiFetch<
    UserProfile & {
      userAvatarObjectKey?: string;
      userAvatarImageUrl?: string;
      updatedAt?: string;
    }
  >('/me/profile', {
    method: 'GET'
  });
  return {
    userName: profile.userName ?? '',
    sex: profile.sex ?? 'no-answer',
    birthDate: profile.birthDate ?? '',
    heightCm: typeof profile.heightCm === 'number' ? profile.heightCm : null,
    timeZoneId: profile.timeZoneId ?? 'Asia/Tokyo',
    userAvatarObjectKey: typeof profile.userAvatarObjectKey === 'string' ? profile.userAvatarObjectKey : undefined,
    userAvatarImageUrl: typeof profile.userAvatarImageUrl === 'string' ? profile.userAvatarImageUrl : undefined
  };
}

type UserProfileUpsertInput = {
  userName: string;
  sex: UserProfile['sex'];
  birthDate: string;
  heightCm: number | null;
  timeZoneId: string;
  userAvatarObjectKey?: string | null;
};

export async function putProfile(profile: UserProfileUpsertInput): Promise<UserProfile> {
  const saved = await coreApiFetch<UserProfile>('/me/profile', {
    method: 'PUT',
    body: JSON.stringify(profile)
  });
  return {
    ...saved,
    userAvatarObjectKey: typeof saved.userAvatarObjectKey === 'string' ? saved.userAvatarObjectKey : undefined,
    userAvatarImageUrl: typeof saved.userAvatarImageUrl === 'string' ? saved.userAvatarImageUrl : undefined
  };
}

export async function listTrainingMenuItems(params?: {
  limit?: number;
  nextToken?: string;
  itemKind?: 'training' | 'recovery';
}): Promise<ListTrainingMenuItemsResponse> {
  const search = new URLSearchParams();
  if (typeof params?.limit === 'number' && Number.isFinite(params.limit)) {
    search.set('limit', String(Math.floor(params.limit)));
  }
  if (params?.nextToken) {
    search.set('nextToken', params.nextToken);
  }
  if (params?.itemKind) {
    search.set('itemKind', params.itemKind);
  }
  const query = search.toString();
  return coreApiFetch<ListTrainingMenuItemsResponse>(query ? `/training-menu-items?${query}` : '/training-menu-items', {
    method: 'GET'
  });
}

export async function createTrainingMenuItem(input: {
  trainingName: string;
  itemKind?: 'training' | 'recovery';
  standardDurationMinutes?: number | null;
  exerciseFamilyId?: string;
  muscleTargets?: MuscleTarget[];
  movementFamily?: MovementFamily;
  jointActions?: JointAction[];
  laterality?: Laterality;
  loadModel?: LoadModel;
  equipmentType?: EquipmentType;
  equipmentProfileId?: string;
  cableSettings?: CableSettings;
  isAiGenerated?: boolean;
  description?: string;
  weightInputMode: WeightInputMode;
  loadMultiplier: WeightLoadMultiplier;
  fixedWeightKg: number;
}): Promise<TrainingMenuItemDto> {
  return coreApiFetch<TrainingMenuItemDto>('/training-menu-items', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export async function updateTrainingMenuItem(
  trainingMenuItemId: string,
  input: Partial<{
    trainingName: string;
    itemKind: 'training' | 'recovery';
    standardDurationMinutes: number | null;
    exerciseFamilyId: string;
    muscleTargets: MuscleTarget[];
    movementFamily: MovementFamily;
    jointActions: JointAction[];
    laterality: Laterality;
    loadModel: LoadModel;
    equipmentType: EquipmentType;
    equipmentProfileId: string;
    cableSettings: CableSettings;
    isAiGenerated: boolean;
    description: string;
    weightInputMode: WeightInputMode;
    loadMultiplier: WeightLoadMultiplier;
    fixedWeightKg: number;
    isActive: boolean;
    expectedVersion: number;
    updateReason: string;
  }>
): Promise<TrainingMenuItemDto> {
  return coreApiFetch<TrainingMenuItemDto>(`/training-menu-items/${trainingMenuItemId}`, {
    method: 'PUT',
    body: JSON.stringify(input)
  });
}

export async function deleteTrainingMenuItem(trainingMenuItemId: string): Promise<void> {
  await coreApiFetch<void>(`/training-menu-items/${trainingMenuItemId}`, {
    method: 'DELETE'
  });
}

export async function reorderTrainingMenuItems(items: Array<{ trainingMenuItemId: string; displayOrder: number }>): Promise<void> {
  await coreApiFetch<void>('/training-menu-items/reorder', {
    method: 'PUT',
    body: JSON.stringify({ items })
  });
}

export async function listTrainingMenuSets(): Promise<ListTrainingMenuSetsResponse> {
  return coreApiFetch<ListTrainingMenuSetsResponse>('/training-menu-sets', {
    method: 'GET'
  });
}

export async function createTrainingMenuSet(input: {
  setName: string;
  menuSetKind?: 'training' | 'recovery';
  setType?: 'reusable' | 'temporary';
  source?: 'manual' | 'ai';
  validFromDate?: string;
  validToDate?: string;
  scheduledDates?: string[];
  replaceExistingPlan?: boolean;
  isDefault?: boolean;
}): Promise<TrainingMenuSetDto> {
  return coreApiFetch<TrainingMenuSetDto>('/training-menu-sets', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export async function updateTrainingMenuSet(
  trainingMenuSetId: string,
  input: Partial<{
    setName: string;
    menuSetKind: 'training' | 'recovery';
    setType: 'reusable' | 'temporary';
    source: 'manual' | 'ai';
    validFromDate?: string;
    validToDate?: string;
    replaceExistingPlan?: boolean;
    isDefault: boolean;
    expectedVersion: number;
  }>
): Promise<TrainingMenuSetDto> {
  return coreApiFetch<TrainingMenuSetDto>(`/training-menu-sets/${trainingMenuSetId}`, {
    method: 'PUT',
    body: JSON.stringify(input)
  });
}

export async function deleteTrainingMenuSet(trainingMenuSetId: string): Promise<void> {
  await coreApiFetch<void>(`/training-menu-sets/${trainingMenuSetId}`, {
    method: 'DELETE'
  });
}

export async function addTrainingMenuItemToSet(
  trainingMenuSetId: string,
  input: {
    trainingMenuItemId: string;
    targetWeightKg?: number;
    targetRepsMin?: number;
    targetRepsMax?: number;
    targetSets?: number;
    recommendedIntervalDays?: number;
    targetDurationMinutes?: number;
    instruction?: string;
    createdBy?: 'manual' | 'ai';
  }
): Promise<TrainingMenuSetItemDto> {
  return coreApiFetch<TrainingMenuSetItemDto>(`/training-menu-sets/${trainingMenuSetId}/items`, {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export async function updateTrainingMenuSetItem(
  trainingMenuSetId: string,
  trainingMenuSetItemId: string,
  input: Partial<{
    targetWeightKg: number;
    targetRepsMin: number;
    targetRepsMax: number;
    targetSets: number;
    recommendedIntervalDays: number;
    targetDurationMinutes: number | null;
    instruction: string;
  }>
): Promise<TrainingMenuSetItemDto> {
  return coreApiFetch<TrainingMenuSetItemDto>(
    `/training-menu-sets/${trainingMenuSetId}/items/${trainingMenuSetItemId}`,
    { method: 'PUT', body: JSON.stringify(input) }
  );
}

export async function removeTrainingMenuItemFromSet(
  trainingMenuSetId: string,
  trainingMenuSetItemId: string
): Promise<void> {
  await coreApiFetch<void>(`/training-menu-sets/${trainingMenuSetId}/items/${trainingMenuSetItemId}`, {
    method: 'DELETE'
  });
}

export async function reorderTrainingMenuSetItems(
  trainingMenuSetId: string,
  items: Array<{ trainingMenuSetItemId: string; displayOrder: number }>
): Promise<void> {
  await coreApiFetch<void>(`/training-menu-sets/${trainingMenuSetId}/items/reorder`, {
    method: 'PUT',
    body: JSON.stringify({ items })
  });
}

export type DailyTrainingPlanDto = {
  planDate: string;
  trainingMenuSetId: string;
  menuSetKind: 'training' | 'recovery';
  menuSetName: string;
  source: 'manual' | 'ai';
  createdAt: string;
  updatedAt: string;
};

export async function getDailyTrainingPlan(date: string): Promise<DailyTrainingPlanDto | null> {
  try {
    return await coreApiFetch<DailyTrainingPlanDto>(`/daily-training-plans/${encodeURIComponent(date)}`, {
      method: 'GET'
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('not found')) {
      return null;
    }
    throw error;
  }
}

export async function putDailyTrainingPlan(
  date: string,
  trainingMenuSetId: string,
  source: 'manual' | 'ai' = 'manual'
): Promise<DailyTrainingPlanDto> {
  return coreApiFetch<DailyTrainingPlanDto>(`/daily-training-plans/${encodeURIComponent(date)}`, {
    method: 'PUT',
    body: JSON.stringify({ trainingMenuSetId, source })
  });
}

export type RecoveryExecutionEntryInput = {
  menuItemId: string;
  activityNameSnapshot: string;
  sourceMenuSetItemId: string;
  targetDurationMinutesSnapshot?: number;
  actualDurationMinutes?: number;
  instructionSnapshot?: string;
  note?: string;
  performedAtUtc: string;
};

export type RecoveryExecutionDto = {
  executionId: string;
  menuSetKind: 'recovery';
  executionDateLocal: string;
  sourceMenuSetId: string;
  sourceMenuSetNameSnapshot: string;
  planRelationAtRegistration: 'matches_plan' | 'differs_from_plan' | 'no_plan' | 'additional';
  entries: RecoveryExecutionEntryInput[];
  createdAt: string;
};

export async function createRecoveryExecution(input: {
  executionDateLocal: string;
  timeZoneId: string;
  sourceMenuSetId: string;
  sourceMenuSetNameSnapshot: string;
  sourceMenuSetTypeSnapshot: 'reusable' | 'temporary';
  entries: RecoveryExecutionEntryInput[];
}): Promise<{ executionId: string }> {
  return coreApiFetch<{ executionId: string }>('/menu-executions', {
    method: 'POST',
    body: JSON.stringify({ menuSetKind: 'recovery', ...input })
  });
}

export async function listRecoveryExecutions(params?: { from?: string; to?: string }): Promise<RecoveryExecutionDto[]> {
  const search = new URLSearchParams({ limit: '200', menuSetKind: 'recovery' });
  if (params?.from) search.set('from', params.from);
  if (params?.to) search.set('to', params.to);
  const items: RecoveryExecutionDto[] = [];
  let nextToken: string | undefined;
  do {
    if (nextToken) search.set('nextToken', nextToken);
    const result = await coreApiFetch<{
      items: Array<RecoveryExecutionDto | GymVisitDto>;
      nextToken?: string;
    }>(`/menu-executions?${search.toString()}`, { method: 'GET' });
    items.push(...result.items.filter(
      (item): item is RecoveryExecutionDto => 'menuSetKind' in item && item.menuSetKind === 'recovery'
    ));
    nextToken = result.nextToken;
  } while (nextToken);
  return items;
}

export async function deleteDailyTrainingPlan(date: string): Promise<void> {
  await coreApiFetch<void>(`/daily-training-plans/${encodeURIComponent(date)}`, { method: 'DELETE' });
}

export async function createGymVisit(input: CreateGymVisitInput): Promise<GymVisitDto> {
  return coreApiFetch<GymVisitDto>('/gym-visits', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export async function listGymVisits(params?: {
  from?: string;
  to?: string;
  limit?: number;
  nextToken?: string;
}): Promise<ListGymVisitsResponse> {
  const search = new URLSearchParams();
  if (params?.from) {
    search.set('from', params.from);
  }
  if (params?.to) {
    search.set('to', params.to);
  }
  if (typeof params?.limit === 'number' && Number.isFinite(params.limit)) {
    search.set('limit', String(Math.floor(params.limit)));
  }
  if (params?.nextToken) {
    search.set('nextToken', params.nextToken);
  }
  const query = search.toString();
  const path = query ? `/gym-visits?${query}` : '/gym-visits';

  return coreApiFetch<ListGymVisitsResponse>(path, {
    method: 'GET'
  });
}

export async function getTrainingSessionView(date: string, trainingMenuSetId?: string): Promise<TrainingSessionViewResponse> {
  const search = new URLSearchParams();
  search.set('date', date);
  if (trainingMenuSetId) {
    search.set('trainingMenuSetId', trainingMenuSetId);
  }
  return coreApiFetch<TrainingSessionViewResponse>(`/training-session-view?${search.toString()}`, {
    method: 'GET'
  });
}

export async function putDailyRecord(
  date: string,
  input: Partial<{
    bodyWeightKg: number | null;
    bodyFatPercent: number | null;
    muscleMassKg: number | null;
    bodyMetricMeasuredTimeLocal: string | null;
    timeZoneId: string;
    conditionRating: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
    moodRating: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
    conditionComment: string;
    sleepHours: number;
    sleepQuality: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
    fatigueLevel: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
    motivationLevel: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
    muscleSorenessLevel: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
    painAreas: Array<{
      area: string;
      severity: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
      occursAtRest: boolean;
      occursDuringMovement: boolean;
      numbness: boolean;
      weakness: boolean;
    }>;
    restingHeartRate: number;
    mealNotes: string;
    diary: string;
    otherActivities: string[];
  }>
): Promise<void> {
  await coreApiFetch<void>(`/daily-records/${encodeURIComponent(date)}`, {
    method: 'PUT',
    body: JSON.stringify(input)
  });
}

export async function listDailyRecords(params?: {
  from?: string;
  to?: string;
  limit?: number;
  nextToken?: string;
}): Promise<ListDailyRecordsResponse> {
  const search = new URLSearchParams();
  if (params?.from) {
    search.set('from', params.from);
  }
  if (params?.to) {
    search.set('to', params.to);
  }
  if (typeof params?.limit === 'number' && Number.isFinite(params.limit)) {
    search.set('limit', String(Math.floor(params.limit)));
  }
  if (params?.nextToken) {
    search.set('nextToken', params.nextToken);
  }
  const query = search.toString();
  return coreApiFetch<ListDailyRecordsResponse>(query ? `/daily-records?${query}` : '/daily-records', {
    method: 'GET'
  });
}

export async function getDailyRecord(date: string): Promise<DailyRecordDto> {
  return coreApiFetch<DailyRecordDto>(`/daily-records/${encodeURIComponent(date)}`, {
    method: 'GET'
  });
}

export async function getCalendarMonth(month: string): Promise<CalendarMonthResponse> {
  const search = new URLSearchParams();
  search.set('month', month);
  return coreApiFetch<CalendarMonthResponse>(`/calendar?${search.toString()}`, {
    method: 'GET'
  });
}

export async function getGoal(): Promise<Goal> {
  const goal = await coreApiFetch<GoalDto>('/goals', {
    method: 'GET'
  });
  return {
    targetWeightKg: typeof goal.targetWeightKg === 'number' ? goal.targetWeightKg : undefined,
    targetBodyFatPercent: typeof goal.targetBodyFatPercent === 'number' ? goal.targetBodyFatPercent : undefined,
    deadlineDate:
      typeof goal.deadlineDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(goal.deadlineDate) ? goal.deadlineDate : undefined,
    comment: typeof goal.comment === 'string' ? goal.comment : undefined,
    updatedAt: typeof goal.updatedAt === 'string' ? goal.updatedAt : undefined
  };
}

export async function putGoal(input: {
  targetWeightKg: number;
  targetBodyFatPercent: number;
  deadlineDate?: string;
  comment?: string;
}): Promise<Goal> {
  const saved = await coreApiFetch<GoalDto>('/goals', {
    method: 'PUT',
    body: JSON.stringify(input)
  });
  return {
    targetWeightKg: typeof saved.targetWeightKg === 'number' ? saved.targetWeightKg : input.targetWeightKg,
    targetBodyFatPercent:
      typeof saved.targetBodyFatPercent === 'number' ? saved.targetBodyFatPercent : input.targetBodyFatPercent,
    deadlineDate:
      typeof saved.deadlineDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(saved.deadlineDate) ? saved.deadlineDate : undefined,
    comment: typeof saved.comment === 'string' ? saved.comment : undefined,
    updatedAt: typeof saved.updatedAt === 'string' ? saved.updatedAt : undefined
  };
}

export async function getAiCharacterProfile(): Promise<AiCharacterProfileDto> {
  return coreApiFetch<AiCharacterProfileDto>('/ai-character-profile', {
    method: 'GET'
  });
}

export async function putAiCharacterProfile(input: {
  characterId: string;
  characterName: string;
  coachAvatarObjectKey?: string | null;
  avatarImageUrl?: string;
  tonePreset: string;
  characterDescription: string;
  speechEnding: string;
}): Promise<AiCharacterProfileDto> {
  return coreApiFetch<AiCharacterProfileDto>('/ai-character-profile', {
    method: 'PUT',
    body: JSON.stringify(input)
  });
}

export async function getCoachingContext(): Promise<CoachingContextResponse> {
  return coreApiFetch<CoachingContextResponse>('/coaching-context', {
    method: 'GET'
  });
}

export async function putCoachingContext(input: {
  goalSummary: string;
  constraints: string[];
  preferences: string[];
  trainingPolicy: string;
  nextReviewDate?: string;
  expectedVersion: number;
  changeReason: string;
}): Promise<CoachingContextDto> {
  return coreApiFetch<CoachingContextDto>('/coaching-context', {
    method: 'PUT',
    body: JSON.stringify(input)
  });
}

export async function appendCoachingNote(input: {
  idempotencyKey: string;
  category: CoachingNoteCategoryDto;
  content: string;
  validFromDate?: string;
  validToDate?: string;
}): Promise<{ note: CoachingNoteDto; created: boolean }> {
  return coreApiFetch<{ note: CoachingNoteDto; created: boolean }>('/coaching-notes', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export async function deleteCoachingNote(noteId: string): Promise<void> {
  await coreApiFetch<void>(`/coaching-notes/${encodeURIComponent(noteId)}`, {
    method: 'DELETE'
  });
}

export async function uploadAvatarImage(
  target: AvatarUploadTarget,
  file: File
): Promise<{ objectKey: string; maxSizeBytes: number }> {
  const presign = await coreApiFetch<AvatarUploadPresignResponse>('/avatar-upload/presign', {
    method: 'POST',
    body: JSON.stringify({
      target,
      fileName: file.name,
      contentType: file.type,
      fileSizeBytes: file.size
    })
  });

  const formData = new FormData();
  for (const [key, value] of Object.entries(presign.fields)) {
    formData.append(key, value);
  }
  if (!Object.prototype.hasOwnProperty.call(presign.fields, 'Content-Type')) {
    formData.append('Content-Type', file.type);
  }
  formData.append('file', file);

  const uploadResponse = await fetch(presign.uploadUrl, {
    method: 'POST',
    body: formData
  });

  if (!uploadResponse.ok) {
    throw new Error(`Avatar upload failed (${uploadResponse.status}).`);
  }

  return {
    objectKey: presign.objectKey,
    maxSizeBytes: presign.maxSizeBytes
  };
}

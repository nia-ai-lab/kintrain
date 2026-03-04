import { fetchAuthSession } from 'aws-amplify/auth';
import amplifyOutputs from '../amplify_outputs.json';
import type { UserProfile } from '../types';

type CoreEndpointOutput = {
  custom?: {
    endpoints?: {
      coreApiEndpoint?: string;
    };
  };
};

type TrainingMenuItemDto = {
  trainingMenuItemId: string;
  trainingName: string;
  bodyPart?: string;
  defaultWeightKg: number;
  defaultRepsMin: number;
  defaultRepsMax: number;
  defaultReps?: number;
  defaultSets: number;
  displayOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

type ListTrainingMenuItemsResponse = {
  items: TrainingMenuItemDto[];
  nextToken?: string;
};

export type TrainingMenuSetDto = {
  trainingMenuSetId: string;
  setName: string;
  menuSetOrder: number;
  isDefault: boolean;
  isActive: boolean;
  itemIds: string[];
  createdAt?: string;
  updatedAt?: string;
};

type ListTrainingMenuSetsResponse = {
  items: TrainingMenuSetDto[];
};

type GymVisitEntryInput = {
  trainingMenuItemId: string;
  trainingNameSnapshot: string;
  bodyPartSnapshot?: string;
  weightKg: number;
  reps: number;
  sets: number;
  performedAtUtc: string;
};

type CreateGymVisitInput = {
  startedAtUtc: string;
  endedAtUtc: string;
  timeZoneId: string;
  visitDateLocal: string;
  entries: GymVisitEntryInput[];
  note?: string;
};

type GymVisitDto = {
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
};

type DailyRecordDto = {
  recordDate?: string;
  timeZoneId?: string;
  bodyWeightKg?: number;
  bodyFatPercent?: number;
  bodyMetricMeasuredTimeLocal?: string;
  conditionRating?: 1 | 2 | 3 | 4 | 5;
  conditionComment?: string;
  diary?: string;
  otherActivities?: string[];
};

type ListDailyRecordsResponse = {
  items: DailyRecordDto[];
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

export async function listTrainingMenuItems(): Promise<ListTrainingMenuItemsResponse> {
  return coreApiFetch<ListTrainingMenuItemsResponse>('/training-menu-items', {
    method: 'GET'
  });
}

export async function createTrainingMenuItem(input: {
  trainingName: string;
  bodyPart?: string;
  defaultWeightKg: number;
  defaultRepsMin: number;
  defaultRepsMax: number;
  defaultReps?: number;
  defaultSets: number;
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
    bodyPart: string;
    defaultWeightKg: number;
    defaultRepsMin: number;
    defaultRepsMax: number;
    defaultReps: number;
    defaultSets: number;
    isActive: boolean;
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

export async function createTrainingMenuSet(input: { setName: string; isDefault?: boolean }): Promise<TrainingMenuSetDto> {
  return coreApiFetch<TrainingMenuSetDto>('/training-menu-sets', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export async function updateTrainingMenuSet(
  trainingMenuSetId: string,
  input: Partial<{
    setName: string;
    isDefault: boolean;
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

export async function addTrainingMenuItemToSet(trainingMenuSetId: string, trainingMenuItemId: string): Promise<void> {
  await coreApiFetch<void>(`/training-menu-sets/${trainingMenuSetId}/items`, {
    method: 'POST',
    body: JSON.stringify({ trainingMenuItemId })
  });
}

export async function removeTrainingMenuItemFromSet(trainingMenuSetId: string, trainingMenuItemId: string): Promise<void> {
  await coreApiFetch<void>(`/training-menu-sets/${trainingMenuSetId}/items/${trainingMenuItemId}`, {
    method: 'DELETE'
  });
}

export async function reorderTrainingMenuSetItems(
  trainingMenuSetId: string,
  items: Array<{ trainingMenuItemId: string; displayOrder: number }>
): Promise<void> {
  await coreApiFetch<void>(`/training-menu-sets/${trainingMenuSetId}/items/reorder`, {
    method: 'PUT',
    body: JSON.stringify({ items })
  });
}

export async function createGymVisit(input: CreateGymVisitInput): Promise<GymVisitDto> {
  return coreApiFetch<GymVisitDto>('/gym-visits', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export async function listGymVisits(params?: { from?: string; to?: string; limit?: number }): Promise<ListGymVisitsResponse> {
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
  const query = search.toString();
  const path = query ? `/gym-visits?${query}` : '/gym-visits';

  return coreApiFetch<ListGymVisitsResponse>(path, {
    method: 'GET'
  });
}

export async function putDailyRecord(
  date: string,
  input: Partial<{
    bodyWeightKg: number;
    bodyFatPercent: number;
    bodyMetricMeasuredTimeLocal: string;
    timeZoneId: string;
    conditionRating: 1 | 2 | 3 | 4 | 5;
    conditionComment: string;
    diary: string;
    otherActivities: string[];
  }>
): Promise<void> {
  await coreApiFetch<void>(`/daily-records/${encodeURIComponent(date)}`, {
    method: 'PUT',
    body: JSON.stringify(input)
  });
}

export async function listDailyRecords(params: { from: string; to: string }): Promise<ListDailyRecordsResponse> {
  const search = new URLSearchParams();
  search.set('from', params.from);
  search.set('to', params.to);
  return coreApiFetch<ListDailyRecordsResponse>(`/daily-records?${search.toString()}`, {
    method: 'GET'
  });
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

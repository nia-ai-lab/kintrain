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
  const profile = await coreApiFetch<UserProfile & { updatedAt?: string }>('/me/profile', {
    method: 'GET'
  });
  return {
    userName: profile.userName ?? '',
    sex: profile.sex ?? 'no-answer',
    birthDate: profile.birthDate ?? '',
    heightCm: typeof profile.heightCm === 'number' ? profile.heightCm : null,
    timeZoneId: profile.timeZoneId ?? 'Asia/Tokyo'
  };
}

export async function putProfile(profile: UserProfile): Promise<UserProfile> {
  return coreApiFetch<UserProfile>('/me/profile', {
    method: 'PUT',
    body: JSON.stringify(profile)
  });
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

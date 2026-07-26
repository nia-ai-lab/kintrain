import {
  getGoal,
  getProfile,
  listDailyRecords,
  listGymVisits,
  listTrainingMenuItems,
  listTrainingMenuSets,
  type DailyRecordDto,
  type GymVisitDto,
  type TrainingMenuItemDto
} from '../api/coreApi';

export type AnalysisExportRange =
  | {
      rangeMode: 'dateRange';
      from: string;
      to: string;
    }
  | {
      rangeMode: 'allAvailable';
    };

export type AnalysisExportProgress = {
  section: 'profile' | 'trainingMenus' | 'dailyRecords' | 'gymVisits' | 'complete';
  fetched: number;
};

type Page<T> = {
  items: T[];
  nextToken?: string;
};

async function collectPages<T>(
  fetchPage: (nextToken?: string) => Promise<Page<T>>,
  onPage?: (count: number) => void
): Promise<T[]> {
  const items: T[] = [];
  let nextToken: string | undefined;
  do {
    const page = await fetchPage(nextToken);
    items.push(...page.items);
    nextToken = page.nextToken || undefined;
    onPage?.(items.length);
  } while (nextToken);
  return items;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeDailyRecord(item: DailyRecordDto) {
  return {
    date: nullableString(item.recordDate),
    timeZoneId: nullableString(item.timeZoneId),
    bodyWeightKg: nullableNumber(item.bodyWeightKg),
    bodyFatPercent: nullableNumber(item.bodyFatPercent),
    bodyMetricMeasuredTimeLocal: nullableString(item.bodyMetricMeasuredTimeLocal),
    conditionRating: nullableNumber(item.conditionRating),
    moodRating: nullableNumber(item.moodRating),
    conditionComment: nullableString(item.conditionComment),
    diary: nullableString(item.diary),
    otherActivities: Array.isArray(item.otherActivities) ? item.otherActivities : [],
    createdAtUtc: nullableString(item.createdAt),
    updatedAtUtc: nullableString(item.updatedAt)
  };
}

function normalizeGymVisit(item: GymVisitDto) {
  return {
    visitId: item.visitId,
    date: item.visitDateLocal,
    startedAtUtc: item.startedAtUtc,
    endedAtUtc: item.endedAtUtc,
    timeZoneId: item.timeZoneId,
    note: nullableString(item.note),
    entries: (item.entries ?? []).map((entry) => ({
      trainingMenuItemId: entry.trainingMenuItemId,
      trainingName: entry.trainingNameSnapshot,
      bodyPart: nullableString(entry.bodyPartSnapshot),
      equipment: nullableString(entry.equipmentSnapshot),
      isAiGenerated: entry.isAiGeneratedSnapshot === true,
      frequencyDays: nullableNumber(entry.frequencySnapshot),
      weightKg: entry.weightKg,
      reps: entry.reps,
      sets: entry.sets,
      performedAtUtc: entry.performedAtUtc,
      note: nullableString(entry.note)
    })),
    createdAtUtc: nullableString(item.createdAt),
    updatedAtUtc: nullableString(item.updatedAt)
  };
}

function normalizeTrainingMenu(item: TrainingMenuItemDto) {
  return {
    trainingMenuItemId: item.trainingMenuItemId,
    trainingName: item.trainingName,
    bodyPart: nullableString(item.bodyPart),
    equipment: nullableString(item.equipment),
    isAiGenerated: item.isAiGenerated === true,
    description: nullableString(item.description),
    frequencyDays: nullableNumber(item.frequency),
    defaultWeightKg: item.defaultWeightKg,
    defaultRepsMin: item.defaultRepsMin,
    defaultRepsMax: item.defaultRepsMax,
    defaultSets: item.defaultSets,
    displayOrder: item.displayOrder,
    isActive: item.isActive,
    createdAtUtc: nullableString(item.createdAt),
    updatedAtUtc: nullableString(item.updatedAt)
  };
}

export async function createAnalysisExport(
  range: AnalysisExportRange,
  onProgress?: (progress: AnalysisExportProgress) => void
) {
  onProgress?.({ section: 'profile', fetched: 0 });
  const [profile, goal, menuSetsResponse] = await Promise.all([getProfile(), getGoal(), listTrainingMenuSets()]);

  onProgress?.({ section: 'trainingMenus', fetched: 0 });
  const trainingMenus = await collectPages(
    (nextToken) => listTrainingMenuItems({ limit: 200, nextToken }),
    (fetched) => onProgress?.({ section: 'trainingMenus', fetched })
  );

  const dateParams =
    range.rangeMode === 'dateRange'
      ? {
          from: range.from,
          to: range.to
        }
      : {};

  onProgress?.({ section: 'dailyRecords', fetched: 0 });
  const dailyRecords = await collectPages(
    (nextToken) => listDailyRecords({ ...dateParams, limit: 200, nextToken }),
    (fetched) => onProgress?.({ section: 'dailyRecords', fetched })
  );

  onProgress?.({ section: 'gymVisits', fetched: 0 });
  const gymVisits = await collectPages(
    (nextToken) => listGymVisits({ ...dateParams, limit: 200, nextToken }),
    (fetched) => onProgress?.({ section: 'gymVisits', fetched })
  );

  const normalizedDailyRecords = dailyRecords
    .map(normalizeDailyRecord)
    .filter((item): item is ReturnType<typeof normalizeDailyRecord> & { date: string } => item.date !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
  const normalizedGymVisits = gymVisits.map(normalizeGymVisit).sort((a, b) => {
    const dateComparison = a.date.localeCompare(b.date);
    return dateComparison !== 0 ? dateComparison : a.startedAtUtc.localeCompare(b.startedAtUtc);
  });
  const historyDates = [
    ...normalizedDailyRecords.map((item) => item.date),
    ...normalizedGymVisits.map((item) => item.date)
  ].sort();

  const result = {
    schema: 'kintrain.analysis-export',
    schemaVersion: 1,
    generatedAtUtc: new Date().toISOString(),
    selection: {
      rangeMode: range.rangeMode,
      fromLocalDate: range.rangeMode === 'dateRange' ? range.from : null,
      toLocalDate: range.rangeMode === 'dateRange' ? range.to : null,
      inclusive: true,
      timeZoneId: profile.timeZoneId
    },
    coverage: {
      firstRecordDate: historyDates[0] ?? null,
      lastRecordDate: historyDates.at(-1) ?? null,
      dailyRecordCount: normalizedDailyRecords.length,
      gymVisitCount: normalizedGymVisits.length
    },
    currentContext: {
      userProfile: {
        userName: profile.userName,
        sex: profile.sex,
        birthDate: nullableString(profile.birthDate),
        heightCm: nullableNumber(profile.heightCm),
        timeZoneId: profile.timeZoneId
      },
      goal:
        goal.targetWeightKg === undefined && goal.targetBodyFatPercent === undefined
          ? null
          : {
              targetWeightKg: nullableNumber(goal.targetWeightKg),
              targetBodyFatPercent: nullableNumber(goal.targetBodyFatPercent),
              deadlineDate: nullableString(goal.deadlineDate),
              comment: nullableString(goal.comment),
              updatedAtUtc: nullableString(goal.updatedAt)
            },
      trainingMenus: trainingMenus.map(normalizeTrainingMenu).sort((a, b) => a.displayOrder - b.displayOrder),
      trainingMenuSets: menuSetsResponse.items
        .map((item) => ({
          trainingMenuSetId: item.trainingMenuSetId,
          setName: item.setName,
          displayOrder: item.menuSetOrder,
          isDefault: item.isDefault,
          isAiGenerated: item.isAiGenerated === true,
          isActive: item.isActive,
          trainingMenuItemIds: item.itemIds,
          createdAtUtc: nullableString(item.createdAt),
          updatedAtUtc: nullableString(item.updatedAt)
        }))
        .sort((a, b) => a.displayOrder - b.displayOrder)
    },
    history: {
      dailyRecords: normalizedDailyRecords,
      gymVisits: normalizedGymVisits
    }
  };

  onProgress?.({
    section: 'complete',
    fetched: normalizedDailyRecords.length + normalizedGymVisits.length
  });
  return result;
}

export type AnalysisExport = Awaited<ReturnType<typeof createAnalysisExport>>;

export function isValidAnalysisDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return (
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3])
  );
}

export function analysisExportFileName(exportData: AnalysisExport): string {
  const range =
    exportData.selection.rangeMode === 'allAvailable'
      ? 'all'
      : `${exportData.selection.fromLocalDate}_${exportData.selection.toLocalDate}`;
  const timestamp = exportData.generatedAtUtc.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `kintrain-analysis_${range}_${timestamp}.json`;
}

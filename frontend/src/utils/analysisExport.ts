import {
  getGoal,
  getProfile,
  listDailyRecords,
  listGymVisits,
  listRecoveryExecutions,
  listTrainingMenuItems,
  listTrainingMenuSets,
  type DailyRecordDto,
  type GymVisitDto,
  type RecoveryExecutionDto,
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
  section: 'profile' | 'trainingMenus' | 'dailyRecords' | 'gymVisits' | 'recoveryExecutions' | 'complete';
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
    muscleMassKg: nullableNumber(item.muscleMassKg),
    bodyMetricMeasuredTimeLocal: nullableString(item.bodyMetricMeasuredTimeLocal),
    conditionRating: nullableNumber(item.conditionRating),
    moodRating: nullableNumber(item.moodRating),
    conditionComment: nullableString(item.conditionComment),
    sleepHours: nullableNumber(item.sleepHours),
    sleepQuality: nullableNumber(item.sleepQuality),
    fatigueLevel: nullableNumber(item.fatigueLevel),
    motivationLevel: nullableNumber(item.motivationLevel),
    muscleSorenessLevel: nullableNumber(item.muscleSorenessLevel),
    painAreas: Array.isArray(item.painAreas) ? item.painAreas : [],
    restingHeartRate: nullableNumber(item.restingHeartRate),
    mealNotes: nullableString(item.mealNotes),
    diary: nullableString(item.diary),
    aiCoachReview: nullableString(item.aiCoachReview),
    aiCoachReviewedAtUtc: nullableString(item.aiCoachReviewedAt),
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
      muscleTargets: entry.muscleTargetsSnapshot,
      movementFamily: entry.movementFamilySnapshot,
      jointActions: entry.jointActionsSnapshot,
      laterality: entry.lateralitySnapshot,
      loadModel: entry.loadModelSnapshot,
      classificationVersion: entry.classificationVersionSnapshot,
      bodyWeightKgSnapshot: nullableNumber(entry.bodyWeightKgSnapshot),
      equipmentType: entry.equipmentTypeSnapshot,
      equipmentProfileId: nullableString(entry.equipmentProfileIdSnapshot),
      cableSettings: entry.cableSettingsSnapshot ?? null,
      isAiGenerated: entry.isAiGeneratedSnapshot === true,
      frequencyDays: nullableNumber(entry.frequencySnapshot),
      weightKg: entry.weightKg,
      additionalLoadKg: nullableNumber(entry.additionalLoadKg),
      assistanceKg: nullableNumber(entry.assistanceKg),
      weightInputMode: entry.weightInputModeSnapshot ?? 'legacyUnspecified',
      loadMultiplier: nullableNumber(entry.loadMultiplierSnapshot),
      fixedWeightKg: nullableNumber(entry.fixedWeightKgSnapshot),
      calculatedTotalWeightKg: nullableNumber(entry.calculatedTotalWeightKg),
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
  if (item.itemKind === 'recovery') {
    return {
      trainingMenuItemId: item.trainingMenuItemId,
      trainingName: item.trainingName,
      itemKind: 'recovery' as const,
      standardDurationMinutes: nullableNumber(item.standardDurationMinutes),
      isSystemProvided: item.isSystemProvided === true,
      isAiGenerated: item.isAiGenerated === true,
      description: nullableString(item.description),
      usageCount: item.usageCount,
      isActive: item.isActive,
      createdAtUtc: nullableString(item.createdAt),
      updatedAtUtc: nullableString(item.updatedAt)
    };
  }
  const weightInputMode = item.weightInputMode ?? 'legacyUnspecified';
  return {
    trainingMenuItemId: item.trainingMenuItemId,
    trainingName: item.trainingName,
    itemKind: 'training' as const,
    exerciseFamilyId: item.exerciseFamilyId,
    muscleTargets: item.muscleTargets,
    movementFamily: item.movementFamily,
    jointActions: item.jointActions,
    laterality: item.laterality,
    loadModel: item.loadModel,
    classificationVersion: item.classificationVersion,
    equipmentType: item.equipmentType,
    equipmentProfileId: nullableString(item.equipmentProfileId),
    cableSettings: item.cableSettings ?? null,
    isAiGenerated: item.isAiGenerated === true,
    description: nullableString(item.description),
    weightInputMode,
    loadMultiplier: weightInputMode === 'legacyUnspecified' ? null : nullableNumber(item.loadMultiplier),
    fixedWeightKg:
      weightInputMode === 'legacyUnspecified' ? null : nullableNumber(item.fixedWeightKg),
    usageCount: item.usageCount,
    isActive: item.isActive,
    createdAtUtc: nullableString(item.createdAt),
    updatedAtUtc: nullableString(item.updatedAt)
  };
}

function normalizeRecoveryExecution(item: RecoveryExecutionDto) {
  return {
    executionId: item.executionId,
    date: item.executionDateLocal,
    menuSetKind: 'recovery' as const,
    sourceMenuSetId: item.sourceMenuSetId,
    sourceMenuSetNameSnapshot: item.sourceMenuSetNameSnapshot,
    planRelationAtRegistration: item.planRelationAtRegistration,
    entries: item.entries.map((entry) => ({
      menuItemId: entry.menuItemId,
      activityNameSnapshot: entry.activityNameSnapshot,
      targetDurationMinutesSnapshot: entry.targetDurationMinutesSnapshot ?? null,
      actualDurationMinutes: entry.actualDurationMinutes ?? null,
      instructionSnapshot: nullableString(entry.instructionSnapshot),
      note: nullableString(entry.note),
      performedAtUtc: entry.performedAtUtc
    })),
    createdAtUtc: item.createdAt
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

  onProgress?.({ section: 'recoveryExecutions', fetched: 0 });
  const recoveryExecutions = await listRecoveryExecutions(dateParams);
  onProgress?.({ section: 'recoveryExecutions', fetched: recoveryExecutions.length });

  const normalizedDailyRecords = dailyRecords
    .map(normalizeDailyRecord)
    .filter((item): item is ReturnType<typeof normalizeDailyRecord> & { date: string } => item.date !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
  const normalizedGymVisits = gymVisits.map(normalizeGymVisit).sort((a, b) => {
    const dateComparison = a.date.localeCompare(b.date);
    return dateComparison !== 0 ? dateComparison : a.startedAtUtc.localeCompare(b.startedAtUtc);
  });
  const normalizedRecoveryExecutions = recoveryExecutions.map(normalizeRecoveryExecution).sort((a, b) => a.date.localeCompare(b.date));
  const historyDates = [
    ...normalizedDailyRecords.map((item) => item.date),
    ...normalizedGymVisits.map((item) => item.date),
    ...normalizedRecoveryExecutions.map((item) => item.date)
  ].sort();

  const result = {
    schema: 'kintrain.analysis-export',
    schemaVersion: 8,
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
      gymVisitCount: normalizedGymVisits.length,
      recoveryExecutionCount: normalizedRecoveryExecutions.length
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
      trainingMenus: trainingMenus.map(normalizeTrainingMenu).sort((a, b) => a.trainingName.localeCompare(b.trainingName)),
      trainingMenuSets: menuSetsResponse.items
        .map((item) => ({
          trainingMenuSetId: item.trainingMenuSetId,
          setName: item.setName,
          displayOrder: item.menuSetOrder,
          isDefault: item.isDefault,
          setType: item.setType,
          menuSetKind: item.menuSetKind,
          source: item.source,
          validFromDate: nullableString(item.validFromDate),
          validToDate: nullableString(item.validToDate),
          isActive: item.isActive,
          items: item.items.map((setItem) => ({
            trainingMenuSetItemId: setItem.trainingMenuSetItemId,
            trainingMenuItemId: setItem.trainingMenuItemId,
            displayOrder: setItem.displayOrder,
            itemKind: setItem.itemKind,
            targetDurationMinutes: setItem.targetDurationMinutes ?? null,
            targetWeightKg: setItem.targetWeightKg,
            targetRepsMin: setItem.targetRepsMin,
            targetRepsMax: setItem.targetRepsMax,
            targetSets: setItem.targetSets,
            recommendedIntervalDays: setItem.recommendedIntervalDays,
            instruction: setItem.instruction
          })),
          createdAtUtc: nullableString(item.createdAt),
          updatedAtUtc: nullableString(item.updatedAt)
        }))
        .sort((a, b) => a.displayOrder - b.displayOrder)
    },
    history: {
      dailyRecords: normalizedDailyRecords,
      gymVisits: normalizedGymVisits,
      recoveryExecutions: normalizedRecoveryExecutions
    }
  };

  onProgress?.({
    section: 'complete',
    fetched: normalizedDailyRecords.length + normalizedGymVisits.length + normalizedRecoveryExecutions.length
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

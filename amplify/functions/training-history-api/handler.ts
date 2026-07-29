import { BatchGetCommand, GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ddb } from "../shared/ddb";
import { getUserId, normalizePath, nowIsoSeconds, parseBody, parseYmd, response } from "../shared/http";
import {
  MUSCLE_TAXONOMY_VERSION,
  normalizeLaterality,
  normalizeLoadModel,
  normalizeMovementPattern,
  normalizeMuscleTargets,
  type Laterality,
  type LoadModel,
  type MovementPattern,
  type MuscleTarget
} from "../shared/muscle-targets";
import { decodePageToken, encodePageToken } from "../shared/pagination";

const trainingHistoryTableName = process.env.TRAINING_HISTORY_TABLE_NAME ?? "";
const trainingPerformanceTableName = process.env.TRAINING_PERFORMANCE_TABLE_NAME ?? "";
const trainingMenuTableName = process.env.TRAINING_MENU_TABLE_NAME ?? "";
const trainingMenuSetTableName = process.env.TRAINING_MENU_SET_TABLE_NAME ?? "";
const trainingMenuSetItemTableName = process.env.TRAINING_MENU_SET_ITEM_TABLE_NAME ?? "";
const dailyTrainingPlanTableName = process.env.DAILY_TRAINING_PLAN_TABLE_NAME ?? "";

const defaultMenuSetIndex = "UserDefaultMenuSetIndex";
const setItemsBySetOrderIndex = "UserSetItemsBySetOrderIndex";
const defaultSetMarker = "DEFAULT";
const userStartedAtIndex = "UserStartedAtIndex";
const userTrainingMenuItemPerformedAtIndex = "UserTrainingMenuItemPerformedAtIndex";
const userVisitIndex = "UserVisitIndex";
const maxVisitEntryCount = 12;

function addYmdDays(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

type ExerciseEntry = {
  trainingMenuItemId: string;
  trainingNameSnapshot: string;
  muscleTargetsSnapshot: MuscleTarget[];
  movementPatternSnapshot: MovementPattern;
  lateralitySnapshot: Laterality;
  loadModelSnapshot: LoadModel;
  classificationVersionSnapshot: number;
  bodyWeightKgSnapshot?: number;
  equipmentSnapshot?: string;
  isAiGeneratedSnapshot?: boolean;
  frequencySnapshot?: number;
  weightKg: number;
  weightInputModeSnapshot?: "direct" | "perSide" | "legacyUnspecified";
  loadMultiplierSnapshot?: 1 | 2;
  fixedWeightKgSnapshot?: number;
  calculatedTotalWeightKg?: number;
  reps: number;
  sets: number;
  performedAtUtc: string;
  note?: string;
  rpe?: number;
  sourceTrainingMenuSetId?: string;
  sourceTrainingMenuSetNameSnapshot?: string;
  sourceTrainingMenuSetItemId?: string;
  sourceTrainingMenuSetTypeSnapshot?: "reusable" | "temporary";
  targetWeightKgSnapshot?: number;
  targetRepsMinSnapshot?: number;
  targetRepsMaxSnapshot?: number;
  targetSetsSnapshot?: number;
  targetInstructionSnapshot?: string;
};

type GymVisitInput = {
  visitId?: string;
  startedAtUtc: string;
  endedAtUtc: string;
  timeZoneId: string;
  visitDateLocal: string;
  entries: ExerciseEntry[];
  note?: string;
};

function toRepsRange(menu: Record<string, unknown>): { defaultRepsMin: number; defaultRepsMax: number } {
  const legacy = Number(menu.defaultReps);
  const minCandidate = Number(menu.defaultRepsMin ?? legacy);
  const maxCandidate = Number(menu.defaultRepsMax ?? legacy);
  const min = Number.isFinite(minCandidate) && minCandidate > 0 ? Math.floor(minCandidate) : 1;
  const maxBase = Number.isFinite(maxCandidate) && maxCandidate > 0 ? Math.floor(maxCandidate) : min;
  return {
    defaultRepsMin: Math.min(min, maxBase),
    defaultRepsMax: Math.max(min, maxBase)
  };
}

function toFrequencyDays(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 1) {
    return Math.min(8, Math.floor(value));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "毎日") {
      return 1;
    }
    if (trimmed === "8日+" || trimmed === "8+") {
      return 8;
    }
    const numeric = Number(trimmed.replace(/[^\d]/g, ""));
    if (Number.isFinite(numeric) && numeric >= 1) {
      return Math.min(8, Math.floor(numeric));
    }
  }
  return 3;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function toTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "";
}

type WeightInputMode = "direct" | "perSide" | "legacyUnspecified";

function normalizeWeightInputMode(value: unknown): WeightInputMode {
  if (value === "direct" || value === "perSide") {
    return value;
  }
  return "legacyUnspecified";
}

function normalizeLoadMultiplier(value: unknown, mode: WeightInputMode): 1 | 2 {
  if (value === 1 || value === 2) {
    return value;
  }
  return mode === "perSide" ? 2 : 1;
}

function normalizeFixedWeightKg(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.round(value * 100) / 100;
}

function calculateTotalWeightKg(weightKg: number, multiplier: number, fixedWeightKg: number): number {
  return Math.round((weightKg * multiplier + fixedWeightKg) * 100) / 100;
}

function validateEntries(entries: ExerciseEntry[] | undefined): boolean {
  if (!Array.isArray(entries)) {
    return false;
  }
  return entries.every((entry) => {
    return (
      typeof entry.trainingMenuItemId === "string" &&
      entry.trainingMenuItemId.trim().length > 0 &&
      typeof entry.trainingNameSnapshot === "string" &&
      entry.trainingNameSnapshot.trim().length > 0 &&
      isNonNegativeNumber(entry.weightKg) &&
      (entry.weightInputModeSnapshot === undefined ||
        entry.weightInputModeSnapshot === "direct" ||
        entry.weightInputModeSnapshot === "perSide" ||
        entry.weightInputModeSnapshot === "legacyUnspecified") &&
      (entry.loadMultiplierSnapshot === undefined ||
        entry.loadMultiplierSnapshot === 1 ||
        entry.loadMultiplierSnapshot === 2) &&
      (entry.fixedWeightKgSnapshot === undefined || isNonNegativeNumber(entry.fixedWeightKgSnapshot)) &&
      isPositiveNumber(entry.reps) &&
      isPositiveNumber(entry.sets) &&
      typeof entry.performedAtUtc === "string" &&
      entry.performedAtUtc.length > 0 &&
      normalizeMuscleTargets(entry.muscleTargetsSnapshot) !== null &&
      normalizeMovementPattern(entry.movementPatternSnapshot) !== null &&
      normalizeLaterality(entry.lateralitySnapshot) !== null &&
      normalizeLoadModel(entry.loadModelSnapshot) !== null &&
      entry.classificationVersionSnapshot === MUSCLE_TAXONOMY_VERSION &&
      (entry.bodyWeightKgSnapshot === undefined || isPositiveNumber(entry.bodyWeightKgSnapshot)) &&
      (entry.equipmentSnapshot === undefined || typeof entry.equipmentSnapshot === "string") &&
      (entry.isAiGeneratedSnapshot === undefined || typeof entry.isAiGeneratedSnapshot === "boolean") &&
      (entry.frequencySnapshot === undefined ||
        (typeof entry.frequencySnapshot === "number" &&
          Number.isInteger(entry.frequencySnapshot) &&
          entry.frequencySnapshot >= 1 &&
          entry.frequencySnapshot <= 8)) &&
      (entry.note === undefined || (typeof entry.note === "string" && entry.note.trim().length <= 500))
      &&
      (entry.sourceTrainingMenuSetId === undefined || typeof entry.sourceTrainingMenuSetId === "string") &&
      (entry.sourceTrainingMenuSetNameSnapshot === undefined ||
        typeof entry.sourceTrainingMenuSetNameSnapshot === "string") &&
      (entry.sourceTrainingMenuSetItemId === undefined || typeof entry.sourceTrainingMenuSetItemId === "string") &&
      (entry.sourceTrainingMenuSetTypeSnapshot === undefined ||
        entry.sourceTrainingMenuSetTypeSnapshot === "reusable" ||
        entry.sourceTrainingMenuSetTypeSnapshot === "temporary") &&
      (entry.targetWeightKgSnapshot === undefined || isNonNegativeNumber(entry.targetWeightKgSnapshot)) &&
      (entry.targetRepsMinSnapshot === undefined || isPositiveNumber(entry.targetRepsMinSnapshot)) &&
      (entry.targetRepsMaxSnapshot === undefined || isPositiveNumber(entry.targetRepsMaxSnapshot)) &&
      (entry.targetSetsSnapshot === undefined || isPositiveNumber(entry.targetSetsSnapshot)) &&
      (entry.targetInstructionSnapshot === undefined ||
        (typeof entry.targetInstructionSnapshot === "string" &&
          entry.targetInstructionSnapshot.trim().length <= 500))
    );
  });
}

export function normalizeEntries(entries: ExerciseEntry[]): ExerciseEntry[] {
  return entries.map((entry) => {
    const muscleTargetsSnapshot = normalizeMuscleTargets(entry.muscleTargetsSnapshot);
    const movementPatternSnapshot = normalizeMovementPattern(entry.movementPatternSnapshot);
    const lateralitySnapshot = normalizeLaterality(entry.lateralitySnapshot);
    const loadModelSnapshot = normalizeLoadModel(entry.loadModelSnapshot);
    if (!muscleTargetsSnapshot || !movementPatternSnapshot || !lateralitySnapshot || !loadModelSnapshot) {
      throw new Error("Exercise classification is invalid.");
    }
    const equipmentSnapshot = toTrimmedString(entry.equipmentSnapshot);
    const note = toTrimmedString(entry.note);
    const weightInputModeSnapshot = normalizeWeightInputMode(entry.weightInputModeSnapshot);
    const loadMultiplierSnapshot =
      weightInputModeSnapshot === "legacyUnspecified"
        ? undefined
        : weightInputModeSnapshot === "direct"
          ? 1
          : normalizeLoadMultiplier(entry.loadMultiplierSnapshot, weightInputModeSnapshot);
    const fixedWeightKgSnapshot =
      weightInputModeSnapshot === "legacyUnspecified"
        ? undefined
        : weightInputModeSnapshot === "direct"
          ? 0
          : normalizeFixedWeightKg(entry.fixedWeightKgSnapshot);
    const calculatedTotalWeightKg =
      weightInputModeSnapshot === "legacyUnspecified" ||
      loadMultiplierSnapshot === undefined ||
      fixedWeightKgSnapshot === undefined
        ? undefined
        : calculateTotalWeightKg(entry.weightKg, loadMultiplierSnapshot, fixedWeightKgSnapshot);
    return {
      ...entry,
      trainingMenuItemId: entry.trainingMenuItemId.trim(),
      trainingNameSnapshot: entry.trainingNameSnapshot.trim(),
      muscleTargetsSnapshot,
      movementPatternSnapshot,
      lateralitySnapshot,
      loadModelSnapshot,
      classificationVersionSnapshot: MUSCLE_TAXONOMY_VERSION,
      bodyWeightKgSnapshot:
        typeof entry.bodyWeightKgSnapshot === "number"
          ? Math.round(entry.bodyWeightKgSnapshot * 100) / 100
          : undefined,
      equipmentSnapshot,
      isAiGeneratedSnapshot: entry.isAiGeneratedSnapshot === true,
      frequencySnapshot:
        typeof entry.frequencySnapshot === "number" &&
        Number.isInteger(entry.frequencySnapshot) &&
        entry.frequencySnapshot >= 1 &&
        entry.frequencySnapshot <= 8
          ? entry.frequencySnapshot
          : undefined,
      weightInputModeSnapshot,
      loadMultiplierSnapshot,
      fixedWeightKgSnapshot,
      calculatedTotalWeightKg,
      note
      ,
      sourceTrainingMenuSetId: toTrimmedString(entry.sourceTrainingMenuSetId),
      sourceTrainingMenuSetNameSnapshot: toTrimmedString(entry.sourceTrainingMenuSetNameSnapshot),
      sourceTrainingMenuSetItemId: toTrimmedString(entry.sourceTrainingMenuSetItemId),
      sourceTrainingMenuSetTypeSnapshot: entry.sourceTrainingMenuSetTypeSnapshot,
      targetWeightKgSnapshot: entry.targetWeightKgSnapshot,
      targetRepsMinSnapshot: entry.targetRepsMinSnapshot,
      targetRepsMaxSnapshot: entry.targetRepsMaxSnapshot,
      targetSetsSnapshot: entry.targetSetsSnapshot,
      targetInstructionSnapshot: toTrimmedString(entry.targetInstructionSnapshot)
    };
  });
}

type TrainingPerformanceItem = {
  userId: string;
  trainingPerformanceId: string;
  visitId: string;
  trainingMenuItemId: string;
  trainingMenuItemPerformedAtKey: string;
  performedAtUtc: string;
  visitDateLocal: string;
  timeZoneId: string;
  trainingNameSnapshot: string;
  muscleTargetsSnapshot: MuscleTarget[];
  movementPatternSnapshot: MovementPattern;
  lateralitySnapshot: Laterality;
  loadModelSnapshot: LoadModel;
  classificationVersionSnapshot: number;
  bodyWeightKgSnapshot?: number;
  equipmentSnapshot: string;
  isAiGeneratedSnapshot: boolean;
  frequencySnapshot?: number;
  weightKg: number;
  weightInputModeSnapshot: WeightInputMode;
  loadMultiplierSnapshot?: 1 | 2;
  fixedWeightKgSnapshot?: number;
  calculatedTotalWeightKg?: number;
  reps: number;
  sets: number;
  note: string;
  sourceTrainingMenuSetId?: string;
  sourceTrainingMenuSetNameSnapshot?: string;
  sourceTrainingMenuSetItemId?: string;
  sourceTrainingMenuSetTypeSnapshot?: "reusable" | "temporary";
  targetWeightKgSnapshot?: number;
  targetRepsMinSnapshot?: number;
  targetRepsMaxSnapshot?: number;
  targetSetsSnapshot?: number;
  targetInstructionSnapshot?: string;
  createdAt: string;
  updatedAt: string;
};

function buildTrainingPerformanceId(visitId: string, sequence: number): string {
  return `${visitId}#${sequence.toString().padStart(3, "0")}`;
}

function buildTrainingMenuItemPerformedAtKey(trainingMenuItemId: string, performedAtUtc: string): string {
  return `${trainingMenuItemId}#${performedAtUtc}`;
}

function buildTrainingPerformanceItems(params: {
  userId: string;
  visitId: string;
  visitDateLocal: string;
  timeZoneId: string;
  entries: ExerciseEntry[];
  createdAt: string;
  updatedAt: string;
}): TrainingPerformanceItem[] {
  return params.entries.map((entry, index) => ({
    userId: params.userId,
    trainingPerformanceId: buildTrainingPerformanceId(params.visitId, index + 1),
    visitId: params.visitId,
    trainingMenuItemId: entry.trainingMenuItemId,
    trainingMenuItemPerformedAtKey: buildTrainingMenuItemPerformedAtKey(entry.trainingMenuItemId, entry.performedAtUtc),
    performedAtUtc: entry.performedAtUtc,
    visitDateLocal: params.visitDateLocal,
    timeZoneId: params.timeZoneId,
    trainingNameSnapshot: entry.trainingNameSnapshot,
    muscleTargetsSnapshot: entry.muscleTargetsSnapshot,
    movementPatternSnapshot: entry.movementPatternSnapshot,
    lateralitySnapshot: entry.lateralitySnapshot,
    loadModelSnapshot: entry.loadModelSnapshot,
    classificationVersionSnapshot: entry.classificationVersionSnapshot,
    bodyWeightKgSnapshot: entry.bodyWeightKgSnapshot,
    equipmentSnapshot: entry.equipmentSnapshot ?? "",
    isAiGeneratedSnapshot: entry.isAiGeneratedSnapshot === true,
    frequencySnapshot: entry.frequencySnapshot,
    weightKg: entry.weightKg,
    weightInputModeSnapshot: entry.weightInputModeSnapshot ?? "legacyUnspecified",
    loadMultiplierSnapshot: entry.loadMultiplierSnapshot,
    fixedWeightKgSnapshot: entry.fixedWeightKgSnapshot,
    calculatedTotalWeightKg: entry.calculatedTotalWeightKg,
    reps: entry.reps,
    sets: entry.sets,
    note: entry.note ?? "",
    sourceTrainingMenuSetId: entry.sourceTrainingMenuSetId,
    sourceTrainingMenuSetNameSnapshot: entry.sourceTrainingMenuSetNameSnapshot,
    sourceTrainingMenuSetItemId: entry.sourceTrainingMenuSetItemId,
    sourceTrainingMenuSetTypeSnapshot: entry.sourceTrainingMenuSetTypeSnapshot,
    targetWeightKgSnapshot: entry.targetWeightKgSnapshot,
    targetRepsMinSnapshot: entry.targetRepsMinSnapshot,
    targetRepsMaxSnapshot: entry.targetRepsMaxSnapshot,
    targetSetsSnapshot: entry.targetSetsSnapshot,
    targetInstructionSnapshot: entry.targetInstructionSnapshot,
    createdAt: params.createdAt,
    updatedAt: params.updatedAt
  }));
}

function buildVisitItem(params: {
  userId: string;
  visitId: string;
  startedAtUtc: string;
  endedAtUtc: string;
  timeZoneId: string;
  visitDateLocal: string;
  entries: ExerciseEntry[];
  note?: string;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    userId: params.userId,
    visitId: params.visitId,
    startedAtUtc: params.startedAtUtc,
    endedAtUtc: params.endedAtUtc,
    timeZoneId: params.timeZoneId,
    visitDateLocal: params.visitDateLocal,
    entries: params.entries,
    note: params.note ?? "",
    createdAt: params.createdAt,
    updatedAt: params.updatedAt
  };
}

async function listTrainingPerformanceItemsByVisitId(userId: string, visitId: string): Promise<TrainingPerformanceItem[]> {
  if (!trainingPerformanceTableName) {
    throw new Error("Lambda environment is not configured.");
  }
  const result = await ddb.send(
    new QueryCommand({
      TableName: trainingPerformanceTableName,
      IndexName: userVisitIndex,
      KeyConditionExpression: "userId = :userId AND visitId = :visitId",
      ExpressionAttributeValues: {
        ":userId": userId,
        ":visitId": visitId
      }
    })
  );

  return (result.Items ?? []) as TrainingPerformanceItem[];
}

async function getLatestPerformanceSnapshot(userId: string, trainingMenuItemId: string): Promise<Record<string, unknown> | undefined> {
  if (!trainingPerformanceTableName) {
    throw new Error("Lambda environment is not configured.");
  }
  const result = await ddb.send(
    new QueryCommand({
      TableName: trainingPerformanceTableName,
      IndexName: userTrainingMenuItemPerformedAtIndex,
      KeyConditionExpression: "userId = :userId AND begins_with(trainingMenuItemPerformedAtKey, :prefix)",
      ExpressionAttributeValues: {
        ":userId": userId,
        ":prefix": `${trainingMenuItemId}#`
      },
      ScanIndexForward: false,
      Limit: 1
    })
  );

  const item = result.Items?.[0] as TrainingPerformanceItem | undefined;
  if (!item) {
    return undefined;
  }
  return {
    performedAtUtc: item.performedAtUtc,
    weightKg: item.weightKg,
    weightInputModeSnapshot: item.weightInputModeSnapshot ?? "legacyUnspecified",
    loadMultiplierSnapshot: item.loadMultiplierSnapshot,
    fixedWeightKgSnapshot: item.fixedWeightKgSnapshot,
    calculatedTotalWeightKg: item.calculatedTotalWeightKg,
    reps: item.reps,
    sets: item.sets,
    muscleTargetsSnapshot: item.muscleTargetsSnapshot,
    movementPatternSnapshot: item.movementPatternSnapshot,
    lateralitySnapshot: item.lateralitySnapshot,
    loadModelSnapshot: item.loadModelSnapshot,
    classificationVersionSnapshot: item.classificationVersionSnapshot,
    bodyWeightKgSnapshot: item.bodyWeightKgSnapshot,
    equipmentSnapshot: item.equipmentSnapshot ?? "",
    note: item.note ?? "",
    visitDateLocal: item.visitDateLocal
  };
}

async function resolveTrainingSessionMenuSetId(
  userId: string,
  requestedTrainingMenuSetId: string,
  date: string
): Promise<{
  trainingMenuSetId: string;
  notFound: boolean;
  resolvedFromDailyPlan: boolean;
  menuSet?: Record<string, unknown>;
}> {
  if (requestedTrainingMenuSetId) {
    const result = await ddb.send(
      new GetCommand({
        TableName: trainingMenuSetTableName,
        Key: {
          userId,
          trainingMenuSetId: requestedTrainingMenuSetId
        }
      })
    );
    if (!result.Item || result.Item.isActive === false) {
      return { trainingMenuSetId: "", notFound: true, resolvedFromDailyPlan: false };
    }
    return {
      trainingMenuSetId: requestedTrainingMenuSetId,
      notFound: false,
      resolvedFromDailyPlan: false,
      menuSet: result.Item as Record<string, unknown>
    };
  }

  const dailyPlanResult = await ddb.send(
    new GetCommand({
      TableName: dailyTrainingPlanTableName,
      Key: { userId, planDate: date }
    })
  );
  const dailySetId =
    typeof dailyPlanResult.Item?.trainingMenuSetId === "string"
      ? dailyPlanResult.Item.trainingMenuSetId
      : "";
  if (dailySetId) {
    const dailySetResult = await ddb.send(
      new GetCommand({
        TableName: trainingMenuSetTableName,
        Key: { userId, trainingMenuSetId: dailySetId }
      })
    );
    if (dailySetResult.Item && dailySetResult.Item.isActive !== false) {
      return {
        trainingMenuSetId: dailySetId,
        notFound: false,
        resolvedFromDailyPlan: true,
        menuSet: dailySetResult.Item as Record<string, unknown>
      };
    }
  }

  const defaultMenuSetResult = await ddb.send(
    new QueryCommand({
      TableName: trainingMenuSetTableName,
      IndexName: defaultMenuSetIndex,
      KeyConditionExpression: "userId = :userId AND defaultSetMarker = :defaultSetMarker",
      ExpressionAttributeValues: {
        ":userId": userId,
        ":defaultSetMarker": defaultSetMarker
      },
      Limit: 1
    })
  );

  let defaultMenuSetIdRaw = defaultMenuSetResult.Items?.[0]?.trainingMenuSetId;
  if (typeof defaultMenuSetIdRaw !== "string") {
    const reusableSets = await ddb.send(
      new QueryCommand({
        TableName: trainingMenuSetTableName,
        IndexName: "UserMenuSetByOrderIndex",
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: { ":userId": userId }
      })
    );
    defaultMenuSetIdRaw = reusableSets.Items?.find(
      (item) => item.isActive !== false && item.setType !== "temporary"
    )?.trainingMenuSetId;
  }
  const defaultMenuSet =
    typeof defaultMenuSetIdRaw === "string"
      ? await ddb.send(
          new GetCommand({
            TableName: trainingMenuSetTableName,
            Key: { userId, trainingMenuSetId: defaultMenuSetIdRaw }
          })
        )
      : undefined;
  return {
    trainingMenuSetId: typeof defaultMenuSetIdRaw === "string" ? defaultMenuSetIdRaw : "",
    notFound: false,
    resolvedFromDailyPlan: false,
    menuSet: defaultMenuSet?.Item as Record<string, unknown> | undefined
  };
}

async function listActiveMenuItemsForSet(
  userId: string,
  trainingMenuSetId: string
): Promise<Array<Record<string, unknown>>> {
  if (!trainingMenuSetId) {
    return [];
  }

  const setItemsResult = await ddb.send(
    new QueryCommand({
      TableName: trainingMenuSetItemTableName,
      IndexName: setItemsBySetOrderIndex,
      KeyConditionExpression: "userId = :userId AND begins_with(menuSetOrderKey, :setPrefix)",
      ExpressionAttributeValues: {
        ":userId": userId,
        ":setPrefix": `${trainingMenuSetId}#`
      }
    })
  );

  const orderedSetItems = (setItemsResult.Items ?? []).filter(
    (item) =>
      typeof item.trainingMenuItemId === "string" &&
      typeof item.trainingMenuSetItemId === "string"
  );
  const orderedMenuItemIds = orderedSetItems
    .map((item) => (typeof item.trainingMenuItemId === "string" ? item.trainingMenuItemId : ""))
    .filter((trainingMenuItemId) => trainingMenuItemId.length > 0);
  const uniqueOrderedMenuItemIds = Array.from(new Set(orderedMenuItemIds));
  if (uniqueOrderedMenuItemIds.length === 0) {
    return [];
  }

  const menuItemsById = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < uniqueOrderedMenuItemIds.length; i += 100) {
    const chunk = uniqueOrderedMenuItemIds.slice(i, i + 100);
    const batchResult = await ddb.send(
      new BatchGetCommand({
        RequestItems: {
          [trainingMenuTableName]: {
            Keys: chunk.map((trainingMenuItemId) => ({
              userId,
              trainingMenuItemId
            }))
          }
        }
      })
    );
    const chunkItems = batchResult.Responses?.[trainingMenuTableName] ?? [];
    for (const item of chunkItems) {
      if (typeof item.trainingMenuItemId === "string") {
        menuItemsById.set(item.trainingMenuItemId, item as Record<string, unknown>);
      }
    }
  }

  return orderedSetItems.flatMap((setItem): Record<string, unknown>[] => {
      const menuItem = menuItemsById.get(String(setItem.trainingMenuItemId));
      if (!menuItem || menuItem.isActive === false) {
        return [];
      }
      return [{
        ...menuItem,
        trainingMenuSetItemId: setItem.trainingMenuSetItemId,
        displayOrder: setItem.displayOrder,
        targetWeightKg: setItem.targetWeightKg,
        targetRepsMin: setItem.targetRepsMin,
        targetRepsMax: setItem.targetRepsMax,
        targetSets: setItem.targetSets,
        recommendedIntervalDays: setItem.recommendedIntervalDays,
        instruction: setItem.instruction ?? "",
        createdBy: setItem.createdBy ?? "manual"
      }];
    });
}

function exceedsTransactionLimit(stalePerformanceCount: number, newEntryCount: number): boolean {
  return stalePerformanceCount + newEntryCount + 1 > 25;
}

async function createGymVisit(event: APIGatewayProxyEvent, userId: string): Promise<APIGatewayProxyResult> {
  if (!trainingPerformanceTableName) {
    return response(500, { message: "Lambda environment is not configured." });
  }
  const body = parseBody<GymVisitInput>(event);
  if (!body || !validateEntries(body.entries)) {
    return response(400, { message: "Invalid request body." });
  }
  if (!parseYmd(body.visitDateLocal)) {
    return response(400, { message: "visitDateLocal must be YYYY-MM-DD." });
  }
  if (body.entries.length > maxVisitEntryCount) {
    return response(400, { message: `1回の記録で登録できる種目数は最大${maxVisitEntryCount}件です。` });
  }

  const visitId = body.visitId?.trim() || randomUUID();
  const ts = nowIsoSeconds();
  const normalizedEntries = normalizeEntries(body.entries);
  const visitItem = buildVisitItem({
    userId,
    visitId,
    startedAtUtc: body.startedAtUtc,
    endedAtUtc: body.endedAtUtc,
    timeZoneId: body.timeZoneId,
    visitDateLocal: body.visitDateLocal,
    entries: normalizedEntries,
    note: body.note,
    createdAt: ts,
    updatedAt: ts
  });
  const performanceItems = buildTrainingPerformanceItems({
    userId,
    visitId,
    visitDateLocal: body.visitDateLocal,
    timeZoneId: body.timeZoneId,
    entries: normalizedEntries,
    createdAt: ts,
    updatedAt: ts
  });

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: trainingHistoryTableName,
            Item: visitItem,
            ConditionExpression: "attribute_not_exists(userId) AND attribute_not_exists(visitId)"
          }
        },
        ...performanceItems.map((item) => ({
          Put: {
            TableName: trainingPerformanceTableName,
            Item: item,
            ConditionExpression: "attribute_not_exists(userId) AND attribute_not_exists(trainingPerformanceId)"
          }
        }))
      ]
    })
  );

  return response(201, {
    visitId,
    startedAtUtc: body.startedAtUtc,
    endedAtUtc: body.endedAtUtc,
    timeZoneId: body.timeZoneId,
    visitDateLocal: body.visitDateLocal,
    entries: normalizedEntries,
    note: body.note ?? "",
    createdAt: ts,
    updatedAt: ts
  });
}

async function getTrainingSessionView(event: APIGatewayProxyEvent, userId: string): Promise<APIGatewayProxyResult> {
  if (
    !trainingMenuTableName ||
    !trainingMenuSetTableName ||
    !trainingMenuSetItemTableName ||
    !dailyTrainingPlanTableName ||
    !trainingPerformanceTableName
  ) {
    return response(500, { message: "Lambda environment is not configured." });
  }

  const date = parseYmd(event.queryStringParameters?.date);
  if (!date) {
    return response(400, { message: "date is required in YYYY-MM-DD format." });
  }

  const requestedTrainingMenuSetId =
    typeof event.queryStringParameters?.trainingMenuSetId === "string"
      ? event.queryStringParameters.trainingMenuSetId.trim()
      : "";
  const resolvedMenuSet = await resolveTrainingSessionMenuSetId(userId, requestedTrainingMenuSetId, date);
  if (resolvedMenuSet.notFound) {
    return response(404, { message: "training menu set not found." });
  }
  const activeMenuItems = await listActiveMenuItemsForSet(userId, resolvedMenuSet.trainingMenuSetId);

  const todayVisitsResult = await ddb.send(
    new QueryCommand({
      TableName: trainingHistoryTableName,
      IndexName: userStartedAtIndex,
      KeyConditionExpression: "userId = :userId AND startedAtUtc BETWEEN :fromUtc AND :toUtc",
      ExpressionAttributeValues: {
        ":userId": userId,
        ":fromUtc": `${date}T00:00:00Z`,
        ":toUtc": `${date}T23:59:59Z`
      }
    })
  );

  const todayDoneTrainingMenuItemIds = new Set<string>();
  for (const visit of todayVisitsResult.Items ?? []) {
    for (const entry of (visit.entries as ExerciseEntry[] | undefined) ?? []) {
      if (entry.trainingMenuItemId) {
        todayDoneTrainingMenuItemIds.add(entry.trainingMenuItemId);
      }
    }
  }
  const items = await Promise.all(
    activeMenuItems.map(async (menu) => {
      const trainingMenuItemId = String(menu.trainingMenuItemId);
      const weightInputMode = normalizeWeightInputMode(menu.weightInputMode);
      const lastPerformanceSnapshot = await getLatestPerformanceSnapshot(userId, trainingMenuItemId);

      return {
        trainingMenuItemId,
        trainingName: menu.trainingName,
        muscleTargets: normalizeMuscleTargets(menu.muscleTargets) ?? [],
        movementPattern: normalizeMovementPattern(menu.movementPattern),
        laterality: normalizeLaterality(menu.laterality),
        loadModel: normalizeLoadModel(menu.loadModel),
        classificationVersion: Number(menu.classificationVersion ?? MUSCLE_TAXONOMY_VERSION),
        equipment: typeof menu.equipment === "string" ? menu.equipment : "",
        isAiGenerated: menu.isAiGenerated === true,
        description: typeof menu.description === "string" ? menu.description : "",
        trainingMenuSetItemId: menu.trainingMenuSetItemId,
        targetWeightKg: Number(menu.targetWeightKg),
        targetRepsMin: Number(menu.targetRepsMin),
        targetRepsMax: Number(menu.targetRepsMax),
        targetSets: Number(menu.targetSets),
        recommendedIntervalDays: Number(menu.recommendedIntervalDays),
        instruction: typeof menu.instruction === "string" ? menu.instruction : "",
        createdBy: menu.createdBy === "ai" ? "ai" : "manual",
        weightInputMode,
        loadMultiplier: normalizeLoadMultiplier(menu.loadMultiplier, weightInputMode),
        fixedWeightKg: normalizeFixedWeightKg(menu.fixedWeightKg),
        displayOrder: menu.displayOrder,
        isActive: menu.isActive,
        lastPerformanceSnapshot
      };
    })
  );

  return response(200, {
    resolvedMenuSet: resolvedMenuSet.menuSet
      ? {
          trainingMenuSetId: resolvedMenuSet.trainingMenuSetId,
          setName: String(resolvedMenuSet.menuSet.setName ?? ""),
          setType: resolvedMenuSet.menuSet.setType === "temporary" ? "temporary" : "reusable",
          source: resolvedMenuSet.menuSet.source === "ai" ? "ai" : "manual",
          isDefault: resolvedMenuSet.menuSet.isDefault === true
        }
      : null,
    resolvedFromDailyPlan: resolvedMenuSet.resolvedFromDailyPlan,
    items,
    todayDoneTrainingMenuItemIds: Array.from(todayDoneTrainingMenuItemIds)
  });
}

async function listGymVisits(event: APIGatewayProxyEvent, userId: string): Promise<APIGatewayProxyResult> {
  const rawFrom = event.queryStringParameters?.from;
  const rawTo = event.queryStringParameters?.to;
  const from = parseYmd(rawFrom);
  const to = parseYmd(rawTo);
  if ((rawFrom && !from) || (rawTo && !to) || Boolean(from) !== Boolean(to)) {
    return response(400, { message: "from and to must both be valid YYYY-MM-DD dates, or both be omitted." });
  }
  if (from && to && from > to) {
    return response(400, { message: "from must be on or before to." });
  }
  const requestedLimit = Number(event.queryStringParameters?.limit ?? "100");
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(200, Math.floor(requestedLimit))) : 100;
  const tokenContext = JSON.stringify(["gym-visits", from ?? null, to ?? null]);
  const exclusiveStartKey = await decodePageToken(
    event.queryStringParameters?.nextToken,
    tokenContext,
    userId
  );
  if (exclusiveStartKey === null) {
    return response(400, { message: "nextToken is invalid for this user or date range." });
  }

  let keyConditionExpression = "userId = :userId";
  const expressionAttributeValues: Record<string, unknown> = {
    ":userId": userId
  };

  if (from && to) {
    keyConditionExpression += " AND startedAtUtc BETWEEN :fromUtc AND :toUtc";
    expressionAttributeValues[":fromUtc"] = `${addYmdDays(from, -1)}T00:00:00Z`;
    expressionAttributeValues[":toUtc"] = `${addYmdDays(to, 1)}T23:59:59Z`;
  }

  const result = await ddb.send(
    new QueryCommand({
      TableName: trainingHistoryTableName,
      IndexName: userStartedAtIndex,
      KeyConditionExpression: keyConditionExpression,
      ExpressionAttributeValues: expressionAttributeValues,
      ScanIndexForward: true,
      Limit: limit,
      ExclusiveStartKey: exclusiveStartKey
    })
  );

  return response(200, {
    items: (result.Items ?? [])
      .filter((item) => {
        if (!from || !to) {
          return true;
        }
        const visitDateLocal = typeof item.visitDateLocal === "string" ? item.visitDateLocal : "";
        return visitDateLocal >= from && visitDateLocal <= to;
      })
      .map(({ userId: _userId, ...item }) => item),
    nextToken: await encodePageToken(
      result.LastEvaluatedKey as Record<string, unknown> | undefined,
      tokenContext,
      userId
    )
  });
}

async function getGymVisit(userId: string, visitId: string): Promise<APIGatewayProxyResult> {
  const result = await ddb.send(
    new GetCommand({
      TableName: trainingHistoryTableName,
      Key: {
        userId,
        visitId
      }
    })
  );

  if (!result.Item) {
    return response(404, { message: "gym visit not found." });
  }

  return response(200, result.Item);
}

async function putGymVisit(
  event: APIGatewayProxyEvent,
  userId: string,
  visitId: string
): Promise<APIGatewayProxyResult> {
  const body = parseBody<GymVisitInput>(event);
  if (!body || !validateEntries(body.entries)) {
    return response(400, { message: "Invalid request body." });
  }
  if (!parseYmd(body.visitDateLocal)) {
    return response(400, { message: "visitDateLocal must be YYYY-MM-DD." });
  }
  if (!trainingPerformanceTableName) {
    return response(500, { message: "Lambda environment is not configured." });
  }
  if (body.entries.length > maxVisitEntryCount) {
    return response(400, { message: `1回の記録で登録できる種目数は最大${maxVisitEntryCount}件です。` });
  }

  const existing = await ddb.send(
    new GetCommand({
      TableName: trainingHistoryTableName,
      Key: { userId, visitId }
    })
  );
  if (!existing.Item) {
    return response(404, { message: "gym visit not found." });
  }

  const ts = nowIsoSeconds();
  const normalizedEntries = normalizeEntries(body.entries);
  const existingPerformanceItems = await listTrainingPerformanceItemsByVisitId(userId, visitId);
  const createdAt = typeof existing.Item.createdAt === "string" ? existing.Item.createdAt : ts;
  const visitItem = buildVisitItem({
    userId,
    visitId,
    startedAtUtc: body.startedAtUtc,
    endedAtUtc: body.endedAtUtc,
    timeZoneId: body.timeZoneId,
    visitDateLocal: body.visitDateLocal,
    entries: normalizedEntries,
    note: body.note,
    createdAt,
    updatedAt: ts
  });
  const performanceItems = buildTrainingPerformanceItems({
    userId,
    visitId,
    visitDateLocal: body.visitDateLocal,
    timeZoneId: body.timeZoneId,
    entries: normalizedEntries,
    createdAt,
    updatedAt: ts
  });
  const nextPerformanceIds = new Set(performanceItems.map((item) => item.trainingPerformanceId));
  const stalePerformanceItems = existingPerformanceItems.filter(
    (item) => !nextPerformanceIds.has(item.trainingPerformanceId)
  );
  if (exceedsTransactionLimit(stalePerformanceItems.length, performanceItems.length)) {
    return response(400, { message: `1回の記録で更新できる種目数は最大${maxVisitEntryCount}件です。` });
  }

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: trainingHistoryTableName,
            Item: visitItem
          }
        },
        ...stalePerformanceItems.map((item) => ({
          Delete: {
            TableName: trainingPerformanceTableName,
            Key: {
              userId,
              trainingPerformanceId: item.trainingPerformanceId
            }
          }
        })),
        ...performanceItems.map((item) => ({
          Put: {
            TableName: trainingPerformanceTableName,
            Item: item
          }
        }))
      ]
    })
  );

  return response(200, {
    userId,
    visitId,
    startedAtUtc: body.startedAtUtc,
    endedAtUtc: body.endedAtUtc,
    timeZoneId: body.timeZoneId,
    visitDateLocal: body.visitDateLocal,
    entries: normalizedEntries,
    note: body.note ?? "",
    createdAt,
    updatedAt: ts
  });
}

async function deleteGymVisit(userId: string, visitId: string): Promise<APIGatewayProxyResult> {
  if (!trainingPerformanceTableName) {
    return response(500, { message: "Lambda environment is not configured." });
  }

  const performanceItems = await listTrainingPerformanceItemsByVisitId(userId, visitId);
  if (performanceItems.length + 1 > 25) {
    return response(400, { message: "削除対象が多すぎるため、この記録は削除できません。" });
  }

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Delete: {
            TableName: trainingHistoryTableName,
            Key: {
              userId,
              visitId
            }
          }
        },
        ...performanceItems.map((item) => ({
          Delete: {
            TableName: trainingPerformanceTableName,
            Key: {
              userId,
              trainingPerformanceId: item.trainingPerformanceId
            }
          }
        }))
      ]
    })
  );

  return response(204, {});
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  if (!trainingHistoryTableName) {
    return response(500, { message: "Lambda environment is not configured." });
  }

  const userId = getUserId(event);
  if (!userId) {
    return response(401, { message: "Unauthorized" });
  }

  const path = normalizePath(event);
  const method = event.httpMethod.toUpperCase();

  if ((path === "/training-session-view" || path === "/training-session-view/") && method === "GET") {
    return getTrainingSessionView(event, userId);
  }

  if ((path === "/gym-visits" || path === "/gym-visits/") && method === "POST") {
    return createGymVisit(event, userId);
  }
  if ((path === "/gym-visits" || path === "/gym-visits/") && method === "GET") {
    return listGymVisits(event, userId);
  }

  const visitMatch = path.match(/^\/gym-visits\/([^/]+)\/?$/);
  if (visitMatch && method === "GET") {
    return getGymVisit(userId, visitMatch[1]);
  }
  if (visitMatch && method === "PUT") {
    return putGymVisit(event, userId, visitMatch[1]);
  }
  if (visitMatch && method === "DELETE") {
    return deleteGymVisit(userId, visitMatch[1]);
  }

  return response(404, { message: "Not found" });
};

import { BatchGetCommand, GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ddb } from "../shared/ddb";
import { getUserId, normalizePath, nowIsoSeconds, parseBody, parseYmd, response } from "../shared/http";

const trainingHistoryTableName = process.env.TRAINING_HISTORY_TABLE_NAME ?? "";
const trainingPerformanceTableName = process.env.TRAINING_PERFORMANCE_TABLE_NAME ?? "";
const trainingMenuTableName = process.env.TRAINING_MENU_TABLE_NAME ?? "";
const trainingMenuSetTableName = process.env.TRAINING_MENU_SET_TABLE_NAME ?? "";
const trainingMenuSetItemTableName = process.env.TRAINING_MENU_SET_ITEM_TABLE_NAME ?? "";

const defaultMenuSetIndex = "UserDefaultMenuSetIndex";
const setItemsBySetOrderIndex = "UserSetItemsBySetOrderIndex";
const defaultSetMarker = "DEFAULT";
const userStartedAtIndex = "UserStartedAtIndex";
const userTrainingMenuItemPerformedAtIndex = "UserTrainingMenuItemPerformedAtIndex";
const userVisitIndex = "UserVisitIndex";
const maxVisitEntryCount = 12;

type ExerciseEntry = {
  trainingMenuItemId: string;
  trainingNameSnapshot: string;
  bodyPartSnapshot?: string;
  equipmentSnapshot?: string;
  isAiGeneratedSnapshot?: boolean;
  frequencySnapshot?: number;
  weightKg: number;
  reps: number;
  sets: number;
  performedAtUtc: string;
  note?: string;
  rpe?: number;
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

function toTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "";
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
      isPositiveNumber(entry.weightKg) &&
      isPositiveNumber(entry.reps) &&
      isPositiveNumber(entry.sets) &&
      typeof entry.performedAtUtc === "string" &&
      entry.performedAtUtc.length > 0 &&
      (entry.bodyPartSnapshot === undefined || typeof entry.bodyPartSnapshot === "string") &&
      (entry.equipmentSnapshot === undefined || typeof entry.equipmentSnapshot === "string") &&
      (entry.isAiGeneratedSnapshot === undefined || typeof entry.isAiGeneratedSnapshot === "boolean") &&
      (entry.frequencySnapshot === undefined ||
        (typeof entry.frequencySnapshot === "number" &&
          Number.isInteger(entry.frequencySnapshot) &&
          entry.frequencySnapshot >= 1 &&
          entry.frequencySnapshot <= 8)) &&
      (entry.note === undefined || (typeof entry.note === "string" && entry.note.trim().length <= 500))
    );
  });
}

function normalizeEntries(entries: ExerciseEntry[]): ExerciseEntry[] {
  return entries.map((entry) => {
    const bodyPartSnapshot = toTrimmedString(entry.bodyPartSnapshot);
    const equipmentSnapshot = toTrimmedString(entry.equipmentSnapshot);
    const note = toTrimmedString(entry.note);
    return {
      ...entry,
      trainingMenuItemId: entry.trainingMenuItemId.trim(),
      trainingNameSnapshot: entry.trainingNameSnapshot.trim(),
      bodyPartSnapshot,
      equipmentSnapshot,
      isAiGeneratedSnapshot: entry.isAiGeneratedSnapshot === true,
      frequencySnapshot:
        typeof entry.frequencySnapshot === "number" &&
        Number.isInteger(entry.frequencySnapshot) &&
        entry.frequencySnapshot >= 1 &&
        entry.frequencySnapshot <= 8
          ? entry.frequencySnapshot
          : undefined,
      note
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
  bodyPartSnapshot: string;
  equipmentSnapshot: string;
  isAiGeneratedSnapshot: boolean;
  frequencySnapshot?: number;
  weightKg: number;
  reps: number;
  sets: number;
  note: string;
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
    bodyPartSnapshot: entry.bodyPartSnapshot ?? "",
    equipmentSnapshot: entry.equipmentSnapshot ?? "",
    isAiGeneratedSnapshot: entry.isAiGeneratedSnapshot === true,
    frequencySnapshot: entry.frequencySnapshot,
    weightKg: entry.weightKg,
    reps: entry.reps,
    sets: entry.sets,
    note: entry.note ?? "",
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
    reps: item.reps,
    sets: item.sets,
    bodyPartSnapshot: item.bodyPartSnapshot ?? "",
    equipmentSnapshot: item.equipmentSnapshot ?? "",
    note: item.note ?? "",
    visitDateLocal: item.visitDateLocal
  };
}

function exceedsTransactionLimit(existingPerformanceCount: number, newEntryCount: number): boolean {
  return existingPerformanceCount + newEntryCount + 1 > 25;
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
  if (!trainingMenuTableName || !trainingMenuSetTableName || !trainingMenuSetItemTableName || !trainingPerformanceTableName) {
    return response(500, { message: "Lambda environment is not configured." });
  }

  const date = parseYmd(event.queryStringParameters?.date);
  if (!date) {
    return response(400, { message: "date is required in YYYY-MM-DD format." });
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

  const defaultMenuSetIdRaw = defaultMenuSetResult.Items?.[0]?.trainingMenuSetId;
  const defaultMenuSetId = typeof defaultMenuSetIdRaw === "string" ? defaultMenuSetIdRaw : "";

  let activeMenuItems: Array<Record<string, unknown>> = [];
  if (defaultMenuSetId) {
    const setItemsResult = await ddb.send(
      new QueryCommand({
        TableName: trainingMenuSetItemTableName,
        IndexName: setItemsBySetOrderIndex,
        KeyConditionExpression: "userId = :userId AND begins_with(menuSetOrderKey, :setPrefix)",
        ExpressionAttributeValues: {
          ":userId": userId,
          ":setPrefix": `${defaultMenuSetId}#`
        }
      })
    );

    const orderedMenuItemIds = (setItemsResult.Items ?? [])
      .map((item) => (typeof item.trainingMenuItemId === "string" ? item.trainingMenuItemId : ""))
      .filter((trainingMenuItemId) => trainingMenuItemId.length > 0);
    const uniqueOrderedMenuItemIds = Array.from(new Set(orderedMenuItemIds));

    if (uniqueOrderedMenuItemIds.length > 0) {
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

      activeMenuItems = uniqueOrderedMenuItemIds
        .map((trainingMenuItemId) => menuItemsById.get(trainingMenuItemId))
        .filter((item): item is Record<string, unknown> => item !== undefined && item.isActive !== false);
    }
  }

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
    const repsRange = toRepsRange(menu as Record<string, unknown>);
      const lastPerformanceSnapshot = await getLatestPerformanceSnapshot(userId, trainingMenuItemId);

      return {
        trainingMenuItemId,
        trainingName: menu.trainingName,
        bodyPart: typeof menu.bodyPart === "string" ? menu.bodyPart : "",
        equipment: typeof menu.equipment === "string" ? menu.equipment : "",
        isAiGenerated: menu.isAiGenerated === true,
        memo: typeof menu.memo === "string" ? menu.memo : "",
        frequency: toFrequencyDays(menu.frequency),
        defaultWeightKg: menu.defaultWeightKg,
        defaultRepsMin: repsRange.defaultRepsMin,
        defaultRepsMax: repsRange.defaultRepsMax,
        defaultReps: repsRange.defaultRepsMax,
        defaultSets: menu.defaultSets,
        displayOrder: menu.displayOrder,
        isActive: menu.isActive,
        lastPerformanceSnapshot
      };
    })
  );

  return response(200, {
    items,
    todayDoneTrainingMenuItemIds: Array.from(todayDoneTrainingMenuItemIds)
  });
}

async function listGymVisits(event: APIGatewayProxyEvent, userId: string): Promise<APIGatewayProxyResult> {
  const from = parseYmd(event.queryStringParameters?.from);
  const to = parseYmd(event.queryStringParameters?.to);
  const limit = Math.max(1, Math.min(200, Number(event.queryStringParameters?.limit ?? "100")));

  let keyConditionExpression = "userId = :userId";
  const expressionAttributeValues: Record<string, unknown> = {
    ":userId": userId
  };

  if (from && to) {
    keyConditionExpression += " AND startedAtUtc BETWEEN :fromUtc AND :toUtc";
    expressionAttributeValues[":fromUtc"] = `${from}T00:00:00Z`;
    expressionAttributeValues[":toUtc"] = `${to}T23:59:59Z`;
  }

  const result = await ddb.send(
    new QueryCommand({
      TableName: trainingHistoryTableName,
      IndexName: userStartedAtIndex,
      KeyConditionExpression: keyConditionExpression,
      ExpressionAttributeValues: expressionAttributeValues,
      ScanIndexForward: false,
      Limit: limit
    })
  );

  return response(200, {
    items: result.Items ?? []
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
  if (exceedsTransactionLimit(existingPerformanceItems.length, normalizedEntries.length)) {
    return response(400, { message: `1回の記録で更新できる種目数は最大${maxVisitEntryCount}件です。` });
  }
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

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: trainingHistoryTableName,
            Item: visitItem
          }
        },
        ...existingPerformanceItems.map((item) => ({
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

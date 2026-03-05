import { BatchGetCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ddb } from "../shared/ddb";
import { getUserId, normalizePath, nowIsoSeconds, parseBody, parseYmd, response } from "../shared/http";

const trainingHistoryTableName = process.env.TRAINING_HISTORY_TABLE_NAME ?? "";
const trainingMenuTableName = process.env.TRAINING_MENU_TABLE_NAME ?? "";
const trainingMenuSetTableName = process.env.TRAINING_MENU_SET_TABLE_NAME ?? "";
const trainingMenuSetItemTableName = process.env.TRAINING_MENU_SET_ITEM_TABLE_NAME ?? "";

const defaultMenuSetIndex = "UserDefaultMenuSetIndex";
const setItemsBySetOrderIndex = "UserSetItemsBySetOrderIndex";
const defaultSetMarker = "DEFAULT";

type ExerciseEntry = {
  trainingMenuItemId?: string;
  trainingNameSnapshot: string;
  bodyPartSnapshot?: string;
  equipmentSnapshot?: string;
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
      typeof entry.trainingNameSnapshot === "string" &&
      entry.trainingNameSnapshot.trim().length > 0 &&
      isPositiveNumber(entry.weightKg) &&
      isPositiveNumber(entry.reps) &&
      isPositiveNumber(entry.sets) &&
      typeof entry.performedAtUtc === "string" &&
      entry.performedAtUtc.length > 0 &&
      (entry.bodyPartSnapshot === undefined || typeof entry.bodyPartSnapshot === "string") &&
      (entry.equipmentSnapshot === undefined || typeof entry.equipmentSnapshot === "string") &&
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
      trainingNameSnapshot: entry.trainingNameSnapshot.trim(),
      bodyPartSnapshot,
      equipmentSnapshot,
      note
    };
  });
}

async function createGymVisit(event: APIGatewayProxyEvent, userId: string): Promise<APIGatewayProxyResult> {
  const body = parseBody<GymVisitInput>(event);
  if (!body || !validateEntries(body.entries)) {
    return response(400, { message: "Invalid request body." });
  }
  if (!parseYmd(body.visitDateLocal)) {
    return response(400, { message: "visitDateLocal must be YYYY-MM-DD." });
  }

  const visitId = body.visitId?.trim() || randomUUID();
  const ts = nowIsoSeconds();
  const normalizedEntries = normalizeEntries(body.entries);

  await ddb.send(
    new PutCommand({
      TableName: trainingHistoryTableName,
      Item: {
        userId,
        visitId,
        startedAtUtc: body.startedAtUtc,
        endedAtUtc: body.endedAtUtc,
        timeZoneId: body.timeZoneId,
        visitDateLocal: body.visitDateLocal,
        entries: normalizedEntries,
        note: body.note ?? "",
        createdAt: ts,
        updatedAt: ts
      },
      ConditionExpression: "attribute_not_exists(userId) AND attribute_not_exists(visitId)"
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
  if (!trainingMenuTableName || !trainingMenuSetTableName || !trainingMenuSetItemTableName) {
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
      IndexName: "UserStartedAtIndex",
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

  const recentVisitsResult = await ddb.send(
    new QueryCommand({
      TableName: trainingHistoryTableName,
      IndexName: "UserStartedAtIndex",
      KeyConditionExpression: "userId = :userId",
      ExpressionAttributeValues: {
        ":userId": userId
      },
      ScanIndexForward: false,
      Limit: 200
    })
  );
  const recentVisits = recentVisitsResult.Items ?? [];

  const items = activeMenuItems.map((menu) => {
    const trainingMenuItemId = String(menu.trainingMenuItemId);
    const repsRange = toRepsRange(menu as Record<string, unknown>);

    let lastPerformanceSnapshot: Record<string, unknown> | undefined;
    for (const visit of recentVisits) {
      const entries = (visit.entries as ExerciseEntry[] | undefined) ?? [];
      const matched = entries.find((entry) => entry.trainingMenuItemId === trainingMenuItemId);
      if (matched) {
        lastPerformanceSnapshot = {
          performedAtUtc: matched.performedAtUtc,
          weightKg: matched.weightKg,
          reps: matched.reps,
          sets: matched.sets,
          bodyPartSnapshot: matched.bodyPartSnapshot ?? "",
          equipmentSnapshot: matched.equipmentSnapshot ?? "",
          note: typeof matched.note === "string" ? matched.note : "",
          visitDateLocal: visit.visitDateLocal
        };
        break;
      }
    }

    return {
      trainingMenuItemId,
      trainingName: menu.trainingName,
      bodyPart: typeof menu.bodyPart === "string" ? menu.bodyPart : "",
      equipment: typeof menu.equipment === "string" ? menu.equipment : "",
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
  });

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
      IndexName: "UserStartedAtIndex",
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
  await ddb.send(
    new PutCommand({
      TableName: trainingHistoryTableName,
      Item: {
        userId,
        visitId,
        startedAtUtc: body.startedAtUtc,
        endedAtUtc: body.endedAtUtc,
        timeZoneId: body.timeZoneId,
        visitDateLocal: body.visitDateLocal,
        entries: normalizedEntries,
        note: body.note ?? "",
        createdAt: existing.Item.createdAt ?? ts,
        updatedAt: ts
      }
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
    createdAt: existing.Item.createdAt ?? ts,
    updatedAt: ts
  });
}

async function deleteGymVisit(userId: string, visitId: string): Promise<APIGatewayProxyResult> {
  await ddb.send(
    new DeleteCommand({
      TableName: trainingHistoryTableName,
      Key: {
        userId,
        visitId
      }
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

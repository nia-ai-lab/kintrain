import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ddb } from "../shared/ddb";
import { getUserId, normalizePath, nowIsoSeconds, parseBody, response, toNonEmptyString } from "../shared/http";

const trainingMenuTableName = process.env.TRAINING_MENU_TABLE_NAME ?? "";

type RepsRangeInput = {
  defaultReps?: number;
  defaultRepsMin?: number;
  defaultRepsMax?: number;
};

type RepsRange = {
  defaultRepsMin: number;
  defaultRepsMax: number;
};

type TrainingMenuItemInput = RepsRangeInput & {
  trainingName: string;
  bodyPart?: string;
  defaultWeightKg: number;
  defaultSets: number;
};

function normalizeTrainingName(name: string): string {
  return name.trim().toLowerCase();
}

function toPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function toTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value.trim();
}

function toRepsRangeFromItem(item: Record<string, unknown>): RepsRange {
  const legacy = toPositiveInt(item.defaultReps);
  const min = toPositiveInt(item.defaultRepsMin) ?? legacy ?? 1;
  const maxCandidate = toPositiveInt(item.defaultRepsMax) ?? legacy ?? min;
  return {
    defaultRepsMin: Math.min(min, maxCandidate),
    defaultRepsMax: Math.max(min, maxCandidate)
  };
}

function resolveRepsRange(input: RepsRangeInput, current?: Record<string, unknown>): RepsRange | null {
  const currentRange = current ? toRepsRangeFromItem(current) : undefined;
  const hasInput =
    input.defaultReps !== undefined || input.defaultRepsMin !== undefined || input.defaultRepsMax !== undefined;

  if (!hasInput && currentRange) {
    return currentRange;
  }

  const legacy = toPositiveInt(input.defaultReps);
  const min = toPositiveInt(input.defaultRepsMin) ?? legacy ?? currentRange?.defaultRepsMin;
  const max = toPositiveInt(input.defaultRepsMax) ?? legacy ?? currentRange?.defaultRepsMax ?? min;

  if (!min || !max) {
    return null;
  }

  if (min > max) {
    return null;
  }

  return {
    defaultRepsMin: min,
    defaultRepsMax: max
  };
}

function toTrainingMenuResponse(item: Record<string, unknown>): Record<string, unknown> {
  const repsRange = toRepsRangeFromItem(item);
  return {
    trainingMenuItemId: item.trainingMenuItemId,
    trainingName: item.trainingName,
    bodyPart: typeof item.bodyPart === "string" ? item.bodyPart : "",
    defaultWeightKg: item.defaultWeightKg,
    defaultRepsMin: repsRange.defaultRepsMin,
    defaultRepsMax: repsRange.defaultRepsMax,
    defaultReps: repsRange.defaultRepsMax,
    defaultSets: item.defaultSets,
    displayOrder: item.displayOrder,
    isActive: item.isActive,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

function decodeNextToken(token?: string): Record<string, unknown> | undefined {
  if (!token) {
    return undefined;
  }
  try {
    const raw = Buffer.from(token, "base64").toString("utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function encodeNextToken(lastEvaluatedKey?: Record<string, unknown>): string | undefined {
  if (!lastEvaluatedKey) {
    return undefined;
  }
  return Buffer.from(JSON.stringify(lastEvaluatedKey), "utf-8").toString("base64");
}

async function listTrainingMenuItems(event: APIGatewayProxyEvent, userId: string): Promise<APIGatewayProxyResult> {
  const requestedLimit = Number(event.queryStringParameters?.limit ?? "100");
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(200, requestedLimit)) : 100;

  const result = await ddb.send(
    new QueryCommand({
      TableName: trainingMenuTableName,
      IndexName: "UserDisplayOrderIndex",
      KeyConditionExpression: "userId = :userId",
      ExpressionAttributeValues: {
        ":userId": userId
      },
      Limit: limit,
      ExclusiveStartKey: decodeNextToken(event.queryStringParameters?.nextToken)
    })
  );

  const items = (result.Items ?? [])
    .filter((item) => item.isActive !== false)
    .map((item) => toTrainingMenuResponse(item as Record<string, unknown>));

  return response(200, {
    items,
    nextToken: encodeNextToken(result.LastEvaluatedKey as Record<string, unknown> | undefined)
  });
}

async function getMaxDisplayOrder(userId: string): Promise<number> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: trainingMenuTableName,
      IndexName: "UserDisplayOrderIndex",
      KeyConditionExpression: "userId = :userId",
      ExpressionAttributeValues: {
        ":userId": userId
      },
      ScanIndexForward: false,
      Limit: 1
    })
  );
  const max = Number(result.Items?.[0]?.displayOrder ?? 0);
  return Number.isFinite(max) ? max : 0;
}

async function existsByTrainingName(
  userId: string,
  normalizedTrainingName: string
): Promise<{ trainingMenuItemId: string } | null> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: trainingMenuTableName,
      IndexName: "UserTrainingNameIndex",
      KeyConditionExpression: "userId = :userId AND normalizedTrainingName = :normalizedTrainingName",
      ExpressionAttributeValues: {
        ":userId": userId,
        ":normalizedTrainingName": normalizedTrainingName
      },
      Limit: 1
    })
  );
  const found = result.Items?.[0];
  if (!found?.trainingMenuItemId || typeof found.trainingMenuItemId !== "string") {
    return null;
  }
  return { trainingMenuItemId: found.trainingMenuItemId };
}

async function createTrainingMenuItem(event: APIGatewayProxyEvent, userId: string): Promise<APIGatewayProxyResult> {
  const body = parseBody<TrainingMenuItemInput>(event);
  if (!body) {
    return response(400, { message: "Invalid JSON body." });
  }

  const trainingName = toNonEmptyString(body.trainingName);
  if (!trainingName) {
    return response(400, { message: "trainingName is required." });
  }
  const bodyPart = toTrimmedString(body.bodyPart) ?? "";

  const repsRange = resolveRepsRange(body);
  if (!repsRange) {
    return response(400, {
      message: "defaultRepsMin/defaultRepsMax must be positive integers and defaultRepsMin <= defaultRepsMax."
    });
  }

  if (body.defaultWeightKg <= 0 || body.defaultSets <= 0) {
    return response(400, { message: "defaultWeightKg/defaultSets must be greater than 0." });
  }

  const normalizedTrainingName = normalizeTrainingName(trainingName);
  const dup = await existsByTrainingName(userId, normalizedTrainingName);
  if (dup) {
    return response(409, { message: "trainingName already exists." });
  }

  const trainingMenuItemId = randomUUID();
  const displayOrder = (await getMaxDisplayOrder(userId)) + 1;
  const ts = nowIsoSeconds();
  const defaultWeightKg = Math.round(body.defaultWeightKg * 100) / 100;
  const defaultSets = Math.floor(body.defaultSets);

  await ddb.send(
    new PutCommand({
      TableName: trainingMenuTableName,
      Item: {
        userId,
        trainingMenuItemId,
        trainingName,
        bodyPart,
        normalizedTrainingName,
        defaultWeightKg,
        defaultRepsMin: repsRange.defaultRepsMin,
        defaultRepsMax: repsRange.defaultRepsMax,
        defaultReps: repsRange.defaultRepsMax,
        defaultSets,
        displayOrder,
        isActive: true,
        createdAt: ts,
        updatedAt: ts
      },
      ConditionExpression: "attribute_not_exists(userId) AND attribute_not_exists(trainingMenuItemId)"
    })
  );

  return response(201, {
    trainingMenuItemId,
    trainingName,
    bodyPart,
    defaultWeightKg,
    defaultRepsMin: repsRange.defaultRepsMin,
    defaultRepsMax: repsRange.defaultRepsMax,
    defaultReps: repsRange.defaultRepsMax,
    defaultSets,
    displayOrder,
    isActive: true,
    createdAt: ts,
    updatedAt: ts
  });
}

async function updateTrainingMenuItem(
  event: APIGatewayProxyEvent,
  userId: string,
  trainingMenuItemId: string
): Promise<APIGatewayProxyResult> {
  const body = parseBody<Partial<TrainingMenuItemInput & { isActive: boolean }>>(event);
  if (!body) {
    return response(400, { message: "Invalid JSON body." });
  }

  const existing = await ddb.send(
    new GetCommand({
      TableName: trainingMenuTableName,
      Key: {
        userId,
        trainingMenuItemId
      }
    })
  );

  if (!existing.Item) {
    return response(404, { message: "training menu item not found." });
  }

  const current = existing.Item as Record<string, unknown>;
  const currentName = String(current.trainingName ?? "");
  const currentBodyPart = typeof current.bodyPart === "string" ? current.bodyPart : "";
  const nextName = toNonEmptyString(body.trainingName) ?? currentName;
  const nextBodyPartInput = toTrimmedString(body.bodyPart);
  const nextBodyPart = body.bodyPart !== undefined ? nextBodyPartInput ?? "" : currentBodyPart;
  const nextNormalizedName = normalizeTrainingName(nextName);
  const repsRange = resolveRepsRange(body, current);

  if (!repsRange) {
    return response(400, {
      message: "defaultRepsMin/defaultRepsMax must be positive integers and defaultRepsMin <= defaultRepsMax."
    });
  }

  if (
    (body.defaultWeightKg !== undefined && body.defaultWeightKg <= 0) ||
    (body.defaultSets !== undefined && body.defaultSets <= 0)
  ) {
    return response(400, { message: "defaultWeightKg/defaultSets must be greater than 0." });
  }

  if (nextNormalizedName !== normalizeTrainingName(currentName)) {
    const dup = await existsByTrainingName(userId, nextNormalizedName);
    if (dup && dup.trainingMenuItemId !== trainingMenuItemId) {
      return response(409, { message: "trainingName already exists." });
    }
  }

  const updatedAt = nowIsoSeconds();
  const updated = {
    trainingName: nextName,
    bodyPart: nextBodyPart,
    normalizedTrainingName: nextNormalizedName,
    defaultWeightKg:
      body.defaultWeightKg !== undefined
        ? Math.round(body.defaultWeightKg * 100) / 100
        : Number(current.defaultWeightKg),
    defaultRepsMin: repsRange.defaultRepsMin,
    defaultRepsMax: repsRange.defaultRepsMax,
    defaultReps: repsRange.defaultRepsMax,
    defaultSets: body.defaultSets !== undefined ? Math.floor(body.defaultSets) : Number(current.defaultSets),
    isActive: body.isActive ?? Boolean(current.isActive),
    updatedAt
  };

  await ddb.send(
    new UpdateCommand({
      TableName: trainingMenuTableName,
      Key: {
        userId,
        trainingMenuItemId
      },
      UpdateExpression:
        "SET trainingName = :trainingName, bodyPart = :bodyPart, normalizedTrainingName = :normalizedTrainingName, defaultWeightKg = :defaultWeightKg, defaultRepsMin = :defaultRepsMin, defaultRepsMax = :defaultRepsMax, defaultReps = :defaultReps, defaultSets = :defaultSets, isActive = :isActive, updatedAt = :updatedAt",
      ExpressionAttributeValues: {
        ":trainingName": updated.trainingName,
        ":bodyPart": updated.bodyPart,
        ":normalizedTrainingName": updated.normalizedTrainingName,
        ":defaultWeightKg": updated.defaultWeightKg,
        ":defaultRepsMin": updated.defaultRepsMin,
        ":defaultRepsMax": updated.defaultRepsMax,
        ":defaultReps": updated.defaultReps,
        ":defaultSets": updated.defaultSets,
        ":isActive": updated.isActive,
        ":updatedAt": updated.updatedAt
      }
    })
  );

  return response(200, {
    trainingMenuItemId,
    displayOrder: Number(current.displayOrder),
    createdAt: current.createdAt,
    ...updated
  });
}

async function deleteTrainingMenuItem(userId: string, trainingMenuItemId: string): Promise<APIGatewayProxyResult> {
  await ddb.send(
    new DeleteCommand({
      TableName: trainingMenuTableName,
      Key: {
        userId,
        trainingMenuItemId
      },
      ConditionExpression: "attribute_exists(userId) AND attribute_exists(trainingMenuItemId)"
    })
  );

  return response(204, {});
}

async function reorderTrainingMenuItems(event: APIGatewayProxyEvent, userId: string): Promise<APIGatewayProxyResult> {
  const body = parseBody<{ items: Array<{ trainingMenuItemId: string; displayOrder: number }> }>(event);
  if (!body || !Array.isArray(body.items) || body.items.length === 0) {
    return response(400, { message: "items is required." });
  }
  if (body.items.length > 25) {
    return response(400, { message: "items cannot exceed 25 per request." });
  }

  const ts = nowIsoSeconds();
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: body.items.map((item) => ({
        Update: {
          TableName: trainingMenuTableName,
          Key: {
            userId,
            trainingMenuItemId: item.trainingMenuItemId
          },
          UpdateExpression: "SET displayOrder = :displayOrder, updatedAt = :updatedAt",
          ExpressionAttributeValues: {
            ":displayOrder": Math.floor(item.displayOrder),
            ":updatedAt": ts
          }
        }
      }))
    })
  );

  return response(200, { updatedCount: body.items.length });
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  if (!trainingMenuTableName) {
    return response(500, { message: "Lambda environment is not configured." });
  }

  const userId = getUserId(event);
  if (!userId) {
    return response(401, { message: "Unauthorized" });
  }

  const path = normalizePath(event);
  const method = event.httpMethod.toUpperCase();

  if ((path === "/training-menu-items" || path === "/training-menu-items/") && method === "GET") {
    return listTrainingMenuItems(event, userId);
  }
  if ((path === "/training-menu-items" || path === "/training-menu-items/") && method === "POST") {
    return createTrainingMenuItem(event, userId);
  }
  if ((path === "/training-menu-items/reorder" || path === "/training-menu-items/reorder/") && method === "PUT") {
    return reorderTrainingMenuItems(event, userId);
  }

  const match = path.match(/^\/training-menu-items\/([^/]+)\/?$/);
  if (match && method === "PUT") {
    return updateTrainingMenuItem(event, userId, match[1]);
  }
  if (match && method === "DELETE") {
    return deleteTrainingMenuItem(userId, match[1]);
  }

  return response(404, { message: "Not found" });
};

import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand
} from "@aws-sdk/lib-dynamodb";
import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ddb } from "../shared/ddb";
import { getUserId, normalizePath, nowIsoSeconds, parseBody, response, toNonEmptyString } from "../shared/http";

const trainingMenuTableName = process.env.TRAINING_MENU_TABLE_NAME ?? "";
const trainingMenuSetTableName = process.env.TRAINING_MENU_SET_TABLE_NAME ?? "";
const trainingMenuSetItemTableName = process.env.TRAINING_MENU_SET_ITEM_TABLE_NAME ?? "";

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

type TrainingMenuSetInput = {
  setName: string;
  isDefault?: boolean;
};

type TrainingMenuSetUpdateInput = {
  setName?: string;
  isDefault?: boolean;
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

const menuSetByOrderIndex = "UserMenuSetByOrderIndex";
const defaultMenuSetIndex = "UserDefaultMenuSetIndex";
const setItemsBySetOrderIndex = "UserSetItemsBySetOrderIndex";
const setItemsBySetAndItemIndex = "UserSetItemsBySetAndItemIndex";
const setItemsByMenuItemIndex = "UserSetItemsByMenuItemIndex";
const defaultSetMarker = "DEFAULT";

function zeroPadOrder(order: number): string {
  const value = Number.isFinite(order) ? Math.max(0, Math.floor(order)) : 0;
  return value.toString().padStart(6, "0");
}

function buildMenuSetOrderKey(trainingMenuSetId: string, displayOrder: number): string {
  return `${trainingMenuSetId}#${zeroPadOrder(displayOrder)}`;
}

function buildMenuSetItemKey(trainingMenuSetId: string, trainingMenuItemId: string): string {
  return `${trainingMenuSetId}#${trainingMenuItemId}`;
}

function toMenuSetResponse(
  set: Record<string, unknown>,
  setItemIdsBySetId: Record<string, string[]>
): Record<string, unknown> {
  const trainingMenuSetId = String(set.trainingMenuSetId ?? "");
  return {
    trainingMenuSetId,
    setName: String(set.setName ?? ""),
    menuSetOrder: Number(set.menuSetOrder ?? 0),
    isDefault: Boolean(set.isDefault),
    isActive: set.isActive !== false,
    itemIds: setItemIdsBySetId[trainingMenuSetId] ?? [],
    createdAt: set.createdAt,
    updatedAt: set.updatedAt
  };
}

async function getCurrentDefaultSetId(userId: string): Promise<string | null> {
  const result = await ddb.send(
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
  const found = result.Items?.[0];
  if (!found?.trainingMenuSetId || typeof found.trainingMenuSetId !== "string") {
    return null;
  }
  return found.trainingMenuSetId;
}

async function getMaxMenuSetOrder(userId: string): Promise<number> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: trainingMenuSetTableName,
      IndexName: menuSetByOrderIndex,
      KeyConditionExpression: "userId = :userId",
      ExpressionAttributeValues: {
        ":userId": userId
      },
      ScanIndexForward: false,
      Limit: 1
    })
  );
  const max = Number(result.Items?.[0]?.menuSetOrder ?? 0);
  return Number.isFinite(max) ? max : 0;
}

async function getSetItemLinkBySetAndItem(
  userId: string,
  trainingMenuSetId: string,
  trainingMenuItemId: string
): Promise<Record<string, unknown> | null> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: trainingMenuSetItemTableName,
      IndexName: setItemsBySetAndItemIndex,
      KeyConditionExpression: "userId = :userId AND menuSetItemKey = :menuSetItemKey",
      ExpressionAttributeValues: {
        ":userId": userId,
        ":menuSetItemKey": buildMenuSetItemKey(trainingMenuSetId, trainingMenuItemId)
      },
      Limit: 1
    })
  );
  return (result.Items?.[0] as Record<string, unknown> | undefined) ?? null;
}

async function getMaxSetItemDisplayOrder(userId: string, trainingMenuSetId: string): Promise<number> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: trainingMenuSetItemTableName,
      IndexName: setItemsBySetOrderIndex,
      KeyConditionExpression: "userId = :userId AND begins_with(menuSetOrderKey, :prefix)",
      ExpressionAttributeValues: {
        ":userId": userId,
        ":prefix": `${trainingMenuSetId}#`
      },
      ScanIndexForward: false,
      Limit: 1
    })
  );
  const max = Number(result.Items?.[0]?.displayOrder ?? 0);
  return Number.isFinite(max) ? max : 0;
}

async function getMenuSetById(userId: string, trainingMenuSetId: string): Promise<Record<string, unknown> | null> {
  const result = await ddb.send(
    new GetCommand({
      TableName: trainingMenuSetTableName,
      Key: {
        userId,
        trainingMenuSetId
      }
    })
  );
  return (result.Item as Record<string, unknown> | undefined) ?? null;
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
  const linksResult = await ddb.send(
    new QueryCommand({
      TableName: trainingMenuSetItemTableName,
      IndexName: setItemsByMenuItemIndex,
      KeyConditionExpression: "userId = :userId AND trainingMenuItemId = :trainingMenuItemId",
      ExpressionAttributeValues: {
        ":userId": userId,
        ":trainingMenuItemId": trainingMenuItemId
      }
    })
  );

  const linkItems = (linksResult.Items ?? []).filter(
    (item): item is Record<string, unknown> => typeof item.trainingMenuSetItemId === "string"
  );

  const transactDeleteItems = linkItems.map((item) => ({
    Delete: {
      TableName: trainingMenuSetItemTableName,
      Key: {
        userId,
        trainingMenuSetItemId: item.trainingMenuSetItemId as string
      },
      ConditionExpression: "attribute_exists(userId) AND attribute_exists(trainingMenuSetItemId)"
    }
  }));

  const chunks: Array<NonNullable<TransactWriteCommandInput["TransactItems"]>> = [];
  for (let i = 0; i < transactDeleteItems.length; i += 25) {
    chunks.push(transactDeleteItems.slice(i, i + 25));
  }

  for (const chunk of chunks) {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: chunk
      })
    );
  }

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

async function listTrainingMenuSets(userId: string): Promise<APIGatewayProxyResult> {
  const [setsResult, setItemsResult] = await Promise.all([
    ddb.send(
      new QueryCommand({
        TableName: trainingMenuSetTableName,
        IndexName: menuSetByOrderIndex,
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: {
          ":userId": userId
        }
      })
    ),
    ddb.send(
      new QueryCommand({
        TableName: trainingMenuSetItemTableName,
        IndexName: setItemsBySetOrderIndex,
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: {
          ":userId": userId
        }
      })
    )
  ]);

  const setItemsBySetId: Record<string, string[]> = {};
  for (const item of setItemsResult.Items ?? []) {
    const setId = typeof item.trainingMenuSetId === "string" ? item.trainingMenuSetId : "";
    const menuItemId = typeof item.trainingMenuItemId === "string" ? item.trainingMenuItemId : "";
    if (!setId || !menuItemId) {
      continue;
    }
    if (!setItemsBySetId[setId]) {
      setItemsBySetId[setId] = [];
    }
    setItemsBySetId[setId].push(menuItemId);
  }

  const items = (setsResult.Items ?? [])
    .filter((set) => set.isActive !== false)
    .map((set) => toMenuSetResponse(set as Record<string, unknown>, setItemsBySetId));

  return response(200, { items });
}

async function createTrainingMenuSet(event: APIGatewayProxyEvent, userId: string): Promise<APIGatewayProxyResult> {
  const body = parseBody<TrainingMenuSetInput>(event);
  if (!body) {
    return response(400, { message: "Invalid JSON body." });
  }

  const setName = toNonEmptyString(body.setName);
  if (!setName) {
    return response(400, { message: "setName is required." });
  }

  const trainingMenuSetId = randomUUID();
  const menuSetOrder = (await getMaxMenuSetOrder(userId)) + 1;
  const currentDefaultSetId = await getCurrentDefaultSetId(userId);
  const shouldBeDefault = Boolean(body.isDefault) || !currentDefaultSetId;
  const ts = nowIsoSeconds();

  if (shouldBeDefault && currentDefaultSetId) {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: trainingMenuSetTableName,
              Key: {
                userId,
                trainingMenuSetId: currentDefaultSetId
              },
              UpdateExpression: "SET isDefault = :isDefault, updatedAt = :updatedAt REMOVE defaultSetMarker",
              ExpressionAttributeValues: {
                ":isDefault": false,
                ":updatedAt": ts
              }
            }
          },
          {
            Put: {
              TableName: trainingMenuSetTableName,
              Item: {
                userId,
                trainingMenuSetId,
                setName,
                menuSetOrder,
                isDefault: true,
                isActive: true,
                defaultSetMarker,
                createdAt: ts,
                updatedAt: ts
              },
              ConditionExpression: "attribute_not_exists(userId) AND attribute_not_exists(trainingMenuSetId)"
            }
          }
        ]
      })
    );
  } else {
    await ddb.send(
      new PutCommand({
        TableName: trainingMenuSetTableName,
        Item: {
          userId,
          trainingMenuSetId,
          setName,
          menuSetOrder,
          isDefault: shouldBeDefault,
          isActive: true,
          ...(shouldBeDefault ? { defaultSetMarker } : {}),
          createdAt: ts,
          updatedAt: ts
        },
        ConditionExpression: "attribute_not_exists(userId) AND attribute_not_exists(trainingMenuSetId)"
      })
    );
  }

  return response(201, {
    trainingMenuSetId,
    setName,
    menuSetOrder,
    isDefault: shouldBeDefault,
    isActive: true,
    itemIds: [],
    createdAt: ts,
    updatedAt: ts
  });
}

async function updateTrainingMenuSet(
  event: APIGatewayProxyEvent,
  userId: string,
  trainingMenuSetId: string
): Promise<APIGatewayProxyResult> {
  const body = parseBody<TrainingMenuSetUpdateInput>(event);
  if (!body) {
    return response(400, { message: "Invalid JSON body." });
  }

  const current = await getMenuSetById(userId, trainingMenuSetId);
  if (!current || current.isActive === false) {
    return response(404, { message: "training menu set not found." });
  }

  const nextSetName = toNonEmptyString(body.setName) ?? String(current.setName ?? "");
  const currentIsDefault = Boolean(current.isDefault);
  const requestedDefault = body.isDefault;
  const ts = nowIsoSeconds();

  if (requestedDefault === false && currentIsDefault) {
    return response(400, { message: "default set cannot be unset directly. choose another set as default." });
  }

  const shouldSwitchDefault = requestedDefault === true && !currentIsDefault;
  if (shouldSwitchDefault) {
    const currentDefaultSetId = await getCurrentDefaultSetId(userId);
    const transactItems: NonNullable<TransactWriteCommandInput["TransactItems"]> = [];

    if (currentDefaultSetId && currentDefaultSetId !== trainingMenuSetId) {
      transactItems.push({
        Update: {
          TableName: trainingMenuSetTableName,
          Key: {
            userId,
            trainingMenuSetId: currentDefaultSetId
          },
          UpdateExpression: "SET isDefault = :isDefault, updatedAt = :updatedAt REMOVE defaultSetMarker",
          ExpressionAttributeValues: {
            ":isDefault": false,
            ":updatedAt": ts
          }
        }
      });
    }

    transactItems.push({
      Update: {
        TableName: trainingMenuSetTableName,
        Key: {
          userId,
          trainingMenuSetId
        },
        UpdateExpression:
          "SET setName = :setName, isDefault = :isDefault, defaultSetMarker = :defaultSetMarker, updatedAt = :updatedAt",
        ExpressionAttributeValues: {
          ":setName": nextSetName,
          ":isDefault": true,
          ":defaultSetMarker": defaultSetMarker,
          ":updatedAt": ts
        }
      }
    });

    await ddb.send(
      new TransactWriteCommand({
        TransactItems: transactItems
      })
    );

    return response(200, {
      trainingMenuSetId,
      setName: nextSetName,
      menuSetOrder: Number(current.menuSetOrder ?? 0),
      isDefault: true,
      isActive: true,
      updatedAt: ts
    });
  }

  const updateExpressionParts = ["setName = :setName", "updatedAt = :updatedAt"];
  const expressionAttributeValues: Record<string, unknown> = {
    ":setName": nextSetName,
    ":updatedAt": ts
  };

  if (currentIsDefault) {
    updateExpressionParts.push("isDefault = :isDefault", "defaultSetMarker = :defaultSetMarker");
    expressionAttributeValues[":isDefault"] = true;
    expressionAttributeValues[":defaultSetMarker"] = defaultSetMarker;
  }

  await ddb.send(
    new UpdateCommand({
      TableName: trainingMenuSetTableName,
      Key: {
        userId,
        trainingMenuSetId
      },
      UpdateExpression: `SET ${updateExpressionParts.join(", ")}`,
      ExpressionAttributeValues: expressionAttributeValues
    })
  );

  return response(200, {
    trainingMenuSetId,
    setName: nextSetName,
    menuSetOrder: Number(current.menuSetOrder ?? 0),
    isDefault: currentIsDefault,
    isActive: true,
    updatedAt: ts
  });
}

async function deleteTrainingMenuSet(userId: string, trainingMenuSetId: string): Promise<APIGatewayProxyResult> {
  const current = await getMenuSetById(userId, trainingMenuSetId);
  if (!current || current.isActive === false) {
    return response(404, { message: "training menu set not found." });
  }
  if (Boolean(current.isDefault)) {
    return response(400, { message: "default set cannot be deleted. choose another set as default first." });
  }

  const linkedSetItemIds: string[] = [];
  let nextKey: Record<string, unknown> | undefined;
  do {
    const linksResult = await ddb.send(
      new QueryCommand({
        TableName: trainingMenuSetItemTableName,
        IndexName: setItemsBySetOrderIndex,
        KeyConditionExpression: "userId = :userId AND begins_with(menuSetOrderKey, :prefix)",
        ExpressionAttributeValues: {
          ":userId": userId,
          ":prefix": `${trainingMenuSetId}#`
        },
        ExclusiveStartKey: nextKey
      })
    );
    for (const item of linksResult.Items ?? []) {
      if (typeof item.trainingMenuSetItemId === "string") {
        linkedSetItemIds.push(item.trainingMenuSetItemId);
      }
    }
    nextKey = linksResult.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (nextKey);

  if (linkedSetItemIds.length > 0) {
    const deleteLinkTransactItems = linkedSetItemIds.map((trainingMenuSetItemId) => ({
      Delete: {
        TableName: trainingMenuSetItemTableName,
        Key: {
          userId,
          trainingMenuSetItemId
        },
        ConditionExpression: "attribute_exists(userId) AND attribute_exists(trainingMenuSetItemId)"
      }
    }));
    for (let i = 0; i < deleteLinkTransactItems.length; i += 25) {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: deleteLinkTransactItems.slice(i, i + 25)
        })
      );
    }
  }

  await ddb.send(
    new DeleteCommand({
      TableName: trainingMenuSetTableName,
      Key: {
        userId,
        trainingMenuSetId
      },
      ConditionExpression: "attribute_exists(userId) AND attribute_exists(trainingMenuSetId)"
    })
  );

  return response(204, {});
}

async function addTrainingMenuItemToSet(
  event: APIGatewayProxyEvent,
  userId: string,
  trainingMenuSetId: string
): Promise<APIGatewayProxyResult> {
  const body = parseBody<{ trainingMenuItemId: string }>(event);
  if (!body) {
    return response(400, { message: "Invalid JSON body." });
  }

  const trainingMenuItemId = toNonEmptyString(body.trainingMenuItemId);
  if (!trainingMenuItemId) {
    return response(400, { message: "trainingMenuItemId is required." });
  }

  const [menuSet, menuItem, existingLink] = await Promise.all([
    getMenuSetById(userId, trainingMenuSetId),
    ddb.send(
      new GetCommand({
        TableName: trainingMenuTableName,
        Key: { userId, trainingMenuItemId }
      })
    ),
    getSetItemLinkBySetAndItem(userId, trainingMenuSetId, trainingMenuItemId)
  ]);

  if (!menuSet || menuSet.isActive === false) {
    return response(404, { message: "training menu set not found." });
  }
  if (!menuItem.Item || menuItem.Item.isActive === false) {
    return response(404, { message: "training menu item not found." });
  }
  if (existingLink) {
    return response(409, { message: "training menu item already assigned to the set." });
  }

  const displayOrder = (await getMaxSetItemDisplayOrder(userId, trainingMenuSetId)) + 1;
  const trainingMenuSetItemId = randomUUID();
  const ts = nowIsoSeconds();

  await ddb.send(
    new PutCommand({
      TableName: trainingMenuSetItemTableName,
      Item: {
        userId,
        trainingMenuSetItemId,
        trainingMenuSetId,
        trainingMenuItemId,
        displayOrder,
        menuSetOrderKey: buildMenuSetOrderKey(trainingMenuSetId, displayOrder),
        menuSetItemKey: buildMenuSetItemKey(trainingMenuSetId, trainingMenuItemId),
        createdAt: ts,
        updatedAt: ts
      },
      ConditionExpression: "attribute_not_exists(userId) AND attribute_not_exists(trainingMenuSetItemId)"
    })
  );

  return response(201, {
    trainingMenuSetItemId,
    trainingMenuSetId,
    trainingMenuItemId,
    displayOrder,
    createdAt: ts,
    updatedAt: ts
  });
}

async function removeTrainingMenuItemFromSet(
  userId: string,
  trainingMenuSetId: string,
  trainingMenuItemId: string
): Promise<APIGatewayProxyResult> {
  const link = await getSetItemLinkBySetAndItem(userId, trainingMenuSetId, trainingMenuItemId);
  if (!link || typeof link.trainingMenuSetItemId !== "string") {
    return response(404, { message: "training menu set item not found." });
  }

  await ddb.send(
    new DeleteCommand({
      TableName: trainingMenuSetItemTableName,
      Key: {
        userId,
        trainingMenuSetItemId: link.trainingMenuSetItemId
      },
      ConditionExpression: "attribute_exists(userId) AND attribute_exists(trainingMenuSetItemId)"
    })
  );

  return response(204, {});
}

async function reorderTrainingMenuSetItems(
  event: APIGatewayProxyEvent,
  userId: string,
  trainingMenuSetId: string
): Promise<APIGatewayProxyResult> {
  const body = parseBody<{ items: Array<{ trainingMenuItemId: string; displayOrder: number }> }>(event);
  if (!body || !Array.isArray(body.items) || body.items.length === 0) {
    return response(400, { message: "items is required." });
  }
  if (body.items.length > 25) {
    return response(400, { message: "items cannot exceed 25 per request." });
  }

  const ts = nowIsoSeconds();
  const links = await Promise.all(
    body.items.map(async (item) => {
      const trainingMenuItemId = toNonEmptyString(item.trainingMenuItemId);
      if (!trainingMenuItemId) {
        return null;
      }
      const link = await getSetItemLinkBySetAndItem(userId, trainingMenuSetId, trainingMenuItemId);
      if (!link || typeof link.trainingMenuSetItemId !== "string") {
        return null;
      }
      return {
        trainingMenuSetItemId: link.trainingMenuSetItemId,
        trainingMenuItemId,
        displayOrder: Math.max(1, Math.floor(item.displayOrder))
      };
    })
  );

  if (links.some((link) => link === null)) {
    return response(404, { message: "one or more training menu set items were not found." });
  }

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: (links as Array<{ trainingMenuSetItemId: string; trainingMenuItemId: string; displayOrder: number }>).map(
        (link) => ({
          Update: {
            TableName: trainingMenuSetItemTableName,
            Key: {
              userId,
              trainingMenuSetItemId: link.trainingMenuSetItemId
            },
            UpdateExpression:
              "SET displayOrder = :displayOrder, menuSetOrderKey = :menuSetOrderKey, updatedAt = :updatedAt",
            ExpressionAttributeValues: {
              ":displayOrder": link.displayOrder,
              ":menuSetOrderKey": buildMenuSetOrderKey(trainingMenuSetId, link.displayOrder),
              ":updatedAt": ts
            }
          }
        })
      )
    })
  );

  return response(200, { updatedCount: links.length });
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  if (!trainingMenuTableName || !trainingMenuSetTableName || !trainingMenuSetItemTableName) {
    return response(500, { message: "Lambda environment is not configured." });
  }

  const userId = getUserId(event);
  if (!userId) {
    return response(401, { message: "Unauthorized" });
  }

  const path = normalizePath(event);
  const method = event.httpMethod.toUpperCase();

  if ((path === "/training-menu-sets" || path === "/training-menu-sets/") && method === "GET") {
    return listTrainingMenuSets(userId);
  }
  if ((path === "/training-menu-sets" || path === "/training-menu-sets/") && method === "POST") {
    return createTrainingMenuSet(event, userId);
  }

  const menuSetMatch = path.match(/^\/training-menu-sets\/([^/]+)\/?$/);
  if (menuSetMatch && method === "PUT") {
    return updateTrainingMenuSet(event, userId, menuSetMatch[1]);
  }
  if (menuSetMatch && method === "DELETE") {
    return deleteTrainingMenuSet(userId, menuSetMatch[1]);
  }

  const menuSetItemsMatch = path.match(/^\/training-menu-sets\/([^/]+)\/items\/?$/);
  if (menuSetItemsMatch && method === "POST") {
    return addTrainingMenuItemToSet(event, userId, menuSetItemsMatch[1]);
  }

  const menuSetItemsReorderMatch = path.match(/^\/training-menu-sets\/([^/]+)\/items\/reorder\/?$/);
  if (menuSetItemsReorderMatch && method === "PUT") {
    return reorderTrainingMenuSetItems(event, userId, menuSetItemsReorderMatch[1]);
  }

  const menuSetItemDeleteMatch = path.match(/^\/training-menu-sets\/([^/]+)\/items\/([^/]+)\/?$/);
  if (menuSetItemDeleteMatch && method === "DELETE") {
    return removeTrainingMenuItemFromSet(userId, menuSetItemDeleteMatch[1], menuSetItemDeleteMatch[2]);
  }

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

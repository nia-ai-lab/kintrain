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
import { getUserId, normalizePath, nowIsoSeconds, parseBody, parseYmd, response, toNonEmptyString } from "../shared/http";
import { decodePageToken, encodePageToken } from "../shared/pagination";

const trainingMenuTableName = process.env.TRAINING_MENU_TABLE_NAME ?? "";
const trainingMenuSetTableName = process.env.TRAINING_MENU_SET_TABLE_NAME ?? "";
const trainingMenuSetItemTableName = process.env.TRAINING_MENU_SET_ITEM_TABLE_NAME ?? "";
const dailyTrainingPlanTableName = process.env.DAILY_TRAINING_PLAN_TABLE_NAME ?? "";

const menuItemOrderIndex = "UserDisplayOrderIndex";
const menuItemNameIndex = "UserTrainingNameIndex";
const menuSetByOrderIndex = "UserMenuSetByOrderIndex";
const defaultMenuSetIndex = "UserDefaultMenuSetIndex";
const setItemsBySetOrderIndex = "UserSetItemsBySetOrderIndex";
const setItemsBySetAndItemIndex = "UserSetItemsBySetAndItemIndex";
const setItemsByMenuItemIndex = "UserSetItemsByMenuItemIndex";
const defaultSetMarker = "DEFAULT";

type WeightInputMode = "direct" | "perSide" | "legacyUnspecified";
type MenuSetType = "reusable" | "temporary";
type DataSource = "manual" | "ai";

type MenuItemInput = {
  trainingName: string;
  bodyPart?: string;
  equipment?: string;
  isAiGenerated?: boolean;
  description?: string;
  weightInputMode?: WeightInputMode;
  loadMultiplier?: 1 | 2;
  fixedWeightKg?: number;
  isActive?: boolean;
};

type MenuSetInput = {
  setName: string;
  setType?: MenuSetType;
  source?: DataSource;
  scheduledDate?: string;
  isDefault?: boolean;
};

type PrescriptionInput = {
  trainingMenuItemId?: string;
  targetWeightKg?: number;
  targetRepsMin?: number;
  targetRepsMax?: number;
  targetSets?: number;
  recommendedIntervalDays?: number;
  instruction?: string;
  createdBy?: DataSource;
};

type Prescription = {
  targetWeightKg: number;
  targetRepsMin: number;
  targetRepsMax: number;
  targetSets: number;
  recommendedIntervalDays: number;
  instruction: string;
  createdBy: DataSource;
};

function trimmed(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function normalizeTrainingName(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeEquipment(value: unknown): string | undefined {
  const aliases: Record<string, string> = { バーベル: "フリー", ダンベル: "フリー", ケトルベル: "フリー" };
  const normalized = aliases[trimmed(value) ?? ""] ?? trimmed(value);
  return normalized && ["マシン", "フリー", "自重", "その他"].includes(normalized) ? normalized : undefined;
}

function normalizeWeightInputMode(value: unknown): WeightInputMode {
  return value === "direct" || value === "perSide" || value === "legacyUnspecified"
    ? value
    : "legacyUnspecified";
}

function normalizeLoadMultiplier(value: unknown, mode: WeightInputMode): 1 | 2 {
  if (mode === "direct") {
    return 1;
  }
  return value === 1 || value === 2 ? value : mode === "perSide" ? 2 : 1;
}

function normalizeFixedWeightKg(value: unknown, mode: WeightInputMode): number {
  if (mode === "direct") {
    return 0;
  }
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value * 100) / 100
    : 0;
}

function normalizeSetType(value: unknown): MenuSetType {
  return value === "temporary" ? "temporary" : "reusable";
}

function normalizeSource(value: unknown): DataSource {
  return value === "ai" ? "ai" : "manual";
}

function parsePrescription(input: PrescriptionInput, current?: Record<string, unknown>): Prescription | null {
  const targetWeightKg = input.targetWeightKg ?? Number(current?.targetWeightKg);
  const targetRepsMin = input.targetRepsMin ?? Number(current?.targetRepsMin);
  const targetRepsMax = input.targetRepsMax ?? Number(current?.targetRepsMax);
  const targetSets = input.targetSets ?? Number(current?.targetSets);
  const recommendedIntervalDays = input.recommendedIntervalDays ?? Number(current?.recommendedIntervalDays);
  const instruction = input.instruction !== undefined ? trimmed(input.instruction) ?? "" : String(current?.instruction ?? "");
  const createdBy = input.createdBy !== undefined ? normalizeSource(input.createdBy) : normalizeSource(current?.createdBy);
  if (
    !Number.isFinite(targetWeightKg) ||
    targetWeightKg < 0 ||
    !Number.isInteger(targetRepsMin) ||
    targetRepsMin <= 0 ||
    !Number.isInteger(targetRepsMax) ||
    targetRepsMax < targetRepsMin ||
    !Number.isInteger(targetSets) ||
    targetSets <= 0 ||
    !Number.isInteger(recommendedIntervalDays) ||
    recommendedIntervalDays < 1 ||
    recommendedIntervalDays > 8 ||
    instruction.length > 500
  ) {
    return null;
  }
  return {
    targetWeightKg: Math.round(targetWeightKg * 100) / 100,
    targetRepsMin,
    targetRepsMax,
    targetSets,
    recommendedIntervalDays,
    instruction,
    createdBy
  };
}

function zeroPadOrder(value: number): string {
  return Math.max(0, Math.floor(value)).toString().padStart(6, "0");
}

function buildMenuSetOrderKey(trainingMenuSetId: string, displayOrder: number): string {
  return `${trainingMenuSetId}#${zeroPadOrder(displayOrder)}`;
}

function buildMenuSetItemKey(trainingMenuSetId: string, trainingMenuItemId: string): string {
  return `${trainingMenuSetId}#${trainingMenuItemId}`;
}

function toMenuItemResponse(item: Record<string, unknown>, usageCount = 0): Record<string, unknown> {
  const weightInputMode = normalizeWeightInputMode(item.weightInputMode);
  return {
    trainingMenuItemId: item.trainingMenuItemId,
    trainingName: String(item.trainingName ?? ""),
    bodyPart: String(item.bodyPart ?? ""),
    equipment: normalizeEquipment(item.equipment) ?? "その他",
    isAiGenerated: item.isAiGenerated === true,
    description: String(item.description ?? ""),
    weightInputMode,
    loadMultiplier: normalizeLoadMultiplier(item.loadMultiplier, weightInputMode),
    fixedWeightKg: normalizeFixedWeightKg(item.fixedWeightKg, weightInputMode),
    isActive: item.isActive !== false,
    usageCount,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

function toSetItemResponse(item: Record<string, unknown>): Record<string, unknown> {
  return {
    trainingMenuSetItemId: item.trainingMenuSetItemId,
    trainingMenuSetId: item.trainingMenuSetId,
    trainingMenuItemId: item.trainingMenuItemId,
    displayOrder: Number(item.displayOrder ?? 0),
    targetWeightKg: Number(item.targetWeightKg),
    targetRepsMin: Number(item.targetRepsMin),
    targetRepsMax: Number(item.targetRepsMax),
    targetSets: Number(item.targetSets),
    recommendedIntervalDays: Number(item.recommendedIntervalDays),
    instruction: String(item.instruction ?? ""),
    createdBy: normalizeSource(item.createdBy),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

function toMenuSetResponse(set: Record<string, unknown>, items: Record<string, unknown>[]): Record<string, unknown> {
  return {
    trainingMenuSetId: set.trainingMenuSetId,
    setName: String(set.setName ?? ""),
    menuSetOrder: Number(set.menuSetOrder ?? 0),
    setType: normalizeSetType(set.setType),
    source: normalizeSource(set.source),
    scheduledDate: typeof set.scheduledDate === "string" ? set.scheduledDate : undefined,
    isDefault: set.isDefault === true,
    isActive: set.isActive !== false,
    items: items.map(toSetItemResponse),
    createdAt: set.createdAt,
    updatedAt: set.updatedAt
  };
}

async function getMenuItem(userId: string, trainingMenuItemId: string): Promise<Record<string, unknown> | null> {
  const result = await ddb.send(new GetCommand({
    TableName: trainingMenuTableName,
    Key: { userId, trainingMenuItemId }
  }));
  return (result.Item as Record<string, unknown> | undefined) ?? null;
}

async function getMenuSet(userId: string, trainingMenuSetId: string): Promise<Record<string, unknown> | null> {
  const result = await ddb.send(new GetCommand({
    TableName: trainingMenuSetTableName,
    Key: { userId, trainingMenuSetId }
  }));
  return (result.Item as Record<string, unknown> | undefined) ?? null;
}

async function getSetItem(userId: string, trainingMenuSetItemId: string): Promise<Record<string, unknown> | null> {
  const result = await ddb.send(new GetCommand({
    TableName: trainingMenuSetItemTableName,
    Key: { userId, trainingMenuSetItemId }
  }));
  return (result.Item as Record<string, unknown> | undefined) ?? null;
}

async function listSetItems(userId: string, trainingMenuSetId?: string): Promise<Record<string, unknown>[]> {
  const result = await ddb.send(new QueryCommand({
    TableName: trainingMenuSetItemTableName,
    IndexName: setItemsBySetOrderIndex,
    KeyConditionExpression: trainingMenuSetId
      ? "userId = :userId AND begins_with(menuSetOrderKey, :prefix)"
      : "userId = :userId",
    ExpressionAttributeValues: {
      ":userId": userId,
      ...(trainingMenuSetId ? { ":prefix": `${trainingMenuSetId}#` } : {})
    }
  }));
  return (result.Items ?? []) as Record<string, unknown>[];
}

async function getCurrentDefaultSetId(userId: string): Promise<string | null> {
  const result = await ddb.send(new QueryCommand({
    TableName: trainingMenuSetTableName,
    IndexName: defaultMenuSetIndex,
    KeyConditionExpression: "userId = :userId AND defaultSetMarker = :marker",
    ExpressionAttributeValues: { ":userId": userId, ":marker": defaultSetMarker },
    Limit: 1
  }));
  return typeof result.Items?.[0]?.trainingMenuSetId === "string" ? result.Items[0].trainingMenuSetId : null;
}

async function nextOrder(tableName: string, indexName: string, userId: string, field: string): Promise<number> {
  const result = await ddb.send(new QueryCommand({
    TableName: tableName,
    IndexName: indexName,
    KeyConditionExpression: "userId = :userId",
    ExpressionAttributeValues: { ":userId": userId },
    ScanIndexForward: false,
    Limit: 1
  }));
  return Number(result.Items?.[0]?.[field] ?? 0) + 1;
}

async function existsByName(userId: string, normalizedTrainingName: string): Promise<string | null> {
  const result = await ddb.send(new QueryCommand({
    TableName: trainingMenuTableName,
    IndexName: menuItemNameIndex,
    KeyConditionExpression: "userId = :userId AND normalizedTrainingName = :name",
    ExpressionAttributeValues: { ":userId": userId, ":name": normalizedTrainingName },
    Limit: 1
  }));
  return typeof result.Items?.[0]?.trainingMenuItemId === "string" ? result.Items[0].trainingMenuItemId : null;
}

async function listMenuItems(event: APIGatewayProxyEvent, userId: string): Promise<APIGatewayProxyResult> {
  const limit = Math.max(1, Math.min(200, Math.floor(Number(event.queryStringParameters?.limit ?? 100))));
  const context = JSON.stringify(["training-menu-items-v2"]);
  const exclusiveStartKey = await decodePageToken(event.queryStringParameters?.nextToken, context, userId);
  if (exclusiveStartKey === null) {
    return response(400, { message: "nextToken is invalid for this user." });
  }
  const [result, links] = await Promise.all([
    ddb.send(new QueryCommand({
      TableName: trainingMenuTableName,
      IndexName: menuItemOrderIndex,
      KeyConditionExpression: "userId = :userId",
      ExpressionAttributeValues: { ":userId": userId },
      Limit: limit,
      ExclusiveStartKey: exclusiveStartKey
    })),
    listSetItems(userId)
  ]);
  const usage = new Map<string, number>();
  for (const link of links) {
    const id = String(link.trainingMenuItemId ?? "");
    usage.set(id, (usage.get(id) ?? 0) + 1);
  }
  return response(200, {
    items: (result.Items ?? []).map((item) =>
      toMenuItemResponse(item as Record<string, unknown>, usage.get(String(item.trainingMenuItemId)) ?? 0)
    ),
    nextToken: await encodePageToken(result.LastEvaluatedKey as Record<string, unknown> | undefined, context, userId)
  });
}

async function createMenuItem(event: APIGatewayProxyEvent, userId: string): Promise<APIGatewayProxyResult> {
  const body = parseBody<MenuItemInput>(event);
  const trainingName = toNonEmptyString(body?.trainingName);
  if (!body || !trainingName) {
    return response(400, { message: "trainingName is required." });
  }
  const normalizedTrainingName = normalizeTrainingName(trainingName);
  if (await existsByName(userId, normalizedTrainingName)) {
    return response(409, { message: "trainingName already exists." });
  }
  const equipment = normalizeEquipment(body.equipment ?? "その他");
  const description = trimmed(body.description) ?? "";
  const weightInputMode = body.weightInputMode ?? "direct";
  if (!equipment || description.length > 500 || !["direct", "perSide"].includes(weightInputMode)) {
    return response(400, { message: "invalid menu item." });
  }
  const trainingMenuItemId = randomUUID();
  const displayOrder = await nextOrder(trainingMenuTableName, menuItemOrderIndex, userId, "displayOrder");
  const ts = nowIsoSeconds();
  const item = {
    userId,
    trainingMenuItemId,
    trainingName,
    normalizedTrainingName,
    bodyPart: trimmed(body.bodyPart) ?? "",
    equipment,
    description,
    weightInputMode,
    loadMultiplier: normalizeLoadMultiplier(body.loadMultiplier, weightInputMode),
    fixedWeightKg: normalizeFixedWeightKg(body.fixedWeightKg, weightInputMode),
    isAiGenerated: body.isAiGenerated === true,
    isActive: true,
    displayOrder,
    createdAt: ts,
    updatedAt: ts
  };
  await ddb.send(new PutCommand({
    TableName: trainingMenuTableName,
    Item: item,
    ConditionExpression: "attribute_not_exists(userId) AND attribute_not_exists(trainingMenuItemId)"
  }));
  return response(201, toMenuItemResponse(item));
}

async function updateMenuItem(
  event: APIGatewayProxyEvent,
  userId: string,
  trainingMenuItemId: string
): Promise<APIGatewayProxyResult> {
  const body = parseBody<Partial<MenuItemInput>>(event);
  const current = await getMenuItem(userId, trainingMenuItemId);
  if (!body || !current) {
    return response(current ? 400 : 404, { message: current ? "Invalid JSON body." : "training menu item not found." });
  }
  const trainingName = body.trainingName !== undefined ? toNonEmptyString(body.trainingName) : String(current.trainingName);
  if (!trainingName) {
    return response(400, { message: "trainingName is required." });
  }
  const normalizedTrainingName = normalizeTrainingName(trainingName);
  const duplicateId = await existsByName(userId, normalizedTrainingName);
  if (duplicateId && duplicateId !== trainingMenuItemId) {
    return response(409, { message: "trainingName already exists." });
  }
  const equipment = body.equipment !== undefined ? normalizeEquipment(body.equipment) : normalizeEquipment(current.equipment);
  const description = body.description !== undefined ? trimmed(body.description) ?? "" : String(current.description ?? "");
  const weightInputMode = body.weightInputMode ?? normalizeWeightInputMode(current.weightInputMode);
  if (!equipment || description.length > 500) {
    return response(400, { message: "invalid menu item." });
  }
  const updatedAt = nowIsoSeconds();
  const updated = {
    trainingName,
    normalizedTrainingName,
    bodyPart: body.bodyPart !== undefined ? trimmed(body.bodyPart) ?? "" : String(current.bodyPart ?? ""),
    equipment,
    description,
    weightInputMode,
    loadMultiplier: normalizeLoadMultiplier(body.loadMultiplier ?? current.loadMultiplier, weightInputMode),
    fixedWeightKg: normalizeFixedWeightKg(body.fixedWeightKg ?? current.fixedWeightKg, weightInputMode),
    isAiGenerated: body.isAiGenerated ?? (current.isAiGenerated === true),
    isActive: body.isActive ?? (current.isActive !== false),
    updatedAt
  };
  await ddb.send(new UpdateCommand({
    TableName: trainingMenuTableName,
    Key: { userId, trainingMenuItemId },
    UpdateExpression:
      "SET trainingName=:trainingName, normalizedTrainingName=:normalizedTrainingName, bodyPart=:bodyPart, equipment=:equipment, #description=:description, weightInputMode=:weightInputMode, loadMultiplier=:loadMultiplier, fixedWeightKg=:fixedWeightKg, isAiGenerated=:isAiGenerated, isActive=:isActive, updatedAt=:updatedAt REMOVE frequency, defaultWeightKg, defaultRepsMin, defaultRepsMax, defaultReps, defaultSets",
    ExpressionAttributeNames: { "#description": "description" },
    ExpressionAttributeValues: Object.fromEntries(Object.entries(updated).map(([key, value]) => [`:${key}`, value]))
  }));
  return response(200, toMenuItemResponse({ ...current, ...updated }));
}

async function deleteInChunks(items: NonNullable<TransactWriteCommandInput["TransactItems"]>): Promise<void> {
  for (let index = 0; index < items.length; index += 25) {
    await ddb.send(new TransactWriteCommand({ TransactItems: items.slice(index, index + 25) }));
  }
}

async function deleteMenuItem(userId: string, trainingMenuItemId: string): Promise<APIGatewayProxyResult> {
  const links = await ddb.send(new QueryCommand({
    TableName: trainingMenuSetItemTableName,
    IndexName: setItemsByMenuItemIndex,
    KeyConditionExpression: "userId=:userId AND trainingMenuItemId=:itemId",
    ExpressionAttributeValues: { ":userId": userId, ":itemId": trainingMenuItemId }
  }));
  await deleteInChunks((links.Items ?? []).map((item) => ({
    Delete: { TableName: trainingMenuSetItemTableName, Key: { userId, trainingMenuSetItemId: item.trainingMenuSetItemId } }
  })));
  await ddb.send(new DeleteCommand({ TableName: trainingMenuTableName, Key: { userId, trainingMenuItemId } }));
  return response(204, {});
}

async function listMenuSets(userId: string): Promise<APIGatewayProxyResult> {
  const [setsResult, setItems] = await Promise.all([
    ddb.send(new QueryCommand({
      TableName: trainingMenuSetTableName,
      IndexName: menuSetByOrderIndex,
      KeyConditionExpression: "userId=:userId",
      ExpressionAttributeValues: { ":userId": userId }
    })),
    listSetItems(userId)
  ]);
  const itemsBySet = new Map<string, Record<string, unknown>[]>();
  for (const item of setItems) {
    const setId = String(item.trainingMenuSetId);
    itemsBySet.set(setId, [...(itemsBySet.get(setId) ?? []), item]);
  }
  return response(200, {
    items: (setsResult.Items ?? [])
      .filter((set) => set.isActive !== false)
      .map((set) => toMenuSetResponse(
        set as Record<string, unknown>,
        itemsBySet.get(String(set.trainingMenuSetId)) ?? []
      ))
  });
}

async function getMenuSetDetail(userId: string, trainingMenuSetId: string): Promise<APIGatewayProxyResult> {
  const [set, items] = await Promise.all([
    getMenuSet(userId, trainingMenuSetId),
    listSetItems(userId, trainingMenuSetId)
  ]);
  if (!set || set.isActive === false) {
    return response(404, { message: "training menu set not found." });
  }
  return response(200, toMenuSetResponse(set, items));
}

async function createMenuSet(event: APIGatewayProxyEvent, userId: string): Promise<APIGatewayProxyResult> {
  const body = parseBody<MenuSetInput>(event);
  const setName = toNonEmptyString(body?.setName);
  if (!body || !setName) {
    return response(400, { message: "setName is required." });
  }
  const setType = normalizeSetType(body.setType);
  const source = normalizeSource(body.source);
  const scheduledDate = body.scheduledDate ? parseYmd(body.scheduledDate) : undefined;
  if (body.scheduledDate && !scheduledDate) {
    return response(400, { message: "scheduledDate must be YYYY-MM-DD." });
  }
  if (setType === "temporary" && body.isDefault) {
    return response(400, { message: "temporary set cannot be default." });
  }
  const currentDefaultId = await getCurrentDefaultSetId(userId);
  const isDefault = setType === "reusable" && (body.isDefault === true || !currentDefaultId);
  const trainingMenuSetId = randomUUID();
  const menuSetOrder = await nextOrder(trainingMenuSetTableName, menuSetByOrderIndex, userId, "menuSetOrder");
  const ts = nowIsoSeconds();
  const item = {
    userId,
    trainingMenuSetId,
    setName,
    menuSetOrder,
    setType,
    source,
    ...(scheduledDate ? { scheduledDate } : {}),
    isDefault,
    ...(isDefault ? { defaultSetMarker } : {}),
    isActive: true,
    createdAt: ts,
    updatedAt: ts
  };
  const writes: NonNullable<TransactWriteCommandInput["TransactItems"]> = [];
  if (isDefault && currentDefaultId) {
    writes.push({
      Update: {
        TableName: trainingMenuSetTableName,
        Key: { userId, trainingMenuSetId: currentDefaultId },
        UpdateExpression: "SET isDefault=:false, updatedAt=:updatedAt REMOVE defaultSetMarker",
        ExpressionAttributeValues: { ":false": false, ":updatedAt": ts }
      }
    });
  }
  writes.push({ Put: { TableName: trainingMenuSetTableName, Item: item } });
  await ddb.send(new TransactWriteCommand({ TransactItems: writes }));
  return response(201, toMenuSetResponse(item, []));
}

async function updateMenuSet(
  event: APIGatewayProxyEvent,
  userId: string,
  trainingMenuSetId: string
): Promise<APIGatewayProxyResult> {
  const body = parseBody<Partial<MenuSetInput>>(event);
  const current = await getMenuSet(userId, trainingMenuSetId);
  if (!body || !current) {
    return response(current ? 400 : 404, { message: current ? "Invalid JSON body." : "training menu set not found." });
  }
  const setName = body.setName !== undefined ? toNonEmptyString(body.setName) : String(current.setName);
  const setType = body.setType !== undefined ? normalizeSetType(body.setType) : normalizeSetType(current.setType);
  const source = body.source !== undefined ? normalizeSource(body.source) : normalizeSource(current.source);
  const scheduledDate = body.scheduledDate === undefined
    ? (typeof current.scheduledDate === "string" ? current.scheduledDate : undefined)
    : body.scheduledDate
      ? parseYmd(body.scheduledDate)
      : undefined;
  const makeDefault = body.isDefault === true;
  if (!setName || (body.scheduledDate && !scheduledDate) || (setType === "temporary" && makeDefault)) {
    return response(400, { message: "invalid training menu set." });
  }
  if (current.isDefault === true && setType === "temporary") {
    return response(400, { message: "default set cannot be changed to temporary." });
  }
  if (body.isDefault === false && current.isDefault === true) {
    return response(400, { message: "choose another reusable set as default first." });
  }
  const ts = nowIsoSeconds();
  const currentDefaultId = makeDefault ? await getCurrentDefaultSetId(userId) : null;
  const writes: NonNullable<TransactWriteCommandInput["TransactItems"]> = [];
  if (makeDefault && currentDefaultId && currentDefaultId !== trainingMenuSetId) {
    writes.push({
      Update: {
        TableName: trainingMenuSetTableName,
        Key: { userId, trainingMenuSetId: currentDefaultId },
        UpdateExpression: "SET isDefault=:false, updatedAt=:updatedAt REMOVE defaultSetMarker",
        ExpressionAttributeValues: { ":false": false, ":updatedAt": ts }
      }
    });
  }
  const isDefault = setType === "reusable" && (makeDefault || current.isDefault === true);
  const setParts = [
    "setName=:setName",
    "setType=:setType",
    "#source=:source",
    "isDefault=:isDefault",
    "updatedAt=:updatedAt"
  ];
  const removeParts: string[] = [];
  if (scheduledDate) {
    setParts.push("scheduledDate=:scheduledDate");
  } else {
    removeParts.push("scheduledDate");
  }
  if (isDefault) {
    setParts.push("defaultSetMarker=:defaultSetMarker");
  } else {
    removeParts.push("defaultSetMarker");
  }
  writes.push({
    Update: {
      TableName: trainingMenuSetTableName,
      Key: { userId, trainingMenuSetId },
      UpdateExpression: `SET ${setParts.join(", ")}${removeParts.length ? ` REMOVE ${removeParts.join(", ")}` : ""}`,
      ExpressionAttributeNames: { "#source": "source" },
      ExpressionAttributeValues: {
        ":setName": setName,
        ":setType": setType,
        ":source": source,
        ":isDefault": isDefault,
        ":updatedAt": ts,
        ...(scheduledDate ? { ":scheduledDate": scheduledDate } : {}),
        ...(isDefault ? { ":defaultSetMarker": defaultSetMarker } : {})
      }
    }
  });
  await ddb.send(new TransactWriteCommand({ TransactItems: writes }));
  return response(200, toMenuSetResponse({
    ...current,
    setName,
    setType,
    source,
    scheduledDate,
    isDefault,
    updatedAt: ts
  }, await listSetItems(userId, trainingMenuSetId)));
}

async function deleteMenuSet(userId: string, trainingMenuSetId: string): Promise<APIGatewayProxyResult> {
  const current = await getMenuSet(userId, trainingMenuSetId);
  if (!current) {
    return response(404, { message: "training menu set not found." });
  }
  if (current.isDefault === true) {
    return response(400, { message: "default set cannot be deleted." });
  }
  const [links, plans] = await Promise.all([
    listSetItems(userId, trainingMenuSetId),
    ddb.send(new QueryCommand({
      TableName: dailyTrainingPlanTableName,
      KeyConditionExpression: "userId=:userId",
      ExpressionAttributeValues: { ":userId": userId }
    }))
  ]);
  await deleteInChunks([
    ...links.map((item) => ({
      Delete: { TableName: trainingMenuSetItemTableName, Key: { userId, trainingMenuSetItemId: item.trainingMenuSetItemId } }
    })),
    ...(plans.Items ?? [])
      .filter((plan) => plan.trainingMenuSetId === trainingMenuSetId)
      .map((plan) => ({
        Delete: { TableName: dailyTrainingPlanTableName, Key: { userId, planDate: plan.planDate } }
      }))
  ]);
  await ddb.send(new DeleteCommand({ TableName: trainingMenuSetTableName, Key: { userId, trainingMenuSetId } }));
  return response(204, {});
}

async function addSetItem(
  event: APIGatewayProxyEvent,
  userId: string,
  trainingMenuSetId: string
): Promise<APIGatewayProxyResult> {
  const body = parseBody<PrescriptionInput>(event);
  const trainingMenuItemId = toNonEmptyString(body?.trainingMenuItemId);
  const prescription = body ? parsePrescription(body) : null;
  if (!body || !trainingMenuItemId || !prescription) {
    return response(400, { message: "trainingMenuItemId and valid prescription are required." });
  }
  const [set, item, duplicate] = await Promise.all([
    getMenuSet(userId, trainingMenuSetId),
    getMenuItem(userId, trainingMenuItemId),
    ddb.send(new QueryCommand({
      TableName: trainingMenuSetItemTableName,
      IndexName: setItemsBySetAndItemIndex,
      KeyConditionExpression: "userId=:userId AND menuSetItemKey=:key",
      ExpressionAttributeValues: { ":userId": userId, ":key": buildMenuSetItemKey(trainingMenuSetId, trainingMenuItemId) },
      Limit: 1
    }))
  ]);
  if (!set || !item) {
    return response(404, { message: "training menu set or item not found." });
  }
  if (duplicate.Items?.length) {
    return response(409, { message: "training menu item already assigned to the set." });
  }
  const currentItems = await listSetItems(userId, trainingMenuSetId);
  const displayOrder = Math.max(0, ...currentItems.map((entry) => Number(entry.displayOrder))) + 1;
  const trainingMenuSetItemId = randomUUID();
  const ts = nowIsoSeconds();
  const setItem = {
    userId,
    trainingMenuSetItemId,
    trainingMenuSetId,
    trainingMenuItemId,
    displayOrder,
    menuSetOrderKey: buildMenuSetOrderKey(trainingMenuSetId, displayOrder),
    menuSetItemKey: buildMenuSetItemKey(trainingMenuSetId, trainingMenuItemId),
    ...prescription,
    createdAt: ts,
    updatedAt: ts
  };
  await ddb.send(new PutCommand({ TableName: trainingMenuSetItemTableName, Item: setItem }));
  return response(201, toSetItemResponse(setItem));
}

async function updateSetItem(
  event: APIGatewayProxyEvent,
  userId: string,
  trainingMenuSetId: string,
  trainingMenuSetItemId: string
): Promise<APIGatewayProxyResult> {
  const body = parseBody<PrescriptionInput>(event);
  const current = await getSetItem(userId, trainingMenuSetItemId);
  const prescription = body && current ? parsePrescription(body, current) : null;
  if (!current || current.trainingMenuSetId !== trainingMenuSetId) {
    return response(404, { message: "training menu set item not found." });
  }
  if (!body || !prescription) {
    return response(400, { message: "invalid prescription." });
  }
  const updatedAt = nowIsoSeconds();
  await ddb.send(new UpdateCommand({
    TableName: trainingMenuSetItemTableName,
    Key: { userId, trainingMenuSetItemId },
    UpdateExpression:
      "SET targetWeightKg=:targetWeightKg, targetRepsMin=:targetRepsMin, targetRepsMax=:targetRepsMax, targetSets=:targetSets, recommendedIntervalDays=:recommendedIntervalDays, instruction=:instruction, createdBy=:createdBy, updatedAt=:updatedAt",
    ExpressionAttributeValues: {
      ...Object.fromEntries(Object.entries(prescription).map(([key, value]) => [`:${key}`, value])),
      ":updatedAt": updatedAt
    }
  }));
  return response(200, toSetItemResponse({ ...current, ...prescription, updatedAt }));
}

async function removeSetItem(
  userId: string,
  trainingMenuSetId: string,
  trainingMenuSetItemId: string
): Promise<APIGatewayProxyResult> {
  const current = await getSetItem(userId, trainingMenuSetItemId);
  if (!current || current.trainingMenuSetId !== trainingMenuSetId) {
    return response(404, { message: "training menu set item not found." });
  }
  await ddb.send(new DeleteCommand({ TableName: trainingMenuSetItemTableName, Key: { userId, trainingMenuSetItemId } }));
  return response(204, {});
}

async function reorderSetItems(
  event: APIGatewayProxyEvent,
  userId: string,
  trainingMenuSetId: string
): Promise<APIGatewayProxyResult> {
  const body = parseBody<{ items: Array<{ trainingMenuSetItemId: string; displayOrder: number }> }>(event);
  if (!body?.items?.length || body.items.length > 25) {
    return response(400, { message: "items must contain 1 to 25 entries." });
  }
  const current = new Map((await listSetItems(userId, trainingMenuSetId)).map((item) => [item.trainingMenuSetItemId, item]));
  if (body.items.some((item) => !current.has(item.trainingMenuSetItemId))) {
    return response(404, { message: "one or more training menu set items were not found." });
  }
  const updatedAt = nowIsoSeconds();
  await ddb.send(new TransactWriteCommand({
    TransactItems: body.items.map((item) => ({
      Update: {
        TableName: trainingMenuSetItemTableName,
        Key: { userId, trainingMenuSetItemId: item.trainingMenuSetItemId },
        UpdateExpression: "SET displayOrder=:displayOrder, menuSetOrderKey=:orderKey, updatedAt=:updatedAt",
        ExpressionAttributeValues: {
          ":displayOrder": Math.max(1, Math.floor(item.displayOrder)),
          ":orderKey": buildMenuSetOrderKey(trainingMenuSetId, item.displayOrder),
          ":updatedAt": updatedAt
        }
      }
    }))
  }));
  return response(200, { updatedCount: body.items.length });
}

async function bulkUpdateSetItems(
  event: APIGatewayProxyEvent,
  userId: string,
  trainingMenuSetId: string
): Promise<APIGatewayProxyResult> {
  const body = parseBody<{ items: Array<PrescriptionInput & { trainingMenuSetItemId: string }> }>(event);
  if (!body?.items?.length || body.items.length > 25) {
    return response(400, { message: "items must contain 1 to 25 entries." });
  }
  const currentItems = new Map(
    (await listSetItems(userId, trainingMenuSetId)).map((item) => [String(item.trainingMenuSetItemId), item])
  );
  const updates = body.items.map((input) => {
    const current = currentItems.get(input.trainingMenuSetItemId);
    const prescription = current ? parsePrescription(input, current) : null;
    return current && prescription ? { current, prescription } : null;
  });
  if (updates.some((item) => item === null)) {
    return response(400, { message: "one or more prescriptions are invalid." });
  }
  const updatedAt = nowIsoSeconds();
  await ddb.send(new TransactWriteCommand({
    TransactItems: updates.map((update) => {
      const value = update!;
      return {
        Update: {
          TableName: trainingMenuSetItemTableName,
          Key: { userId, trainingMenuSetItemId: value.current.trainingMenuSetItemId },
          UpdateExpression:
            "SET targetWeightKg=:targetWeightKg, targetRepsMin=:targetRepsMin, targetRepsMax=:targetRepsMax, targetSets=:targetSets, recommendedIntervalDays=:recommendedIntervalDays, instruction=:instruction, createdBy=:createdBy, updatedAt=:updatedAt",
          ExpressionAttributeValues: {
            ...Object.fromEntries(Object.entries(value.prescription).map(([key, item]) => [`:${key}`, item])),
            ":updatedAt": updatedAt
          }
        }
      };
    })
  }));
  return response(200, { updatedCount: updates.length });
}

async function getDailyPlan(userId: string, planDate: string): Promise<APIGatewayProxyResult> {
  const result = await ddb.send(new GetCommand({
    TableName: dailyTrainingPlanTableName,
    Key: { userId, planDate }
  }));
  return result.Item
    ? response(200, {
        planDate: result.Item.planDate,
        trainingMenuSetId: result.Item.trainingMenuSetId,
        source: normalizeSource(result.Item.source),
        createdAt: result.Item.createdAt,
        updatedAt: result.Item.updatedAt
      })
    : response(404, { message: "daily training plan not found." });
}

async function putDailyPlan(
  event: APIGatewayProxyEvent,
  userId: string,
  planDate: string
): Promise<APIGatewayProxyResult> {
  const body = parseBody<{ trainingMenuSetId: string; source?: DataSource }>(event);
  const trainingMenuSetId = toNonEmptyString(body?.trainingMenuSetId);
  const set = trainingMenuSetId ? await getMenuSet(userId, trainingMenuSetId) : null;
  if (!body || !trainingMenuSetId || !set || set.isActive === false) {
    return response(404, { message: "training menu set not found." });
  }
  const existing = await ddb.send(new GetCommand({
    TableName: dailyTrainingPlanTableName,
    Key: { userId, planDate }
  }));
  const ts = nowIsoSeconds();
  const item = {
    userId,
    planDate,
    trainingMenuSetId,
    source: normalizeSource(body.source),
    createdAt: existing.Item?.createdAt ?? ts,
    updatedAt: ts
  };
  await ddb.send(new PutCommand({ TableName: dailyTrainingPlanTableName, Item: item }));
  return response(existing.Item ? 200 : 201, {
    planDate,
    trainingMenuSetId,
    source: item.source,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  });
}

async function deleteDailyPlan(userId: string, planDate: string): Promise<APIGatewayProxyResult> {
  await ddb.send(new DeleteCommand({ TableName: dailyTrainingPlanTableName, Key: { userId, planDate } }));
  return response(204, {});
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  if (!trainingMenuTableName || !trainingMenuSetTableName || !trainingMenuSetItemTableName || !dailyTrainingPlanTableName) {
    return response(500, { message: "Lambda environment is not configured." });
  }
  const userId = getUserId(event);
  if (!userId) {
    return response(401, { message: "Unauthorized" });
  }
  const path = normalizePath(event);
  const method = event.httpMethod.toUpperCase();

  const dailyPlanMatch = path.match(/^\/daily-training-plans\/(\d{4}-\d{2}-\d{2})\/?$/);
  if (dailyPlanMatch) {
    if (!parseYmd(dailyPlanMatch[1])) return response(400, { message: "invalid date." });
    if (method === "GET") return getDailyPlan(userId, dailyPlanMatch[1]);
    if (method === "PUT") return putDailyPlan(event, userId, dailyPlanMatch[1]);
    if (method === "DELETE") return deleteDailyPlan(userId, dailyPlanMatch[1]);
  }

  if (/^\/training-menu-sets\/?$/.test(path)) {
    if (method === "GET") return listMenuSets(userId);
    if (method === "POST") return createMenuSet(event, userId);
  }
  const reorderMatch = path.match(/^\/training-menu-sets\/([^/]+)\/items\/reorder\/?$/);
  if (reorderMatch && method === "PUT") return reorderSetItems(event, userId, reorderMatch[1]);
  const bulkMatch = path.match(/^\/training-menu-sets\/([^/]+)\/items\/bulk\/?$/);
  if (bulkMatch && method === "PUT") return bulkUpdateSetItems(event, userId, bulkMatch[1]);
  const setItemMatch = path.match(/^\/training-menu-sets\/([^/]+)\/items\/([^/]+)\/?$/);
  if (setItemMatch && method === "PUT") return updateSetItem(event, userId, setItemMatch[1], setItemMatch[2]);
  if (setItemMatch && method === "DELETE") return removeSetItem(userId, setItemMatch[1], setItemMatch[2]);
  const setItemsMatch = path.match(/^\/training-menu-sets\/([^/]+)\/items\/?$/);
  if (setItemsMatch && method === "POST") return addSetItem(event, userId, setItemsMatch[1]);
  const setMatch = path.match(/^\/training-menu-sets\/([^/]+)\/?$/);
  if (setMatch && method === "GET") return getMenuSetDetail(userId, setMatch[1]);
  if (setMatch && method === "PUT") return updateMenuSet(event, userId, setMatch[1]);
  if (setMatch && method === "DELETE") return deleteMenuSet(userId, setMatch[1]);

  if (/^\/training-menu-items\/?$/.test(path)) {
    if (method === "GET") return listMenuItems(event, userId);
    if (method === "POST") return createMenuItem(event, userId);
  }
  const itemMatch = path.match(/^\/training-menu-items\/([^/]+)\/?$/);
  if (itemMatch && method === "PUT") return updateMenuItem(event, userId, itemMatch[1]);
  if (itemMatch && method === "DELETE") return deleteMenuItem(userId, itemMatch[1]);

  return response(404, { message: "Not found" });
};

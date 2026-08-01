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
import { enumerateYmdRange } from "../shared/date-range";
import { getUserId, normalizePath, nowIsoSeconds, parseBody, parseYmd, response, toNonEmptyString } from "../shared/http";
import {
  MUSCLE_TAXONOMY_VERSION,
  normalizeEquipmentType,
  normalizeJointActions,
  normalizeLaterality,
  normalizeLoadModel,
  normalizeMovementFamily,
  normalizeMuscleTargets,
  type EquipmentType,
  type JointAction,
  type Laterality,
  type LoadModel,
  type MovementFamily,
  type MuscleTarget
} from "../shared/muscle-targets";
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
type DailyPlanType = "training" | "rest";

type MenuItemInput = {
  trainingName: string;
  exerciseFamilyId?: string;
  muscleTargets?: MuscleTarget[];
  movementFamily?: MovementFamily;
  jointActions?: JointAction[];
  laterality?: Laterality;
  loadModel?: LoadModel;
  equipmentType?: EquipmentType;
  equipmentProfileId?: string;
  cableSettings?: {
    pulleyPosition?: string;
    attachmentType?: string;
    cableSides?: string;
  };
  isAiGenerated?: boolean;
  description?: string;
  weightInputMode?: WeightInputMode;
  loadMultiplier?: 1 | 2;
  fixedWeightKg?: number;
  isActive?: boolean;
  expectedVersion?: number;
  updateReason?: string;
};

type MenuSetInput = {
  setName: string;
  setType?: MenuSetType;
  source?: DataSource;
  validFromDate?: string;
  validToDate?: string;
  replaceExistingPlan?: boolean;
  isDefault?: boolean;
  expectedVersion?: number;
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

function isValidFixedWeightKg(value: unknown): boolean {
  return value === undefined ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function normalizeCableSettings(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const pulleyPositions = ["high", "middle", "low", "adjustable"];
  const attachmentTypes = ["single_handle", "rope", "straight_bar", "ez_bar", "ankle_strap", "none", "other"];
  if (
    !pulleyPositions.includes(String(record.pulleyPosition)) ||
    !attachmentTypes.includes(String(record.attachmentType)) ||
    (record.cableSides !== "single" && record.cableSides !== "dual")
  ) {
    return undefined;
  }
  return {
    pulleyPosition: String(record.pulleyPosition),
    attachmentType: String(record.attachmentType),
    cableSides: record.cableSides
  };
}

function normalizeSetType(value: unknown): MenuSetType {
  return value === "temporary" ? "temporary" : "reusable";
}

function menuSetVersion(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function menuSetVersionCondition(version: number): string {
  return version === 0
    ? "(attribute_not_exists(#version) OR #version = :expectedVersion)"
    : "#version = :expectedVersion";
}

function buildMenuSetVersionBump(
  userId: string,
  set: Record<string, unknown>,
  updatedAt: string
): NonNullable<TransactWriteCommandInput["TransactItems"]>[number] {
  const currentVersion = menuSetVersion(set.version);
  return {
    Update: {
      TableName: trainingMenuSetTableName,
      Key: { userId, trainingMenuSetId: set.trainingMenuSetId },
      UpdateExpression:
        "SET #version=:nextVersion, updatedAt=:updatedAt, updatedBy=:updatedBy, updateReason=:updateReason",
      ConditionExpression: menuSetVersionCondition(currentVersion),
      ExpressionAttributeNames: { "#version": "version" },
      ExpressionAttributeValues: {
        ":expectedVersion": currentVersion,
        ":nextVersion": currentVersion + 1,
        ":updatedAt": updatedAt,
        ":updatedBy": "user",
        ":updateReason": "Menu set items updated"
      }
    }
  };
}

function normalizeSource(value: unknown): DataSource {
  return value === "ai" ? "ai" : "manual";
}

function normalizeDailyPlanType(value: unknown): DailyPlanType {
  return value === "rest" ? "rest" : "training";
}

function normalizeRestDates(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((date): date is string => typeof date === "string" && Boolean(parseYmd(date)))
    : [];
}

function dailyPlanWriteCondition(existing?: Record<string, unknown>): {
  ConditionExpression: string;
  ExpressionAttributeValues?: Record<string, unknown>;
} {
  if (!existing) {
    return { ConditionExpression: "attribute_not_exists(userId)" };
  }
  if (typeof existing.updatedAt === "string") {
    return {
      ConditionExpression: "updatedAt = :expectedPlanUpdatedAt",
      ExpressionAttributeValues: { ":expectedPlanUpdatedAt": existing.updatedAt }
    };
  }
  if (typeof existing.trainingMenuSetId === "string") {
    return {
      ConditionExpression: "trainingMenuSetId = :expectedTrainingMenuSetId",
      ExpressionAttributeValues: { ":expectedTrainingMenuSetId": existing.trainingMenuSetId }
    };
  }
  return {
    ConditionExpression: "planType = :expectedPlanType",
    ExpressionAttributeValues: { ":expectedPlanType": normalizeDailyPlanType(existing.planType) }
  };
}

function validityFromSet(set: Record<string, unknown>): { validFromDate?: string; validToDate?: string } {
  const legacyDate = typeof set.scheduledDate === "string" ? set.scheduledDate : undefined;
  return {
    validFromDate: typeof set.validFromDate === "string" ? set.validFromDate : legacyDate,
    validToDate: typeof set.validToDate === "string" ? set.validToDate : legacyDate
  };
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
    exerciseFamilyId: String(item.exerciseFamilyId ?? item.trainingMenuItemId ?? ""),
    muscleTargets: normalizeMuscleTargets(item.muscleTargets) ?? [],
    movementFamily: normalizeMovementFamily(item.movementFamily),
    jointActions: normalizeJointActions(item.jointActions) ?? [],
    laterality: normalizeLaterality(item.laterality),
    loadModel: normalizeLoadModel(item.loadModel),
    classificationVersion: Number(item.classificationVersion ?? MUSCLE_TAXONOMY_VERSION),
    equipmentType: normalizeEquipmentType(item.equipmentType) ?? "other",
    equipmentProfileId: trimmed(item.equipmentProfileId),
    cableSettings: normalizeCableSettings(item.cableSettings),
    isAiGenerated: item.isAiGenerated === true,
    description: String(item.description ?? ""),
    weightInputMode,
    loadMultiplier: normalizeLoadMultiplier(item.loadMultiplier, weightInputMode),
    fixedWeightKg: normalizeFixedWeightKg(item.fixedWeightKg, weightInputMode),
    isActive: item.isActive !== false,
    version: menuSetVersion(item.version),
    usageCount,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    updatedBy: item.updatedBy,
    updateReason: item.updateReason
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
  const validity = validityFromSet(set);
  return {
    trainingMenuSetId: set.trainingMenuSetId,
    setName: String(set.setName ?? ""),
    menuSetOrder: Number(set.menuSetOrder ?? 0),
    setType: normalizeSetType(set.setType),
    source: normalizeSource(set.source),
    ...validity,
    restDates: normalizeRestDates(set.restDates),
    isDefault: set.isDefault === true,
    isActive: set.isActive !== false,
    version: menuSetVersion(set.version),
    updatedBy: set.updatedBy,
    updateReason: set.updateReason,
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
  const equipmentType = normalizeEquipmentType(body.equipmentType);
  const exerciseFamilyId = trimmed(body.exerciseFamilyId) ?? trainingName;
  const description = trimmed(body.description) ?? "";
  const weightInputMode = body.weightInputMode ?? "direct";
  const muscleTargets = normalizeMuscleTargets(body.muscleTargets);
  const movementFamily = normalizeMovementFamily(body.movementFamily);
  const jointActions = normalizeJointActions(body.jointActions);
  const laterality = normalizeLaterality(body.laterality);
  const loadModel = normalizeLoadModel(body.loadModel);
  if (
    !equipmentType ||
    !exerciseFamilyId ||
    exerciseFamilyId.length > 80 ||
    !muscleTargets ||
    !movementFamily ||
    !jointActions ||
    !laterality ||
    !loadModel ||
    description.length > 500 ||
    !["direct", "perSide"].includes(weightInputMode) ||
    !isValidFixedWeightKg(body.fixedWeightKg)
  ) {
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
    exerciseFamilyId,
    muscleTargets,
    movementFamily,
    jointActions,
    laterality,
    loadModel,
    classificationVersion: MUSCLE_TAXONOMY_VERSION,
    equipmentType,
    ...(trimmed(body.equipmentProfileId) ? { equipmentProfileId: trimmed(body.equipmentProfileId) } : {}),
    ...(equipmentType === "cable_machine"
      ? { cableSettings: normalizeCableSettings(body.cableSettings) ?? {
          pulleyPosition: "adjustable",
          attachmentType: "other",
          cableSides: "single"
        } }
      : {}),
    description,
    weightInputMode,
    loadMultiplier: normalizeLoadMultiplier(body.loadMultiplier, weightInputMode),
    fixedWeightKg: normalizeFixedWeightKg(body.fixedWeightKg, weightInputMode),
    isAiGenerated: body.isAiGenerated === true,
    isActive: true,
    displayOrder,
    version: 1,
    updatedBy: "user",
    updateReason: "Exercise master created",
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
  const equipmentType =
    body.equipmentType !== undefined
      ? normalizeEquipmentType(body.equipmentType)
      : normalizeEquipmentType(current.equipmentType);
  const exerciseFamilyId =
    body.exerciseFamilyId !== undefined ? trimmed(body.exerciseFamilyId) : trimmed(current.exerciseFamilyId);
  const description = body.description !== undefined ? trimmed(body.description) ?? "" : String(current.description ?? "");
  const weightInputMode = body.weightInputMode ?? normalizeWeightInputMode(current.weightInputMode);
  const muscleTargets =
    body.muscleTargets !== undefined
      ? normalizeMuscleTargets(body.muscleTargets)
      : normalizeMuscleTargets(current.muscleTargets);
  const movementFamily =
    body.movementFamily !== undefined
      ? normalizeMovementFamily(body.movementFamily)
      : normalizeMovementFamily(current.movementFamily);
  const jointActions =
    body.jointActions !== undefined
      ? normalizeJointActions(body.jointActions)
      : normalizeJointActions(current.jointActions);
  const laterality =
    body.laterality !== undefined ? normalizeLaterality(body.laterality) : normalizeLaterality(current.laterality);
  const loadModel =
    body.loadModel !== undefined ? normalizeLoadModel(body.loadModel) : normalizeLoadModel(current.loadModel);
  if (
    !equipmentType ||
    !exerciseFamilyId ||
    exerciseFamilyId.length > 80 ||
    !muscleTargets ||
    !movementFamily ||
    !jointActions ||
    !laterality ||
    !loadModel ||
    description.length > 500 ||
    !["direct", "perSide"].includes(weightInputMode) ||
    !isValidFixedWeightKg(body.fixedWeightKg)
  ) {
    return response(400, { message: "invalid menu item." });
  }
  const updatedAt = nowIsoSeconds();
  const currentVersion = menuSetVersion(current.version);
  const expectedVersion =
    body.expectedVersion === undefined ? currentVersion : body.expectedVersion;
  if (
    typeof expectedVersion !== "number" ||
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 0 ||
    expectedVersion !== currentVersion
  ) {
    return response(409, {
      code: "VERSION_CONFLICT",
      message: "training menu item changed.",
      currentVersion
    });
  }
  const nextVersion = currentVersion + 1;
  const updateReason = trimmed(body.updateReason) ?? "Exercise master updated";
  if (updateReason.length > 500) {
    return response(400, { message: "updateReason must not exceed 500 characters." });
  }
  const updated = {
    trainingName,
    normalizedTrainingName,
    exerciseFamilyId,
    muscleTargets,
    movementFamily,
    jointActions,
    laterality,
    loadModel,
    classificationVersion: MUSCLE_TAXONOMY_VERSION,
    equipmentType,
    equipmentProfileId:
      (body.equipmentProfileId !== undefined ? trimmed(body.equipmentProfileId) : trimmed(current.equipmentProfileId)) ?? "",
    cableSettings:
      equipmentType === "cable_machine"
        ? normalizeCableSettings(body.cableSettings ?? current.cableSettings) ?? {
            pulleyPosition: "adjustable",
            attachmentType: "other",
            cableSides: "single"
          }
        : null,
    description,
    weightInputMode,
    loadMultiplier: normalizeLoadMultiplier(body.loadMultiplier ?? current.loadMultiplier, weightInputMode),
    fixedWeightKg: normalizeFixedWeightKg(body.fixedWeightKg ?? current.fixedWeightKg, weightInputMode),
    isAiGenerated: body.isAiGenerated ?? (current.isAiGenerated === true),
    isActive: body.isActive ?? (current.isActive !== false),
    version: nextVersion,
    updatedBy: "user",
    updateReason,
    updatedAt
  };
  const versionCondition =
    expectedVersion === 0
      ? "(attribute_not_exists(#version) OR #version = :expectedVersion)"
      : "#version = :expectedVersion";
  try {
    await ddb.send(new UpdateCommand({
      TableName: trainingMenuTableName,
      Key: { userId, trainingMenuItemId },
      UpdateExpression:
        "SET trainingName=:trainingName, normalizedTrainingName=:normalizedTrainingName, exerciseFamilyId=:exerciseFamilyId, muscleTargets=:muscleTargets, movementFamily=:movementFamily, jointActions=:jointActions, laterality=:laterality, loadModel=:loadModel, classificationVersion=:classificationVersion, equipmentType=:equipmentType, equipmentProfileId=:equipmentProfileId, cableSettings=:cableSettings, #description=:description, weightInputMode=:weightInputMode, loadMultiplier=:loadMultiplier, fixedWeightKg=:fixedWeightKg, isAiGenerated=:isAiGenerated, isActive=:isActive, #version=:version, updatedBy=:updatedBy, updateReason=:updateReason, updatedAt=:updatedAt REMOVE bodyPart, movementPattern, equipment, frequency, defaultWeightKg, defaultRepsMin, defaultRepsMax, defaultReps, defaultSets",
      ConditionExpression: versionCondition,
      ExpressionAttributeNames: {
        "#description": "description",
        "#version": "version"
      },
      ExpressionAttributeValues: {
        ...Object.fromEntries(Object.entries(updated).map(([key, value]) => [`:${key}`, value])),
        ":expectedVersion": expectedVersion
      }
    }));
  } catch {
    return response(409, {
      code: "VERSION_CONFLICT",
      message: "training menu item changed while it was being updated."
    });
  }
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
  const validFromDate = body.validFromDate ? parseYmd(body.validFromDate) : undefined;
  const validToDate = body.validToDate ? parseYmd(body.validToDate) : undefined;
  const validityDates =
    setType === "temporary" && validFromDate && validToDate
      ? enumerateYmdRange(validFromDate, validToDate)
      : setType === "temporary"
        ? null
        : [];
  if (!validityDates) {
    return response(400, {
      message: "temporary set requires validFromDate and validToDate in YYYY-MM-DD format within 31 days."
    });
  }
  if (setType === "temporary" && body.isDefault) {
    return response(400, { message: "temporary set cannot be default." });
  }
  const existingPlans = await Promise.all(
    validityDates.map((planDate) =>
      ddb.send(new GetCommand({ TableName: dailyTrainingPlanTableName, Key: { userId, planDate } }))
    )
  );
  const conflicts = validityDates.filter((_, index) => Boolean(existingPlans[index].Item));
  if (conflicts.length && body.replaceExistingPlan !== true) {
    return response(409, {
      message: "one or more dates already have a temporary menu. confirm replacement first.",
      conflictingDates: conflicts
    });
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
    ...(validFromDate ? { validFromDate } : {}),
    ...(validToDate ? { validToDate } : {}),
    ...(setType === "temporary" ? { restDates: [] } : {}),
    isDefault,
    ...(isDefault ? { defaultSetMarker } : {}),
    isActive: true,
    version: 1,
    updatedBy: "user",
    updateReason: "Menu set created",
    createdAt: ts,
    updatedAt: ts
  };
  const writes: NonNullable<TransactWriteCommandInput["TransactItems"]> = [];
  if (isDefault && currentDefaultId) {
    writes.push({
      Update: {
        TableName: trainingMenuSetTableName,
        Key: { userId, trainingMenuSetId: currentDefaultId },
        UpdateExpression:
          "SET isDefault=:false, #version=if_not_exists(#version, :zero)+:one, updatedAt=:updatedAt, updatedBy=:updatedBy, updateReason=:updateReason REMOVE defaultSetMarker",
        ExpressionAttributeNames: { "#version": "version" },
        ExpressionAttributeValues: {
          ":false": false,
          ":zero": 0,
          ":one": 1,
          ":updatedAt": ts,
          ":updatedBy": "user",
          ":updateReason": "Default menu set changed"
        }
      }
    });
  }
  writes.push({ Put: { TableName: trainingMenuSetTableName, Item: item } });
  validityDates.forEach((planDate, index) => {
    const existing = existingPlans[index].Item;
    writes.push({
      Put: {
        TableName: dailyTrainingPlanTableName,
        Item: {
          userId,
          planDate,
          trainingMenuSetId,
          planType: "training",
          source,
          createdAt: existing?.createdAt ?? ts,
          updatedAt: ts
        },
        ...dailyPlanWriteCondition(existing as Record<string, unknown> | undefined)
      }
    });
  });
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
  const currentVersion = menuSetVersion(current.version);
  if (
    body.expectedVersion !== undefined &&
    (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 0 || body.expectedVersion !== currentVersion)
  ) {
    return response(409, {
      code: "VERSION_CONFLICT",
      message: "training menu set version does not match.",
      currentVersion
    });
  }
  const setName = body.setName !== undefined ? toNonEmptyString(body.setName) : String(current.setName);
  const setType = body.setType !== undefined ? normalizeSetType(body.setType) : normalizeSetType(current.setType);
  const source = body.source !== undefined ? normalizeSource(body.source) : normalizeSource(current.source);
  const currentValidity = validityFromSet(current);
  const validFromDate = setType === "temporary"
    ? (body.validFromDate !== undefined ? parseYmd(body.validFromDate) : currentValidity.validFromDate)
    : undefined;
  const validToDate = setType === "temporary"
    ? (body.validToDate !== undefined ? parseYmd(body.validToDate) : currentValidity.validToDate)
    : undefined;
  const validityDates =
    setType === "temporary" && validFromDate && validToDate
      ? enumerateYmdRange(validFromDate, validToDate)
      : setType === "temporary"
        ? null
        : [];
  const makeDefault = body.isDefault === true;
  if (!setName || !validityDates || (setType === "temporary" && makeDefault)) {
    return response(400, { message: "invalid training menu set." });
  }
  if (current.isDefault === true && setType === "temporary") {
    return response(400, { message: "default set cannot be changed to temporary." });
  }
  if (body.isDefault === false && current.isDefault === true) {
    return response(400, { message: "choose another reusable set as default first." });
  }
  const ts = nowIsoSeconds();
  const restDates = setType === "temporary"
    ? normalizeRestDates(current.restDates).filter((date) => validityDates.includes(date))
    : [];
  const existingPlans = await Promise.all(
    validityDates.map((planDate) =>
      ddb.send(new GetCommand({ TableName: dailyTrainingPlanTableName, Key: { userId, planDate } }))
    )
  );
  const conflicts = validityDates.filter((_, index) => {
    const plan = existingPlans[index].Item;
    return Boolean(plan) && plan?.trainingMenuSetId !== trainingMenuSetId;
  });
  if (conflicts.length && body.replaceExistingPlan !== true) {
    return response(409, {
      message: "one or more dates already have a temporary menu. confirm replacement first.",
      conflictingDates: conflicts
    });
  }
  const oldValidityDates =
    currentValidity.validFromDate && currentValidity.validToDate
      ? enumerateYmdRange(currentValidity.validFromDate, currentValidity.validToDate) ?? []
      : [];
  const nextDateSet = new Set(validityDates);
  const oldOnlyDates = oldValidityDates.filter((planDate) => !nextDateSet.has(planDate));
  const oldOnlyPlans = await Promise.all(
    oldOnlyDates.map((planDate) =>
      ddb.send(new GetCommand({ TableName: dailyTrainingPlanTableName, Key: { userId, planDate } }))
    )
  );
  const currentDefaultId = makeDefault ? await getCurrentDefaultSetId(userId) : null;
  const writes: NonNullable<TransactWriteCommandInput["TransactItems"]> = [];
  if (makeDefault && currentDefaultId && currentDefaultId !== trainingMenuSetId) {
    writes.push({
      Update: {
        TableName: trainingMenuSetTableName,
        Key: { userId, trainingMenuSetId: currentDefaultId },
        UpdateExpression:
          "SET isDefault=:false, #version=if_not_exists(#version, :zero)+:one, updatedAt=:updatedAt, updatedBy=:updatedBy, updateReason=:updateReason REMOVE defaultSetMarker",
        ExpressionAttributeNames: { "#version": "version" },
        ExpressionAttributeValues: {
          ":false": false,
          ":zero": 0,
          ":one": 1,
          ":updatedAt": ts,
          ":updatedBy": "user",
          ":updateReason": "Default menu set changed"
        }
      }
    });
  }
  const isDefault = setType === "reusable" && (makeDefault || current.isDefault === true);
  const setParts = [
    "setName=:setName",
    "setType=:setType",
    "#source=:source",
    "isDefault=:isDefault",
    "#version=:nextVersion",
    "updatedBy=:updatedBy",
    "updateReason=:updateReason",
    "updatedAt=:updatedAt"
  ];
  const removeParts: string[] = [];
  if (validFromDate && validToDate) {
    setParts.push("validFromDate=:validFromDate", "validToDate=:validToDate", "restDates=:restDates");
  } else {
    removeParts.push("validFromDate", "validToDate", "restDates");
  }
  removeParts.push("scheduledDate");
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
      ExpressionAttributeNames: { "#source": "source", "#version": "version" },
      ConditionExpression: menuSetVersionCondition(currentVersion),
      ExpressionAttributeValues: {
        ":setName": setName,
        ":setType": setType,
        ":source": source,
        ":isDefault": isDefault,
        ":expectedVersion": currentVersion,
        ":nextVersion": currentVersion + 1,
        ":updatedBy": "user",
        ":updateReason": "Menu set updated",
        ":updatedAt": ts,
        ...(validFromDate && validToDate
          ? { ":validFromDate": validFromDate, ":validToDate": validToDate, ":restDates": restDates }
          : {}),
        ...(isDefault ? { ":defaultSetMarker": defaultSetMarker } : {})
      }
    }
  });
  oldOnlyDates.forEach((planDate, index) => {
    if (oldOnlyPlans[index].Item?.trainingMenuSetId === trainingMenuSetId) {
      writes.push({
        Delete: {
          TableName: dailyTrainingPlanTableName,
          Key: { userId, planDate },
          ConditionExpression: "trainingMenuSetId = :trainingMenuSetId",
          ExpressionAttributeValues: { ":trainingMenuSetId": trainingMenuSetId }
        }
      });
    }
  });
  validityDates.forEach((planDate, index) => {
    const existing = existingPlans[index].Item;
    writes.push({
      Put: {
        TableName: dailyTrainingPlanTableName,
        Item: {
          userId,
          planDate,
          trainingMenuSetId,
          planType: restDates.includes(planDate) ? "rest" : "training",
          source,
          createdAt: existing?.createdAt ?? ts,
          updatedAt: ts
        },
        ...dailyPlanWriteCondition(existing as Record<string, unknown> | undefined)
      }
    });
  });
  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: writes }));
  } catch {
    return response(409, {
      code: "VERSION_CONFLICT",
      message: "training menu set changed while the update was being applied."
    });
  }
  return response(200, toMenuSetResponse({
    ...current,
    setName,
    setType,
    source,
    validFromDate,
    validToDate,
    restDates,
    isDefault,
    version: currentVersion + 1,
    updatedBy: "user",
    updateReason: "Menu set updated",
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
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: trainingMenuSetItemTableName,
            Item: setItem,
            ConditionExpression:
              "attribute_not_exists(userId) AND attribute_not_exists(trainingMenuSetItemId)"
          }
        },
        buildMenuSetVersionBump(userId, set, ts)
      ]
    }));
  } catch {
    return response(409, { code: "VERSION_CONFLICT", message: "training menu set changed." });
  }
  return response(201, toSetItemResponse(setItem));
}

async function updateSetItem(
  event: APIGatewayProxyEvent,
  userId: string,
  trainingMenuSetId: string,
  trainingMenuSetItemId: string
): Promise<APIGatewayProxyResult> {
  const body = parseBody<PrescriptionInput>(event);
  const [current, set] = await Promise.all([
    getSetItem(userId, trainingMenuSetItemId),
    getMenuSet(userId, trainingMenuSetId)
  ]);
  const prescription = body && current ? parsePrescription(body, current) : null;
  if (!current || !set || current.trainingMenuSetId !== trainingMenuSetId) {
    return response(404, { message: "training menu set item not found." });
  }
  if (!body || !prescription) {
    return response(400, { message: "invalid prescription." });
  }
  const updatedAt = nowIsoSeconds();
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: trainingMenuSetItemTableName,
            Key: { userId, trainingMenuSetItemId },
            UpdateExpression:
              "SET targetWeightKg=:targetWeightKg, targetRepsMin=:targetRepsMin, targetRepsMax=:targetRepsMax, targetSets=:targetSets, recommendedIntervalDays=:recommendedIntervalDays, instruction=:instruction, createdBy=:createdBy, updatedAt=:updatedAt",
            ConditionExpression: "trainingMenuSetId=:trainingMenuSetId",
            ExpressionAttributeValues: {
              ...Object.fromEntries(Object.entries(prescription).map(([key, value]) => [`:${key}`, value])),
              ":updatedAt": updatedAt,
              ":trainingMenuSetId": trainingMenuSetId
            }
          }
        },
        buildMenuSetVersionBump(userId, set, updatedAt)
      ]
    }));
  } catch {
    return response(409, { code: "VERSION_CONFLICT", message: "training menu set changed." });
  }
  return response(200, toSetItemResponse({ ...current, ...prescription, updatedAt }));
}

async function removeSetItem(
  userId: string,
  trainingMenuSetId: string,
  trainingMenuSetItemId: string
): Promise<APIGatewayProxyResult> {
  const [current, set] = await Promise.all([
    getSetItem(userId, trainingMenuSetItemId),
    getMenuSet(userId, trainingMenuSetId)
  ]);
  if (!current || !set || current.trainingMenuSetId !== trainingMenuSetId) {
    return response(404, { message: "training menu set item not found." });
  }
  const updatedAt = nowIsoSeconds();
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Delete: {
            TableName: trainingMenuSetItemTableName,
            Key: { userId, trainingMenuSetItemId },
            ConditionExpression: "trainingMenuSetId=:trainingMenuSetId",
            ExpressionAttributeValues: { ":trainingMenuSetId": trainingMenuSetId }
          }
        },
        buildMenuSetVersionBump(userId, set, updatedAt)
      ]
    }));
  } catch {
    return response(409, { code: "VERSION_CONFLICT", message: "training menu set changed." });
  }
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
  const [set, setItems] = await Promise.all([
    getMenuSet(userId, trainingMenuSetId),
    listSetItems(userId, trainingMenuSetId)
  ]);
  if (!set) {
    return response(404, { message: "training menu set not found." });
  }
  const current = new Map(setItems.map((item) => [item.trainingMenuSetItemId, item]));
  if (body.items.some((item) => !current.has(item.trainingMenuSetItemId))) {
    return response(404, { message: "one or more training menu set items were not found." });
  }
  const updatedAt = nowIsoSeconds();
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        ...body.items.map((item) => ({
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
        })),
        buildMenuSetVersionBump(userId, set, updatedAt)
      ]
    }));
  } catch {
    return response(409, { code: "VERSION_CONFLICT", message: "training menu set changed." });
  }
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
  const set = await getMenuSet(userId, trainingMenuSetId);
  if (!set) {
    return response(404, { message: "training menu set not found." });
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
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        ...updates.map((update) => {
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
        }),
        buildMenuSetVersionBump(userId, set, updatedAt)
      ]
    }));
  } catch {
    return response(409, { code: "VERSION_CONFLICT", message: "training menu set changed." });
  }
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
        planType: normalizeDailyPlanType(result.Item.planType),
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
  const body = parseBody<{ trainingMenuSetId?: string; planType?: DailyPlanType; source?: DataSource }>(event);
  const planType = normalizeDailyPlanType(body?.planType);
  const trainingMenuSetId = toNonEmptyString(body?.trainingMenuSetId);
  const set = planType === "training" && trainingMenuSetId
    ? await getMenuSet(userId, trainingMenuSetId)
    : null;
  if (!body || (body.planType !== undefined && body.planType !== "training" && body.planType !== "rest")) {
    return response(400, { message: "planType must be training or rest." });
  }
  if (planType === "rest" && trainingMenuSetId) {
    return response(400, { message: "rest plan must not specify a training menu set." });
  }
  if (planType === "training" && (!trainingMenuSetId || !set || set.isActive === false)) {
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
    planType,
    ...(trainingMenuSetId ? { trainingMenuSetId } : {}),
    source: normalizeSource(body.source),
    createdAt: existing.Item?.createdAt ?? ts,
    updatedAt: ts
  };
  await ddb.send(new PutCommand({ TableName: dailyTrainingPlanTableName, Item: item }));
  return response(existing.Item ? 200 : 201, {
    planDate,
    planType,
    ...(trainingMenuSetId ? { trainingMenuSetId } : {}),
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

import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { ddb } from "../shared/ddb";

const trainingMenuTableName = process.env.TRAINING_MENU_TABLE_NAME ?? "";
const trainingMenuSetTableName = process.env.TRAINING_MENU_SET_TABLE_NAME ?? "";
const trainingMenuSetItemTableName = process.env.TRAINING_MENU_SET_ITEM_TABLE_NAME ?? "";
const trainingHistoryTableName = process.env.TRAINING_HISTORY_TABLE_NAME ?? "";
const trainingPerformanceTableName = process.env.TRAINING_PERFORMANCE_TABLE_NAME ?? "";
const dailyRecordTableName = process.env.DAILY_RECORD_TABLE_NAME ?? "";
const goalTableName = process.env.GOAL_TABLE_NAME ?? "";
const aiSettingTableName = process.env.AI_SETTING_TABLE_NAME ?? "";
const aiAdviceLogTableName = process.env.AI_ADVICE_LOG_TABLE_NAME ?? "";

type LambdaLikeResponse = {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
};

type LambdaToolContext = {
  clientContext?: {
    custom?: {
      bedrockAgentCoreToolName?: string;
      bedrockAgentCoreActorId?: string;
      actorId?: string;
      userId?: string;
    };
  };
  client_context?: {
    custom?: {
      bedrockAgentCoreToolName?: string;
      bedrockAgentCoreActorId?: string;
      actorId?: string;
      userId?: string;
    };
  };
};

type ToolArgs = Record<string, unknown>;
type DiarySaveMode = "append" | "overwrite";
type AiMenuItemInput = {
  trainingName?: unknown;
  bodyPart?: unknown;
  equipment?: unknown;
  frequency?: unknown;
  defaultWeightKg?: unknown;
  defaultRepsMin?: unknown;
  defaultRepsMax?: unknown;
  defaultSets?: unknown;
  memo?: unknown;
};

const allowedEquipments = new Set(["マシン", "フリー", "自重", "その他"]);
const defaultEquipment = "マシン";
const defaultFrequency = 3;
const menuSetByOrderIndex = "UserMenuSetByOrderIndex";
const defaultMenuSetIndex = "UserDefaultMenuSetIndex";
const trainingNameIndex = "UserTrainingNameIndex";
const defaultSetMarker = "DEFAULT";
const trainingPerformanceByMenuItemIndex = "UserTrainingMenuItemPerformedAtIndex";

function normalizeTrainingName(name: string): string {
  return name.trim().toLowerCase();
}

function zeroPadOrder(order: number): string {
  return Math.max(0, Math.floor(order)).toString().padStart(6, "0");
}

function buildMenuSetOrderKey(trainingMenuSetId: string, displayOrder: number): string {
  return `${trainingMenuSetId}#${zeroPadOrder(displayOrder)}`;
}

function buildMenuSetItemKey(trainingMenuSetId: string, trainingMenuItemId: string): string {
  return `${trainingMenuSetId}#${trainingMenuItemId}`;
}

function nowIsoSeconds(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function jsonResponse(statusCode: number, body: unknown): LambdaLikeResponse {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify(body)
  };
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseYmd(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? value
    : undefined;
}

export function resolveTimeZoneId(args: ToolArgs): string | undefined {
  const raw = toNonEmptyString(args.timeZoneId) ?? "Asia/Tokyo";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw }).format(new Date());
    return raw;
  } catch {
    return undefined;
  }
}

function nowYmdInTimeZone(timeZoneId: string, now = new Date()): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZoneId,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

export function resolveRecordDate(value: unknown, timeZoneId: string, now = new Date()): string | undefined {
  return value === undefined ? nowYmdInTimeZone(timeZoneId, now) : parseYmd(value);
}

export function parseLocalTime(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : undefined;
}

export function isValidBodyWeightKg(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function isValidBodyFatPercent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function addYmdDays(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear().toString().padStart(4, "0")}-${(date.getUTCMonth() + 1)
    .toString()
    .padStart(2, "0")}-${date.getUTCDate().toString().padStart(2, "0")}`;
}

function timeZoneOffsetMs(instant: Date, timeZoneId: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZoneId,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  const representedAsUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour"),
    value("minute"),
    value("second")
  );
  return representedAsUtc - instant.getTime();
}

export function localDateStartUtc(date: string, timeZoneId: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const localAsUtc = Date.UTC(year, month - 1, day);
  let instant = new Date(localAsUtc);
  for (let iteration = 0; iteration < 3; iteration += 1) {
    instant = new Date(localAsUtc - timeZoneOffsetMs(instant, timeZoneId));
  }
  return instant.toISOString();
}

export function localDateInclusiveUpperKey(date: string, timeZoneId: string): string {
  return localDateStartUtc(addYmdDays(date, 1), timeZoneId).replace(/Z$/, "");
}

type ListArguments = {
  from?: string;
  to?: string;
  timeZoneId: string;
  limit: number;
  exclusiveStartKey?: Record<string, unknown>;
  nextTokenContext: string;
};

type ListArgumentResult = { value: ListArguments } | { response: LambdaLikeResponse };

function encodeNextToken(lastEvaluatedKey: Record<string, unknown> | undefined, context: string): string | undefined {
  if (!lastEvaluatedKey) {
    return undefined;
  }
  return Buffer.from(JSON.stringify({ version: 1, context, key: lastEvaluatedKey }), "utf8").toString("base64url");
}

export function decodeNextToken(value: unknown, expectedContext: string): Record<string, unknown> | undefined | null {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    const key = parsed?.key;
    return parsed?.version === 1 && parsed?.context === expectedContext && key && typeof key === "object" && !Array.isArray(key)
      ? (key as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseListArguments(args: ToolArgs, scope: string): ListArgumentResult {
  const from = args.from === undefined ? undefined : parseYmd(args.from);
  const to = args.to === undefined ? undefined : parseYmd(args.to);
  if (args.from !== undefined && !from) {
    return { response: jsonResponse(400, { message: "from must be a valid date in YYYY-MM-DD format." }) };
  }
  if (args.to !== undefined && !to) {
    return { response: jsonResponse(400, { message: "to must be a valid date in YYYY-MM-DD format." }) };
  }
  if (from && to && from > to) {
    return { response: jsonResponse(400, { message: "from must be on or before to." }) };
  }
  const timeZoneId = resolveTimeZoneId(args);
  if (!timeZoneId) {
    return { response: jsonResponse(400, { message: "timeZoneId must be a valid IANA time zone ID." }) };
  }
  const limit = args.limit === undefined ? 100 : args.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    return { response: jsonResponse(400, { message: "limit must be an integer between 1 and 100." }) };
  }
  const nextTokenContext = JSON.stringify([scope, from ?? null, to ?? null, timeZoneId]);
  const exclusiveStartKey = decodeNextToken(args.nextToken, nextTokenContext);
  if (exclusiveStartKey === null) {
    return { response: jsonResponse(400, { message: "nextToken is invalid." }) };
  }
  return { value: { from, to, timeZoneId, limit, exclusiveStartKey, nextTokenContext } };
}

function listRange(arguments_: ListArguments): Record<string, string | null> {
  return {
    from: arguments_.from ?? null,
    to: arguments_.to ?? null,
    timeZoneId: arguments_.timeZoneId
  };
}

function resolveDiarySaveMode(value: unknown): DiarySaveMode | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "append") {
    return "append";
  }
  if (normalized === "overwrite") {
    return "overwrite";
  }
  return undefined;
}

function normalizeEquipment(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return allowedEquipments.has(trimmed) ? trimmed : undefined;
}

function normalizeFrequency(value: unknown): number | undefined {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return undefined;
  }
  const normalized = Math.floor(num);
  if (normalized < 1 || normalized > 8) {
    return undefined;
  }
  return normalized;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return undefined;
  }
  return Math.floor(num);
}

function normalizePositiveDecimal(value: unknown): number | undefined {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return undefined;
  }
  return Math.round(num * 100) / 100;
}

function normalizeMemo(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > 500) {
    return undefined;
  }
  return trimmed;
}

function extractToolName(context: LambdaToolContext): string | null {
  const fullName =
    context.clientContext?.custom?.bedrockAgentCoreToolName ??
    context.client_context?.custom?.bedrockAgentCoreToolName;
  const normalized = toNonEmptyString(fullName);
  if (!normalized) {
    return null;
  }
  const separatorIndex = normalized.indexOf("__");
  const rawToolName = separatorIndex >= 0 ? normalized.slice(separatorIndex + 2) : normalized;
  const trimmedToolName = rawToolName.replace(/^_+/, "");
  return trimmedToolName.length > 0 ? trimmedToolName : null;
}

function requireConfiguredTables(): string | null {
  if (
    !trainingMenuTableName ||
    !trainingMenuSetTableName ||
    !trainingMenuSetItemTableName ||
    !trainingHistoryTableName ||
    !dailyRecordTableName ||
    !goalTableName ||
    !aiSettingTableName ||
    !aiAdviceLogTableName
  ) {
    return "MCP lambda environment is not configured.";
  }
  return null;
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
  const item = result.Items?.[0];
  return typeof item?.trainingMenuSetId === "string" ? item.trainingMenuSetId : null;
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

async function existsByTrainingName(userId: string, normalizedTrainingName: string): Promise<boolean> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: trainingMenuTableName,
      IndexName: trainingNameIndex,
      KeyConditionExpression: "userId = :userId AND normalizedTrainingName = :normalizedTrainingName",
      ExpressionAttributeValues: {
        ":userId": userId,
        ":normalizedTrainingName": normalizedTrainingName
      },
      Limit: 1
    })
  );
  return Boolean(result.Items?.[0]);
}

function requireUserId(args: ToolArgs): string | null {
  return toNonEmptyString(args.__principalUserId) ?? null;
}

async function getGymVisits(args: ToolArgs, userId: string): Promise<LambdaLikeResponse> {
  const parsed = parseListArguments(args, "get_gym_visits");
  if ("response" in parsed) {
    return parsed.response;
  }
  const options = parsed.value;
  const expressionAttributeValues: Record<string, unknown> = { ":userId": userId };
  let keyConditionExpression = "userId = :userId";
  if (options.from || options.to) {
    expressionAttributeValues[":fromUtc"] = options.from
      ? localDateStartUtc(options.from, options.timeZoneId)
      : "0000-01-01T00:00:00.000Z";
    expressionAttributeValues[":toUtc"] = options.to
      ? localDateInclusiveUpperKey(options.to, options.timeZoneId)
      : "9999-12-31T23:59:59Z";
    keyConditionExpression += " AND startedAtUtc BETWEEN :fromUtc AND :toUtc";
  }

  const result = await ddb.send(
    new QueryCommand({
      TableName: trainingHistoryTableName,
      IndexName: "UserStartedAtIndex",
      KeyConditionExpression: keyConditionExpression,
      ExpressionAttributeValues: expressionAttributeValues,
      ScanIndexForward: false,
      Limit: options.limit,
      ExclusiveStartKey: options.exclusiveStartKey
    })
  );

  return jsonResponse(200, {
    tool: "get_gym_visits",
    items: (result.Items ?? []).map(({ userId: _userId, ...item }) => item),
    range: listRange(options),
    limit: options.limit,
    nextToken:
      encodeNextToken(result.LastEvaluatedKey as Record<string, unknown> | undefined, options.nextTokenContext) ?? null
  });
}

async function getTrainingHistory(args: ToolArgs, userId: string): Promise<LambdaLikeResponse> {
  const trainingMenuItemId = toNonEmptyString(args.trainingMenuItemId);
  if (!trainingMenuItemId) {
    return jsonResponse(400, { message: "trainingMenuItemId is required." });
  }
  if (!trainingPerformanceTableName) {
    return jsonResponse(500, { message: "Training performance table is not configured." });
  }
  const parsed = parseListArguments(args, `get_training_history:${trainingMenuItemId}`);
  if ("response" in parsed) {
    return parsed.response;
  }
  const options = parsed.value;
  const prefix = `${trainingMenuItemId}#`;
  const expressionAttributeValues: Record<string, unknown> = { ":userId": userId };
  let keyConditionExpression: string;
  if (options.from || options.to) {
    const fromUtc = options.from ? localDateStartUtc(options.from, options.timeZoneId) : "";
    const toUtc = options.to ? localDateInclusiveUpperKey(options.to, options.timeZoneId) : undefined;
    expressionAttributeValues[":fromKey"] = `${prefix}${fromUtc}`;
    expressionAttributeValues[":toKey"] = `${prefix}${toUtc ?? "\uffff"}`;
    keyConditionExpression =
      "userId = :userId AND trainingMenuItemPerformedAtKey BETWEEN :fromKey AND :toKey";
  } else {
    expressionAttributeValues[":prefix"] = prefix;
    keyConditionExpression =
      "userId = :userId AND begins_with(trainingMenuItemPerformedAtKey, :prefix)";
  }

  const performanceResult = await ddb.send(
    new QueryCommand({
      TableName: trainingPerformanceTableName,
      IndexName: trainingPerformanceByMenuItemIndex,
      KeyConditionExpression: keyConditionExpression,
      ExpressionAttributeValues: expressionAttributeValues,
      ScanIndexForward: false,
      Limit: options.limit,
      ExclusiveStartKey: options.exclusiveStartKey
    })
  );
  const items = (performanceResult.Items ?? []).map((item) => ({
    trainingMenuItemId: item.trainingMenuItemId,
    trainingNameSnapshot: item.trainingNameSnapshot,
    bodyPartSnapshot: item.bodyPartSnapshot ?? "",
    equipmentSnapshot: item.equipmentSnapshot ?? "",
    isAiGeneratedSnapshot: item.isAiGeneratedSnapshot === true,
    frequencySnapshot: item.frequencySnapshot,
    note: typeof item.note === "string" ? item.note : "",
    weightKg: item.weightKg,
    reps: item.reps,
    sets: item.sets,
    performedAtUtc: item.performedAtUtc,
    visitId: item.visitId,
    visitDateLocal: item.visitDateLocal
  }));

  return jsonResponse(200, {
    tool: "get_training_history",
    trainingMenuItemId,
    items,
    range: listRange(options),
    limit: options.limit,
    nextToken: encodeNextToken(
      performanceResult.LastEvaluatedKey as Record<string, unknown> | undefined,
      options.nextTokenContext
    ) ?? null
  });
}

async function getDailyRecords(args: ToolArgs, userId: string): Promise<LambdaLikeResponse> {
  const parsed = parseListArguments(args, "get_daily_records");
  if ("response" in parsed) {
    return parsed.response;
  }
  const options = parsed.value;
  const expressionAttributeValues: Record<string, unknown> = { ":userId": userId };
  let keyConditionExpression = "userId = :userId";
  if (options.from || options.to) {
    expressionAttributeValues[":from"] = options.from ?? "0000-01-01";
    expressionAttributeValues[":to"] = options.to ?? "9999-12-31";
    keyConditionExpression += " AND recordDate BETWEEN :from AND :to";
  }

  const result = await ddb.send(
    new QueryCommand({
      TableName: dailyRecordTableName,
      KeyConditionExpression: keyConditionExpression,
      ExpressionAttributeValues: expressionAttributeValues,
      ScanIndexForward: false,
      Limit: options.limit,
      ExclusiveStartKey: options.exclusiveStartKey
    })
  );

  return jsonResponse(200, {
    tool: "get_daily_records",
    items: (result.Items ?? []).map(({ userId: _userId, ...item }) => item),
    range: listRange(options),
    limit: options.limit,
    nextToken:
      encodeNextToken(result.LastEvaluatedKey as Record<string, unknown> | undefined, options.nextTokenContext) ?? null
  });
}

async function getDailyRecord(args: ToolArgs, userId: string): Promise<LambdaLikeResponse> {
  const date = parseYmd(args.date);
  if (!date) {
    return jsonResponse(400, { message: "date is required in YYYY-MM-DD format." });
  }

  const result = await ddb.send(
    new GetCommand({
      TableName: dailyRecordTableName,
      Key: {
        userId,
        recordDate: date
      }
    })
  );

  return jsonResponse(200, {
    tool: "get_daily_record",
    item: result.Item ?? null
  });
}

async function saveDailyDiary(args: ToolArgs, userId: string): Promise<LambdaLikeResponse> {
  const diary = toNonEmptyString(args.diary);
  if (!diary) {
    return jsonResponse(400, { message: "diary is required." });
  }
  const mode = resolveDiarySaveMode(args.mode);
  if (args.mode !== undefined && !mode) {
    return jsonResponse(400, { message: "mode must be append or overwrite." });
  }

  const timeZoneId = resolveTimeZoneId(args);
  if (!timeZoneId) {
    return jsonResponse(400, { message: "timeZoneId must be a valid IANA time zone ID." });
  }
  const date = resolveRecordDate(args.date, timeZoneId);
  if (!date) {
    return jsonResponse(400, { message: "date must be a valid date in YYYY-MM-DD format." });
  }

  const current = await ddb.send(
    new GetCommand({
      TableName: dailyRecordTableName,
      Key: {
        userId,
        recordDate: date,
      },
    })
  );

  const currentItem = (current.Item as Record<string, unknown> | undefined) ?? {};
  const existingDiary = toNonEmptyString(currentItem.diary);
  if (existingDiary && !mode) {
    return jsonResponse(409, {
      message: "Diary already exists. Specify mode=append or mode=overwrite.",
      existingDiary,
      recordDate: date,
      timeZoneId,
    });
  }

  const nextDiary =
    mode === "append" && existingDiary
      ? `${existingDiary}\n${diary}`
      : diary;

  const ts = nowIsoSeconds();
  const item = {
    userId,
    recordDate: date,
    timeZoneId,
    otherActivities: [],
    ...currentItem,
    diary: nextDiary,
    updatedAt: ts,
    createdAt: (currentItem.createdAt as string | undefined) ?? ts,
  };

  await ddb.send(
    new PutCommand({
      TableName: dailyRecordTableName,
      Item: item,
    })
  );

  return jsonResponse(200, {
    tool: "save_daily_diary",
    recordDate: date,
    timeZoneId,
    mode: mode ?? "overwrite",
    diary: nextDiary,
    updatedAt: ts,
  });
}

async function saveBodyMetrics(args: ToolArgs, userId: string): Promise<LambdaLikeResponse> {
  const date = parseYmd(args.date);
  if (!date) {
    return jsonResponse(400, { message: "date must be a valid date in YYYY-MM-DD format." });
  }
  const measuredTimeLocal = parseLocalTime(args.bodyMetricMeasuredTimeLocal);
  if (!measuredTimeLocal) {
    return jsonResponse(400, { message: "bodyMetricMeasuredTimeLocal must be HH:mm in 24-hour format." });
  }
  const bodyWeightKg = args.bodyWeightKg;
  if (!isValidBodyWeightKg(bodyWeightKg)) {
    return jsonResponse(400, { message: "bodyWeightKg must be a positive number." });
  }
  const bodyFatPercent = args.bodyFatPercent;
  if (!isValidBodyFatPercent(bodyFatPercent)) {
    return jsonResponse(400, { message: "bodyFatPercent must be a number between 0 and 100." });
  }
  const timeZoneId = resolveTimeZoneId(args);
  if (!timeZoneId) {
    return jsonResponse(400, { message: "timeZoneId must be a valid IANA time zone ID." });
  }

  const current = await ddb.send(
    new GetCommand({
      TableName: dailyRecordTableName,
      Key: {
        userId,
        recordDate: date
      }
    })
  );
  const currentItem = (current.Item as Record<string, unknown> | undefined) ?? {};
  const ts = nowIsoSeconds();
  const item = {
    otherActivities: [],
    ...currentItem,
    userId,
    recordDate: date,
    bodyWeightKg,
    bodyFatPercent,
    bodyMetricMeasuredTimeLocal: measuredTimeLocal,
    timeZoneId,
    updatedAt: ts,
    createdAt: (currentItem.createdAt as string | undefined) ?? ts
  };

  await ddb.send(
    new PutCommand({
      TableName: dailyRecordTableName,
      Item: item
    })
  );

  return jsonResponse(200, {
    tool: "save_body_metrics",
    recordDate: date,
    bodyWeightKg,
    bodyFatPercent,
    bodyMetricMeasuredTimeLocal: measuredTimeLocal,
    timeZoneId,
    updatedAt: ts
  });
}

async function getGoal(userId: string): Promise<LambdaLikeResponse> {
  const result = await ddb.send(
    new GetCommand({
      TableName: goalTableName,
      Key: {
        userId
      }
    })
  );

  return jsonResponse(200, {
    tool: "get_goal",
    item: result.Item ?? null
  });
}

async function getAiCharacterProfile(userId: string): Promise<LambdaLikeResponse> {
  const result = await ddb.send(
    new GetCommand({
      TableName: aiSettingTableName,
      Key: {
        userId
      }
    })
  );

  return jsonResponse(200, {
    tool: "get_ai_character_profile",
    item: result.Item ?? null
  });
}

async function saveAdviceLog(args: ToolArgs, userId: string): Promise<LambdaLikeResponse> {
  const advice = toNonEmptyString(args.advice);
  const requestId = toNonEmptyString(args.requestId);
  if (!advice) {
    return jsonResponse(400, { message: "advice is required." });
  }

  const adviceLogId = randomUUID();
  const ts = nowIsoSeconds();
  await ddb.send(
    new PutCommand({
      TableName: aiAdviceLogTableName,
      Item: {
        userId,
        adviceLogId,
        requestId: requestId ?? "",
        advice,
        createdAt: ts
      }
    })
  );

  return jsonResponse(200, {
    tool: "save_advice_log",
    adviceLogId,
    createdAt: ts
  });
}

async function createTrainingMenuSetFromAi(args: ToolArgs, userId: string): Promise<LambdaLikeResponse> {
  const setName = toNonEmptyString(args.setName);
  if (!setName) {
    return jsonResponse(400, { message: "setName is required." });
  }

  const rawItems = Array.isArray(args.items) ? (args.items as AiMenuItemInput[]) : null;
  if (!rawItems || rawItems.length === 0) {
    return jsonResponse(400, { message: "items is required." });
  }
  if (rawItems.length > 20) {
    return jsonResponse(400, { message: "items cannot exceed 20." });
  }

  let normalizedItems: Array<{
    trainingName: string;
    normalizedTrainingName: string;
    bodyPart: string;
    equipment: string;
    frequency: number;
    defaultWeightKg: number;
    defaultRepsMin: number;
    defaultRepsMax: number;
    defaultSets: number;
    memo: string;
  }>;
  try {
    normalizedItems = rawItems.map((item, index) => {
      const trainingName = toNonEmptyString(item.trainingName);
      const equipment = normalizeEquipment(item.equipment) ?? defaultEquipment;
      const frequency = normalizeFrequency(item.frequency) ?? defaultFrequency;
      const defaultWeightKg = normalizePositiveDecimal(item.defaultWeightKg);
      const defaultRepsMin = normalizePositiveInteger(item.defaultRepsMin);
      const defaultRepsMax = normalizePositiveInteger(item.defaultRepsMax);
      const defaultSets = normalizePositiveInteger(item.defaultSets);
      const memo = normalizeMemo(item.memo);
      const bodyPart = toNonEmptyString(item.bodyPart) ?? "";

      if (!trainingName) {
        throw new Error(`items[${index}].trainingName is required.`);
      }
      if (!normalizeEquipment(item.equipment)) {
        throw new Error(`items[${index}].equipment must be one of マシン/フリー/自重/その他.`);
      }
      if (!normalizeFrequency(item.frequency)) {
        throw new Error(`items[${index}].frequency must be one of 1..8.`);
      }
      if (!defaultWeightKg || !defaultRepsMin || !defaultRepsMax || !defaultSets) {
        throw new Error(`items[${index}] must include positive weight/reps/sets.`);
      }
      if (defaultRepsMin > defaultRepsMax) {
        throw new Error(`items[${index}].defaultRepsMin must be <= defaultRepsMax.`);
      }
      if (memo === undefined) {
        throw new Error(`items[${index}].memo must be a string up to 500 characters.`);
      }

      return {
        trainingName,
        normalizedTrainingName: normalizeTrainingName(trainingName),
        bodyPart,
        equipment,
        frequency,
        defaultWeightKg,
        defaultRepsMin,
        defaultRepsMax,
        defaultSets,
        memo
      };
    });
  } catch (error) {
    return jsonResponse(400, {
      message: error instanceof Error ? error.message : "invalid items."
    });
  }

  const duplicateNamesInRequest = Array.from(
    new Set(
      normalizedItems
        .map((item) => item.normalizedTrainingName)
        .filter((name, index, list) => list.indexOf(name) !== index)
    )
  );
  if (duplicateNamesInRequest.length > 0) {
    return jsonResponse(409, {
      message: "duplicate training names exist in items.",
      duplicateTrainingNames: duplicateNamesInRequest
    });
  }

  const duplicateChecks = await Promise.all(
    normalizedItems.map(async (item) => ({
      trainingName: item.trainingName,
      exists: await existsByTrainingName(userId, item.normalizedTrainingName)
    }))
  );
  const duplicateTrainingNames = duplicateChecks.filter((item) => item.exists).map((item) => item.trainingName);
  if (duplicateTrainingNames.length > 0) {
    return jsonResponse(409, {
      message: "trainingName already exists.",
      duplicateTrainingNames
    });
  }

  const currentDefaultSetId = await getCurrentDefaultSetId(userId);
  if (args.makeDefault === true && currentDefaultSetId) {
    return jsonResponse(400, {
      message: "makeDefault cannot be true because a default set already exists."
    });
  }

  const shouldBeDefault = !currentDefaultSetId;
  const menuSetOrder = (await getMaxMenuSetOrder(userId)) + 1;
  const startingDisplayOrder = (await getMaxDisplayOrder(userId)) + 1;
  const trainingMenuSetId = randomUUID();
  const ts = nowIsoSeconds();

  const transactItems = [
    {
      Put: {
        TableName: trainingMenuSetTableName,
        Item: {
          userId,
          trainingMenuSetId,
          setName,
          menuSetOrder,
          isDefault: shouldBeDefault,
          isAiGenerated: true,
          isActive: true,
          ...(shouldBeDefault ? { defaultSetMarker } : {}),
          createdAt: ts,
          updatedAt: ts
        },
        ConditionExpression: "attribute_not_exists(userId) AND attribute_not_exists(trainingMenuSetId)"
      }
    },
    ...normalizedItems.flatMap((item, index) => {
      const trainingMenuItemId = randomUUID();
      const displayOrder = startingDisplayOrder + index;
      const trainingMenuSetItemId = randomUUID();
      const setDisplayOrder = index + 1;

      return [
        {
          Put: {
            TableName: trainingMenuTableName,
            Item: {
              userId,
              trainingMenuItemId,
              trainingName: item.trainingName,
              normalizedTrainingName: item.normalizedTrainingName,
              bodyPart: item.bodyPart,
              equipment: item.equipment,
              isAiGenerated: true,
              memo: item.memo,
              frequency: item.frequency,
              defaultWeightKg: item.defaultWeightKg,
              defaultRepsMin: item.defaultRepsMin,
              defaultRepsMax: item.defaultRepsMax,
              defaultReps: item.defaultRepsMax,
              defaultSets: item.defaultSets,
              displayOrder,
              isActive: true,
              createdAt: ts,
              updatedAt: ts
            },
            ConditionExpression: "attribute_not_exists(userId) AND attribute_not_exists(trainingMenuItemId)"
          }
        },
        {
          Put: {
            TableName: trainingMenuSetItemTableName,
            Item: {
              userId,
              trainingMenuSetItemId,
              trainingMenuSetId,
              trainingMenuItemId,
              displayOrder: setDisplayOrder,
              menuSetOrderKey: buildMenuSetOrderKey(trainingMenuSetId, setDisplayOrder),
              menuSetItemKey: buildMenuSetItemKey(trainingMenuSetId, trainingMenuItemId),
              createdAt: ts,
              updatedAt: ts
            },
            ConditionExpression: "attribute_not_exists(userId) AND attribute_not_exists(trainingMenuSetItemId)"
          }
        }
      ];
    })
  ];

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: transactItems
    })
  );

  return jsonResponse(200, {
    tool: "create_training_menu_set_from_ai",
    trainingMenuSetId,
    setName,
    isDefault: shouldBeDefault,
    isAiGenerated: true,
    createdCount: normalizedItems.length
  });
}

export const handler = async (event: ToolArgs = {}, context: LambdaToolContext = {}): Promise<LambdaLikeResponse> => {
  try {
    const envError = requireConfiguredTables();
    if (envError) {
      return jsonResponse(500, { message: envError });
    }

    const toolName = extractToolName(context);
    if (!toolName) {
      return jsonResponse(400, {
        message: "Tool name is missing in context.clientContext.custom.bedrockAgentCoreToolName."
      });
    }

    const userId = requireUserId(event);
    if (!userId) {
      return jsonResponse(403, { message: "Trusted user identity is required." });
    }

    if (toolName === "get_gym_visits") {
      return getGymVisits(event, userId);
    }
    if (toolName === "get_training_history") {
      return getTrainingHistory(event, userId);
    }
    if (toolName === "get_daily_records") {
      return getDailyRecords(event, userId);
    }
    if (toolName === "get_daily_record") {
      return getDailyRecord(event, userId);
    }
    if (toolName === "save_daily_diary") {
      return saveDailyDiary(event, userId);
    }
    if (toolName === "save_body_metrics") {
      return saveBodyMetrics(event, userId);
    }
    if (toolName === "get_goal") {
      return getGoal(userId);
    }
    if (toolName === "get_ai_character_profile") {
      return getAiCharacterProfile(userId);
    }
    if (toolName === "save_advice_log") {
      return saveAdviceLog(event, userId);
    }
    if (toolName === "create_training_menu_set_from_ai") {
      return createTrainingMenuSetFromAi(event, userId);
    }

    return jsonResponse(404, { message: `Method not found: ${toolName}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    return jsonResponse(500, {
      message
    });
  }
};

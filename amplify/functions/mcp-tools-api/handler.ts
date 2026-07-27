import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { ddb } from "../shared/ddb";
import { decodePageToken, encodePageToken } from "../shared/pagination";

const trainingMenuTableName = process.env.TRAINING_MENU_TABLE_NAME ?? "";
const trainingMenuSetTableName = process.env.TRAINING_MENU_SET_TABLE_NAME ?? "";
const trainingMenuSetItemTableName = process.env.TRAINING_MENU_SET_ITEM_TABLE_NAME ?? "";
const dailyTrainingPlanTableName = process.env.DAILY_TRAINING_PLAN_TABLE_NAME ?? "";
const trainingHistoryTableName = process.env.TRAINING_HISTORY_TABLE_NAME ?? "";
const trainingPerformanceTableName = process.env.TRAINING_PERFORMANCE_TABLE_NAME ?? "";
const dailyRecordTableName = process.env.DAILY_RECORD_TABLE_NAME ?? "";
const goalTableName = process.env.GOAL_TABLE_NAME ?? "";
const aiSettingTableName = process.env.AI_SETTING_TABLE_NAME ?? "";
const aiAdviceLogTableName = process.env.AI_ADVICE_LOG_TABLE_NAME ?? "";
const userProfileTableName = process.env.USER_PROFILE_TABLE_NAME ?? "";

export type McpToolResponse = Record<string, unknown>;

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
type BodyMetricsConflictPolicy = "reject" | "overwrite";
type BodyMetricWritableField =
  | "bodyWeightKg"
  | "bodyFatPercent"
  | "bodyMetricMeasuredTimeLocal"
  | "timeZoneId";
type BodyMetricInput = {
  date: string;
  bodyWeightKg?: number;
  bodyFatPercent?: number;
  bodyMetricMeasuredTimeLocal?: string;
};
type BodyMetricResultInput = {
  date?: unknown;
  bodyWeightKg?: unknown;
  bodyFatPercent?: unknown;
  bodyMetricMeasuredTimeLocal?: unknown;
  raw?: unknown;
};
type BodyMetricRecordError = {
  field: string;
  code: string;
  message: string;
};
type BodyMetricBatchResult = {
  index: number;
  recordDate?: string;
  status: "success" | "failed";
  action?: "created" | "updated" | "unchanged" | "would_create" | "would_update";
  input: BodyMetricResultInput;
  error?: BodyMetricRecordError;
};
export type BodyMetricDdbCommand = GetCommand | UpdateCommand;
export type BodyMetricDdbSender = (
  command: BodyMetricDdbCommand
) => Promise<{ Item?: Record<string, unknown> }>;
export type SaveBodyMetricsBatchOptions = {
  now?: Date;
  send?: BodyMetricDdbSender;
  logger?: (entry: Record<string, unknown>) => void;
};
type AiMenuItemInput = {
  existingTrainingMenuItemId?: unknown;
  newTrainingMenuItem?: {
    trainingName?: unknown;
    bodyPart?: unknown;
    equipment?: unknown;
    description?: unknown;
    weightInputMode?: unknown;
    fixedWeightKg?: unknown;
  };
  prescription?: {
    targetWeightKg?: unknown;
    targetRepsMin?: unknown;
    targetRepsMax?: unknown;
    targetSets?: unknown;
    recommendedIntervalDays?: unknown;
    instruction?: unknown;
  };
};

const allowedEquipments = new Set(["マシン", "フリー", "自重", "その他"]);
const menuSetByOrderIndex = "UserMenuSetByOrderIndex";
const setItemsBySetOrderIndex = "UserSetItemsBySetOrderIndex";
const trainingNameIndex = "UserTrainingNameIndex";
const trainingPerformanceByMenuItemIndex = "UserTrainingMenuItemPerformedAtIndex";
const trainingMenuByOrderIndex = "UserDisplayOrderIndex";
const trainingHistoryByStartedAtIndex = "UserStartedAtIndex";
const bodyMetricsBatchLimit = 100;
const bodyMetricsWriteConcurrency = 10;
const bodyMetricRecordFields = new Set([
  "date",
  "bodyWeightKg",
  "bodyFatPercent",
  "bodyMetricMeasuredTimeLocal"
]);
const bodyMetricBatchTopLevelFields = new Set([
  "records",
  "timeZoneId",
  "conflictPolicy",
  "dryRun",
  "__principalUserId"
]);

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

function defaultErrorCode(statusCode: number): string {
  if (statusCode === 400) {
    return "INVALID_REQUEST";
  }
  if (statusCode === 403) {
    return "FORBIDDEN";
  }
  if (statusCode === 404) {
    return "NOT_FOUND";
  }
  if (statusCode === 409) {
    return "CONFLICT";
  }
  return "INTERNAL_ERROR";
}

export function mcpToolResponse(statusCode: number, body: unknown): McpToolResponse {
  const payload =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : { message: String(body) };
  if (statusCode >= 200 && statusCode < 300) {
    return payload;
  }

  const {
    code,
    message,
    requestId,
    ...details
  } = payload;
  return {
    error: {
      code: typeof code === "string" ? code : defaultErrorCode(statusCode),
      message: typeof message === "string" ? message : "The tool request failed.",
      ...(typeof requestId === "string" ? { requestId } : {}),
      ...(Object.keys(details).length > 0 ? { details } : {})
    }
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
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= 500 &&
    hasAtMostTwoDecimalPlaces(value)
  );
}

export function isValidBodyFatPercent(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100 &&
    hasAtMostTwoDecimalPlaces(value)
  );
}

function hasAtMostTwoDecimalPlaces(value: number): boolean {
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-9;
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

type ListArgumentResult = { value: ListArguments } | { response: McpToolResponse };

async function encodeNextToken(
  lastEvaluatedKey: Record<string, unknown> | undefined,
  context: string,
  userId: string
): Promise<string | undefined> {
  return encodePageToken(lastEvaluatedKey, context, userId);
}

export async function decodeNextToken(
  value: unknown,
  expectedContext: string,
  expectedUserId: string,
  signingSecret?: string
): Promise<Record<string, unknown> | undefined | null> {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    return null;
  }
  return decodePageToken(value, expectedContext, expectedUserId, signingSecret);
}

async function parseListArguments(args: ToolArgs, scope: string, userId: string): Promise<ListArgumentResult> {
  const from = args.from === undefined ? undefined : parseYmd(args.from);
  const to = args.to === undefined ? undefined : parseYmd(args.to);
  if (args.from !== undefined && !from) {
    return { response: mcpToolResponse(400, { message: "from must be a valid date in YYYY-MM-DD format." }) };
  }
  if (args.to !== undefined && !to) {
    return { response: mcpToolResponse(400, { message: "to must be a valid date in YYYY-MM-DD format." }) };
  }
  if (from && to && from > to) {
    return { response: mcpToolResponse(400, { message: "from must be on or before to." }) };
  }
  const timeZoneId = resolveTimeZoneId(args);
  if (!timeZoneId) {
    return { response: mcpToolResponse(400, { message: "timeZoneId must be a valid IANA time zone ID." }) };
  }
  const limit = args.limit === undefined ? 100 : args.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    return { response: mcpToolResponse(400, { message: "limit must be an integer between 1 and 100." }) };
  }
  const nextTokenContext = JSON.stringify([scope, from ?? null, to ?? null, timeZoneId]);
  const exclusiveStartKey = await decodeNextToken(args.nextToken, nextTokenContext, userId);
  if (exclusiveStartKey === null) {
    return { response: mcpToolResponse(400, { message: "nextToken is invalid." }) };
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

type AnalysisExportRangeMode = "dateRange" | "allAvailable";
type AnalysisExportSection = "trainingMenus" | "trainingMenuSets" | "dailyRecords" | "gymVisits";
type AnalysisExportSelection = {
  rangeMode: AnalysisExportRangeMode;
  from?: string;
  to?: string;
  timeZoneId: string;
};

type AnalysisExportSelectionResult =
  | { value: AnalysisExportSelection }
  | { response: McpToolResponse };

export function parseAnalysisExportSelection(args: ToolArgs): AnalysisExportSelectionResult {
  const rangeMode = args.rangeMode;
  if (rangeMode !== "dateRange" && rangeMode !== "allAvailable") {
    return {
      response: mcpToolResponse(400, {
        code: "INVALID_RANGE_MODE",
        message: "rangeMode must be dateRange or allAvailable."
      })
    };
  }

  const timeZoneId = resolveTimeZoneId(args);
  if (!timeZoneId) {
    return {
      response: mcpToolResponse(400, {
        code: "INVALID_TIME_ZONE",
        message: "timeZoneId must be a valid IANA time zone ID."
      })
    };
  }

  if (rangeMode === "allAvailable") {
    if (args.from !== undefined || args.to !== undefined) {
      return {
        response: mcpToolResponse(400, {
          code: "UNEXPECTED_DATE_RANGE",
          message: "from and to must be omitted when rangeMode is allAvailable."
        })
      };
    }
    return { value: { rangeMode, timeZoneId } };
  }

  const from = parseYmd(args.from);
  const to = parseYmd(args.to);
  if (!from || !to) {
    return {
      response: mcpToolResponse(400, {
        code: "INVALID_DATE_RANGE",
        message: "from and to are required as valid YYYY-MM-DD dates when rangeMode is dateRange."
      })
    };
  }
  if (from > to) {
    return {
      response: mcpToolResponse(400, {
        code: "INVALID_DATE_RANGE",
        message: "from must be on or before to."
      })
    };
  }
  return { value: { rangeMode, from, to, timeZoneId } };
}

function analysisExportSelectionResponse(selection: AnalysisExportSelection): Record<string, unknown> {
  return {
    rangeMode: selection.rangeMode,
    fromLocalDate: selection.from ?? null,
    toLocalDate: selection.to ?? null,
    inclusive: true,
    timeZoneId: selection.timeZoneId
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeAnalysisDailyRecord(item: Record<string, unknown>): Record<string, unknown> {
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

function normalizeAnalysisGymVisit(item: Record<string, unknown>): Record<string, unknown> {
  const entries = Array.isArray(item.entries) ? item.entries : [];
  return {
    visitId: nullableString(item.visitId),
    date: nullableString(item.visitDateLocal),
    startedAtUtc: nullableString(item.startedAtUtc),
    endedAtUtc: nullableString(item.endedAtUtc),
    timeZoneId: nullableString(item.timeZoneId),
    note: nullableString(item.note),
    entries: entries.map((rawEntry) => {
      const entry =
        rawEntry && typeof rawEntry === "object" && !Array.isArray(rawEntry)
          ? (rawEntry as Record<string, unknown>)
          : {};
      return {
        trainingMenuItemId: nullableString(entry.trainingMenuItemId),
        trainingName: nullableString(entry.trainingNameSnapshot),
        bodyPart: nullableString(entry.bodyPartSnapshot),
        equipment: nullableString(entry.equipmentSnapshot),
        isAiGenerated: entry.isAiGeneratedSnapshot === true,
        frequencyDays: nullableNumber(entry.frequencySnapshot),
        weightKg: nullableNumber(entry.weightKg),
        weightInputMode: typeof entry.weightInputModeSnapshot === "string"
          ? entry.weightInputModeSnapshot
          : "legacyUnspecified",
        loadMultiplier: nullableNumber(entry.loadMultiplierSnapshot),
        fixedWeightKg: nullableNumber(entry.fixedWeightKgSnapshot),
        calculatedTotalWeightKg: nullableNumber(entry.calculatedTotalWeightKg),
        reps: nullableNumber(entry.reps),
        sets: nullableNumber(entry.sets),
        performedAtUtc: nullableString(entry.performedAtUtc),
        note: nullableString(entry.note)
      };
    }),
    createdAtUtc: nullableString(item.createdAt),
    updatedAtUtc: nullableString(item.updatedAt)
  };
}

export function normalizeGymVisitWeightSnapshots(item: Record<string, unknown>): Record<string, unknown> {
  const entries = Array.isArray(item.entries) ? item.entries : [];
  return {
    visitId: nullableString(item.visitId),
    visitDateLocal: nullableString(item.visitDateLocal),
    startedAtUtc: nullableString(item.startedAtUtc),
    endedAtUtc: nullableString(item.endedAtUtc),
    timeZoneId: nullableString(item.timeZoneId),
    note: nullableString(item.note),
    entries: entries.map((rawEntry) => {
      const entry =
        rawEntry && typeof rawEntry === "object" && !Array.isArray(rawEntry)
          ? (rawEntry as Record<string, unknown>)
          : {};
      return {
        trainingMenuItemId: nullableString(entry.trainingMenuItemId),
        trainingNameSnapshot: nullableString(entry.trainingNameSnapshot),
        bodyPartSnapshot: nullableString(entry.bodyPartSnapshot),
        equipmentSnapshot: nullableString(entry.equipmentSnapshot),
        isAiGeneratedSnapshot: entry.isAiGeneratedSnapshot === true,
        frequencySnapshot: nullableNumber(entry.frequencySnapshot),
        weightKg: nullableNumber(entry.weightKg),
        weightInputModeSnapshot:
          typeof entry.weightInputModeSnapshot === "string"
            ? entry.weightInputModeSnapshot
            : "legacyUnspecified",
        loadMultiplierSnapshot: nullableNumber(entry.loadMultiplierSnapshot),
        fixedWeightKgSnapshot: nullableNumber(entry.fixedWeightKgSnapshot),
        calculatedTotalWeightKg: nullableNumber(entry.calculatedTotalWeightKg),
        reps: nullableNumber(entry.reps),
        sets: nullableNumber(entry.sets),
        performedAtUtc: nullableString(entry.performedAtUtc),
        note: nullableString(entry.note)
      };
    }),
    createdAt: nullableString(item.createdAt),
    updatedAt: nullableString(item.updatedAt)
  };
}

function normalizeAnalysisTrainingMenu(item: Record<string, unknown>): Record<string, unknown> {
  const legacyReps = nullableNumber(item.defaultReps);
  const weightInputMode =
    item.weightInputMode === "direct" || item.weightInputMode === "perSide"
      ? item.weightInputMode
      : "legacyUnspecified";
  return {
    trainingMenuItemId: nullableString(item.trainingMenuItemId),
    trainingName: nullableString(item.trainingName),
    bodyPart: nullableString(item.bodyPart),
    equipment: nullableString(item.equipment),
    isAiGenerated: item.isAiGenerated === true,
    description: nullableString(item.description),
    frequencyDays: nullableNumber(item.frequency),
    defaultWeightKg: nullableNumber(item.defaultWeightKg),
    weightInputMode,
    loadMultiplier: weightInputMode === "legacyUnspecified" ? null : nullableNumber(item.loadMultiplier),
    fixedWeightKg: weightInputMode === "legacyUnspecified" ? null : nullableNumber(item.fixedWeightKg),
    defaultRepsMin: nullableNumber(item.defaultRepsMin) ?? legacyReps,
    defaultRepsMax: nullableNumber(item.defaultRepsMax) ?? legacyReps,
    defaultSets: nullableNumber(item.defaultSets),
    displayOrder: nullableNumber(item.displayOrder),
    isActive: item.isActive !== false,
    createdAtUtc: nullableString(item.createdAt),
    updatedAtUtc: nullableString(item.updatedAt)
  };
}

export function normalizeDailyRecordForMcp(item: Record<string, unknown>): Record<string, unknown> {
  return {
    recordDate: nullableString(item.recordDate),
    timeZoneId: nullableString(item.timeZoneId),
    bodyWeightKg: nullableNumber(item.bodyWeightKg),
    bodyFatPercent: nullableNumber(item.bodyFatPercent),
    bodyMetricMeasuredTimeLocal: nullableString(item.bodyMetricMeasuredTimeLocal),
    conditionRating: nullableNumber(item.conditionRating),
    moodRating: nullableNumber(item.moodRating),
    conditionComment: nullableString(item.conditionComment),
    diary: nullableString(item.diary),
    otherActivities: Array.isArray(item.otherActivities) ? item.otherActivities : [],
    createdAt: nullableString(item.createdAt),
    updatedAt: nullableString(item.updatedAt)
  };
}

export function normalizeGoalForMcp(item: Record<string, unknown>): Record<string, unknown> {
  return {
    targetWeightKg: nullableNumber(item.targetWeightKg),
    targetBodyFatPercent: nullableNumber(item.targetBodyFatPercent),
    deadlineDate: nullableString(item.deadlineDate),
    comment: nullableString(item.comment),
    createdAt: nullableString(item.createdAt),
    updatedAt: nullableString(item.updatedAt)
  };
}

export function normalizeAiCharacterProfileForMcp(item: Record<string, unknown>): Record<string, unknown> {
  return {
    characterId: nullableString(item.characterId),
    characterName: nullableString(item.characterName),
    tonePreset: nullableString(item.tonePreset),
    characterDescription: nullableString(item.characterDescription),
    speechEnding: nullableString(item.speechEnding),
    createdAt: nullableString(item.createdAt),
    updatedAt: nullableString(item.updatedAt)
  };
}

async function listAnalysisMenuSetItemIds(userId: string, trainingMenuSetId: string): Promise<string[]> {
  const itemIds: string[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: trainingMenuSetItemTableName,
        IndexName: setItemsBySetOrderIndex,
        KeyConditionExpression: "userId = :userId AND begins_with(menuSetOrderKey, :prefix)",
        ExpressionAttributeValues: {
          ":userId": userId,
          ":prefix": `${trainingMenuSetId}#`
        },
        ScanIndexForward: true,
        ExclusiveStartKey: exclusiveStartKey
      })
    );
    for (const item of result.Items ?? []) {
      if (typeof item.trainingMenuItemId === "string") {
        itemIds.push(item.trainingMenuItemId);
      }
    }
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return itemIds;
}

async function getAnalysisExportManifest(args: ToolArgs, userId: string): Promise<McpToolResponse> {
  const parsed = parseAnalysisExportSelection(args);
  if ("response" in parsed) {
    return parsed.response;
  }
  const selection = parsed.value;
  const [profileResult, goalResult] = await Promise.all([
    ddb.send(
      new GetCommand({
        TableName: userProfileTableName,
        Key: { userId }
      })
    ),
    ddb.send(
      new GetCommand({
        TableName: goalTableName,
        Key: { userId }
      })
    )
  ]);
  const profile = profileResult.Item ?? {};
  const goal = goalResult.Item;

  return mcpToolResponse(200, {
    tool: "get_analysis_export_manifest",
    schema: "kintrain.analysis-export",
    schemaVersion: 2,
    generatedAtUtc: new Date().toISOString(),
    selection: analysisExportSelectionResponse(selection),
    currentContext: {
      userProfile: {
        userName: typeof profile.userName === "string" ? profile.userName : "",
        sex: typeof profile.sex === "string" ? profile.sex : "no-answer",
        birthDate: nullableString(profile.birthDate),
        heightCm: nullableNumber(profile.heightCm),
        timeZoneId: typeof profile.timeZoneId === "string" ? profile.timeZoneId : selection.timeZoneId
      },
      goal: goal
        ? {
            targetWeightKg: nullableNumber(goal.targetWeightKg),
            targetBodyFatPercent: nullableNumber(goal.targetBodyFatPercent),
            deadlineDate: nullableString(goal.deadlineDate),
            comment: nullableString(goal.comment),
            updatedAtUtc: nullableString(goal.updatedAt)
          }
        : null
    },
    sections: ["trainingMenus", "trainingMenuSets", "dailyRecords", "gymVisits"],
    paging: {
      tool: "get_analysis_export_page",
      maxLimit: 50,
      instruction:
        "Call each required section with the same selection. Repeat with the returned nextToken until nextToken is null."
    }
  });
}

async function getAnalysisExportPage(args: ToolArgs, userId: string): Promise<McpToolResponse> {
  const parsed = parseAnalysisExportSelection(args);
  if ("response" in parsed) {
    return parsed.response;
  }
  const selection = parsed.value;
  const section = args.section;
  const allowedSections = new Set<AnalysisExportSection>([
    "trainingMenus",
    "trainingMenuSets",
    "dailyRecords",
    "gymVisits"
  ]);
  if (typeof section !== "string" || !allowedSections.has(section as AnalysisExportSection)) {
    return mcpToolResponse(400, {
      code: "INVALID_SECTION",
      message: "section must be trainingMenus, trainingMenuSets, dailyRecords, or gymVisits."
    });
  }
  const typedSection = section as AnalysisExportSection;
  const requestedLimit = args.limit === undefined ? 50 : args.limit;
  if (
    typeof requestedLimit !== "number" ||
    !Number.isInteger(requestedLimit) ||
    requestedLimit < 1 ||
    requestedLimit > 50
  ) {
    return mcpToolResponse(400, {
      code: "INVALID_LIMIT",
      message: "limit must be an integer between 1 and 50."
    });
  }

  const tokenContext = JSON.stringify([
    "analysis-export",
    2,
    typedSection,
    selection.rangeMode,
    selection.from ?? null,
    selection.to ?? null,
    selection.timeZoneId
  ]);
  const exclusiveStartKey = await decodeNextToken(args.nextToken, tokenContext, userId);
  if (
    exclusiveStartKey === null ||
    (exclusiveStartKey !== undefined && exclusiveStartKey.userId !== userId)
  ) {
    return mcpToolResponse(400, {
      code: "INVALID_NEXT_TOKEN",
      message: "nextToken is invalid for this user, section, or selection."
    });
  }

  let result: {
    Items?: Record<string, unknown>[];
    LastEvaluatedKey?: Record<string, unknown>;
  };
  if (typedSection === "dailyRecords") {
    const expressionAttributeValues: Record<string, unknown> = { ":userId": userId };
    let keyConditionExpression = "userId = :userId";
    if (selection.rangeMode === "dateRange") {
      keyConditionExpression += " AND recordDate BETWEEN :from AND :to";
      expressionAttributeValues[":from"] = selection.from;
      expressionAttributeValues[":to"] = selection.to;
    }
    result = await ddb.send(
      new QueryCommand({
        TableName: dailyRecordTableName,
        KeyConditionExpression: keyConditionExpression,
        ExpressionAttributeValues: expressionAttributeValues,
        ScanIndexForward: true,
        Limit: requestedLimit,
        ExclusiveStartKey: exclusiveStartKey
      })
    );
  } else if (typedSection === "gymVisits") {
    const expressionAttributeValues: Record<string, unknown> = { ":userId": userId };
    let keyConditionExpression = "userId = :userId";
    if (selection.rangeMode === "dateRange") {
      keyConditionExpression += " AND startedAtUtc BETWEEN :fromUtc AND :toUtc";
      expressionAttributeValues[":fromUtc"] = `${addYmdDays(selection.from!, -1)}T00:00:00Z`;
      expressionAttributeValues[":toUtc"] = `${addYmdDays(selection.to!, 1)}T23:59:59Z`;
    }
    result = await ddb.send(
      new QueryCommand({
        TableName: trainingHistoryTableName,
        IndexName: trainingHistoryByStartedAtIndex,
        KeyConditionExpression: keyConditionExpression,
        ExpressionAttributeValues: expressionAttributeValues,
        ScanIndexForward: true,
        Limit: requestedLimit,
        ExclusiveStartKey: exclusiveStartKey
      })
    );
    if (selection.rangeMode === "dateRange") {
      result.Items = (result.Items ?? []).filter((item) => {
        const visitDateLocal = typeof item.visitDateLocal === "string" ? item.visitDateLocal : "";
        return visitDateLocal >= selection.from! && visitDateLocal <= selection.to!;
      });
    }
  } else if (typedSection === "trainingMenus") {
    result = await ddb.send(
      new QueryCommand({
        TableName: trainingMenuTableName,
        IndexName: trainingMenuByOrderIndex,
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: {
          ":userId": userId
        },
        ScanIndexForward: true,
        Limit: requestedLimit,
        ExclusiveStartKey: exclusiveStartKey
      })
    );
    result.Items = (result.Items ?? []).filter((item) => item.isActive !== false);
  } else {
    result = await ddb.send(
      new QueryCommand({
        TableName: trainingMenuSetTableName,
        IndexName: menuSetByOrderIndex,
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: {
          ":userId": userId
        },
        ScanIndexForward: true,
        Limit: requestedLimit,
        ExclusiveStartKey: exclusiveStartKey
      })
    );
    result.Items = (result.Items ?? []).filter((item) => item.isActive !== false);
  }

  let items: Record<string, unknown>[];
  if (typedSection === "dailyRecords") {
    items = (result.Items ?? []).map(normalizeAnalysisDailyRecord);
  } else if (typedSection === "gymVisits") {
    items = (result.Items ?? []).map(normalizeAnalysisGymVisit);
  } else if (typedSection === "trainingMenus") {
    items = (result.Items ?? []).map(normalizeAnalysisTrainingMenu);
  } else {
    items = await Promise.all(
      (result.Items ?? []).map(async (item) => {
        const trainingMenuSetId = typeof item.trainingMenuSetId === "string" ? item.trainingMenuSetId : "";
        return {
          trainingMenuSetId: nullableString(item.trainingMenuSetId),
          setName: nullableString(item.setName),
          displayOrder: nullableNumber(item.menuSetOrder),
          isDefault: item.isDefault === true,
          isAiGenerated: item.isAiGenerated === true,
          isActive: item.isActive !== false,
          trainingMenuItemIds: trainingMenuSetId
            ? await listAnalysisMenuSetItemIds(userId, trainingMenuSetId)
            : [],
          createdAtUtc: nullableString(item.createdAt),
          updatedAtUtc: nullableString(item.updatedAt)
        };
      })
    );
  }

  const nextToken =
    (await encodeNextToken(
      result.LastEvaluatedKey as Record<string, unknown> | undefined,
      tokenContext,
      userId
    )) ?? null;
  return mcpToolResponse(200, {
    tool: "get_analysis_export_page",
    schema: "kintrain.analysis-export",
    schemaVersion: 2,
    selection: analysisExportSelectionResponse(selection),
    section: typedSection,
    items,
    page: {
      limit: requestedLimit,
      returned: items.length,
      nextToken,
      hasMore: nextToken !== null
    }
  });
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

export function normalizeNonNegativeDecimal(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.round(value * 100) / 100;
}

function normalizeDescription(value: unknown): string | undefined {
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
    !dailyTrainingPlanTableName ||
    !trainingHistoryTableName ||
    !dailyRecordTableName ||
    !goalTableName ||
    !userProfileTableName ||
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

async function getGymVisits(args: ToolArgs, userId: string): Promise<McpToolResponse> {
  const parsed = await parseListArguments(args, "get_gym_visits", userId);
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

  return mcpToolResponse(200, {
    tool: "get_gym_visits",
    items: (result.Items ?? []).map((item) => normalizeGymVisitWeightSnapshots(item)),
    range: listRange(options),
    limit: options.limit,
    nextToken:
      (await encodeNextToken(
        result.LastEvaluatedKey as Record<string, unknown> | undefined,
        options.nextTokenContext,
        userId
      )) ?? null
  });
}

type ResolvedTrainingMenu = {
  trainingMenuItemId: string;
  trainingMenuName: string | null;
};

type TrainingMenuResolution =
  | { value: ResolvedTrainingMenu }
  | { response: McpToolResponse };

export type TrainingMenuLookupSender = (
  command: GetCommand | QueryCommand
) => Promise<{
  Item?: Record<string, unknown>;
  Items?: Record<string, unknown>[];
}>;

async function defaultTrainingMenuLookupSender(
  command: GetCommand | QueryCommand
): Promise<{
  Item?: Record<string, unknown>;
  Items?: Record<string, unknown>[];
}> {
  if (command instanceof GetCommand) {
    const result = await ddb.send(command);
    return {
      Item: result.Item as Record<string, unknown> | undefined
    };
  }
  const result = await ddb.send(command);
  return {
    Items: result.Items as Record<string, unknown>[] | undefined
  };
}

export async function resolveTrainingMenuForHistory(
  args: ToolArgs,
  userId: string,
  send: TrainingMenuLookupSender = defaultTrainingMenuLookupSender
): Promise<TrainingMenuResolution> {
  const requestedId = toNonEmptyString(args.trainingMenuItemId);
  const requestedName = toNonEmptyString(args.trainingMenuName);
  if (!requestedId && !requestedName) {
    return {
      response: mcpToolResponse(400, {
        code: "TRAINING_MENU_REFERENCE_REQUIRED",
        message: "trainingMenuItemId or trainingMenuName is required."
      })
    };
  }

  let item: Record<string, unknown> | undefined;
  if (requestedName) {
    const result = await send(
      new QueryCommand({
        TableName: trainingMenuTableName,
        IndexName: trainingNameIndex,
        KeyConditionExpression: "userId = :userId AND normalizedTrainingName = :normalizedTrainingName",
        ExpressionAttributeValues: {
          ":userId": userId,
          ":normalizedTrainingName": normalizeTrainingName(requestedName)
        },
        Limit: 1
      })
    );
    item = result.Items?.[0] as Record<string, unknown> | undefined;
  } else if (requestedId) {
    const result = await send(
      new GetCommand({
        TableName: trainingMenuTableName,
        Key: {
          userId,
          trainingMenuItemId: requestedId
        }
      })
    );
    item = result.Item as Record<string, unknown> | undefined;
  }

  const resolvedId = toNonEmptyString(item?.trainingMenuItemId);
  if (!item || !resolvedId) {
    return {
      response: mcpToolResponse(404, {
        code: "TRAINING_MENU_NOT_FOUND",
        message: "The requested training menu was not found."
      })
    };
  }
  if (requestedId && requestedId !== resolvedId) {
    return {
      response: mcpToolResponse(400, {
        code: "TRAINING_MENU_REFERENCE_MISMATCH",
        message: "trainingMenuItemId and trainingMenuName refer to different training menus."
      })
    };
  }

  return {
    value: {
      trainingMenuItemId: resolvedId,
      trainingMenuName: nullableString(item.trainingName)
    }
  };
}

async function getTrainingHistory(args: ToolArgs, userId: string): Promise<McpToolResponse> {
  if (!trainingPerformanceTableName) {
    return mcpToolResponse(500, { message: "Training performance table is not configured." });
  }
  const resolvedMenu = await resolveTrainingMenuForHistory(args, userId);
  if ("response" in resolvedMenu) {
    return resolvedMenu.response;
  }
  const { trainingMenuItemId, trainingMenuName } = resolvedMenu.value;
  const parsed = await parseListArguments(args, `get_training_history:${trainingMenuItemId}`, userId);
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
    weightInputModeSnapshot:
      typeof item.weightInputModeSnapshot === "string" ? item.weightInputModeSnapshot : "legacyUnspecified",
    loadMultiplierSnapshot: item.loadMultiplierSnapshot ?? null,
    fixedWeightKgSnapshot: item.fixedWeightKgSnapshot ?? null,
    calculatedTotalWeightKg: item.calculatedTotalWeightKg ?? null,
    reps: item.reps,
    sets: item.sets,
    performedAtUtc: item.performedAtUtc,
    visitId: item.visitId,
    visitDateLocal: item.visitDateLocal
  }));

  return mcpToolResponse(200, {
    tool: "get_training_history",
    trainingMenuItemId,
    trainingMenuName,
    items,
    range: listRange(options),
    limit: options.limit,
    nextToken:
      (await encodeNextToken(
        performanceResult.LastEvaluatedKey as Record<string, unknown> | undefined,
        options.nextTokenContext,
        userId
      )) ?? null
  });
}

async function getDailyRecords(args: ToolArgs, userId: string): Promise<McpToolResponse> {
  const parsed = await parseListArguments(args, "get_daily_records", userId);
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

  return mcpToolResponse(200, {
    tool: "get_daily_records",
    items: (result.Items ?? []).map((item) => normalizeDailyRecordForMcp(item)),
    range: listRange(options),
    limit: options.limit,
    nextToken:
      (await encodeNextToken(
        result.LastEvaluatedKey as Record<string, unknown> | undefined,
        options.nextTokenContext,
        userId
      )) ?? null
  });
}

async function getDailyRecord(args: ToolArgs, userId: string): Promise<McpToolResponse> {
  const date = parseYmd(args.date);
  if (!date) {
    return mcpToolResponse(400, { message: "date is required in YYYY-MM-DD format." });
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

  return mcpToolResponse(200, {
    tool: "get_daily_record",
    item: result.Item ? normalizeDailyRecordForMcp(result.Item) : null
  });
}

async function saveDailyDiary(args: ToolArgs, userId: string): Promise<McpToolResponse> {
  const diary = toNonEmptyString(args.diary);
  if (!diary) {
    return mcpToolResponse(400, { message: "diary is required." });
  }
  const mode = resolveDiarySaveMode(args.mode);
  if (args.mode !== undefined && !mode) {
    return mcpToolResponse(400, { message: "mode must be append or overwrite." });
  }

  const timeZoneId = resolveTimeZoneId(args);
  if (!timeZoneId) {
    return mcpToolResponse(400, { message: "timeZoneId must be a valid IANA time zone ID." });
  }
  const date = resolveRecordDate(args.date, timeZoneId);
  if (!date) {
    return mcpToolResponse(400, { message: "date must be a valid date in YYYY-MM-DD format." });
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
    return mcpToolResponse(409, {
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

  return mcpToolResponse(200, {
    tool: "save_daily_diary",
    recordDate: date,
    timeZoneId,
    mode: mode ?? "overwrite",
    diary: nextDiary,
    updatedAt: ts,
  });
}

async function saveBodyMetrics(args: ToolArgs, userId: string): Promise<McpToolResponse> {
  const date = parseYmd(args.date);
  if (!date) {
    return mcpToolResponse(400, { message: "date must be a valid date in YYYY-MM-DD format." });
  }
  const measuredTimeLocal = parseLocalTime(args.bodyMetricMeasuredTimeLocal);
  if (!measuredTimeLocal) {
    return mcpToolResponse(400, { message: "bodyMetricMeasuredTimeLocal must be HH:mm in 24-hour format." });
  }
  const bodyWeightKg = args.bodyWeightKg;
  if (!isValidBodyWeightKg(bodyWeightKg)) {
    return mcpToolResponse(400, {
      message: "bodyWeightKg must be a number greater than 0 and at most 500 with no more than 2 decimal places."
    });
  }
  const bodyFatPercent = args.bodyFatPercent;
  if (!isValidBodyFatPercent(bodyFatPercent)) {
    return mcpToolResponse(400, {
      message: "bodyFatPercent must be a number between 0 and 100 with no more than 2 decimal places."
    });
  }
  const timeZoneId = resolveTimeZoneId(args);
  if (!timeZoneId) {
    return mcpToolResponse(400, { message: "timeZoneId must be a valid IANA time zone ID." });
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

  return mcpToolResponse(200, {
    tool: "save_body_metrics",
    recordDate: date,
    bodyWeightKg,
    bodyFatPercent,
    bodyMetricMeasuredTimeLocal: measuredTimeLocal,
    timeZoneId,
    updatedAt: ts
  });
}

function bodyMetricResultInput(value: unknown): BodyMetricResultInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { raw: value };
  }
  const record = value as Record<string, unknown>;
  const input: BodyMetricResultInput = {};
  for (const field of bodyMetricRecordFields) {
    if (Object.hasOwn(record, field)) {
      input[field as keyof Omit<BodyMetricResultInput, "raw">] = record[field];
    }
  }
  return input;
}

function failedBodyMetricResult(
  index: number,
  input: BodyMetricResultInput,
  error: BodyMetricRecordError,
  recordDate?: string
): BodyMetricBatchResult {
  return {
    index,
    ...(recordDate ? { recordDate } : {}),
    status: "failed",
    input,
    error
  };
}

function bodyMetricNumberError(
  field: "bodyWeightKg" | "bodyFatPercent",
  value: unknown
): BodyMetricRecordError | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return {
      field,
      code: "INVALID_RECORD",
      message: `${field} must be a finite JSON number.`
    };
  }
  const inRange = field === "bodyWeightKg" ? value > 0 && value <= 500 : value >= 0 && value <= 100;
  if (!inRange) {
    return {
      field,
      code: "OUT_OF_RANGE",
      message:
        field === "bodyWeightKg"
          ? "bodyWeightKg must be greater than 0 and at most 500."
          : "bodyFatPercent must be between 0 and 100."
    };
  }
  if (!hasAtMostTwoDecimalPlaces(value)) {
    return {
      field,
      code: "TOO_MANY_DECIMALS",
      message: `${field} must have no more than 2 decimal places.`
    };
  }
  return undefined;
}

function normalizeBodyMetricInput(
  raw: unknown,
  index: number,
  today: string,
  duplicateDates: ReadonlySet<string>
): { value?: BodyMetricInput; result?: BodyMetricBatchResult } {
  const input = bodyMetricResultInput(raw);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      result: failedBodyMetricResult(index, input, {
        field: "record",
        code: "INVALID_RECORD",
        message: "Each records item must be an object."
      })
    };
  }

  const record = raw as Record<string, unknown>;
  const unknownField = Object.keys(record).find((field) => !bodyMetricRecordFields.has(field));
  if (unknownField) {
    return {
      result: failedBodyMetricResult(index, input, {
        field: unknownField,
        code: "UNKNOWN_PROPERTY",
        message: `Unknown record property: ${unknownField}.`
      })
    };
  }

  const date = parseYmd(record.date);
  if (!date) {
    return {
      result: failedBodyMetricResult(index, input, {
        field: "date",
        code: "INVALID_DATE",
        message: "date must be a valid date in YYYY-MM-DD format."
      })
    };
  }
  if (date > today) {
    return {
      result: failedBodyMetricResult(
        index,
        input,
        {
          field: "date",
          code: "FUTURE_DATE",
          message: "date must not be later than today in timeZoneId."
        },
        date
      )
    };
  }
  if (duplicateDates.has(date)) {
    return {
      result: failedBodyMetricResult(
        index,
        input,
        {
          field: "date",
          code: "DUPLICATE_DATE",
          message: "The same date appears more than once in records."
        },
        date
      )
    };
  }

  const hasBodyWeight = Object.hasOwn(record, "bodyWeightKg");
  const hasBodyFat = Object.hasOwn(record, "bodyFatPercent");
  if (!hasBodyWeight && !hasBodyFat) {
    return {
      result: failedBodyMetricResult(
        index,
        input,
        {
          field: "record",
          code: "INVALID_RECORD",
          message: "At least one of bodyWeightKg or bodyFatPercent is required."
        },
        date
      )
    };
  }

  if (hasBodyWeight) {
    const error = bodyMetricNumberError("bodyWeightKg", record.bodyWeightKg);
    if (error) {
      return { result: failedBodyMetricResult(index, input, error, date) };
    }
  }
  if (hasBodyFat) {
    const error = bodyMetricNumberError("bodyFatPercent", record.bodyFatPercent);
    if (error) {
      return { result: failedBodyMetricResult(index, input, error, date) };
    }
  }

  let measuredTimeLocal: string | undefined;
  if (Object.hasOwn(record, "bodyMetricMeasuredTimeLocal")) {
    measuredTimeLocal = parseLocalTime(record.bodyMetricMeasuredTimeLocal);
    if (!measuredTimeLocal) {
      return {
        result: failedBodyMetricResult(
          index,
          input,
          {
            field: "bodyMetricMeasuredTimeLocal",
            code: "INVALID_RECORD",
            message: "bodyMetricMeasuredTimeLocal must be HH:mm in 24-hour format."
          },
          date
        )
      };
    }
  }

  return {
    value: {
      date,
      ...(hasBodyWeight ? { bodyWeightKg: record.bodyWeightKg as number } : {}),
      ...(hasBodyFat ? { bodyFatPercent: record.bodyFatPercent as number } : {}),
      ...(measuredTimeLocal ? { bodyMetricMeasuredTimeLocal: measuredTimeLocal } : {})
    }
  };
}

async function defaultBodyMetricDdbSender(
  command: BodyMetricDdbCommand
): Promise<{ Item?: Record<string, unknown> }> {
  if (command instanceof GetCommand) {
    const result = await ddb.send(command);
    return { Item: result.Item as Record<string, unknown> | undefined };
  }
  await ddb.send(command);
  return {};
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

function conditionFieldAlias(field: BodyMetricWritableField): string {
  if (field === "bodyWeightKg") {
    return "bodyWeight";
  }
  if (field === "bodyFatPercent") {
    return "bodyFat";
  }
  if (field === "bodyMetricMeasuredTimeLocal") {
    return "measuredTime";
  }
  return "timeZone";
}

function isConditionalCheckFailure(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "name" in error &&
    (error as { name?: unknown }).name === "ConditionalCheckFailedException"
  );
}

async function processBodyMetricRecord(
  input: BodyMetricInput,
  index: number,
  userId: string,
  timeZoneId: string,
  conflictPolicy: BodyMetricsConflictPolicy,
  dryRun: boolean,
  timestamp: string,
  send: BodyMetricDdbSender
): Promise<BodyMetricBatchResult> {
  const resultInput: BodyMetricResultInput = { ...input };
  let currentItem: Record<string, unknown>;
  try {
    const current = await send(
      new GetCommand({
        TableName: dailyRecordTableName,
        Key: {
          userId,
          recordDate: input.date
        },
        ConsistentRead: true
      })
    );
    currentItem = current.Item ?? {};
  } catch {
    return failedBodyMetricResult(
      index,
      resultInput,
      {
        field: "record",
        code: "READ_FAILED",
        message: "The existing record could not be read. Retry this record."
      },
      input.date
    );
  }

  const nextValues: Partial<Record<BodyMetricWritableField, number | string>> & { timeZoneId: string } = {
    ...(input.bodyWeightKg !== undefined ? { bodyWeightKg: input.bodyWeightKg } : {}),
    ...(input.bodyFatPercent !== undefined ? { bodyFatPercent: input.bodyFatPercent } : {}),
    ...(input.bodyMetricMeasuredTimeLocal !== undefined
      ? { bodyMetricMeasuredTimeLocal: input.bodyMetricMeasuredTimeLocal }
      : {}),
    timeZoneId
  };
  const observedFields = Object.keys(nextValues) as BodyMetricWritableField[];
  const conflicts = observedFields.filter(
    (field) => Object.hasOwn(currentItem, field) && currentItem[field] !== nextValues[field]
  );
  if (conflictPolicy === "reject" && conflicts.length > 0) {
    const field = conflicts[0];
    return failedBodyMetricResult(
      index,
      resultInput,
      {
        field,
        code: "CONFLICT",
        message: `A different ${field} value is already recorded for this date.`
      },
      input.date
    );
  }

  const changedFields = observedFields.filter(
    (field) => !Object.hasOwn(currentItem, field) || currentItem[field] !== nextValues[field]
  );
  if (changedFields.length === 0) {
    return {
      index,
      recordDate: input.date,
      status: "success",
      action: "unchanged",
      input: resultInput
    };
  }

  const hasExistingBodyMetric = [
    "bodyWeightKg",
    "bodyFatPercent",
    "bodyMetricMeasuredTimeLocal"
  ].some((field) => Object.hasOwn(currentItem, field));
  const baseAction = hasExistingBodyMetric ? "updated" : "created";
  if (dryRun) {
    return {
      index,
      recordDate: input.date,
      status: "success",
      action: baseAction === "created" ? "would_create" : "would_update",
      input: resultInput
    };
  }

  const expressionAttributeNames: Record<string, string> = {
    "#createdAt": "createdAt",
    "#updatedAt": "updatedAt",
    "#otherActivities": "otherActivities"
  };
  const expressionAttributeValues: Record<string, unknown> = {
    ":timestamp": timestamp,
    ":emptyActivities": []
  };
  const setExpressions = [
    "#createdAt = if_not_exists(#createdAt, :timestamp)",
    "#updatedAt = :timestamp",
    "#otherActivities = if_not_exists(#otherActivities, :emptyActivities)"
  ];
  for (const field of changedFields) {
    const alias = conditionFieldAlias(field);
    expressionAttributeNames[`#${alias}`] = field;
    expressionAttributeValues[`:next_${alias}`] = nextValues[field];
    setExpressions.push(`#${alias} = :next_${alias}`);
  }

  const conditionExpressions: string[] = [];
  for (const field of observedFields) {
    const alias = conditionFieldAlias(field);
    expressionAttributeNames[`#${alias}`] = field;
    if (Object.hasOwn(currentItem, field)) {
      expressionAttributeValues[`:expected_${alias}`] = currentItem[field];
      conditionExpressions.push(`#${alias} = :expected_${alias}`);
    } else {
      conditionExpressions.push(`attribute_not_exists(#${alias})`);
    }
  }

  try {
    await send(
      new UpdateCommand({
        TableName: dailyRecordTableName,
        Key: {
          userId,
          recordDate: input.date
        },
        UpdateExpression: `SET ${setExpressions.join(", ")}`,
        ConditionExpression: conditionExpressions.join(" AND "),
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues
      })
    );
  } catch (error) {
    if (isConditionalCheckFailure(error)) {
      return failedBodyMetricResult(
        index,
        resultInput,
        {
          field: "record",
          code: "CONCURRENT_UPDATE",
          message: "The record changed during this request. Retry this record after reviewing the latest value."
        },
        input.date
      );
    }
    return failedBodyMetricResult(
      index,
      resultInput,
      {
        field: "record",
        code: "WRITE_FAILED",
        message: "The record could not be saved. Retry this record."
      },
      input.date
    );
  }

  return {
    index,
    recordDate: input.date,
    status: "success",
    action: baseAction,
    input: resultInput
  };
}

export async function saveBodyMetricsBatch(
  args: ToolArgs,
  userId: string,
  options: SaveBodyMetricsBatchOptions = {}
): Promise<McpToolResponse> {
  const startedAtMs = Date.now();
  const requestId = randomUUID();
  const logger =
    options.logger ??
    ((entry: Record<string, unknown>) => {
      console.info(JSON.stringify(entry));
    });
  const requestError = (code: string, message: string): McpToolResponse => {
    logger({
      event: "mcp_body_metrics_batch_rejected",
      tool: "save_body_metrics_batch",
      requestId,
      statusCode: 400,
      code,
      received: Array.isArray(args.records) ? args.records.length : null,
      durationMs: Date.now() - startedAtMs
    });
    return mcpToolResponse(400, {
      code,
      message,
      requestId
    });
  };

  const unknownTopLevelField = Object.keys(args).find((field) => !bodyMetricBatchTopLevelFields.has(field));
  if (unknownTopLevelField) {
    return requestError("UNKNOWN_PROPERTY", `Unknown top-level property: ${unknownTopLevelField}.`);
  }
  if (!Array.isArray(args.records) || args.records.length < 1 || args.records.length > bodyMetricsBatchLimit) {
    return requestError(
      "INVALID_BATCH_SIZE",
      `records must contain between 1 and ${bodyMetricsBatchLimit} items.`
    );
  }
  const timeZoneId = resolveTimeZoneId(args);
  if (!timeZoneId) {
    return requestError("INVALID_TIME_ZONE", "timeZoneId must be a valid IANA time zone ID.");
  }
  const conflictPolicy = args.conflictPolicy ?? "reject";
  if (conflictPolicy !== "reject" && conflictPolicy !== "overwrite") {
    return requestError(
      "INVALID_CONFLICT_POLICY",
      "conflictPolicy must be reject or overwrite."
    );
  }
  if (typeof args.dryRun !== "boolean") {
    return requestError("INVALID_DRY_RUN", "dryRun is required and must be a boolean.");
  }

  const now = options.now ?? new Date();
  const today = nowYmdInTimeZone(timeZoneId, now);
  const dateCounts = new Map<string, number>();
  for (const raw of args.records) {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const date = parseYmd((raw as Record<string, unknown>).date);
      if (date) {
        dateCounts.set(date, (dateCounts.get(date) ?? 0) + 1);
      }
    }
  }
  const duplicateDates = new Set(
    Array.from(dateCounts.entries())
      .filter(([, count]) => count > 1)
      .map(([date]) => date)
  );

  const results = new Array<BodyMetricBatchResult | undefined>(args.records.length);
  const validRecords: Array<{ index: number; input: BodyMetricInput }> = [];
  args.records.forEach((raw, index) => {
    const normalized = normalizeBodyMetricInput(raw, index, today, duplicateDates);
    if (normalized.result) {
      results[index] = normalized.result;
    } else if (normalized.value) {
      validRecords.push({ index, input: normalized.value });
    }
  });

  const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const processed = await mapWithConcurrency(
    validRecords,
    bodyMetricsWriteConcurrency,
    ({ index, input }) =>
      processBodyMetricRecord(
        input,
        index,
        userId,
        timeZoneId,
        conflictPolicy,
        args.dryRun as boolean,
        timestamp,
        options.send ?? defaultBodyMetricDdbSender
      )
  );
  for (const result of processed) {
    results[result.index] = result;
  }

  const completeResults = results.filter((result): result is BodyMetricBatchResult => Boolean(result));
  const succeeded = completeResults.filter((result) => result.status === "success").length;
  const failed = completeResults.length - succeeded;
  const countAction = (...actions: BodyMetricBatchResult["action"][]): number =>
    completeResults.filter((result) => result.action && actions.includes(result.action)).length;
  const conflicts = completeResults.filter(
    (result) => result.error?.code === "CONFLICT" || result.error?.code === "CONCURRENT_UPDATE"
  ).length;
  const outcome = failed === 0 ? "succeeded" : succeeded === 0 ? "failed" : "partially_succeeded";
  const summary = {
    received: args.records.length,
    succeeded,
    failed,
    created: countAction("created", "would_create"),
    updated: countAction("updated", "would_update"),
    unchanged: countAction("unchanged"),
    conflicts
  };

  logger({
    event: "mcp_body_metrics_batch_completed",
    tool: "save_body_metrics_batch",
    requestId,
    statusCode: 200,
    dryRun: args.dryRun,
    conflictPolicy,
    outcome,
    ...summary,
    durationMs: Date.now() - startedAtMs
  });

  return mcpToolResponse(200, {
    tool: "save_body_metrics_batch",
    requestId,
    dryRun: args.dryRun,
    conflictPolicy,
    outcome,
    summary,
    results: completeResults
  });
}

async function getGoal(userId: string): Promise<McpToolResponse> {
  const result = await ddb.send(
    new GetCommand({
      TableName: goalTableName,
      Key: {
        userId
      }
    })
  );

  return mcpToolResponse(200, {
    tool: "get_goal",
    item: result.Item ? normalizeGoalForMcp(result.Item) : null
  });
}

async function getAiCharacterProfile(userId: string): Promise<McpToolResponse> {
  const result = await ddb.send(
    new GetCommand({
      TableName: aiSettingTableName,
      Key: {
        userId
      }
    })
  );

  return mcpToolResponse(200, {
    tool: "get_ai_character_profile",
    item: result.Item ? normalizeAiCharacterProfileForMcp(result.Item) : null
  });
}

async function saveAdviceLog(args: ToolArgs, userId: string): Promise<McpToolResponse> {
  const advice = toNonEmptyString(args.advice);
  const requestId = toNonEmptyString(args.requestId);
  if (!advice) {
    return mcpToolResponse(400, { message: "advice is required." });
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

  return mcpToolResponse(200, {
    tool: "save_advice_log",
    adviceLogId,
    createdAt: ts
  });
}

async function listTrainingMenuItemsForAi(userId: string): Promise<McpToolResponse> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: trainingMenuTableName,
      IndexName: "UserDisplayOrderIndex",
      KeyConditionExpression: "userId = :userId",
      ExpressionAttributeValues: { ":userId": userId }
    })
  );
  return mcpToolResponse(200, {
    tool: "list_training_menu_items",
    items: (result.Items ?? [])
      .filter((item) => item.isActive !== false)
      .map((item) => ({
        trainingMenuItemId: item.trainingMenuItemId,
        trainingName: item.trainingName,
        bodyPart: item.bodyPart ?? "",
        equipment: item.equipment ?? "その他",
        description: item.description ?? "",
        weightInputMode: item.weightInputMode ?? "legacyUnspecified",
        loadMultiplier: item.loadMultiplier,
        fixedWeightKg: item.fixedWeightKg,
        isAiGenerated: item.isAiGenerated === true
      }))
  });
}

async function listTrainingMenuSetsForAi(userId: string): Promise<McpToolResponse> {
  const [sets, links] = await Promise.all([
    ddb.send(
      new QueryCommand({
        TableName: trainingMenuSetTableName,
        IndexName: menuSetByOrderIndex,
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: { ":userId": userId }
      })
    ),
    ddb.send(
      new QueryCommand({
        TableName: trainingMenuSetItemTableName,
        IndexName: setItemsBySetOrderIndex,
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: { ":userId": userId }
      })
    )
  ]);
  return mcpToolResponse(200, {
    tool: "list_training_menu_sets",
    items: (sets.Items ?? []).map((set) => ({
      trainingMenuSetId: set.trainingMenuSetId,
      setName: set.setName,
      setType: set.setType ?? "reusable",
      source: set.source ?? "manual",
      isDefault: set.isDefault === true,
      items: (links.Items ?? [])
        .filter((item) => item.trainingMenuSetId === set.trainingMenuSetId)
        .map((item) => ({
          trainingMenuItemId: item.trainingMenuItemId,
          targetWeightKg: item.targetWeightKg,
          targetRepsMin: item.targetRepsMin,
          targetRepsMax: item.targetRepsMax,
          targetSets: item.targetSets,
          recommendedIntervalDays: item.recommendedIntervalDays,
          instruction: item.instruction ?? ""
        }))
    }))
  });
}

async function createDailyTrainingPlanFromAi(args: ToolArgs, userId: string): Promise<McpToolResponse> {
  const setName = toNonEmptyString(args.setName);
  const planDate = toNonEmptyString(args.planDate);
  const idempotencyKey = toNonEmptyString(args.idempotencyKey);
  const rawItems = Array.isArray(args.items) ? (args.items as AiMenuItemInput[]) : null;
  if (!setName || !planDate || !/^\d{4}-\d{2}-\d{2}$/.test(planDate) || !idempotencyKey || !rawItems?.length) {
    return mcpToolResponse(400, { message: "idempotencyKey, planDate, setName and items are required." });
  }
  if (rawItems.length > 12) {
    return mcpToolResponse(400, { message: "items cannot exceed 12." });
  }

  const currentPlan = await ddb.send(
    new GetCommand({ TableName: dailyTrainingPlanTableName, Key: { userId, planDate } })
  );
  if (currentPlan.Item?.idempotencyKey === idempotencyKey) {
    return mcpToolResponse(200, {
      tool: "create_daily_training_plan_from_ai",
      trainingMenuSetId: currentPlan.Item.trainingMenuSetId,
      planDate,
      idempotentReplay: true
    });
  }
  if (currentPlan.Item && args.replaceExistingPlan !== true) {
    return mcpToolResponse(409, {
      message: "a daily training plan already exists. ask the user before replacing it.",
      existingTrainingMenuSetId: currentPlan.Item.trainingMenuSetId,
      planDate
    });
  }

  type NormalizedAiItem = {
    trainingMenuItemId: string;
    newItem?: Record<string, unknown>;
    prescription: {
      targetWeightKg: number;
      targetRepsMin: number;
      targetRepsMax: number;
      targetSets: number;
      recommendedIntervalDays: number;
      instruction: string;
    };
  };

  const startingDisplayOrder = (await getMaxDisplayOrder(userId)) + 1;
  const normalizedItems: NormalizedAiItem[] = [];
  const newNames = new Set<string>();
  try {
    for (let index = 0; index < rawItems.length; index += 1) {
      const raw = rawItems[index];
      const existingId = toNonEmptyString(raw.existingTrainingMenuItemId);
      const newDefinition = raw.newTrainingMenuItem;
      if (Boolean(existingId) === Boolean(newDefinition)) {
        throw new Error(`items[${index}] must specify exactly one existing item or new item.`);
      }
      const prescriptionInput = raw.prescription;
      const targetWeightKg = normalizeNonNegativeDecimal(prescriptionInput?.targetWeightKg);
      const targetRepsMin = normalizePositiveInteger(prescriptionInput?.targetRepsMin);
      const targetRepsMax = normalizePositiveInteger(prescriptionInput?.targetRepsMax);
      const targetSets = normalizePositiveInteger(prescriptionInput?.targetSets);
      const recommendedIntervalDays = normalizeFrequency(prescriptionInput?.recommendedIntervalDays);
      const instruction = normalizeDescription(prescriptionInput?.instruction);
      if (
        targetWeightKg === undefined ||
        !targetRepsMin ||
        !targetRepsMax ||
        targetRepsMin > targetRepsMax ||
        !targetSets ||
        !recommendedIntervalDays ||
        instruction === undefined
      ) {
        throw new Error(`items[${index}].prescription is invalid.`);
      }

      if (existingId) {
        const existing = await ddb.send(
          new GetCommand({
            TableName: trainingMenuTableName,
            Key: { userId, trainingMenuItemId: existingId }
          })
        );
        if (!existing.Item || existing.Item.isActive === false) {
          throw new Error(`items[${index}].existingTrainingMenuItemId was not found.`);
        }
        normalizedItems.push({
          trainingMenuItemId: existingId,
          prescription: {
            targetWeightKg,
            targetRepsMin,
            targetRepsMax,
            targetSets,
            recommendedIntervalDays,
            instruction
          }
        });
        continue;
      }

      const trainingName = toNonEmptyString(newDefinition?.trainingName);
      const equipment = normalizeEquipment(newDefinition?.equipment);
      const description = normalizeDescription(newDefinition?.description);
      const normalizedTrainingName = trainingName ? normalizeTrainingName(trainingName) : "";
      if (!trainingName || !equipment || description === undefined) {
        throw new Error(`items[${index}].newTrainingMenuItem is invalid.`);
      }
      if (newNames.has(normalizedTrainingName) || await existsByTrainingName(userId, normalizedTrainingName)) {
        throw new Error(`items[${index}].newTrainingMenuItem.trainingName already exists.`);
      }
      newNames.add(normalizedTrainingName);
      const weightInputMode = newDefinition?.weightInputMode === "perSide" ? "perSide" : "direct";
      const fixedWeightKg = normalizeNonNegativeDecimal(newDefinition?.fixedWeightKg) ?? 0;
      const trainingMenuItemId = randomUUID();
      normalizedItems.push({
        trainingMenuItemId,
        newItem: {
          userId,
          trainingMenuItemId,
          trainingName,
          normalizedTrainingName,
          bodyPart: toNonEmptyString(newDefinition?.bodyPart) ?? "",
          equipment,
          description,
          weightInputMode,
          loadMultiplier: weightInputMode === "perSide" ? 2 : 1,
          fixedWeightKg: weightInputMode === "perSide" ? fixedWeightKg : 0,
          isAiGenerated: true,
          isActive: true,
          displayOrder: startingDisplayOrder + index
        },
        prescription: {
          targetWeightKg,
          targetRepsMin,
          targetRepsMax,
          targetSets,
          recommendedIntervalDays,
          instruction
        }
      });
    }
  } catch (error) {
    return mcpToolResponse(400, { message: error instanceof Error ? error.message : "invalid items." });
  }

  if (new Set(normalizedItems.map((item) => item.trainingMenuItemId)).size !== normalizedItems.length) {
    return mcpToolResponse(409, { message: "the same training item cannot appear twice." });
  }

  const menuSetOrder = (await getMaxMenuSetOrder(userId)) + 1;
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
          setType: "temporary",
          source: "ai",
          scheduledDate: planDate,
          isDefault: false,
          isActive: true,
          createdAt: ts,
          updatedAt: ts
        },
        ConditionExpression: "attribute_not_exists(userId) AND attribute_not_exists(trainingMenuSetId)"
      }
    },
    ...normalizedItems.flatMap((item, index) => {
      const displayOrder = index + 1;
      const newItemWrite = item.newItem
        ? [{
            Put: {
              TableName: trainingMenuTableName,
              Item: { ...item.newItem, createdAt: ts, updatedAt: ts },
              ConditionExpression: "attribute_not_exists(userId) AND attribute_not_exists(trainingMenuItemId)"
            }
          }]
        : [];
      return [
        ...newItemWrite,
        {
          Put: {
            TableName: trainingMenuSetItemTableName,
            Item: {
              userId,
              trainingMenuSetItemId: randomUUID(),
              trainingMenuSetId,
              trainingMenuItemId: item.trainingMenuItemId,
              displayOrder,
              menuSetOrderKey: buildMenuSetOrderKey(trainingMenuSetId, displayOrder),
              menuSetItemKey: buildMenuSetItemKey(trainingMenuSetId, item.trainingMenuItemId),
              ...item.prescription,
              createdBy: "ai",
              createdAt: ts,
              updatedAt: ts
            },
            ConditionExpression: "attribute_not_exists(userId) AND attribute_not_exists(trainingMenuSetItemId)"
          }
        }
      ];
    }),
    {
      Put: {
        TableName: dailyTrainingPlanTableName,
        Item: {
          userId,
          planDate,
          trainingMenuSetId,
          source: "ai",
          idempotencyKey,
          createdAt: ts,
          updatedAt: ts
        },
        ConditionExpression: currentPlan.Item
          ? "trainingMenuSetId = :expectedTrainingMenuSetId"
          : "attribute_not_exists(userId)",
        ...(currentPlan.Item
          ? { ExpressionAttributeValues: { ":expectedTrainingMenuSetId": currentPlan.Item.trainingMenuSetId } }
          : {})
      }
    }
  ];

  await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  return mcpToolResponse(200, {
    tool: "create_daily_training_plan_from_ai",
    trainingMenuSetId,
    planDate,
    setName,
    reusedItemCount: normalizedItems.filter((item) => !item.newItem).length,
    createdItemCount: normalizedItems.filter((item) => item.newItem).length
  });
}

export const handler = async (event: ToolArgs = {}, context: LambdaToolContext = {}): Promise<McpToolResponse> => {
  try {
    const envError = requireConfiguredTables();
    if (envError) {
      return mcpToolResponse(500, { message: envError });
    }

    const toolName = extractToolName(context);
    if (!toolName) {
      return mcpToolResponse(400, {
        message: "Tool name is missing in context.clientContext.custom.bedrockAgentCoreToolName."
      });
    }

    const userId = requireUserId(event);
    if (!userId) {
      return mcpToolResponse(403, { message: "Trusted user identity is required." });
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
    if (toolName === "get_analysis_export_manifest") {
      return getAnalysisExportManifest(event, userId);
    }
    if (toolName === "get_analysis_export_page") {
      return getAnalysisExportPage(event, userId);
    }
    if (toolName === "save_daily_diary") {
      return saveDailyDiary(event, userId);
    }
    if (toolName === "save_body_metrics") {
      return saveBodyMetrics(event, userId);
    }
    if (toolName === "save_body_metrics_batch") {
      return saveBodyMetricsBatch(event, userId);
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
    if (toolName === "list_training_menu_items") {
      return listTrainingMenuItemsForAi(userId);
    }
    if (toolName === "list_training_menu_sets") {
      return listTrainingMenuSetsForAi(userId);
    }
    if (toolName === "create_daily_training_plan_from_ai") {
      return createDailyTrainingPlanFromAi(event, userId);
    }

    return mcpToolResponse(404, { message: `Method not found: ${toolName}` });
  } catch {
    return mcpToolResponse(500, {
      message: "Internal error.",
      requestId: randomUUID()
    });
  }
};

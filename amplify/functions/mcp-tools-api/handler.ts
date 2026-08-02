import {
  BatchGetCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand
} from "@aws-sdk/lib-dynamodb";
import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { createHash, randomUUID } from "node:crypto";
import {
  appendCoachingNoteData,
  CoachingNoteLimitError,
  CoachingValidationError,
  CoachingVersionConflictError,
  coachingNoteRetentionDays,
  getCoachingContextData,
  maxActiveCoachingNotes,
  maxReturnedCoachingNotes,
  updateCoachingContextData
} from "../shared/coaching-context-store";
import { ddb } from "../shared/ddb";
import { enumerateYmdRange } from "../shared/date-range";
import {
  MUSCLE_TAXONOMY_VERSION,
  muscleGroupId,
  muscleGroupLabel,
  muscleLabel,
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
const trainingHistoryTableName = process.env.TRAINING_HISTORY_TABLE_NAME ?? "";
const trainingPerformanceTableName = process.env.TRAINING_PERFORMANCE_TABLE_NAME ?? "";
const dailyRecordTableName = process.env.DAILY_RECORD_TABLE_NAME ?? "";
const goalTableName = process.env.GOAL_TABLE_NAME ?? "";
const aiSettingTableName = process.env.AI_SETTING_TABLE_NAME ?? "";
const coachingContextTableName = process.env.COACHING_CONTEXT_TABLE_NAME ?? "";
const userProfileTableName = process.env.USER_PROFILE_TABLE_NAME ?? "";

export type McpToolResponse = Record<string, unknown>;

type LambdaToolContext = {
  awsRequestId?: string;
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
type DailyTextSaveMode = "append" | "overwrite";
type TenPointRating = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
type DailyPainArea = {
  area: string;
  severity: TenPointRating;
  occursAtRest: boolean;
  occursDuringMovement: boolean;
  numbness: boolean;
  weakness: boolean;
};
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
type AiNewTrainingMenuItemInput = {
  trainingName?: unknown;
  exerciseFamilyId?: unknown;
  muscleTargets?: unknown;
  movementFamily?: unknown;
  jointActions?: unknown;
  laterality?: unknown;
  loadModel?: unknown;
  equipmentType?: unknown;
  equipmentProfileId?: unknown;
  cableSettings?: unknown;
  description?: unknown;
  weightInputMode?: unknown;
  fixedWeightKg?: unknown;
  standardDurationMinutes?: unknown;
};
type AiMenuItemInput = {
  existingTrainingMenuItemId?: unknown;
  newTrainingMenuItem?: AiNewTrainingMenuItemInput;
  prescription?: {
    targetWeightKg?: unknown;
    targetRepsMin?: unknown;
    targetRepsMax?: unknown;
    targetSets?: unknown;
    recommendedIntervalDays?: unknown;
    instruction?: unknown;
    targetDurationMinutes?: unknown;
  };
};

type TemporaryPlanConflictPolicy = "reject" | "replace";
type MenuSetPrescriptionInput = {
  targetWeightKg?: unknown;
  targetRepsMin?: unknown;
  targetRepsMax?: unknown;
  targetSets?: unknown;
  recommendedIntervalDays?: unknown;
  instruction?: unknown;
};
type MenuSetItemUpdateInput = MenuSetPrescriptionInput & {
  trainingMenuSetItemId?: unknown;
};
type MenuSetItemAddInput = {
  trainingMenuItemId?: unknown;
  newTrainingMenuItem?: AiNewTrainingMenuItemInput;
  prescription?: MenuSetPrescriptionInput;
};

const menuSetByOrderIndex = "UserMenuSetByOrderIndex";
const setItemsBySetOrderIndex = "UserSetItemsBySetOrderIndex";
const setItemsByMenuItemIndex = "UserSetItemsByMenuItemIndex";
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

function parseScheduledDates(value: unknown, validityDates: string[]): string[] | undefined {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const dates = value.map((date) => parseYmd(date));
  if (
    dates.some((date) => !date) ||
    new Set(dates).size !== dates.length ||
    dates.some((date) => !validityDates.includes(date!))
  ) {
    return undefined;
  }
  return dates as string[];
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
  return { ConditionExpression: "attribute_exists(userId)" };
}

function menuSetVersion(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

export function trainingMenuItemVersion(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableJsonValue(entry)])
    );
  }
  return value;
}

function mutationRequestHash(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(stableJsonValue(value))).digest("hex");
}

function parseExpectedVersion(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function parseDryRun(value: unknown): boolean | undefined {
  return value === undefined || typeof value === "boolean" ? value === true : undefined;
}

function parseBoundedText(value: unknown, maximum: number, optional = false): string | undefined {
  if (value === undefined && optional) {
    return undefined;
  }
  const normalized = toNonEmptyString(value);
  return normalized && normalized.length <= maximum ? normalized : undefined;
}

function versionCondition(expectedVersion: number): {
  condition: string;
  values: Record<string, unknown>;
} {
  return expectedVersion === 0
    ? {
        condition: "(attribute_not_exists(#version) OR #version = :expectedVersion)",
        values: { ":expectedVersion": 0 }
      }
    : {
        condition: "#version = :expectedVersion",
        values: { ":expectedVersion": expectedVersion }
      };
}

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

function isTenPointRating(value: unknown): value is TenPointRating {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10;
}

function isValidDailyPainAreas(value: unknown): value is DailyPainArea[] {
  return (
    Array.isArray(value) &&
    value.length <= 20 &&
    value.every(
      (pain) =>
        pain &&
        typeof pain === "object" &&
        !Array.isArray(pain) &&
        typeof pain.area === "string" &&
        pain.area.trim().length >= 1 &&
        pain.area.trim().length <= 100 &&
        isTenPointRating(pain.severity) &&
        typeof pain.occursAtRest === "boolean" &&
        typeof pain.occursDuringMovement === "boolean" &&
        typeof pain.numbness === "boolean" &&
        typeof pain.weakness === "boolean"
    )
  );
}

function parseLocalDateTime(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = /^(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match || !parseYmd(match[1]) || !parseLocalTime(match[2])) {
    return undefined;
  }
  return value;
}

function localDateTimeInTimeZone(instant: Date, timeZoneId: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZoneId,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}`;
}

function localDateTimeToUtcMs(value: string, timeZoneId: string): number | undefined {
  const [date, time] = value.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let instant = new Date(localAsUtc);
  for (let iteration = 0; iteration < 4; iteration += 1) {
    instant = new Date(localAsUtc - timeZoneOffsetMs(instant, timeZoneId));
  }
  return localDateTimeInTimeZone(instant, timeZoneId) === value ? instant.getTime() : undefined;
}

export function calculateSleepHoursFromLocalDateTimes(
  sleepStartedAtLocal: unknown,
  wokeUpAtLocal: unknown,
  timeZoneId: string
): number | undefined {
  const start = parseLocalDateTime(sleepStartedAtLocal);
  const end = parseLocalDateTime(wokeUpAtLocal);
  if (!start || !end) {
    return undefined;
  }
  const startUtcMs = localDateTimeToUtcMs(start, timeZoneId);
  const endUtcMs = localDateTimeToUtcMs(end, timeZoneId);
  if (startUtcMs === undefined || endUtcMs === undefined) {
    return undefined;
  }
  const durationHours = (endUtcMs - startUtcMs) / 3_600_000;
  if (durationHours <= 0 || durationHours > 24) {
    return undefined;
  }
  return Math.round(durationHours * 100) / 100;
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
type AnalysisExportSection = "trainingMenus" | "trainingMenuSets" | "dailyRecords" | "gymVisits" | "recoveryExecutions";
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
    sleepHours: nullableNumber(item.sleepHours),
    sleepQuality: nullableNumber(item.sleepQuality),
    fatigueLevel: nullableNumber(item.fatigueLevel),
    motivationLevel: nullableNumber(item.motivationLevel),
    muscleSorenessLevel: nullableNumber(item.muscleSorenessLevel),
    painAreas: Array.isArray(item.painAreas) ? item.painAreas : [],
    restingHeartRate: nullableNumber(item.restingHeartRate),
    mealNotes: nullableString(item.mealNotes),
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
        muscleTargets: normalizeMuscleTargets(entry.muscleTargetsSnapshot) ?? [],
        movementFamily: normalizeMovementFamily(entry.movementFamilySnapshot),
        jointActions: normalizeJointActions(entry.jointActionsSnapshot) ?? [],
        laterality: normalizeLaterality(entry.lateralitySnapshot),
        loadModel: normalizeLoadModel(entry.loadModelSnapshot),
        classificationVersion: nullableNumber(entry.classificationVersionSnapshot),
        bodyWeightKgSnapshot: nullableNumber(entry.bodyWeightKgSnapshot),
        equipmentType: normalizeEquipmentType(entry.equipmentTypeSnapshot),
        equipmentProfileId: nullableString(entry.equipmentProfileIdSnapshot),
        cableSettings: entry.cableSettingsSnapshot ?? null,
        isAiGenerated: entry.isAiGeneratedSnapshot === true,
        frequencyDays: nullableNumber(entry.frequencySnapshot),
        weightKg: nullableNumber(entry.weightKg),
        additionalLoadKg: nullableNumber(entry.additionalLoadKg),
        assistanceKg: nullableNumber(entry.assistanceKg),
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

function normalizeAnalysisRecoveryExecution(item: Record<string, unknown>): Record<string, unknown> {
  const entries = Array.isArray(item.entries) ? item.entries : [];
  return {
    executionId: nullableString(item.executionId ?? item.visitId),
    menuSetKind: "recovery",
    date: nullableString(item.executionDateLocal ?? item.visitDateLocal),
    timeZoneId: nullableString(item.timeZoneId),
    sourceMenuSetId: nullableString(item.sourceMenuSetId),
    sourceMenuSetNameSnapshot: nullableString(item.sourceMenuSetNameSnapshot),
    sourceMenuSetTypeSnapshot: nullableString(item.sourceMenuSetTypeSnapshot),
    plannedMenuSetIdSnapshot: nullableString(item.plannedMenuSetIdSnapshot),
    planRelationAtRegistration: nullableString(item.planRelationAtRegistration),
    entries: entries.map((rawEntry) => {
      const entry = rawEntry && typeof rawEntry === "object" && !Array.isArray(rawEntry)
        ? rawEntry as Record<string, unknown>
        : {};
      return {
        menuItemId: nullableString(entry.menuItemId),
        activityNameSnapshot: nullableString(entry.activityNameSnapshot),
        sourceMenuSetItemId: nullableString(entry.sourceMenuSetItemId),
        targetDurationMinutesSnapshot: nullableNumber(entry.targetDurationMinutesSnapshot),
        actualDurationMinutes: nullableNumber(entry.actualDurationMinutes),
        instructionSnapshot: nullableString(entry.instructionSnapshot),
        note: nullableString(entry.note),
        performedAtUtc: nullableString(entry.performedAtUtc)
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
        muscleTargetsSnapshot: normalizeMuscleTargets(entry.muscleTargetsSnapshot) ?? [],
        movementFamilySnapshot: normalizeMovementFamily(entry.movementFamilySnapshot),
        jointActionsSnapshot: normalizeJointActions(entry.jointActionsSnapshot) ?? [],
        lateralitySnapshot: normalizeLaterality(entry.lateralitySnapshot),
        loadModelSnapshot: normalizeLoadModel(entry.loadModelSnapshot),
        classificationVersionSnapshot: nullableNumber(entry.classificationVersionSnapshot),
        bodyWeightKgSnapshot: nullableNumber(entry.bodyWeightKgSnapshot),
        equipmentTypeSnapshot: normalizeEquipmentType(entry.equipmentTypeSnapshot),
        equipmentProfileIdSnapshot: nullableString(entry.equipmentProfileIdSnapshot),
        cableSettingsSnapshot: entry.cableSettingsSnapshot ?? null,
        isAiGeneratedSnapshot: entry.isAiGeneratedSnapshot === true,
        frequencySnapshot: nullableNumber(entry.frequencySnapshot),
        weightKg: nullableNumber(entry.weightKg),
        additionalLoadKg: nullableNumber(entry.additionalLoadKg),
        assistanceKg: nullableNumber(entry.assistanceKg),
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
  if (item.itemKind === "recovery") {
    return {
      trainingMenuItemId: nullableString(item.trainingMenuItemId),
      trainingName: nullableString(item.trainingName),
      itemKind: "recovery",
      standardDurationMinutes: nullableNumber(item.standardDurationMinutes),
      isSystemProvided: item.isSystemProvided === true,
      isAiGenerated: item.isAiGenerated === true,
      description: nullableString(item.description),
      displayOrder: nullableNumber(item.displayOrder),
      isActive: item.isActive !== false,
      createdAtUtc: nullableString(item.createdAt),
      updatedAtUtc: nullableString(item.updatedAt)
    };
  }
  const legacyReps = nullableNumber(item.defaultReps);
  const weightInputMode =
    item.weightInputMode === "direct" || item.weightInputMode === "perSide"
      ? item.weightInputMode
      : "legacyUnspecified";
  return {
    trainingMenuItemId: nullableString(item.trainingMenuItemId),
    trainingName: nullableString(item.trainingName),
    itemKind: "training",
    exerciseFamilyId: nullableString(item.exerciseFamilyId),
    muscleTargets: normalizeMuscleTargets(item.muscleTargets) ?? [],
    movementFamily: normalizeMovementFamily(item.movementFamily),
    jointActions: normalizeJointActions(item.jointActions) ?? [],
    laterality: normalizeLaterality(item.laterality),
    loadModel: normalizeLoadModel(item.loadModel),
    classificationVersion: nullableNumber(item.classificationVersion),
    equipmentType: normalizeEquipmentType(item.equipmentType),
    equipmentProfileId: nullableString(item.equipmentProfileId),
    cableSettings: item.cableSettings ?? null,
    isAiGenerated: item.isAiGenerated === true,
    description: nullableString(item.description),
    frequencyDays: nullableNumber(item.frequency),
    defaultWeightKg: nullableNumber(item.defaultWeightKg),
    weightInputMode,
    loadMultiplier: weightInputMode === "legacyUnspecified" ? null : nullableNumber(item.loadMultiplier),
    fixedWeightKg:
      weightInputMode === "legacyUnspecified" ? null : nullableNumber(item.fixedWeightKg) ?? 0,
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
    sleepHours: nullableNumber(item.sleepHours),
    sleepQuality: nullableNumber(item.sleepQuality),
    fatigueLevel: nullableNumber(item.fatigueLevel),
    motivationLevel: nullableNumber(item.motivationLevel),
    muscleSorenessLevel: nullableNumber(item.muscleSorenessLevel),
    painAreas: Array.isArray(item.painAreas) ? item.painAreas : [],
    restingHeartRate: nullableNumber(item.restingHeartRate),
    mealNotes: nullableString(item.mealNotes),
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
    schemaVersion: 6,
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
    sections: ["trainingMenus", "trainingMenuSets", "dailyRecords", "gymVisits", "recoveryExecutions"],
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
    "gymVisits",
    "recoveryExecutions"
  ]);
  if (typeof section !== "string" || !allowedSections.has(section as AnalysisExportSection)) {
    return mcpToolResponse(400, {
      code: "INVALID_SECTION",
      message: "section must be trainingMenus, trainingMenuSets, dailyRecords, gymVisits, or recoveryExecutions."
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
    4,
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
  } else if (typedSection === "gymVisits" || typedSection === "recoveryExecutions") {
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
        const visitDateLocal = typeof item.visitDateLocal === "string"
          ? item.visitDateLocal
          : typeof item.executionDateLocal === "string" ? item.executionDateLocal : "";
        return visitDateLocal >= selection.from! && visitDateLocal <= selection.to!;
      });
    }
    result.Items = (result.Items ?? []).filter((item) =>
      typedSection === "recoveryExecutions" ? item.menuSetKind === "recovery" : item.menuSetKind !== "recovery"
    );
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
  } else if (typedSection === "recoveryExecutions") {
    items = (result.Items ?? []).map(normalizeAnalysisRecoveryExecution);
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
          setType: item.setType === "temporary" ? "temporary" : "reusable",
          source: item.source === "ai" ? "ai" : "manual",
          validFromDate: nullableString(item.validFromDate ?? item.scheduledDate),
          validToDate: nullableString(item.validToDate ?? item.scheduledDate),
          menuSetKind: item.menuSetKind === "recovery" ? "recovery" : "training",
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
    schemaVersion: 6,
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

function resolveDailyTextSaveMode(value: unknown): DailyTextSaveMode | undefined {
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

export function buildMcpToolInvocationLog(
  toolName: string,
  args: ToolArgs,
  requestId?: string
): Record<string, unknown> {
  const hiddenKeys = new Set(["__principalUserId", "userId", "actorId"]);
  return {
    event: "mcp_tool_invocation",
    toolName,
    argumentKeys: Object.keys(args)
      .filter((key) => !hiddenKeys.has(key))
      .sort(),
    ...(requestId ? { requestId } : {})
  };
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
    !coachingContextTableName
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

async function ensureCompleteRestItemForMcp(userId: string): Promise<void> {
  const trainingName = "完全休養";
  const normalizedTrainingName = normalizeTrainingName(trainingName);
  if (await existsByTrainingName(userId, normalizedTrainingName)) return;
  const ts = nowIsoSeconds();
  const trainingMenuItemId = randomUUID();
  try {
    await ddb.send(new PutCommand({
      TableName: trainingMenuTableName,
      Item: {
        userId,
        trainingMenuItemId,
        trainingName,
        normalizedTrainingName,
        itemKind: "recovery",
        description: "運動や積極的な回復活動を行わず、身体を休める日",
        isSystemProvided: true,
        isAiGenerated: false,
        isActive: true,
        displayOrder: (await getMaxDisplayOrder(userId)) + 1,
        version: 1,
        updatedBy: "system",
        updateReason: "System recovery activity provisioned",
        createdAt: ts,
        updatedAt: ts
      },
      ConditionExpression: "attribute_not_exists(userId) AND attribute_not_exists(trainingMenuItemId)"
    }));
  } catch {
    // A concurrent request may have provisioned it.
  }
}

function normalizeCableSettingsForMcp(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const input = value as Record<string, unknown>;
  const pulleyPosition = input.pulleyPosition;
  const attachmentType = input.attachmentType;
  const cableSides = input.cableSides;
  if (
    !["high", "middle", "low", "adjustable"].includes(String(pulleyPosition)) ||
    !["single_handle", "rope", "straight_bar", "ez_bar", "ankle_strap", "none", "other"].includes(
      String(attachmentType)
    ) ||
    !["single", "dual"].includes(String(cableSides))
  ) {
    return undefined;
  }
  return {
    pulleyPosition: String(pulleyPosition),
    attachmentType: String(attachmentType),
    cableSides: String(cableSides)
  };
}

type NormalizedNewTrainingMenuItem = {
  trainingMenuItemId: string;
  normalizedTrainingName: string;
  item: Record<string, unknown>;
};

async function normalizeNewTrainingMenuItemForMcp(
  userId: string,
  definition: AiNewTrainingMenuItemInput,
  displayOrder: number,
  reservedNames: Set<string>
): Promise<NormalizedNewTrainingMenuItem | { error: string }> {
  const trainingName = toNonEmptyString(definition.trainingName);
  const equipmentType = normalizeEquipmentType(definition.equipmentType);
  const exerciseFamilyId = toNonEmptyString(definition.exerciseFamilyId) ?? trainingName;
  const description = normalizeDescription(definition.description);
  const muscleTargets = normalizeMuscleTargets(definition.muscleTargets);
  const movementFamily = normalizeMovementFamily(definition.movementFamily);
  const jointActions = normalizeJointActions(definition.jointActions);
  const laterality = normalizeLaterality(definition.laterality);
  const loadModel = normalizeLoadModel(definition.loadModel);
  const normalizedTrainingName = trainingName ? normalizeTrainingName(trainingName) : "";
  const cableSettings =
    equipmentType === "cable_machine"
      ? normalizeCableSettingsForMcp(definition.cableSettings) ?? {
          pulleyPosition: "adjustable",
          attachmentType: "other",
          cableSides: "single"
        }
      : null;
  if (
    !trainingName ||
    trainingName.length > 100 ||
    !equipmentType ||
    !exerciseFamilyId ||
    exerciseFamilyId.length > 80 ||
    description === undefined ||
    !muscleTargets ||
    !movementFamily ||
    !jointActions ||
    !laterality ||
    !loadModel ||
    (equipmentType === "cable_machine" && !cableSettings)
  ) {
    return { error: "newTrainingMenuItem is invalid." };
  }
  if (
    reservedNames.has(normalizedTrainingName) ||
    await existsByTrainingName(userId, normalizedTrainingName)
  ) {
    return { error: "newTrainingMenuItem.trainingName already exists." };
  }
  reservedNames.add(normalizedTrainingName);
  const weightInputMode = definition.weightInputMode === "perSide" ? "perSide" : "direct";
  const parsedFixedWeightKg =
    definition.fixedWeightKg === undefined
      ? 0
      : normalizeNonNegativeDecimal(definition.fixedWeightKg);
  if (parsedFixedWeightKg === undefined) {
    return { error: "newTrainingMenuItem.fixedWeightKg is invalid." };
  }
  const fixedWeightKg = parsedFixedWeightKg;
  const trainingMenuItemId = randomUUID();
  return {
    trainingMenuItemId,
    normalizedTrainingName,
    item: {
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
      equipmentProfileId: toNonEmptyString(definition.equipmentProfileId) ?? "",
      cableSettings,
      description,
      weightInputMode,
      loadMultiplier: weightInputMode === "perSide" ? 2 : 1,
      fixedWeightKg: weightInputMode === "perSide" ? fixedWeightKg : 0,
      isAiGenerated: true,
      isActive: true,
      displayOrder,
      version: 1,
      updatedBy: "mcp",
      updateReason: "Created through MCP"
    }
  };
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
    items: (result.Items ?? [])
      .filter((item) => item.menuSetKind !== "recovery")
      .map((item) => normalizeGymVisitWeightSnapshots(item)),
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

function ymdDayNumber(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function daysBetweenYmd(from: string, to: string): number {
  return ymdDayNumber(to) - ymdDayNumber(from);
}

function startOfIsoWeek(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  return addYmdDays(value, -daysSinceMonday);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function rounded(value: number, digits = 2): number {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function rollingAverage(
  records: Record<string, unknown>[],
  field: "bodyWeightKg" | "bodyFatPercent",
  to: string,
  days: number
): Record<string, unknown> {
  const from = addYmdDays(to, -(days - 1));
  const values = records
    .filter((record) => {
      const date = String(record.recordDate ?? "");
      return date >= from && date <= to;
    })
    .map((record) => finiteNumber(record[field]))
    .filter((value): value is number => value !== undefined);
  return {
    from,
    to,
    average: values.length ? rounded(values.reduce((sum, value) => sum + value, 0) / values.length) : null,
    sampleCount: values.length
  };
}

type MuscleSetStats = {
  primarySets: number;
  secondarySets: number;
  stabilizerSets: number;
  effectiveSets: number;
};

function addMuscleSets(stats: Map<string, MuscleSetStats>, key: string, sets: number, target: MuscleTarget) {
  const current = stats.get(key) ?? {
    primarySets: 0,
    secondarySets: 0,
    stabilizerSets: 0,
    effectiveSets: 0
  };
  if (target.role === "primary") current.primarySets += sets;
  if (target.role === "secondary") current.secondarySets += sets;
  if (target.role === "stabilizer") current.stabilizerSets += sets;
  current.effectiveSets += sets * target.effectiveSetFactor;
  stats.set(key, current);
}

function resistanceForStrength(
  entry: Record<string, unknown>,
  loadModel: LoadModel | null,
  inputWeightKg: number
): number | undefined {
  if (loadModel === "external_load") {
    return inputWeightKg > 0 ? inputWeightKg : undefined;
  }
  if (loadModel === "assisted_bodyweight") {
    const bodyWeightKg = finiteNumber(entry.bodyWeightKgSnapshot);
    const assistanceKg = finiteNumber(entry.assistanceKg);
    return bodyWeightKg && assistanceKg !== undefined && bodyWeightKg > assistanceKg
      ? bodyWeightKg - assistanceKg
      : undefined;
  }
  return undefined;
}

export function buildTrainingCoachingSummary(
  visits: Record<string, unknown>[],
  dailyRecords: Record<string, unknown>[],
  from: string,
  to: string,
  timeZoneId: string
): Record<string, unknown> {
  const trainingDates = new Set<string>();
  const weeklySets = new Map<string, number>();
  const muscleSets = new Map<string, MuscleSetStats>();
  const muscleGroupSets = new Map<string, MuscleSetStats>();
  const exerciseMap = new Map<
    string,
    {
      trainingMenuItemId: string;
      trainingName: string | null;
      lastPerformedDate: string | null;
      loadModel: LoadModel | null;
      bestResistanceKg: number | null;
      estimated1RmKg: number | null;
      recommendedIntervalDays: number | null;
      performances: Array<Record<string, unknown>>;
    }
  >();
  let totalSets = 0;
  for (const visit of visits) {
    const date = parseYmd(visit.visitDateLocal) ?? parseYmd(String(visit.startedAtUtc ?? "").slice(0, 10));
    if (!date || date < from || date > to) {
      continue;
    }
    const entries = Array.isArray(visit.entries) ? visit.entries : [];
    if (entries.length) {
      trainingDates.add(date);
    }
    for (const rawEntry of entries) {
      if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
        continue;
      }
      const entry = rawEntry as Record<string, unknown>;
      const sets = Math.max(0, Math.floor(finiteNumber(entry.sets) ?? 0));
      totalSets += sets;
      const week = startOfIsoWeek(date);
      weeklySets.set(week, (weeklySets.get(week) ?? 0) + sets);
      const targets = normalizeMuscleTargets(entry.muscleTargetsSnapshot) ?? [];
      for (const target of targets) {
        addMuscleSets(muscleSets, target.muscleId, sets, target);
        addMuscleSets(muscleGroupSets, muscleGroupId(target.muscleId), sets, target);
      }
      const trainingMenuItemId = toNonEmptyString(entry.trainingMenuItemId);
      if (!trainingMenuItemId) {
        continue;
      }
      const current =
        exerciseMap.get(trainingMenuItemId) ??
        {
          trainingMenuItemId,
          trainingName: nullableString(entry.trainingNameSnapshot),
          lastPerformedDate: null,
          loadModel: normalizeLoadModel(entry.loadModelSnapshot),
          bestResistanceKg: null,
          estimated1RmKg: null,
          recommendedIntervalDays: null,
          performances: []
        };
      const totalWeight =
        finiteNumber(entry.calculatedTotalWeightKg) ?? finiteNumber(entry.weightKg) ?? 0;
      const loadModel = normalizeLoadModel(entry.loadModelSnapshot);
      const resistanceKg = resistanceForStrength(entry, loadModel, totalWeight);
      const reps = Math.max(0, Math.floor(finiteNumber(entry.reps) ?? 0));
      const estimate =
        resistanceKg !== undefined && reps >= 1 && reps <= 10
          ? rounded(resistanceKg * (1 + reps / 30))
          : undefined;
      current.trainingName = nullableString(entry.trainingNameSnapshot) ?? current.trainingName;
      current.lastPerformedDate =
        !current.lastPerformedDate || date > current.lastPerformedDate ? date : current.lastPerformedDate;
      current.loadModel = loadModel ?? current.loadModel;
      if (resistanceKg !== undefined) {
        current.bestResistanceKg =
          current.bestResistanceKg === null ? resistanceKg : Math.max(current.bestResistanceKg, resistanceKg);
      }
      if (estimate !== undefined) {
        current.estimated1RmKg =
          current.estimated1RmKg === null ? estimate : Math.max(current.estimated1RmKg, estimate);
      }
      const frequency = finiteNumber(entry.frequencySnapshot);
      if (frequency && Number.isInteger(frequency) && frequency >= 1 && frequency <= 8) {
        current.recommendedIntervalDays = frequency;
      }
      current.performances.push({
        date,
        inputWeightKg: rounded(totalWeight),
        resistanceKg: resistanceKg === undefined ? null : rounded(resistanceKg),
        loadModel,
        reps,
        sets
      });
      exerciseMap.set(trainingMenuItemId, current);
    }
  }

  const sortedTrainingDates = Array.from(trainingDates).sort();
  let longestTrainingStreak = 0;
  let runningStreak = 0;
  let previousDate: string | undefined;
  for (const date of sortedTrainingDates) {
    runningStreak = previousDate && daysBetweenYmd(previousDate, date) === 1 ? runningStreak + 1 : 1;
    longestTrainingStreak = Math.max(longestTrainingStreak, runningStreak);
    previousDate = date;
  }
  let currentTrainingStreak = 0;
  for (let cursor = to; trainingDates.has(cursor); cursor = addYmdDays(cursor, -1)) {
    currentTrainingStreak += 1;
  }
  const inclusiveDays = daysBetweenYmd(from, to) + 1;
  const exercises = Array.from(exerciseMap.values())
    .map((exercise) => ({
      trainingMenuItemId: exercise.trainingMenuItemId,
      trainingName: exercise.trainingName,
      lastPerformedDate: exercise.lastPerformedDate,
      loadModel: exercise.loadModel,
      bestResistanceKg: exercise.bestResistanceKg,
      estimated1RmKg: exercise.estimated1RmKg,
      recentPerformanceTrend: exercise.performances
        .sort((left, right) => String(left.date).localeCompare(String(right.date)))
        .slice(-5),
      recommendedIntervalDays: exercise.recommendedIntervalDays,
      elapsedDaysSinceLastPerformance: exercise.lastPerformedDate
        ? daysBetweenYmd(exercise.lastPerformedDate, to)
        : null
    }))
    .sort((left, right) =>
      String(left.trainingName ?? left.trainingMenuItemId).localeCompare(
        String(right.trainingName ?? right.trainingMenuItemId),
        "ja"
      )
    );
  const readinessFields = [
    "sleepHours",
    "sleepQuality",
    "fatigueLevel",
    "motivationLevel",
    "muscleSorenessLevel",
    "painAreas",
    "restingHeartRate",
    "mealNotes",
    "conditionRating",
    "moodRating",
    "conditionComment"
  ];
  const recentReadiness = dailyRecords
    .filter((record) => readinessFields.some((field) => record[field] !== undefined))
    .sort((left, right) => String(right.recordDate ?? "").localeCompare(String(left.recordDate ?? "")))
    .slice(0, 7)
    .map((record) => ({
      recordDate: record.recordDate,
      ...Object.fromEntries(readinessFields.map((field) => [field, record[field] ?? null]))
    }));
  return {
    range: { from, to, timeZoneId, inclusive: true },
    trainingDays: trainingDates.size,
    restDays: Math.max(0, inclusiveDays - trainingDates.size),
    totalSets,
    longestTrainingStreak,
    currentTrainingStreakThroughEndDate: currentTrainingStreak,
    weeklySets: Array.from(weeklySets.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([weekStartDate, sets]) => ({ weekStartDate, sets })),
    muscleGroupSets: Array.from(muscleGroupSets.entries())
      .map(([groupId, stats]) => ({
        groupId,
        label: muscleGroupLabel(groupId as Parameters<typeof muscleGroupLabel>[0]),
        primarySets: stats.primarySets,
        secondarySets: stats.secondarySets,
        stabilizerSets: stats.stabilizerSets,
        effectiveSets: rounded(stats.effectiveSets)
      }))
      .sort((left, right) => right.effectiveSets - left.effectiveSets),
    muscleSets: Array.from(muscleSets.entries())
      .map(([muscleId, stats]) => ({
        muscleId,
        label: muscleLabel(muscleId as Parameters<typeof muscleLabel>[0]),
        primarySets: stats.primarySets,
        secondarySets: stats.secondarySets,
        stabilizerSets: stats.stabilizerSets,
        effectiveSets: rounded(stats.effectiveSets)
      }))
      .sort((left, right) => right.effectiveSets - left.effectiveSets),
    exercises,
    bodyMetrics: {
      bodyWeightKg: {
        sevenDay: rollingAverage(dailyRecords, "bodyWeightKg", to, 7),
        twentyEightDay: rollingAverage(dailyRecords, "bodyWeightKg", to, 28)
      },
      bodyFatPercent: {
        sevenDay: rollingAverage(dailyRecords, "bodyFatPercent", to, 7),
        twentyEightDay: rollingAverage(dailyRecords, "bodyFatPercent", to, 28)
      }
    },
    recentReadiness
  };
}

async function getTrainingCoachingSummary(args: ToolArgs, userId: string): Promise<McpToolResponse> {
  const from = parseYmd(args.from);
  const to = parseYmd(args.to);
  const timeZoneId = resolveTimeZoneId(args);
  if (!from || !to || from > to || daysBetweenYmd(from, to) > 365 || !timeZoneId) {
    return mcpToolResponse(400, {
      code: "INVALID_DATE_RANGE",
      message: "from and to must be valid ordered YYYY-MM-DD dates spanning at most 366 days."
    });
  }
  const visits: Record<string, unknown>[] = [];
  let visitCursor: Record<string, unknown> | undefined;
  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: trainingHistoryTableName,
        IndexName: trainingHistoryByStartedAtIndex,
        KeyConditionExpression: "userId = :userId AND startedAtUtc BETWEEN :fromUtc AND :toUtc",
        ExpressionAttributeValues: {
          ":userId": userId,
          ":fromUtc": localDateStartUtc(from, timeZoneId),
          ":toUtc": localDateInclusiveUpperKey(to, timeZoneId)
        },
        ExclusiveStartKey: visitCursor
      })
    );
    visits.push(...((result.Items ?? []) as Record<string, unknown>[]));
    visitCursor = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (visitCursor);

  const dailyRecords: Record<string, unknown>[] = [];
  const bodyAverageFrom = addYmdDays(to, -27);
  const dailyFrom = bodyAverageFrom < from ? bodyAverageFrom : from;
  let dailyCursor: Record<string, unknown> | undefined;
  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: dailyRecordTableName,
        KeyConditionExpression: "userId = :userId AND recordDate BETWEEN :from AND :to",
        ExpressionAttributeValues: {
          ":userId": userId,
          ":from": dailyFrom,
          ":to": to
        },
        ExclusiveStartKey: dailyCursor
      })
    );
    dailyRecords.push(...((result.Items ?? []) as Record<string, unknown>[]));
    dailyCursor = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (dailyCursor);
  return mcpToolResponse(200, {
    tool: "get_training_coaching_summary",
    summary: buildTrainingCoachingSummary(visits, dailyRecords, from, to, timeZoneId),
    definitions: {
      weekStartsOn: "Monday",
      restDay: "A local date in the requested range without a gym visit containing entries.",
      estimated1Rm:
        "Epley formula for external loads and assisted-bodyweight resistance (body weight minus assistance), calculated for 1-10 repetitions. Plain bodyweight movements are excluded.",
      effectiveSets: "Each target receives the exercise-specific effectiveSetFactor stored in muscleTargets.",
      bodyMetricAverage: "Average of recorded samples only; missing dates are not counted."
    }
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
    muscleTargetsSnapshot: normalizeMuscleTargets(item.muscleTargetsSnapshot) ?? [],
    movementFamilySnapshot: normalizeMovementFamily(item.movementFamilySnapshot),
    jointActionsSnapshot: normalizeJointActions(item.jointActionsSnapshot) ?? [],
    lateralitySnapshot: normalizeLaterality(item.lateralitySnapshot),
    loadModelSnapshot: normalizeLoadModel(item.loadModelSnapshot),
    classificationVersionSnapshot: item.classificationVersionSnapshot ?? MUSCLE_TAXONOMY_VERSION,
    bodyWeightKgSnapshot: item.bodyWeightKgSnapshot ?? null,
    equipmentTypeSnapshot: normalizeEquipmentType(item.equipmentTypeSnapshot),
    equipmentProfileIdSnapshot: item.equipmentProfileIdSnapshot ?? null,
    cableSettingsSnapshot: item.cableSettingsSnapshot ?? null,
    isAiGeneratedSnapshot: item.isAiGeneratedSnapshot === true,
    frequencySnapshot: item.frequencySnapshot,
    note: typeof item.note === "string" ? item.note : "",
    weightKg: item.weightKg,
    additionalLoadKg: item.additionalLoadKg ?? null,
    assistanceKg: item.assistanceKg ?? null,
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
  const mode = resolveDailyTextSaveMode(args.mode);
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

export async function saveDailyMealNotes(args: ToolArgs, userId: string): Promise<McpToolResponse> {
  if (typeof args.mealNotes !== "string" || args.mealNotes.length > 5000) {
    return mcpToolResponse(400, {
      message: "mealNotes is required as a string with at most 5000 characters."
    });
  }
  const mealNotes = args.mealNotes;
  const mode = resolveDailyTextSaveMode(args.mode);
  if (args.mode !== undefined && !mode) {
    return mcpToolResponse(400, { message: "mode must be append or overwrite." });
  }
  if (mode === "append" && mealNotes.trim().length === 0) {
    return mcpToolResponse(400, { message: "mealNotes must not be empty when mode is append." });
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
        recordDate: date
      }
    })
  );

  const currentItem = (current.Item as Record<string, unknown> | undefined) ?? {};
  const existingMealNotes =
    typeof currentItem.mealNotes === "string" ? currentItem.mealNotes : "";
  if (existingMealNotes.trim().length > 0 && !mode) {
    return mcpToolResponse(409, {
      message: "Meal notes already exist. Specify mode=append or mode=overwrite.",
      existingMealNotes,
      recordDate: date,
      timeZoneId
    });
  }

  const nextMealNotes =
    mode === "append" && existingMealNotes.trim().length > 0
      ? `${existingMealNotes}\n${mealNotes}`
      : mealNotes;
  if (nextMealNotes.length > 5000) {
    return mcpToolResponse(400, {
      message: "The saved mealNotes value must be at most 5000 characters."
    });
  }

  const ts = nowIsoSeconds();
  const item = {
    userId,
    recordDate: date,
    timeZoneId,
    otherActivities: [],
    ...currentItem,
    mealNotes: nextMealNotes,
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
    tool: "save_daily_meal_notes",
    recordDate: date,
    timeZoneId,
    mode: mode ?? "overwrite",
    mealNotes: nextMealNotes,
    updatedAt: ts
  });
}

export async function saveDailyReadiness(args: ToolArgs, userId: string): Promise<McpToolResponse> {
  const timeZoneId = resolveTimeZoneId(args);
  if (!timeZoneId) {
    return mcpToolResponse(400, { message: "timeZoneId must be a valid IANA time zone ID." });
  }

  const hasSleepStartedAt = args.sleepStartedAtLocal !== undefined;
  const hasWokeUpAt = args.wokeUpAtLocal !== undefined;
  const hasSleepTimePair = hasSleepStartedAt && hasWokeUpAt;
  if (hasSleepStartedAt !== hasWokeUpAt) {
    return mcpToolResponse(400, {
      message: "sleepStartedAtLocal and wokeUpAtLocal must be specified together."
    });
  }
  if (hasSleepTimePair && args.sleepHours !== undefined) {
    return mcpToolResponse(400, {
      message: "Specify either sleepHours or the sleepStartedAtLocal/wokeUpAtLocal pair, not both."
    });
  }

  const sleepStartedAtLocal = hasSleepTimePair
    ? parseLocalDateTime(args.sleepStartedAtLocal)
    : undefined;
  const wokeUpAtLocal = hasSleepTimePair ? parseLocalDateTime(args.wokeUpAtLocal) : undefined;
  if (hasSleepTimePair && (!sleepStartedAtLocal || !wokeUpAtLocal)) {
    return mcpToolResponse(400, {
      message: "Sleep timestamps must use YYYY-MM-DDTHH:mm local date-time format."
    });
  }

  const inferredRecordDate = wokeUpAtLocal?.slice(0, 10);
  const date =
    args.date === undefined && inferredRecordDate
      ? inferredRecordDate
      : resolveRecordDate(args.date, timeZoneId);
  if (!date) {
    return mcpToolResponse(400, { message: "date must be a valid date in YYYY-MM-DD format." });
  }
  if (inferredRecordDate && date !== inferredRecordDate) {
    return mcpToolResponse(400, {
      message: "date must match the local calendar date in wokeUpAtLocal.",
      inferredRecordDate
    });
  }

  const updates: Record<string, unknown> = {};
  let calculatedSleepHours: number | undefined;
  if (hasSleepTimePair) {
    calculatedSleepHours = calculateSleepHoursFromLocalDateTimes(
      sleepStartedAtLocal,
      wokeUpAtLocal,
      timeZoneId
    );
    if (calculatedSleepHours === undefined) {
      return mcpToolResponse(400, {
        message:
          "The sleep interval must be valid in the specified time zone, end after it starts, and be at most 24 hours."
      });
    }
    updates.sleepHours = calculatedSleepHours;
  } else if (args.sleepHours !== undefined) {
    if (
      typeof args.sleepHours !== "number" ||
      !Number.isFinite(args.sleepHours) ||
      args.sleepHours < 0 ||
      args.sleepHours > 24
    ) {
      return mcpToolResponse(400, { message: "sleepHours must be a number between 0 and 24." });
    }
    updates.sleepHours = Math.round(args.sleepHours * 100) / 100;
  }

  for (const field of [
    "sleepQuality",
    "fatigueLevel",
    "motivationLevel",
    "muscleSorenessLevel"
  ] as const) {
    if (args[field] === undefined) {
      continue;
    }
    if (!isTenPointRating(args[field])) {
      return mcpToolResponse(400, {
        message: `${field} must be an integer between 1 and 10.`
      });
    }
    updates[field] = args[field];
  }

  if (args.restingHeartRate !== undefined) {
    if (
      typeof args.restingHeartRate !== "number" ||
      !Number.isInteger(args.restingHeartRate) ||
      args.restingHeartRate < 20 ||
      args.restingHeartRate > 250
    ) {
      return mcpToolResponse(400, {
        message: "restingHeartRate must be an integer between 20 and 250."
      });
    }
    updates.restingHeartRate = args.restingHeartRate;
  }

  if (args.painAreas !== undefined) {
    if (!isValidDailyPainAreas(args.painAreas)) {
      return mcpToolResponse(400, {
        message: "painAreas must contain at most 20 valid structured pain records."
      });
    }
    updates.painAreas = args.painAreas.map((pain) => ({
      ...pain,
      area: pain.area.trim()
    }));
  }

  const updatedFields = Object.keys(updates).sort();
  if (updatedFields.length === 0) {
    return mcpToolResponse(400, {
      message: "Specify at least one readiness field to save."
    });
  }

  const ts = nowIsoSeconds();
  const expressionAttributeNames: Record<string, string> = {
    "#createdAt": "createdAt",
    "#updatedAt": "updatedAt",
    "#timeZoneId": "timeZoneId",
    "#otherActivities": "otherActivities"
  };
  const expressionAttributeValues: Record<string, unknown> = {
    ":createdAt": ts,
    ":updatedAt": ts,
    ":timeZoneId": timeZoneId,
    ":emptyActivities": []
  };
  const setExpressions = [
    "#createdAt = if_not_exists(#createdAt, :createdAt)",
    "#updatedAt = :updatedAt",
    "#timeZoneId = :timeZoneId",
    "#otherActivities = if_not_exists(#otherActivities, :emptyActivities)"
  ];
  for (const [index, [field, value]] of Object.entries(updates).entries()) {
    const nameKey = `#field${index}`;
    const valueKey = `:field${index}`;
    expressionAttributeNames[nameKey] = field;
    expressionAttributeValues[valueKey] = value;
    setExpressions.push(`${nameKey} = ${valueKey}`);
  }

  const result = await ddb.send(
    new UpdateCommand({
      TableName: dailyRecordTableName,
      Key: {
        userId,
        recordDate: date
      },
      UpdateExpression: `SET ${setExpressions.join(", ")}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: "ALL_NEW"
    })
  );

  return mcpToolResponse(200, {
    tool: "save_daily_readiness",
    recordDate: date,
    timeZoneId,
    updatedFields,
    ...(calculatedSleepHours !== undefined
      ? {
          sleepCalculation: {
            sleepStartedAtLocal,
            wokeUpAtLocal,
            sleepHours: calculatedSleepHours
          }
        }
      : {}),
    item: normalizeDailyRecordForMcp((result.Attributes ?? {}) as Record<string, unknown>)
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

function coachingErrorResponse(error: unknown): McpToolResponse {
  if (error instanceof CoachingValidationError) {
    return mcpToolResponse(400, {
      code: "INVALID_COACHING_CONTEXT",
      message: error.message
    });
  }
  if (error instanceof CoachingVersionConflictError) {
    return mcpToolResponse(409, {
      code: "COACHING_CONTEXT_VERSION_CONFLICT",
      message: "The coaching context changed. Retrieve it again before updating.",
      currentVersion: error.currentVersion
    });
  }
  if (error instanceof CoachingNoteLimitError) {
    return mcpToolResponse(409, {
      code: "COACHING_NOTE_LIMIT_REACHED",
      message: error.message,
      maxActiveNotes: maxActiveCoachingNotes
    });
  }
  throw error;
}

async function getCoachingContext(args: ToolArgs, userId: string): Promise<McpToolResponse> {
  const timeZoneId = resolveTimeZoneId(args);
  if (!timeZoneId) {
    return mcpToolResponse(400, {
      code: "INVALID_TIME_ZONE",
      message: "timeZoneId must be a valid IANA time zone."
    });
  }
  const date = resolveRecordDate(args.date, timeZoneId);
  if (!date) {
    return mcpToolResponse(400, {
      code: "INVALID_DATE",
      message: "date must be a valid YYYY-MM-DD date."
    });
  }
  const data = await getCoachingContextData(coachingContextTableName, userId);
  const activeNotes = data.notes
    .filter(
      (note) =>
        (!note.validFromDate || note.validFromDate <= date) &&
        (!note.validToDate || note.validToDate >= date)
    )
    .slice(0, maxReturnedCoachingNotes);

  return mcpToolResponse(200, {
    tool: "get_coaching_context",
    asOfDate: date,
    timeZoneId,
    context: data.context,
    activeNotes,
    limits: {
      returnedNotes: maxReturnedCoachingNotes,
      activeNotes: maxActiveCoachingNotes,
      noteRetentionDays: coachingNoteRetentionDays
    }
  });
}

async function updateCoachingContext(args: ToolArgs, userId: string): Promise<McpToolResponse> {
  if (args.userConfirmed !== true) {
    return mcpToolResponse(400, {
      code: "USER_CONFIRMATION_REQUIRED",
      message: "Obtain explicit user approval and set userConfirmed to true before updating."
    });
  }
  try {
    const context = await updateCoachingContextData(coachingContextTableName, userId, args);
    return mcpToolResponse(200, {
      tool: "update_coaching_context",
      context
    });
  } catch (error) {
    return coachingErrorResponse(error);
  }
}

async function appendCoachingNote(args: ToolArgs, userId: string): Promise<McpToolResponse> {
  if (args.userConfirmed !== true) {
    return mcpToolResponse(400, {
      code: "USER_CONFIRMATION_REQUIRED",
      message: "Obtain explicit user approval and set userConfirmed to true before saving a note."
    });
  }
  try {
    const result = await appendCoachingNoteData(coachingContextTableName, userId, args);
    return mcpToolResponse(200, {
      tool: "append_coaching_note",
      created: result.created,
      note: result.note
    });
  } catch (error) {
    return coachingErrorResponse(error);
  }
}

async function getTrainingMenuSetRecord(
  userId: string,
  trainingMenuSetId: string
): Promise<Record<string, unknown> | undefined> {
  const result = await ddb.send(
    new GetCommand({
      TableName: trainingMenuSetTableName,
      Key: { userId, trainingMenuSetId }
    })
  );
  return result.Item as Record<string, unknown> | undefined;
}

async function listTrainingMenuSetLinks(
  userId: string,
  trainingMenuSetId: string
): Promise<Record<string, unknown>[]> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: trainingMenuSetItemTableName,
      IndexName: setItemsBySetOrderIndex,
      KeyConditionExpression: "userId = :userId AND begins_with(menuSetOrderKey, :prefix)",
      ExpressionAttributeValues: {
        ":userId": userId,
        ":prefix": `${trainingMenuSetId}#`
      }
    })
  );
  return (result.Items ?? []) as Record<string, unknown>[];
}

async function getTrainingMenuItemsById(
  userId: string,
  trainingMenuItemIds: string[]
): Promise<Map<string, Record<string, unknown>>> {
  const uniqueIds = Array.from(new Set(trainingMenuItemIds.filter(Boolean)));
  const result = new Map<string, Record<string, unknown>>();
  for (let index = 0; index < uniqueIds.length; index += 100) {
    const chunk = uniqueIds.slice(index, index + 100);
    const response = await ddb.send(
      new BatchGetCommand({
        RequestItems: {
          [trainingMenuTableName]: {
            Keys: chunk.map((trainingMenuItemId) => ({ userId, trainingMenuItemId }))
          }
        }
      })
    );
    for (const item of response.Responses?.[trainingMenuTableName] ?? []) {
      if (typeof item.trainingMenuItemId === "string") {
        result.set(item.trainingMenuItemId, item as Record<string, unknown>);
      }
    }
  }
  return result;
}

function temporaryMenuSetSummary(set: Record<string, unknown>): Record<string, unknown> {
  return {
    trainingMenuSetId: set.trainingMenuSetId,
    setName: set.setName ?? "",
    setType: set.setType === "temporary" ? "temporary" : "reusable",
    source: set.source === "ai" ? "ai" : "manual",
    menuSetKind: set.menuSetKind === "recovery" ? "recovery" : "training",
    validFromDate: set.validFromDate ?? set.scheduledDate ?? null,
    validToDate: set.validToDate ?? set.scheduledDate ?? null,
    version: menuSetVersion(set.version),
    isActive: set.isActive !== false,
    updatedAt: set.updatedAt ?? null
  };
}

async function hydrateTrainingMenuSet(
  userId: string,
  set: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const trainingMenuSetId = String(set.trainingMenuSetId ?? "");
  const links = await listTrainingMenuSetLinks(userId, trainingMenuSetId);
  const menuItems = await getTrainingMenuItemsById(
    userId,
    links.map((item) => String(item.trainingMenuItemId ?? ""))
  );
  return {
    ...temporaryMenuSetSummary(set),
    items: links.map((link) => {
      const menu = menuItems.get(String(link.trainingMenuItemId ?? ""));
      if (set.menuSetKind === "recovery" || menu?.itemKind === "recovery") {
        return {
          trainingMenuSetItemId: link.trainingMenuSetItemId,
          trainingMenuItemId: link.trainingMenuItemId,
          trainingName: menu?.trainingName ?? null,
          itemKind: "recovery",
          standardDurationMinutes: menu?.standardDurationMinutes ?? null,
          description: menu?.description ?? "",
          displayOrder: link.displayOrder,
          targetDurationMinutes: link.targetDurationMinutes ?? null,
          instruction: link.instruction ?? ""
        };
      }
      return {
        trainingMenuSetItemId: link.trainingMenuSetItemId,
        trainingMenuItemId: link.trainingMenuItemId,
        trainingName: menu?.trainingName ?? null,
        itemKind: "training",
        exerciseFamilyId: menu?.exerciseFamilyId ?? null,
        muscleTargets: normalizeMuscleTargets(menu?.muscleTargets) ?? [],
        movementFamily: normalizeMovementFamily(menu?.movementFamily),
        jointActions: normalizeJointActions(menu?.jointActions) ?? [],
        laterality: normalizeLaterality(menu?.laterality),
        loadModel: normalizeLoadModel(menu?.loadModel),
        classificationVersion: menu?.classificationVersion ?? MUSCLE_TAXONOMY_VERSION,
        equipmentType: normalizeEquipmentType(menu?.equipmentType) ?? "other",
        equipmentProfileId: menu?.equipmentProfileId ?? null,
        cableSettings: menu?.cableSettings ?? null,
        description: menu?.description ?? "",
        weightInputMode: menu?.weightInputMode ?? "legacyUnspecified",
        loadMultiplier: menu?.loadMultiplier ?? null,
        fixedWeightKg:
          menu?.weightInputMode === "legacyUnspecified" ? null : menu?.fixedWeightKg ?? 0,
        displayOrder: link.displayOrder,
        targetWeightKg: link.targetWeightKg,
        targetRepsMin: link.targetRepsMin,
        targetRepsMax: link.targetRepsMax,
        targetSets: link.targetSets,
        recommendedIntervalDays: link.recommendedIntervalDays,
        instruction: link.instruction ?? ""
      };
    })
  };
}

export async function getTrainingPlanForDate(args: ToolArgs, userId: string): Promise<McpToolResponse> {
  const date = parseYmd(args.date);
  if (!date) {
    return mcpToolResponse(400, {
      code: "VALIDATION_ERROR",
      message: "date is required in YYYY-MM-DD format."
    });
  }
  if (args.timeZoneId !== undefined && !resolveTimeZoneId(args)) {
    return mcpToolResponse(400, {
      code: "VALIDATION_ERROR",
      message: "timeZoneId must be a valid IANA time zone ID."
    });
  }
  const planResult = await ddb.send(
    new GetCommand({
      TableName: dailyTrainingPlanTableName,
      Key: { userId, planDate: date }
    })
  );
  const plan = planResult.Item as Record<string, unknown> | undefined;
  if (!plan) {
    return mcpToolResponse(200, {
      tool: "get_training_plan_for_date",
      date,
      plan: null
    });
  }
  if (typeof plan.trainingMenuSetId !== "string") {
    return mcpToolResponse(200, {
      tool: "get_training_plan_for_date",
      date,
      plan: null
    });
  }
  const set = await getTrainingMenuSetRecord(userId, plan.trainingMenuSetId);
  if (!set || set.isActive === false) {
    return mcpToolResponse(200, {
      tool: "get_training_plan_for_date",
      date,
      plan: null
    });
  }
  return mcpToolResponse(200, {
    tool: "get_training_plan_for_date",
    date,
    plan: {
      planDate: date,
      menuSetKind: set.menuSetKind === "recovery" ? "recovery" : "training",
      planSource: plan.source === "ai" ? "ai" : "manual",
      assignedAt: plan.createdAt ?? null,
      assignmentUpdatedAt: plan.updatedAt ?? null,
      ...(await hydrateTrainingMenuSet(userId, set))
    }
  });
}

async function listAllMenuSetsAndLinksForUser(userId: string): Promise<{
  sets: Record<string, unknown>[];
  links: Record<string, unknown>[];
}> {
  const queryAll = async (
    tableName: string,
    indexName: string
  ): Promise<Record<string, unknown>[]> => {
    const items: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await ddb.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: indexName,
          KeyConditionExpression: "userId = :userId",
          ExpressionAttributeValues: { ":userId": userId },
          ExclusiveStartKey: exclusiveStartKey
        })
      );
      items.push(...((result.Items ?? []) as Record<string, unknown>[]));
      exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (exclusiveStartKey);
    return items;
  };
  const [sets, links] = await Promise.all([
    queryAll(trainingMenuSetTableName, menuSetByOrderIndex),
    queryAll(trainingMenuSetItemTableName, setItemsBySetOrderIndex)
  ]);
  return { sets, links };
}

async function getUserTimeZoneIdForMcp(userId: string): Promise<string> {
  const result = await ddb.send(
    new GetCommand({
      TableName: userProfileTableName,
      Key: { userId }
    })
  );
  return resolveTimeZoneId({ timeZoneId: result.Item?.timeZoneId }) ?? "Asia/Tokyo";
}

export function normalizeTrainingMenuItemForMcp(
  item: Record<string, unknown>,
  impact: {
    usageCount: number;
    activeMenuSetIds: string[];
    assignedPlanDates: string[];
    hasFutureAssignments: boolean;
  }
): Record<string, unknown> {
  if (item.itemKind === "recovery") {
    return {
      trainingMenuItemId: item.trainingMenuItemId,
      trainingName: item.trainingName,
      itemKind: "recovery",
      standardDurationMinutes: item.standardDurationMinutes ?? null,
      description: item.description ?? "",
      isSystemProvided: item.isSystemProvided === true,
      isAiGenerated: item.isAiGenerated === true,
      isActive: item.isActive !== false,
      version: trainingMenuItemVersion(item.version),
      updatedAt: item.updatedAt ?? null,
      usageCount: impact.usageCount,
      activeMenuSetCount: impact.activeMenuSetIds.length,
      activeMenuSetIds: impact.activeMenuSetIds,
      assignedPlanDateCount: impact.assignedPlanDates.length,
      assignedPlanDates: impact.assignedPlanDates.slice(0, 31),
      hasFutureAssignments: impact.hasFutureAssignments
    };
  }
  const weightInputMode =
    item.weightInputMode === "direct" || item.weightInputMode === "perSide"
      ? item.weightInputMode
      : "legacyUnspecified";
  return {
    trainingMenuItemId: item.trainingMenuItemId,
    trainingName: item.trainingName,
    itemKind: "training",
    exerciseFamilyId: item.exerciseFamilyId,
    muscleTargets: normalizeMuscleTargets(item.muscleTargets) ?? [],
    movementFamily: normalizeMovementFamily(item.movementFamily),
    jointActions: normalizeJointActions(item.jointActions) ?? [],
    laterality: normalizeLaterality(item.laterality),
    loadModel: normalizeLoadModel(item.loadModel),
    classificationVersion: item.classificationVersion ?? MUSCLE_TAXONOMY_VERSION,
    equipmentType: normalizeEquipmentType(item.equipmentType) ?? "other",
    equipmentProfileId: item.equipmentProfileId ?? null,
    cableSettings: item.cableSettings ?? null,
    description: item.description ?? "",
    weightInputMode,
    loadMultiplier: weightInputMode === "perSide" ? 2 : 1,
    fixedWeightKg:
      weightInputMode === "legacyUnspecified" ? null : item.fixedWeightKg ?? 0,
    isAiGenerated: item.isAiGenerated === true,
    isActive: item.isActive !== false,
    version: trainingMenuItemVersion(item.version),
    updatedAt: item.updatedAt ?? null,
    updatedBy: item.updatedBy ?? null,
    updateReason: item.updateReason ?? null,
    usageCount: impact.usageCount,
    activeMenuSetCount: impact.activeMenuSetIds.length,
    activeMenuSetIds: impact.activeMenuSetIds,
    assignedPlanDateCount: impact.assignedPlanDates.length,
    assignedPlanDates: impact.assignedPlanDates.slice(0, 31),
    hasFutureAssignments: impact.hasFutureAssignments
  };
}

async function listTrainingMenuItemsForAi(args: ToolArgs, userId: string): Promise<McpToolResponse> {
  await ensureCompleteRestItemForMcp(userId);
  const normalizeSearchText = (value: string): string =>
    value.trim().toLowerCase().replace(/\s+/g, " ");
  const query =
    args.query === undefined
      ? ""
      : toNonEmptyString(args.query)
        ? normalizeSearchText(String(args.query))
        : undefined;
  if (
    (args.query !== undefined && (!query || query.length > 100)) ||
    (args.includeInactive !== undefined && typeof args.includeInactive !== "boolean") ||
    (args.onlyAiGenerated !== undefined && typeof args.onlyAiGenerated !== "boolean")
  ) {
    return mutationValidationError("query and filter arguments are invalid.");
  }
  const includeInactive = args.includeInactive === true;
  const onlyAiGenerated = args.onlyAiGenerated === true;
  const limit = args.limit === undefined ? 100 : args.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    return mutationValidationError("limit must be an integer between 1 and 100.");
  }
  const nextTokenContext = JSON.stringify([
    "list_training_menu_items_v3",
    query ?? "",
    includeInactive,
    onlyAiGenerated
  ]);
  let exclusiveStartKey = await decodeNextToken(args.nextToken, nextTokenContext, userId);
  if (exclusiveStartKey === null) {
    return mutationValidationError("nextToken is invalid for these search conditions.");
  }
  const matched: Record<string, unknown>[] = [];
  let nextKey: Record<string, unknown> | undefined;
  while (matched.length < limit) {
    const result = await ddb.send(
      new QueryCommand({
        TableName: trainingMenuTableName,
        IndexName: trainingMenuByOrderIndex,
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: { ":userId": userId },
        Limit: Math.max(limit, 50),
        ExclusiveStartKey: exclusiveStartKey
      })
    );
    const pageItems = (result.Items ?? []) as Record<string, unknown>[];
    for (let index = 0; index < pageItems.length; index += 1) {
      const item = pageItems[index];
      const searchable = normalizeSearchText(
        `${String(item.trainingName ?? "")} ${String(item.description ?? "")}`
      );
      const matches =
        (includeInactive || item.isActive !== false) &&
        (!onlyAiGenerated || item.isAiGenerated === true) &&
        (!query || searchable.includes(query));
      if (matches) {
        matched.push(item);
      }
      if (matched.length === limit) {
        const hasMoreItems =
          index < pageItems.length - 1 || Boolean(result.LastEvaluatedKey);
        nextKey = hasMoreItems
          ? {
              userId: item.userId,
              trainingMenuItemId: item.trainingMenuItemId,
              displayOrder: item.displayOrder
            }
          : undefined;
        break;
      }
    }
    if (matched.length === limit) {
      break;
    }
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (!exclusiveStartKey) {
      nextKey = undefined;
      break;
    }
  }

  const [{ sets, links }, plans, timeZoneId] = await Promise.all([
    listAllMenuSetsAndLinksForUser(userId),
    listAllDailyPlansForUser(userId),
    getUserTimeZoneIdForMcp(userId)
  ]);
  const activeSetIds = new Set(
    sets
      .filter((set) => set.isActive !== false)
      .map((set) => String(set.trainingMenuSetId ?? ""))
      .filter(Boolean)
  );
  const setIdsByMenuItemId = new Map<string, Set<string>>();
  for (const link of links) {
    const trainingMenuItemId = String(link.trainingMenuItemId ?? "");
    const trainingMenuSetId = String(link.trainingMenuSetId ?? "");
    if (!trainingMenuItemId || !activeSetIds.has(trainingMenuSetId)) {
      continue;
    }
    const setIds = setIdsByMenuItemId.get(trainingMenuItemId) ?? new Set<string>();
    setIds.add(trainingMenuSetId);
    setIdsByMenuItemId.set(trainingMenuItemId, setIds);
  }
  const today = nowYmdInTimeZone(timeZoneId);
  const normalizedItems = matched.map((item) => {
    const trainingMenuItemId = String(item.trainingMenuItemId ?? "");
    const itemSetIds = setIdsByMenuItemId.get(trainingMenuItemId) ?? new Set<string>();
    const assignedPlanDates = plans
      .filter(
        (plan) =>
          itemSetIds.has(String(plan.trainingMenuSetId ?? ""))
      )
      .map((plan) => String(plan.planDate ?? ""))
      .filter(Boolean)
      .sort();
    return normalizeTrainingMenuItemForMcp(item, {
      usageCount: links.filter(
        (link) =>
          link.trainingMenuItemId === trainingMenuItemId &&
          activeSetIds.has(String(link.trainingMenuSetId ?? ""))
      ).length,
      activeMenuSetIds: Array.from(itemSetIds),
      assignedPlanDates,
      hasFutureAssignments: assignedPlanDates.some((date) => date >= today)
    });
  });
  return mcpToolResponse(200, {
    tool: "list_training_menu_items",
    items: normalizedItems,
    limit,
    nextToken: (await encodeNextToken(nextKey, nextTokenContext, userId)) ?? null
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
    items: (sets.Items ?? []).filter((set) => set.isActive !== false).map((set) => ({
      trainingMenuSetId: set.trainingMenuSetId,
      setName: set.setName,
      setType: set.setType ?? "reusable",
      source: set.source ?? "manual",
      menuSetKind: set.menuSetKind === "recovery" ? "recovery" : "training",
      validFromDate: set.validFromDate ?? set.scheduledDate,
      validToDate: set.validToDate ?? set.scheduledDate,
      version: menuSetVersion(set.version),
      isDefault: set.isDefault === true,
      items: (links.Items ?? [])
        .filter((item) => item.trainingMenuSetId === set.trainingMenuSetId)
        .map((item) => ({
          trainingMenuSetItemId: item.trainingMenuSetItemId,
          trainingMenuItemId: item.trainingMenuItemId,
          displayOrder: item.displayOrder,
          itemKind: item.itemKind === "recovery" ? "recovery" : (set.menuSetKind === "recovery" ? "recovery" : "training"),
          targetDurationMinutes: item.targetDurationMinutes ?? null,
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

async function getTrainingMenuItemRecord(
  userId: string,
  trainingMenuItemId: string
): Promise<Record<string, unknown> | undefined> {
  const result = await ddb.send(
    new GetCommand({
      TableName: trainingMenuTableName,
      Key: { userId, trainingMenuItemId }
    })
  );
  return result.Item as Record<string, unknown> | undefined;
}

async function trainingMenuItemImpact(
  userId: string,
  trainingMenuItemId: string
): Promise<Record<string, unknown>> {
  const links: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const linksResult = await ddb.send(
      new QueryCommand({
        TableName: trainingMenuSetItemTableName,
        IndexName: setItemsByMenuItemIndex,
        KeyConditionExpression: "userId = :userId AND trainingMenuItemId = :trainingMenuItemId",
        ExpressionAttributeValues: {
          ":userId": userId,
          ":trainingMenuItemId": trainingMenuItemId
        },
        ExclusiveStartKey: exclusiveStartKey
      })
    );
    links.push(...((linksResult.Items ?? []) as Record<string, unknown>[]));
    exclusiveStartKey = linksResult.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  const setIds = Array.from(
    new Set(links.map((link) => String(link.trainingMenuSetId ?? "")).filter(Boolean))
  );
  const [sets, plans, timeZoneId] = await Promise.all([
    Promise.all(setIds.map((setId) => getTrainingMenuSetRecord(userId, setId))),
    listAllDailyPlansForUser(userId),
    getUserTimeZoneIdForMcp(userId)
  ]);
  const activeSets = sets
    .filter(
      (set): set is Record<string, unknown> =>
        Boolean(set) && set!.isActive !== false
    )
    .map((set) => temporaryMenuSetSummary(set));
  const activeSetIds = new Set(
    activeSets.map((set) => String(set.trainingMenuSetId ?? "")).filter(Boolean)
  );
  const assignedPlanDates = plans
    .filter(
      (plan) =>
        activeSetIds.has(String(plan.trainingMenuSetId ?? ""))
    )
    .map((plan) => String(plan.planDate ?? ""))
    .filter(Boolean)
    .sort();
  const today = nowYmdInTimeZone(timeZoneId);
  return {
    activeMenuSetCount: activeSets.length,
    activeMenuSets: activeSets,
    assignedPlanDateCount: assignedPlanDates.length,
    assignedPlanDates: assignedPlanDates.slice(0, 31),
    hasFutureAssignments: assignedPlanDates.some((date) => date >= today),
    historyRecordsPreserved: true
  };
}

function trainingMenuItemEditableSnapshot(item: Record<string, unknown>): Record<string, unknown> {
  const weightInputMode =
    item.weightInputMode === "direct" ||
    item.weightInputMode === "perSide" ||
    item.weightInputMode === "legacyUnspecified"
      ? item.weightInputMode
      : "legacyUnspecified";
  return {
    trainingName: item.trainingName ?? "",
    exerciseFamilyId: item.exerciseFamilyId ?? "",
    muscleTargets: normalizeMuscleTargets(item.muscleTargets) ?? [],
    movementFamily: normalizeMovementFamily(item.movementFamily),
    jointActions: normalizeJointActions(item.jointActions) ?? [],
    laterality: normalizeLaterality(item.laterality),
    loadModel: normalizeLoadModel(item.loadModel),
    equipmentType: normalizeEquipmentType(item.equipmentType) ?? "other",
    equipmentProfileId: item.equipmentProfileId ?? "",
    cableSettings: item.cableSettings ?? null,
    description: item.description ?? "",
    weightInputMode,
    loadMultiplier: weightInputMode === "perSide" ? 2 : 1,
    fixedWeightKg:
      weightInputMode === "legacyUnspecified"
        ? null
        : weightInputMode === "perSide"
          ? item.fixedWeightKg ?? 0
          : 0
  };
}

async function normalizeTrainingMenuItemUpdate(
  args: ToolArgs,
  current: Record<string, unknown>,
  userId: string,
  trainingMenuItemId: string
): Promise<{ value?: Record<string, unknown>; error?: string }> {
  const currentSnapshot = trainingMenuItemEditableSnapshot(current);
  const trainingName =
    args.trainingName === undefined
      ? String(currentSnapshot.trainingName)
      : toNonEmptyString(args.trainingName);
  if (!trainingName || trainingName.length > 100) {
    return { error: "trainingName is invalid." };
  }
  const normalizedTrainingName = normalizeTrainingName(trainingName);
  if (normalizedTrainingName !== current.normalizedTrainingName) {
    const duplicate = await ddb.send(
      new QueryCommand({
        TableName: trainingMenuTableName,
        IndexName: trainingNameIndex,
        KeyConditionExpression:
          "userId = :userId AND normalizedTrainingName = :normalizedTrainingName",
        ExpressionAttributeValues: {
          ":userId": userId,
          ":normalizedTrainingName": normalizedTrainingName
        },
        Limit: 1
      })
    );
    const duplicateId = duplicate.Items?.[0]?.trainingMenuItemId;
    if (duplicateId && duplicateId !== trainingMenuItemId) {
      return { error: "trainingName already exists." };
    }
  }
  const exerciseFamilyId =
    args.exerciseFamilyId === undefined
      ? String(currentSnapshot.exerciseFamilyId)
      : toNonEmptyString(args.exerciseFamilyId);
  const muscleTargets =
    args.muscleTargets === undefined
      ? currentSnapshot.muscleTargets
      : normalizeMuscleTargets(args.muscleTargets);
  const movementFamily =
    args.movementFamily === undefined
      ? currentSnapshot.movementFamily
      : normalizeMovementFamily(args.movementFamily);
  const jointActions =
    args.jointActions === undefined
      ? currentSnapshot.jointActions
      : normalizeJointActions(args.jointActions);
  const laterality =
    args.laterality === undefined
      ? currentSnapshot.laterality
      : normalizeLaterality(args.laterality);
  const loadModel =
    args.loadModel === undefined
      ? currentSnapshot.loadModel
      : normalizeLoadModel(args.loadModel);
  const equipmentType =
    args.equipmentType === undefined
      ? currentSnapshot.equipmentType
      : normalizeEquipmentType(args.equipmentType);
  const description =
    args.description === undefined
      ? String(currentSnapshot.description)
      : normalizeDescription(args.description);
  const equipmentProfileId =
    args.equipmentProfileId === undefined
      ? String(currentSnapshot.equipmentProfileId)
      : typeof args.equipmentProfileId === "string"
        ? args.equipmentProfileId.trim()
        : undefined;
  const weightInputMode =
    args.weightInputMode === undefined
      ? currentSnapshot.weightInputMode
      : args.weightInputMode === "direct" || args.weightInputMode === "perSide"
        ? args.weightInputMode
        : undefined;
  const fixedWeightKg =
    weightInputMode === "direct"
      ? 0
      : weightInputMode === "legacyUnspecified"
        ? 0
        : normalizeNonNegativeDecimal(
            args.fixedWeightKg === undefined ? currentSnapshot.fixedWeightKg : args.fixedWeightKg
          );
  const cableSettings =
    equipmentType === "cable_machine"
      ? normalizeCableSettingsForMcp(
          args.cableSettings === undefined ? currentSnapshot.cableSettings : args.cableSettings
        ) ??
        (args.cableSettings === undefined
          ? {
              pulleyPosition: "adjustable",
              attachmentType: "other",
              cableSides: "single"
            }
          : undefined)
      : null;
  if (
    !exerciseFamilyId ||
    exerciseFamilyId.length > 80 ||
    !muscleTargets ||
    !movementFamily ||
    !jointActions ||
    !laterality ||
    !loadModel ||
    !equipmentType ||
    description === undefined ||
    equipmentProfileId === undefined ||
    equipmentProfileId.length > 80 ||
    !weightInputMode ||
    fixedWeightKg === undefined ||
    (equipmentType === "cable_machine" && !cableSettings)
  ) {
    return { error: "one or more exercise master fields are invalid." };
  }
  return {
    value: {
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
      equipmentProfileId,
      cableSettings,
      description,
      weightInputMode,
      loadMultiplier: weightInputMode === "perSide" ? 2 : 1,
      fixedWeightKg
    }
  };
}

function trainingMenuItemMutationReplay(
  item: Record<string, unknown>,
  idempotencyKey: string,
  requestHash: string,
  tool: string
): McpToolResponse | undefined {
  if (item.lastMutationKey !== idempotencyKey) {
    return undefined;
  }
  if (item.lastMutationHash !== requestHash) {
    return mcpToolResponse(409, {
      code: "IDEMPOTENCY_KEY_REUSED",
      message: "idempotencyKey was already used for a different request."
    });
  }
  return mcpToolResponse(200, {
    tool,
    trainingMenuItemId: item.trainingMenuItemId,
    version: trainingMenuItemVersion(item.version),
    changes: item.lastMutationChanges ?? {},
    idempotentReplay: true
  });
}

export async function updateTrainingMenuItemFromMcp(
  args: ToolArgs,
  userId: string
): Promise<McpToolResponse> {
  const trainingMenuItemId = parseBoundedText(args.trainingMenuItemId, 100);
  const expectedVersion = parseExpectedVersion(args.expectedVersion);
  const idempotencyKey = parseBoundedText(args.idempotencyKey, 100);
  const updateReason =
    parseBoundedText(args.updateReason, 500, true) ?? "Exercise master updated through MCP";
  const dryRun = parseDryRun(args.dryRun);
  const editableFields = [
    "trainingName",
    "exerciseFamilyId",
    "muscleTargets",
    "movementFamily",
    "jointActions",
    "laterality",
    "loadModel",
    "equipmentType",
    "equipmentProfileId",
    "cableSettings",
    "description",
    "weightInputMode",
    "fixedWeightKg"
  ];
  if (
    !trainingMenuItemId ||
    expectedVersion === undefined ||
    !idempotencyKey ||
    dryRun === undefined ||
    (args.updateReason !== undefined && !parseBoundedText(args.updateReason, 500)) ||
    !editableFields.some((field) => args[field] !== undefined)
  ) {
    return mutationValidationError(
      "trainingMenuItemId, expectedVersion, idempotencyKey, and at least one valid update field are required."
    );
  }
  const current = await getTrainingMenuItemRecord(userId, trainingMenuItemId);
  if (!current || current.isActive === false) {
    return mcpToolResponse(404, {
      code: "NOT_FOUND",
      message: "The active training menu item was not found."
    });
  }
  const normalized = await normalizeTrainingMenuItemUpdate(
    args,
    current,
    userId,
    trainingMenuItemId
  );
  if (!normalized.value) {
    return mutationValidationError(normalized.error ?? "Exercise master update is invalid.");
  }
  const before = trainingMenuItemEditableSnapshot(current);
  const after = trainingMenuItemEditableSnapshot({ ...current, ...normalized.value });
  const changes = Object.fromEntries(
    Object.keys(after)
      .filter(
        (field) =>
          JSON.stringify(stableJsonValue(before[field])) !==
          JSON.stringify(stableJsonValue(after[field]))
      )
      .map((field) => [field, { before: before[field], after: after[field] }])
  );
  if (Object.keys(changes).length === 0) {
    return mutationValidationError("The requested update does not change the exercise master.");
  }
  const requestHash = mutationRequestHash({
    tool: "update_training_menu_item",
    trainingMenuItemId,
    expectedVersion,
    changes,
    updateReason
  });
  const replay = trainingMenuItemMutationReplay(
    current,
    idempotencyKey,
    requestHash,
    "update_training_menu_item"
  );
  if (replay) {
    return replay;
  }
  if (trainingMenuItemVersion(current.version) !== expectedVersion) {
    return mcpToolResponse(409, {
      code: "VERSION_CONFLICT",
      message: "The exercise master was updated after it was read.",
      currentVersion: trainingMenuItemVersion(current.version)
    });
  }
  const impact = await trainingMenuItemImpact(userId, trainingMenuItemId);
  if (dryRun) {
    return mcpToolResponse(200, {
      tool: "update_training_menu_item",
      dryRun: true,
      trainingMenuItemId,
      currentVersion: expectedVersion,
      nextVersion: expectedVersion + 1,
      changes,
      impact
    });
  }
  if (args.userConfirmed !== true) {
    return mcpToolResponse(400, {
      code: "USER_CONFIRMATION_REQUIRED",
      message: "Show the dry-run differences and impact, then obtain explicit user approval."
    });
  }
  const condition = versionCondition(expectedVersion);
  const updatedAt = nowIsoSeconds();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: trainingMenuTableName,
        Key: { userId, trainingMenuItemId },
        UpdateExpression:
          "SET trainingName=:trainingName, normalizedTrainingName=:normalizedTrainingName, exerciseFamilyId=:exerciseFamilyId, muscleTargets=:muscleTargets, movementFamily=:movementFamily, jointActions=:jointActions, laterality=:laterality, loadModel=:loadModel, classificationVersion=:classificationVersion, equipmentType=:equipmentType, equipmentProfileId=:equipmentProfileId, cableSettings=:cableSettings, #description=:description, weightInputMode=:weightInputMode, loadMultiplier=:loadMultiplier, fixedWeightKg=:fixedWeightKg, #version=:nextVersion, updatedAt=:updatedAt, updatedBy=:updatedBy, updateReason=:updateReason, lastMutationKey=:lastMutationKey, lastMutationHash=:lastMutationHash, lastMutationChanges=:lastMutationChanges",
        ConditionExpression:
          `${condition.condition} AND (attribute_not_exists(isActive) OR isActive = :true)`,
        ExpressionAttributeNames: {
          "#description": "description",
          "#version": "version"
        },
        ExpressionAttributeValues: {
          ...condition.values,
          ...Object.fromEntries(
            Object.entries(normalized.value).map(([field, value]) => [`:${field}`, value])
          ),
          ":nextVersion": expectedVersion + 1,
          ":updatedAt": updatedAt,
          ":updatedBy": "mcp",
          ":updateReason": updateReason,
          ":lastMutationKey": idempotencyKey,
          ":lastMutationHash": requestHash,
          ":lastMutationChanges": changes,
          ":true": true
        }
      })
    );
  } catch {
    return mcpToolResponse(409, {
      code: "VERSION_CONFLICT",
      message: "The exercise master changed while the update was being applied."
    });
  }
  return mcpToolResponse(200, {
    tool: "update_training_menu_item",
    trainingMenuItemId,
    version: expectedVersion + 1,
    changes,
    impact,
    updatedAt,
    idempotentReplay: false
  });
}

export async function archiveTrainingMenuItemFromMcp(
  args: ToolArgs,
  userId: string
): Promise<McpToolResponse> {
  const trainingMenuItemId = parseBoundedText(args.trainingMenuItemId, 100);
  const expectedVersion = parseExpectedVersion(args.expectedVersion);
  const idempotencyKey = parseBoundedText(args.idempotencyKey, 100);
  const reason = parseBoundedText(args.reason, 500, true) ?? "Archived through MCP";
  const dryRun = parseDryRun(args.dryRun);
  if (
    !trainingMenuItemId ||
    expectedVersion === undefined ||
    !idempotencyKey ||
    dryRun === undefined ||
    (args.reason !== undefined && !parseBoundedText(args.reason, 500))
  ) {
    return mutationValidationError(
      "trainingMenuItemId, expectedVersion, idempotencyKey, and valid optional fields are required."
    );
  }
  const current = await getTrainingMenuItemRecord(userId, trainingMenuItemId);
  if (!current) {
    return mcpToolResponse(404, {
      code: "NOT_FOUND",
      message: "The training menu item was not found."
    });
  }
  const changes = {
    isActive: { before: true, after: false },
    archiveReason: { before: current.archiveReason ?? null, after: reason }
  };
  const requestHash = mutationRequestHash({
    tool: "archive_training_menu_item",
    trainingMenuItemId,
    expectedVersion,
    reason
  });
  const replay = trainingMenuItemMutationReplay(
    current,
    idempotencyKey,
    requestHash,
    "archive_training_menu_item"
  );
  if (replay) {
    return replay;
  }
  if (current.isActive === false) {
    return mcpToolResponse(409, {
      code: "ITEM_ALREADY_ARCHIVED",
      message: "The training menu item is already archived.",
      currentVersion: trainingMenuItemVersion(current.version)
    });
  }
  if (trainingMenuItemVersion(current.version) !== expectedVersion) {
    return mcpToolResponse(409, {
      code: "VERSION_CONFLICT",
      message: "The exercise master was updated after it was read.",
      currentVersion: trainingMenuItemVersion(current.version)
    });
  }
  const impact = await trainingMenuItemImpact(userId, trainingMenuItemId);
  if (dryRun) {
    return mcpToolResponse(200, {
      tool: "archive_training_menu_item",
      dryRun: true,
      trainingMenuItemId,
      currentVersion: expectedVersion,
      nextVersion: expectedVersion + 1,
      changes,
      impact
    });
  }
  if (args.userConfirmed !== true) {
    return mcpToolResponse(400, {
      code: "USER_CONFIRMATION_REQUIRED",
      message: "Show the dry-run impact, then obtain explicit user approval."
    });
  }
  const condition = versionCondition(expectedVersion);
  const archivedAt = nowIsoSeconds();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: trainingMenuTableName,
        Key: { userId, trainingMenuItemId },
        UpdateExpression:
          "SET isActive=:false, #version=:nextVersion, archivedAt=:archivedAt, archivedBy=:archivedBy, archiveReason=:archiveReason, updatedAt=:updatedAt, updatedBy=:updatedBy, updateReason=:updateReason, lastMutationKey=:lastMutationKey, lastMutationHash=:lastMutationHash, lastMutationChanges=:lastMutationChanges",
        ConditionExpression:
          `${condition.condition} AND (attribute_not_exists(isActive) OR isActive = :true)`,
        ExpressionAttributeNames: { "#version": "version" },
        ExpressionAttributeValues: {
          ...condition.values,
          ":false": false,
          ":true": true,
          ":nextVersion": expectedVersion + 1,
          ":archivedAt": archivedAt,
          ":archivedBy": "mcp",
          ":archiveReason": reason,
          ":updatedAt": archivedAt,
          ":updatedBy": "mcp",
          ":updateReason": reason,
          ":lastMutationKey": idempotencyKey,
          ":lastMutationHash": requestHash,
          ":lastMutationChanges": changes
        }
      })
    );
  } catch {
    return mcpToolResponse(409, {
      code: "VERSION_CONFLICT",
      message: "The exercise master changed while it was being archived."
    });
  }
  return mcpToolResponse(200, {
    tool: "archive_training_menu_item",
    trainingMenuItemId,
    version: expectedVersion + 1,
    changes,
    impact,
    archivedAt,
    idempotentReplay: false
  });
}

async function listAllDailyPlansForUser(userId: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: dailyTrainingPlanTableName,
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: { ":userId": userId },
        ExclusiveStartKey: exclusiveStartKey
      })
    );
    items.push(...((result.Items ?? []) as Record<string, unknown>[]));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return items;
}

function mutationValidationError(message: string): McpToolResponse {
  return mcpToolResponse(400, { code: "VALIDATION_ERROR", message });
}

function idempotentMutationReplay(
  set: Record<string, unknown>,
  idempotencyKey: string,
  requestHash: string,
  tool: string
): McpToolResponse | undefined {
  if (set.lastMutationKey !== idempotencyKey) {
    return undefined;
  }
  if (set.lastMutationHash !== requestHash) {
    return mcpToolResponse(409, {
      code: "IDEMPOTENCY_KEY_REUSED",
      message: "idempotencyKey was already used for a different request."
    });
  }
  return mcpToolResponse(200, {
    tool,
    trainingMenuSetId: set.trainingMenuSetId,
    version: menuSetVersion(set.version),
    changes: set.lastMutationChanges ?? {},
    ...(set.cancellationSnapshot ? { cancellationSnapshot: set.cancellationSnapshot } : {}),
    idempotentReplay: true
  });
}

async function dateConflictDetails(
  userId: string,
  conflicts: Record<string, unknown>[]
): Promise<Record<string, unknown>[]> {
  const setIds = Array.from(
    new Set(conflicts.map((plan) => String(plan.trainingMenuSetId ?? "")).filter(Boolean))
  );
  const sets = await Promise.all(setIds.map((setId) => getTrainingMenuSetRecord(userId, setId)));
  const summaries = new Map(
    sets
      .filter((set): set is Record<string, unknown> => Boolean(set))
      .map((set) => [String(set.trainingMenuSetId), temporaryMenuSetSummary(set)])
  );
  return conflicts.map((plan) => ({
    date: plan.planDate,
    trainingMenuSetId: plan.trainingMenuSetId,
    menuSet: summaries.get(String(plan.trainingMenuSetId ?? "")) ?? null
  }));
}

export async function rescheduleTemporaryTrainingPlan(args: ToolArgs, userId: string): Promise<McpToolResponse> {
  const trainingMenuSetId = parseBoundedText(args.trainingMenuSetId, 100);
  const validFromDate = parseYmd(args.newValidFromDate);
  const validToDate = parseYmd(args.newValidToDate);
  const validityDates =
    validFromDate && validToDate ? enumerateYmdRange(validFromDate, validToDate) : undefined;
  const requestedScheduledDates = validityDates ? parseScheduledDates(args.scheduledDates, validityDates) : undefined;
  const expectedVersion = parseExpectedVersion(args.expectedVersion);
  const idempotencyKey = parseBoundedText(args.idempotencyKey, 100);
  const updateReason = parseBoundedText(args.updateReason, 500, true) ?? "Rescheduled by AI";
  const conflictPolicy: TemporaryPlanConflictPolicy =
    args.conflictPolicy === "replace" ? "replace" : "reject";
  if (
    !trainingMenuSetId ||
    !validityDates ||
    !requestedScheduledDates?.length ||
    expectedVersion === undefined ||
    !idempotencyKey ||
    (args.conflictPolicy !== undefined && args.conflictPolicy !== "reject" && args.conflictPolicy !== "replace") ||
    (args.dryRun !== undefined && typeof args.dryRun !== "boolean")
  ) {
    return mutationValidationError(
      "trainingMenuSetId, valid dates within 31 days, expectedVersion, and idempotencyKey are required."
    );
  }
  const dryRun = parseDryRun(args.dryRun) === true;
  const requestHash = mutationRequestHash({
    tool: "reschedule_temporary_training_plan",
    trainingMenuSetId,
    validFromDate,
    validToDate,
    scheduledDates: requestedScheduledDates,
    expectedVersion,
    conflictPolicy,
    updateReason
  });
  const set = await getTrainingMenuSetRecord(userId, trainingMenuSetId);
  if (!set || set.setType !== "temporary") {
    return mcpToolResponse(404, {
      code: "NOT_FOUND",
      message: "The temporary training menu set was not found."
    });
  }
  const replay = idempotentMutationReplay(
    set,
    idempotencyKey,
    requestHash,
    "reschedule_temporary_training_plan"
  );
  if (replay) {
    return replay;
  }
  if (set.isActive === false) {
    return mcpToolResponse(404, {
      code: "NOT_FOUND",
      message: "The temporary training menu set is inactive."
    });
  }
  if (menuSetVersion(set.version) !== expectedVersion) {
    return mcpToolResponse(409, {
      code: "VERSION_CONFLICT",
      message: "The training menu set was updated after it was read.",
      currentVersion: menuSetVersion(set.version),
      current: temporaryMenuSetSummary(set)
    });
  }

  const currentFrom = parseYmd(set.validFromDate ?? set.scheduledDate);
  const currentTo = parseYmd(set.validToDate ?? set.scheduledDate);
  const allCurrentPlans = await listAllDailyPlansForUser(userId);
  const currentDates = allCurrentPlans
    .filter((plan) => plan.trainingMenuSetId === trainingMenuSetId)
    .map((plan) => String(plan.planDate ?? ""))
    .filter(Boolean);
  const planResults = await Promise.all(
    requestedScheduledDates.map((planDate) =>
      ddb.send(new GetCommand({ TableName: dailyTrainingPlanTableName, Key: { userId, planDate } }))
    )
  );
  const conflicts = planResults
    .map((result) => result.Item as Record<string, unknown> | undefined)
    .filter(
      (plan): plan is Record<string, unknown> =>
        plan !== undefined && plan.trainingMenuSetId !== trainingMenuSetId
    );
  const conflictDetails = await dateConflictDetails(userId, conflicts);
  if (conflicts.length && conflictPolicy === "reject") {
    return mcpToolResponse(409, {
      code: "DATE_CONFLICT",
      message: "One or more dates are assigned to another training menu set.",
      conflicts: conflictDetails
    });
  }
  if (conflicts.length && conflictPolicy === "replace" && args.userConfirmed !== true) {
    return mcpToolResponse(409, {
      code: "USER_CONFIRMATION_REQUIRED",
      message: "Show the conflicts to the user and obtain explicit approval before replacement.",
      conflicts: conflictDetails
    });
  }

  const allPlans = conflicts.length ? allCurrentPlans : [];
  const nextDateSet = new Set(requestedScheduledDates);
  const conflictingSetIds = Array.from(
    new Set(conflicts.map((plan) => String(plan.trainingMenuSetId ?? "")).filter(Boolean))
  );
  const partialReplacement = conflictingSetIds.flatMap((setId) => {
    const assignedDates = allPlans
      .filter((plan) => plan.trainingMenuSetId === setId)
      .map((plan) => String(plan.planDate ?? ""));
    return assignedDates.some((date) => !nextDateSet.has(date))
      ? [{ trainingMenuSetId: setId, assignedDates }]
      : [];
  });
  if (partialReplacement.length) {
    return mcpToolResponse(409, {
      code: "DATE_CONFLICT",
      message: "Replacement would only partially displace another menu set. Resolve that set separately.",
      conflicts: conflictDetails,
      partialReplacement
    });
  }
  const conflictingSets = (
    await Promise.all(conflictingSetIds.map((setId) => getTrainingMenuSetRecord(userId, setId)))
  ).filter(
    (value): value is Record<string, unknown> =>
      value !== undefined && value.isActive !== false
  );

  const currentDateSet = new Set(currentDates);
  const removedDates = currentDates.filter((date) => !nextDateSet.has(date));
  const addedDates = requestedScheduledDates.filter((date) => !currentDateSet.has(date));
  const retainedDates = requestedScheduledDates.filter((date) => currentDateSet.has(date));
  const changes = {
    validFromDate: { before: currentFrom ?? null, after: validFromDate },
    validToDate: { before: currentTo ?? null, after: validToDate },
    scheduledDates: { before: currentDates, after: requestedScheduledDates },
    planDates: { added: addedDates, removed: removedDates, retained: retainedDates },
    replacedMenuSetIds: conflictingSetIds
  };
  if (dryRun) {
    return mcpToolResponse(200, {
      tool: "reschedule_temporary_training_plan",
      dryRun: true,
      trainingMenuSetId,
      currentVersion: expectedVersion,
      nextVersion: expectedVersion + 1,
      changes,
      unchanged: [
        "trainingMenuSetId",
        "setName",
        "items",
        "prescriptions",
        "trainingMenuSetItemIds",
        "trainingMenuItemIds"
      ],
      conflicts: conflictDetails
    });
  }

  const ts = nowIsoSeconds();
  const condition = versionCondition(expectedVersion);
  const transactItems: NonNullable<TransactWriteCommandInput["TransactItems"]> = [
    {
      Update: {
        TableName: trainingMenuSetTableName,
        Key: { userId, trainingMenuSetId },
        UpdateExpression:
          "SET validFromDate=:validFromDate, validToDate=:validToDate, #version=:nextVersion, updatedAt=:updatedAt, updatedBy=:updatedBy, updateReason=:updateReason, lastMutationKey=:lastMutationKey, lastMutationHash=:lastMutationHash, lastMutationChanges=:lastMutationChanges REMOVE scheduledDate",
        ConditionExpression: `${condition.condition} AND (attribute_not_exists(isActive) OR isActive = :true) AND setType = :temporary`,
        ExpressionAttributeNames: { "#version": "version" },
        ExpressionAttributeValues: {
          ...condition.values,
          ":validFromDate": validFromDate,
          ":validToDate": validToDate,
          ":nextVersion": expectedVersion + 1,
          ":updatedAt": ts,
          ":updatedBy": "mcp",
          ":updateReason": updateReason,
          ":lastMutationKey": idempotencyKey,
          ":lastMutationHash": requestHash,
          ":lastMutationChanges": changes,
          ":true": true,
          ":temporary": "temporary"
        }
      }
    }
  ];
  for (const conflictSet of conflictingSets) {
    const conflictVersion = menuSetVersion(conflictSet.version);
    const conflictCondition = versionCondition(conflictVersion);
    transactItems.push({
      Update: {
        TableName: trainingMenuSetTableName,
        Key: { userId, trainingMenuSetId: conflictSet.trainingMenuSetId },
        UpdateExpression:
          "SET isActive=:false, #version=:nextVersion, canceledAt=:canceledAt, canceledBy=:canceledBy, cancelReason=:cancelReason, updatedAt=:updatedAt",
        ConditionExpression: `${conflictCondition.condition} AND (attribute_not_exists(isActive) OR isActive = :true)`,
        ExpressionAttributeNames: { "#version": "version" },
        ExpressionAttributeValues: {
          ...conflictCondition.values,
          ":false": false,
          ":true": true,
          ":nextVersion": conflictVersion + 1,
          ":canceledAt": ts,
          ":canceledBy": "mcp",
          ":cancelReason": `Replaced by ${trainingMenuSetId}`,
          ":updatedAt": ts
        }
      }
    });
  }
  for (const planDate of removedDates) {
    transactItems.push({
      Delete: {
        TableName: dailyTrainingPlanTableName,
        Key: { userId, planDate },
        ConditionExpression: "trainingMenuSetId = :trainingMenuSetId",
        ExpressionAttributeValues: { ":trainingMenuSetId": trainingMenuSetId }
      }
    });
  }
  requestedScheduledDates.forEach((planDate, index) => {
    const existing = planResults[index].Item;
    transactItems.push({
      Put: {
        TableName: dailyTrainingPlanTableName,
        Item: {
          userId,
          planDate,
          trainingMenuSetId,
          source: set.source === "ai" ? "ai" : "manual",
          idempotencyKey,
          createdAt: existing?.createdAt ?? ts,
          updatedAt: ts
        },
        ...dailyPlanWriteCondition(existing as Record<string, unknown> | undefined)
      }
    });
  });
  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch {
    return mcpToolResponse(409, {
      code: "VERSION_CONFLICT",
      message: "The plan changed while the reschedule was being applied. No changes were committed."
    });
  }
  return mcpToolResponse(200, {
    tool: "reschedule_temporary_training_plan",
    trainingMenuSetId,
    scheduledDates: requestedScheduledDates,
    version: expectedVersion + 1,
    changes,
    unchanged: [
      "trainingMenuSetId",
      "setName",
      "items",
      "prescriptions",
      "trainingMenuSetItemIds",
      "trainingMenuItemIds"
    ],
    idempotentReplay: false,
    updatedAt: ts
  });
}

export async function cancelTemporaryTrainingPlan(args: ToolArgs, userId: string): Promise<McpToolResponse> {
  const trainingMenuSetId = parseBoundedText(args.trainingMenuSetId, 100);
  const expectedVersion = parseExpectedVersion(args.expectedVersion);
  const idempotencyKey = parseBoundedText(args.idempotencyKey, 100);
  const reason = parseBoundedText(args.reason, 500, true) ?? "Canceled by user request";
  if (
    !trainingMenuSetId ||
    expectedVersion === undefined ||
    !idempotencyKey ||
    (args.dryRun !== undefined && typeof args.dryRun !== "boolean")
  ) {
    return mutationValidationError("trainingMenuSetId, expectedVersion, and idempotencyKey are required.");
  }
  const dryRun = parseDryRun(args.dryRun) === true;
  const requestHash = mutationRequestHash({
    tool: "cancel_temporary_training_plan",
    trainingMenuSetId,
    expectedVersion,
    reason
  });
  const set = await getTrainingMenuSetRecord(userId, trainingMenuSetId);
  if (!set || set.setType !== "temporary") {
    return mcpToolResponse(404, {
      code: "NOT_FOUND",
      message: "The temporary training menu set was not found."
    });
  }
  const replay = idempotentMutationReplay(
    set,
    idempotencyKey,
    requestHash,
    "cancel_temporary_training_plan"
  );
  if (replay) {
    return replay;
  }
  if (set.isActive === false) {
    return mcpToolResponse(409, {
      code: "PLAN_ALREADY_CANCELED",
      message: "The temporary training menu set is already inactive."
    });
  }
  if (menuSetVersion(set.version) !== expectedVersion) {
    return mcpToolResponse(409, {
      code: "VERSION_CONFLICT",
      message: "The training menu set was updated after it was read.",
      currentVersion: menuSetVersion(set.version)
    });
  }
  const plans = (await listAllDailyPlansForUser(userId)).filter(
    (plan) => plan.trainingMenuSetId === trainingMenuSetId
  );
  const cancellationSnapshot = await hydrateTrainingMenuSet(userId, set);
  const changes = {
    isActive: { before: true, after: false },
    canceledPlanDates: plans.map((plan) => plan.planDate),
    reason
  };
  if (dryRun) {
    return mcpToolResponse(200, {
      tool: "cancel_temporary_training_plan",
      dryRun: true,
      trainingMenuSetId,
      currentVersion: expectedVersion,
      nextVersion: expectedVersion + 1,
      changes,
      cancellationSnapshot,
      preserved: ["menuSet", "items", "prescriptions", "trainingMenuItemIds"]
    });
  }
  if (args.userConfirmed !== true) {
    return mcpToolResponse(409, {
      code: "USER_CONFIRMATION_REQUIRED",
      message: "Obtain explicit user approval before canceling the temporary plan.",
      changes
    });
  }
  const ts = nowIsoSeconds();
  const condition = versionCondition(expectedVersion);
  const transactItems: NonNullable<TransactWriteCommandInput["TransactItems"]> = [
    {
      Update: {
        TableName: trainingMenuSetTableName,
        Key: { userId, trainingMenuSetId },
        UpdateExpression:
          "SET isActive=:false, #version=:nextVersion, canceledAt=:canceledAt, canceledBy=:canceledBy, cancelReason=:cancelReason, cancellationSnapshot=:cancellationSnapshot, updatedAt=:updatedAt, updatedBy=:updatedBy, updateReason=:updateReason, lastMutationKey=:lastMutationKey, lastMutationHash=:lastMutationHash, lastMutationChanges=:lastMutationChanges",
        ConditionExpression: `${condition.condition} AND (attribute_not_exists(isActive) OR isActive = :true) AND setType = :temporary`,
        ExpressionAttributeNames: { "#version": "version" },
        ExpressionAttributeValues: {
          ...condition.values,
          ":false": false,
          ":true": true,
          ":temporary": "temporary",
          ":nextVersion": expectedVersion + 1,
          ":canceledAt": ts,
          ":canceledBy": "mcp",
          ":cancelReason": reason,
          ":cancellationSnapshot": cancellationSnapshot,
          ":updatedAt": ts,
          ":updatedBy": "mcp",
          ":updateReason": reason,
          ":lastMutationKey": idempotencyKey,
          ":lastMutationHash": requestHash,
          ":lastMutationChanges": changes
        }
      }
    },
    ...plans.map((plan) => ({
      Delete: {
        TableName: dailyTrainingPlanTableName,
        Key: { userId, planDate: plan.planDate },
        ConditionExpression: "trainingMenuSetId = :trainingMenuSetId",
        ExpressionAttributeValues: { ":trainingMenuSetId": trainingMenuSetId }
      }
    }))
  ];
  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch {
    return mcpToolResponse(409, {
      code: "VERSION_CONFLICT",
      message: "The plan changed while cancellation was being applied. No changes were committed."
    });
  }
  return mcpToolResponse(200, {
    tool: "cancel_temporary_training_plan",
    trainingMenuSetId,
    version: expectedVersion + 1,
    canceledAt: ts,
    changes,
    cancellationSnapshot,
    preserved: ["menuSet", "items", "prescriptions", "trainingMenuItemIds"],
    idempotentReplay: false
  });
}

function normalizeMenuSetPrescription(
  input: MenuSetPrescriptionInput,
  current?: Record<string, unknown>
): Record<string, unknown> | undefined {
  const targetWeightKg =
    input.targetWeightKg === undefined
      ? normalizeNonNegativeDecimal(current?.targetWeightKg)
      : normalizeNonNegativeDecimal(input.targetWeightKg);
  const targetRepsMin =
    input.targetRepsMin === undefined
      ? normalizePositiveInteger(current?.targetRepsMin)
      : normalizePositiveInteger(input.targetRepsMin);
  const targetRepsMax =
    input.targetRepsMax === undefined
      ? normalizePositiveInteger(current?.targetRepsMax)
      : normalizePositiveInteger(input.targetRepsMax);
  const targetSets =
    input.targetSets === undefined
      ? normalizePositiveInteger(current?.targetSets)
      : normalizePositiveInteger(input.targetSets);
  const recommendedIntervalDays =
    input.recommendedIntervalDays === undefined
      ? normalizeFrequency(current?.recommendedIntervalDays)
      : normalizeFrequency(input.recommendedIntervalDays);
  const instruction =
    input.instruction === undefined
      ? normalizeDescription(current?.instruction)
      : normalizeDescription(input.instruction);
  if (
    targetWeightKg === undefined ||
    !targetRepsMin ||
    !targetRepsMax ||
    targetRepsMin > targetRepsMax ||
    !targetSets ||
    !recommendedIntervalDays ||
    instruction === undefined
  ) {
    return undefined;
  }
  return {
    targetWeightKg,
    targetRepsMin,
    targetRepsMax,
    targetSets,
    recommendedIntervalDays,
    instruction
  };
}

function prescriptionSnapshot(item: Record<string, unknown>): Record<string, unknown> {
  return {
    targetWeightKg: item.targetWeightKg,
    targetRepsMin: item.targetRepsMin,
    targetRepsMax: item.targetRepsMax,
    targetSets: item.targetSets,
    recommendedIntervalDays: item.recommendedIntervalDays,
    instruction: item.instruction ?? ""
  };
}

export async function updateTemporaryTrainingMenuSet(args: ToolArgs, userId: string): Promise<McpToolResponse> {
  const trainingMenuSetId = parseBoundedText(args.trainingMenuSetId, 100);
  const expectedVersion = parseExpectedVersion(args.expectedVersion);
  const idempotencyKey = parseBoundedText(args.idempotencyKey, 100);
  const updateReason = parseBoundedText(args.updateReason, 500, true) ?? "Updated by AI";
  const requestedSetName =
    args.setName === undefined ? undefined : parseBoundedText(args.setName, 100);
  const itemUpdates = Array.isArray(args.itemUpdates)
    ? (args.itemUpdates as MenuSetItemUpdateInput[])
    : [];
  const itemAdds = Array.isArray(args.itemAdds) ? (args.itemAdds as MenuSetItemAddInput[]) : [];
  const itemRemovals = Array.isArray(args.itemRemovals) ? args.itemRemovals : [];
  const itemOrder = Array.isArray(args.itemOrder) ? args.itemOrder : undefined;
  const hasDateChange = args.validFromDate !== undefined || args.validToDate !== undefined;
  const hasNonDateChange =
    args.setName !== undefined ||
    itemUpdates.length > 0 ||
    itemAdds.length > 0 ||
    itemRemovals.length > 0 ||
    itemOrder !== undefined;
  if (
    !trainingMenuSetId ||
    expectedVersion === undefined ||
    !idempotencyKey ||
    (args.setName !== undefined && !requestedSetName) ||
    (args.dryRun !== undefined && typeof args.dryRun !== "boolean") ||
    itemUpdates.length > 12 ||
    itemAdds.length > 12 ||
    itemRemovals.length > 12
  ) {
    return mutationValidationError(
      "trainingMenuSetId, expectedVersion, idempotencyKey, and valid bounded update fields are required."
    );
  }
  if (hasDateChange) {
    const from = parseYmd(args.validFromDate);
    const to = parseYmd(args.validToDate);
    if (!from || !to) {
      return mutationValidationError("validFromDate and validToDate must both be valid YYYY-MM-DD dates.");
    }
    if (hasNonDateChange) {
      return mutationValidationError(
        "Date changes cannot be combined with content changes. Use reschedule_temporary_training_plan first."
      );
    }
    const result = await rescheduleTemporaryTrainingPlan(
      {
        ...args,
        newValidFromDate: from,
        newValidToDate: to
      },
      userId
    );
    return result.error
      ? result
      : { ...result, tool: "update_temporary_training_menu_set", delegatedOperation: "reschedule" };
  }
  if (!hasNonDateChange) {
    return mutationValidationError("At least one update field is required.");
  }
  if (
    (args.itemUpdates !== undefined && !Array.isArray(args.itemUpdates)) ||
    (args.itemAdds !== undefined && !Array.isArray(args.itemAdds)) ||
    (args.itemRemovals !== undefined && !Array.isArray(args.itemRemovals)) ||
    (args.itemOrder !== undefined && !Array.isArray(args.itemOrder))
  ) {
    return mutationValidationError("Item mutation fields must be arrays.");
  }
  const dryRun = parseDryRun(args.dryRun) === true;
  if (!dryRun && args.userConfirmed !== true) {
    return mcpToolResponse(400, {
      code: "USER_CONFIRMATION_REQUIRED",
      message: "Run a dry-run, show the differences, and obtain explicit user approval before updating."
    });
  }
  const requestHash = mutationRequestHash({
    tool: "update_temporary_training_menu_set",
    trainingMenuSetId,
    expectedVersion,
    setName: requestedSetName,
    itemUpdates,
    itemAdds,
    itemRemovals,
    itemOrder,
    updateReason
  });
  const set = await getTrainingMenuSetRecord(userId, trainingMenuSetId);
  if (!set || set.setType !== "temporary" || set.isActive === false) {
    return mcpToolResponse(404, {
      code: "NOT_FOUND",
      message: "The active temporary training menu set was not found."
    });
  }
  const replay = idempotentMutationReplay(
    set,
    idempotencyKey,
    requestHash,
    "update_temporary_training_menu_set"
  );
  if (replay) {
    return replay;
  }
  if (menuSetVersion(set.version) !== expectedVersion) {
    return mcpToolResponse(409, {
      code: "VERSION_CONFLICT",
      message: "The training menu set was updated after it was read.",
      currentVersion: menuSetVersion(set.version)
    });
  }

  const currentLinks = await listTrainingMenuSetLinks(userId, trainingMenuSetId);
  const currentById = new Map(
    currentLinks.map((item) => [String(item.trainingMenuSetItemId ?? ""), item])
  );
  const removalIds = itemRemovals.map((value) => toNonEmptyString(value));
  if (
    removalIds.some((value) => !value || !currentById.has(value)) ||
    new Set(removalIds).size !== removalIds.length
  ) {
    return mutationValidationError("itemRemovals contains an unknown or duplicate trainingMenuSetItemId.");
  }
  const updateIds = itemUpdates.map((value) => toNonEmptyString(value.trainingMenuSetItemId));
  if (
    updateIds.some((value) => !value || !currentById.has(value)) ||
    new Set(updateIds).size !== updateIds.length ||
    updateIds.some((value) => removalIds.includes(value))
  ) {
    return mutationValidationError("itemUpdates contains an unknown, duplicate, or removed item.");
  }
  const normalizedUpdates = itemUpdates.map((input, index) => {
    const current = currentById.get(updateIds[index]!)!;
    const prescription = normalizeMenuSetPrescription(input, current);
    return prescription ? { current, prescription } : undefined;
  });
  if (normalizedUpdates.some((value) => !value)) {
    return mutationValidationError("One or more itemUpdates prescriptions are invalid.");
  }
  const existingAddIds = itemAdds
    .map((value) => toNonEmptyString(value.trainingMenuItemId))
    .filter((value): value is string => Boolean(value));
  if (new Set(existingAddIds).size !== existingAddIds.length) {
    return mutationValidationError("itemAdds contains duplicate trainingMenuItemId values.");
  }
  const addMenuItems = await getTrainingMenuItemsById(userId, existingAddIds);
  const startingDisplayOrder = (await getMaxDisplayOrder(userId)) + 1;
  const reservedNames = new Set<string>();
  const normalizedAdds: Array<{
    trainingMenuItemId: string;
    newItem?: Record<string, unknown>;
    prescription: Record<string, unknown>;
  }> = [];
  for (let index = 0; index < itemAdds.length; index += 1) {
    const input = itemAdds[index];
    const trainingMenuItemId = toNonEmptyString(input.trainingMenuItemId);
    const newDefinition = input.newTrainingMenuItem;
    if (Boolean(trainingMenuItemId) === Boolean(newDefinition)) {
      return mutationValidationError(
        `itemAdds[${index}] must specify exactly one trainingMenuItemId or newTrainingMenuItem.`
      );
    }
    const prescription = input.prescription
      ? normalizeMenuSetPrescription(input.prescription)
      : undefined;
    if (!prescription) {
      return mutationValidationError(`itemAdds[${index}].prescription is invalid.`);
    }
    if (trainingMenuItemId) {
      const menu = addMenuItems.get(trainingMenuItemId);
      if (!menu || menu.isActive === false) {
        return mutationValidationError(`itemAdds[${index}].trainingMenuItemId was not found.`);
      }
      normalizedAdds.push({ trainingMenuItemId, prescription });
      continue;
    }
    const normalizedNewItem = await normalizeNewTrainingMenuItemForMcp(
      userId,
      newDefinition!,
      startingDisplayOrder + index,
      reservedNames
    );
    if ("error" in normalizedNewItem) {
      return mutationValidationError(`itemAdds[${index}].${normalizedNewItem.error}`);
    }
    normalizedAdds.push({
      trainingMenuItemId: normalizedNewItem.trainingMenuItemId,
      newItem: normalizedNewItem.item,
      prescription
    });
  }
  const retained = currentLinks.filter(
    (item) => !removalIds.includes(String(item.trainingMenuSetItemId ?? ""))
  );
  const finalTrainingMenuItemIds = [
    ...retained.map((item) => String(item.trainingMenuItemId ?? "")),
    ...normalizedAdds.map((item) => item.trainingMenuItemId)
  ];
  if (
    finalTrainingMenuItemIds.length < 1 ||
    finalTrainingMenuItemIds.length > 12 ||
    new Set(finalTrainingMenuItemIds).size !== finalTrainingMenuItemIds.length
  ) {
    return mutationValidationError("The resulting set must contain 1 to 12 unique training menu items.");
  }
  if (itemOrder && itemAdds.length) {
    return mutationValidationError("itemOrder cannot be combined with itemAdds; add the items first.");
  }
  let orderedRetained = [...retained].sort(
    (left, right) => Number(left.displayOrder ?? 0) - Number(right.displayOrder ?? 0)
  );
  if (itemOrder) {
    const orderIds = itemOrder.map((value) => toNonEmptyString(value));
    const retainedIds = new Set(
      retained.map((item) => String(item.trainingMenuSetItemId ?? ""))
    );
    if (
      orderIds.some((value) => !value || !retainedIds.has(value)) ||
      new Set(orderIds).size !== orderIds.length ||
      orderIds.length !== retained.length
    ) {
      return mutationValidationError("itemOrder must contain every remaining trainingMenuSetItemId exactly once.");
    }
    orderedRetained = orderIds.map((id) => currentById.get(id!)!);
  }

  const normalizedUpdateById = new Map(
    normalizedUpdates.map((value) => [
      String(value!.current.trainingMenuSetItemId),
      value!.prescription
    ])
  );
  const ts = nowIsoSeconds();
  const nextExisting: Record<string, unknown>[] = orderedRetained.map((current, index) => {
    const trainingMenuSetItemId = String(current.trainingMenuSetItemId);
    const prescription = normalizedUpdateById.get(trainingMenuSetItemId) ?? prescriptionSnapshot(current);
    return {
      ...current,
      ...prescription,
      displayOrder: index + 1,
      menuSetOrderKey: buildMenuSetOrderKey(trainingMenuSetId, index + 1),
      updatedAt: ts
    };
  });
  const newLinks: Record<string, unknown>[] = normalizedAdds.map((value, index) => {
    const trainingMenuSetItemId = randomUUID();
    const displayOrder = nextExisting.length + index + 1;
    return {
      userId,
      trainingMenuSetItemId,
      trainingMenuSetId,
      trainingMenuItemId: value.trainingMenuItemId,
      displayOrder,
      menuSetOrderKey: buildMenuSetOrderKey(trainingMenuSetId, displayOrder),
      menuSetItemKey: buildMenuSetItemKey(trainingMenuSetId, value.trainingMenuItemId),
      ...value.prescription,
      createdBy: "ai",
      createdAt: ts,
      updatedAt: ts
    };
  });
  const nextSetName = requestedSetName ?? String(set.setName ?? "");
  const itemChanges = {
    updated: normalizedUpdates.map((value) => ({
      trainingMenuSetItemId: value!.current.trainingMenuSetItemId,
      before: prescriptionSnapshot(value!.current),
      after: value!.prescription
    })),
    added: normalizedAdds.map((value) => ({
      trainingMenuItemId: value.trainingMenuItemId,
      createdTrainingMenuItem: Boolean(value.newItem),
      trainingName: value.newItem?.trainingName ?? addMenuItems.get(value.trainingMenuItemId)?.trainingName ?? null,
      prescription: value.prescription
    })),
    removed: removalIds.map((id) => ({
      trainingMenuSetItemId: id,
      trainingMenuItemId: currentById.get(id!)?.trainingMenuItemId
    })),
    orderBefore: currentLinks.map((item) => item.trainingMenuSetItemId),
    orderAfter: [...nextExisting, ...newLinks].map((item) => item.trainingMenuSetItemId)
  };
  const changes = {
    ...(nextSetName !== set.setName
      ? { setName: { before: set.setName ?? "", after: nextSetName } }
      : {}),
    items: itemChanges
  };
  if (dryRun) {
    return mcpToolResponse(200, {
      tool: "update_temporary_training_menu_set",
      dryRun: true,
      trainingMenuSetId,
      currentVersion: expectedVersion,
      nextVersion: expectedVersion + 1,
      changes,
      unchanged: ["trainingMenuSetId", "validFromDate", "validToDate"]
    });
  }

  const condition = versionCondition(expectedVersion);
  const transactItems: NonNullable<TransactWriteCommandInput["TransactItems"]> = [
    {
      Update: {
        TableName: trainingMenuSetTableName,
        Key: { userId, trainingMenuSetId },
        UpdateExpression:
          "SET setName=:setName, #version=:nextVersion, updatedAt=:updatedAt, updatedBy=:updatedBy, updateReason=:updateReason, lastMutationKey=:lastMutationKey, lastMutationHash=:lastMutationHash, lastMutationChanges=:lastMutationChanges",
        ConditionExpression: `${condition.condition} AND (attribute_not_exists(isActive) OR isActive = :true) AND setType = :temporary`,
        ExpressionAttributeNames: { "#version": "version" },
        ExpressionAttributeValues: {
          ...condition.values,
          ":setName": nextSetName,
          ":nextVersion": expectedVersion + 1,
          ":updatedAt": ts,
          ":updatedBy": "mcp",
          ":updateReason": updateReason,
          ":lastMutationKey": idempotencyKey,
          ":lastMutationHash": requestHash,
          ":lastMutationChanges": changes,
          ":true": true,
          ":temporary": "temporary"
        }
      }
    },
    ...removalIds.map((trainingMenuSetItemId) => ({
      Delete: {
        TableName: trainingMenuSetItemTableName,
        Key: { userId, trainingMenuSetItemId },
        ConditionExpression: "trainingMenuSetId = :trainingMenuSetId",
        ExpressionAttributeValues: { ":trainingMenuSetId": trainingMenuSetId }
      }
    })),
    ...nextExisting
      .filter((next) => {
        const current = currentById.get(String(next.trainingMenuSetItemId))!;
        return JSON.stringify(stableJsonValue(next)) !== JSON.stringify(stableJsonValue({ ...current, updatedAt: ts }));
      })
      .map((item) => {
        const current = currentById.get(String(item.trainingMenuSetItemId))!;
        const hasUpdatedAt = typeof current.updatedAt === "string";
        return {
          Put: {
            TableName: trainingMenuSetItemTableName,
            Item: item,
            ConditionExpression:
              "trainingMenuSetId = :trainingMenuSetId AND " +
              (hasUpdatedAt ? "updatedAt = :expectedUpdatedAt" : "attribute_not_exists(updatedAt)"),
            ExpressionAttributeValues: {
              ":trainingMenuSetId": trainingMenuSetId,
              ...(hasUpdatedAt ? { ":expectedUpdatedAt": current.updatedAt } : {})
            }
          }
        };
      }),
    ...normalizedAdds
      .filter((item) => item.newItem)
      .map((item) => ({
        Put: {
          TableName: trainingMenuTableName,
          Item: { ...item.newItem, createdAt: ts, updatedAt: ts },
          ConditionExpression:
            "attribute_not_exists(userId) AND attribute_not_exists(trainingMenuItemId)"
        }
      })),
    ...newLinks.map((item) => ({
      Put: {
        TableName: trainingMenuSetItemTableName,
        Item: item,
        ConditionExpression:
          "attribute_not_exists(userId) AND attribute_not_exists(trainingMenuSetItemId)"
      }
    }))
  ];
  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch {
    return mcpToolResponse(409, {
      code: "VERSION_CONFLICT",
      message: "The menu set changed while the update was being applied. No changes were committed."
    });
  }
  return mcpToolResponse(200, {
    tool: "update_temporary_training_menu_set",
    trainingMenuSetId,
    version: expectedVersion + 1,
    changes,
    unchanged: ["trainingMenuSetId", "validFromDate", "validToDate"],
    updatedAt: ts,
    idempotentReplay: false
  });
}

async function createTemporaryRecoveryMenuSetFromAi(input: {
  args: ToolArgs;
  userId: string;
  setName: string;
  validFromDate: string;
  validToDate: string;
  scheduledDates: string[];
  idempotencyKey: string;
  rawItems: AiMenuItemInput[];
}): Promise<McpToolResponse> {
  const { args, userId, setName, validFromDate, validToDate, scheduledDates, idempotencyKey, rawItems } = input;
  await ensureCompleteRestItemForMcp(userId);
  if (rawItems.length > 12) return mcpToolResponse(400, { message: "items cannot exceed 12." });
  const currentPlans = await Promise.all(scheduledDates.map((planDate) =>
    ddb.send(new GetCommand({ TableName: dailyTrainingPlanTableName, Key: { userId, planDate } }))
  ));
  const replayPlans = currentPlans.map((result) => result.Item).filter(Boolean) as Record<string, unknown>[];
  if (
    replayPlans.length === scheduledDates.length &&
    replayPlans.every((plan) => plan.idempotencyKey === idempotencyKey) &&
    new Set(replayPlans.map((plan) => plan.trainingMenuSetId)).size === 1
  ) {
    return mcpToolResponse(200, {
      tool: "create_temporary_training_menu_set_from_ai",
      trainingMenuSetId: replayPlans[0].trainingMenuSetId,
      menuSetKind: "recovery",
      validFromDate,
      validToDate,
      scheduledDates,
      idempotentReplay: true
    });
  }
  const conflictingDates = scheduledDates.filter((_, index) => Boolean(currentPlans[index].Item));
  if (conflictingDates.length && args.replaceExistingPlan !== true) {
    return mcpToolResponse(409, { message: "one or more dates already have a menu. ask the user before replacing them.", conflictingDates });
  }

  const normalizedItems: Array<{
    trainingMenuItemId: string;
    newItem?: Record<string, unknown>;
    targetDurationMinutes?: number;
    instruction: string;
  }> = [];
  const newNames = new Set<string>();
  const startingDisplayOrder = (await getMaxDisplayOrder(userId)) + 1;
  for (let index = 0; index < rawItems.length; index += 1) {
    const raw = rawItems[index];
    const existingId = toNonEmptyString(raw.existingTrainingMenuItemId);
    const definition = raw.newTrainingMenuItem;
    if (Boolean(existingId) === Boolean(definition)) {
      return mcpToolResponse(400, { message: `items[${index}] must specify exactly one existing item or new item.` });
    }
    const rawDuration = raw.prescription?.targetDurationMinutes;
    const targetDurationMinutes = rawDuration === undefined ? undefined : normalizePositiveInteger(rawDuration);
    const instruction = normalizeDescription(raw.prescription?.instruction);
    if ((rawDuration !== undefined && (!targetDurationMinutes || targetDurationMinutes > 1440)) || instruction === undefined) {
      return mcpToolResponse(400, { message: `items[${index}].prescription is invalid.` });
    }
    if (existingId) {
      const existing = await ddb.send(new GetCommand({
        TableName: trainingMenuTableName,
        Key: { userId, trainingMenuItemId: existingId }
      }));
      if (!existing.Item || existing.Item.isActive === false || existing.Item.itemKind !== "recovery") {
        return mcpToolResponse(400, { message: `items[${index}].existingTrainingMenuItemId is not an active recovery item.` });
      }
      normalizedItems.push({ trainingMenuItemId: existingId, targetDurationMinutes, instruction });
      continue;
    }
    const trainingName = toNonEmptyString(definition?.trainingName);
    const description = normalizeDescription(definition?.description);
    const normalizedTrainingName = trainingName ? normalizeTrainingName(trainingName) : "";
    const standardDurationMinutes = definition?.standardDurationMinutes === undefined
      ? undefined
      : normalizePositiveInteger(definition.standardDurationMinutes);
    if (!trainingName || description === undefined || (definition?.standardDurationMinutes !== undefined && (!standardDurationMinutes || standardDurationMinutes > 1440))) {
      return mcpToolResponse(400, { message: `items[${index}].newTrainingMenuItem is invalid.` });
    }
    if (newNames.has(normalizedTrainingName) || await existsByTrainingName(userId, normalizedTrainingName)) {
      return mcpToolResponse(409, { message: `items[${index}].newTrainingMenuItem.trainingName already exists.` });
    }
    newNames.add(normalizedTrainingName);
    const trainingMenuItemId = randomUUID();
    normalizedItems.push({
      trainingMenuItemId,
      targetDurationMinutes,
      instruction,
      newItem: {
        userId,
        trainingMenuItemId,
        trainingName,
        normalizedTrainingName,
        itemKind: "recovery",
        ...(standardDurationMinutes ? { standardDurationMinutes } : {}),
        description,
        isAiGenerated: true,
        isSystemProvided: false,
        isActive: true,
        displayOrder: startingDisplayOrder + index,
        version: 1,
        updatedBy: "mcp",
        updateReason: "Created with recovery menu"
      }
    });
  }
  if (new Set(normalizedItems.map((item) => item.trainingMenuItemId)).size !== normalizedItems.length) {
    return mcpToolResponse(409, { message: "the same recovery item cannot appear twice." });
  }

  const trainingMenuSetId = randomUUID();
  const ts = nowIsoSeconds();
  const menuSetOrder = (await getMaxMenuSetOrder(userId)) + 1;
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
          menuSetKind: "recovery",
          source: "ai",
          validFromDate,
          validToDate,
          isDefault: false,
          isActive: true,
          version: 1,
          updatedBy: "mcp",
          updateReason: "Created by AI",
          createdAt: ts,
          updatedAt: ts
        },
        ConditionExpression: "attribute_not_exists(userId) AND attribute_not_exists(trainingMenuSetId)"
      }
    },
    ...normalizedItems.flatMap((item, index) => [
      ...(item.newItem ? [{
        Put: {
          TableName: trainingMenuTableName,
          Item: { ...item.newItem, createdAt: ts, updatedAt: ts },
          ConditionExpression: "attribute_not_exists(userId) AND attribute_not_exists(trainingMenuItemId)"
        }
      }] : []),
      {
        Put: {
          TableName: trainingMenuSetItemTableName,
          Item: {
            userId,
            trainingMenuSetItemId: randomUUID(),
            trainingMenuSetId,
            trainingMenuItemId: item.trainingMenuItemId,
            itemKind: "recovery",
            displayOrder: index + 1,
            menuSetOrderKey: buildMenuSetOrderKey(trainingMenuSetId, index + 1),
            menuSetItemKey: buildMenuSetItemKey(trainingMenuSetId, item.trainingMenuItemId),
            ...(item.targetDurationMinutes ? { targetDurationMinutes: item.targetDurationMinutes } : {}),
            instruction: item.instruction,
            createdBy: "ai",
            createdAt: ts,
            updatedAt: ts
          },
          ConditionExpression: "attribute_not_exists(userId) AND attribute_not_exists(trainingMenuSetItemId)"
        }
      }
    ]),
    ...scheduledDates.map((planDate, index) => ({
      Put: {
        TableName: dailyTrainingPlanTableName,
        Item: {
          userId,
          planDate,
          trainingMenuSetId,
          source: "ai",
          idempotencyKey,
          createdAt: currentPlans[index].Item?.createdAt ?? ts,
          updatedAt: ts
        },
        ...dailyPlanWriteCondition(currentPlans[index].Item as Record<string, unknown> | undefined)
      }
    }))
  ];
  await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  return mcpToolResponse(200, {
    tool: "create_temporary_training_menu_set_from_ai",
    trainingMenuSetId,
    menuSetKind: "recovery",
    validFromDate,
    validToDate,
    scheduledDates,
    setName,
    version: 1,
    reusedItemCount: normalizedItems.filter((item) => !item.newItem).length,
    createdItemCount: normalizedItems.filter((item) => item.newItem).length
  });
}

export async function createTemporaryTrainingMenuSetFromAi(args: ToolArgs, userId: string): Promise<McpToolResponse> {
  const setName = toNonEmptyString(args.setName);
  const menuSetKind = args.menuSetKind === "recovery" ? "recovery" : "training";
  const validFromDate = parseYmd(args.validFromDate);
  const validToDate = parseYmd(args.validToDate);
  const validityDates =
    validFromDate && validToDate ? enumerateYmdRange(validFromDate, validToDate) : undefined;
  const scheduledDates = validityDates ? parseScheduledDates(args.scheduledDates, validityDates) : undefined;
  const idempotencyKey = toNonEmptyString(args.idempotencyKey);
  const rawItems = Array.isArray(args.items) ? (args.items as AiMenuItemInput[]) : null;
  if (!setName || !validityDates || scheduledDates === undefined || !scheduledDates.length || !idempotencyKey || !rawItems?.length) {
    return mcpToolResponse(400, {
      message: "idempotencyKey, validFromDate, validToDate, setName, menuSetKind, non-empty scheduledDates, and items are required; validity is limited to 31 days."
    });
  }
  if (menuSetKind === "recovery") {
    return createTemporaryRecoveryMenuSetFromAi({
      args,
      userId,
      setName,
      validFromDate: validFromDate!,
      validToDate: validToDate!,
      scheduledDates,
      idempotencyKey,
      rawItems
    });
  }
  if (rawItems.length > 12) {
    return mcpToolResponse(400, { message: "items cannot exceed 12." });
  }

  const currentPlans = await Promise.all(
    scheduledDates.map((planDate) =>
      ddb.send(new GetCommand({ TableName: dailyTrainingPlanTableName, Key: { userId, planDate } }))
    )
  );
  const replayPlans = currentPlans
    .map((result) => result.Item)
    .filter((item): item is Record<string, unknown> => Boolean(item));
  const replaySetIds = new Set(replayPlans.map((item) => item.trainingMenuSetId));
  if (
    replayPlans.length === scheduledDates.length &&
    replayPlans.every((item) => item.idempotencyKey === idempotencyKey) &&
    replaySetIds.size === 1
  ) {
    const replayTrainingMenuSetId = String(replayPlans[0].trainingMenuSetId ?? "");
    const replaySet = replayTrainingMenuSetId
      ? await getTrainingMenuSetRecord(userId, replayTrainingMenuSetId)
      : undefined;
    return mcpToolResponse(200, {
      tool: "create_temporary_training_menu_set_from_ai",
      trainingMenuSetId: replayTrainingMenuSetId,
      validFromDate,
      validToDate,
      scheduledDates,
      version: menuSetVersion(replaySet?.version),
      idempotentReplay: true
    });
  }
  const conflictingDates = scheduledDates.filter((_, index) => Boolean(currentPlans[index].Item));
  if (conflictingDates.length && args.replaceExistingPlan !== true) {
    return mcpToolResponse(409, {
      message: "one or more dates already have a temporary menu. ask the user before replacing them.",
      conflictingDates
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
        if (!existing.Item || existing.Item.isActive === false || existing.Item.itemKind === "recovery") {
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
      const equipmentType = normalizeEquipmentType(newDefinition?.equipmentType);
      const exerciseFamilyId = toNonEmptyString(newDefinition?.exerciseFamilyId) ?? trainingName;
      const description = normalizeDescription(newDefinition?.description);
      const muscleTargets = normalizeMuscleTargets(newDefinition?.muscleTargets);
      const movementFamily = normalizeMovementFamily(newDefinition?.movementFamily);
      const jointActions = normalizeJointActions(newDefinition?.jointActions);
      const laterality = normalizeLaterality(newDefinition?.laterality);
      const loadModel = normalizeLoadModel(newDefinition?.loadModel);
      const normalizedTrainingName = trainingName ? normalizeTrainingName(trainingName) : "";
      if (
        !trainingName ||
        !equipmentType ||
        !exerciseFamilyId ||
        description === undefined ||
        !muscleTargets ||
        !movementFamily ||
        !jointActions ||
        !laterality ||
        !loadModel
      ) {
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
          itemKind: "training",
          exerciseFamilyId,
          muscleTargets,
          movementFamily,
          jointActions,
          laterality,
          loadModel,
          classificationVersion: MUSCLE_TAXONOMY_VERSION,
          equipmentType,
          equipmentProfileId: toNonEmptyString(newDefinition?.equipmentProfileId) ?? "",
          cableSettings:
            equipmentType === "cable_machine" &&
            newDefinition?.cableSettings &&
            typeof newDefinition.cableSettings === "object" &&
            !Array.isArray(newDefinition.cableSettings)
              ? newDefinition.cableSettings
              : null,
          description,
          weightInputMode,
          loadMultiplier: weightInputMode === "perSide" ? 2 : 1,
          fixedWeightKg: weightInputMode === "perSide" ? fixedWeightKg : 0,
          isAiGenerated: true,
          isActive: true,
          displayOrder: startingDisplayOrder + index,
          version: 1,
          updatedBy: "mcp",
          updateReason: "Created with temporary menu"
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
          menuSetKind: "training",
          source: "ai",
          validFromDate,
          validToDate,
          isDefault: false,
          isActive: true,
          version: 1,
          updatedBy: "mcp",
          updateReason: "Created by AI",
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
    ...scheduledDates.map((planDate, index) => {
      const currentPlan = currentPlans[index].Item;
      return {
        Put: {
          TableName: dailyTrainingPlanTableName,
          Item: {
            userId,
            planDate,
            trainingMenuSetId,
            source: "ai",
            idempotencyKey,
            createdAt: currentPlan?.createdAt ?? ts,
            updatedAt: ts
          },
          ...dailyPlanWriteCondition(currentPlan as Record<string, unknown> | undefined)
        }
      };
    })
  ];

  await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  return mcpToolResponse(200, {
    tool: "create_temporary_training_menu_set_from_ai",
    trainingMenuSetId,
    validFromDate,
    validToDate,
    scheduledDates,
    setName,
    version: 1,
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
    console.info(JSON.stringify(buildMcpToolInvocationLog(toolName, event, context.awsRequestId)));

    if (toolName === "get_gym_visits") {
      return getGymVisits(event, userId);
    }
    if (toolName === "get_training_history") {
      return getTrainingHistory(event, userId);
    }
    if (toolName === "get_training_coaching_summary") {
      return getTrainingCoachingSummary(event, userId);
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
    if (toolName === "save_daily_meal_notes") {
      return saveDailyMealNotes(event, userId);
    }
    if (toolName === "save_daily_readiness") {
      return saveDailyReadiness(event, userId);
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
    if (toolName === "get_coaching_context") {
      return getCoachingContext(event, userId);
    }
    if (toolName === "update_coaching_context") {
      return updateCoachingContext(event, userId);
    }
    if (toolName === "append_coaching_note") {
      return appendCoachingNote(event, userId);
    }
    if (toolName === "list_training_menu_items") {
      return listTrainingMenuItemsForAi(event, userId);
    }
    if (toolName === "update_training_menu_item") {
      return updateTrainingMenuItemFromMcp(event, userId);
    }
    if (toolName === "archive_training_menu_item") {
      return archiveTrainingMenuItemFromMcp(event, userId);
    }
    if (toolName === "list_training_menu_sets") {
      return listTrainingMenuSetsForAi(userId);
    }
    if (toolName === "get_training_plan_for_date" || toolName === "get_temporary_training_plan") {
      return getTrainingPlanForDate(event, userId);
    }
    if (toolName === "reschedule_temporary_training_plan") {
      return rescheduleTemporaryTrainingPlan(event, userId);
    }
    if (toolName === "cancel_temporary_training_plan") {
      return cancelTemporaryTrainingPlan(event, userId);
    }
    if (toolName === "update_temporary_training_menu_set") {
      return updateTemporaryTrainingMenuSet(event, userId);
    }
    if (toolName === "create_temporary_training_menu_set_from_ai") {
      return createTemporaryTrainingMenuSetFromAi(event, userId);
    }

    return mcpToolResponse(404, { message: `Method not found: ${toolName}` });
  } catch {
    return mcpToolResponse(500, {
      message: "Internal error.",
      requestId: randomUUID()
    });
  }
};

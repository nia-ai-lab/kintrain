import {
  BatchWriteCommand,
  type BatchWriteCommandInput,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand
} from "@aws-sdk/lib-dynamodb";
import { createHash, randomUUID } from "node:crypto";
import { ddb } from "./ddb";

export const coachingContextKey = "CONTEXT";
export const coachingNoteRetentionDays = 90;
export const coachingRevisionRetentionDays = 365;
export const maxActiveCoachingNotes = 50;
export const maxCoachingRevisions = 50;
export const maxReturnedCoachingNotes = 10;

export const coachingSources = ["chatgpt", "claude", "kintrain", "user", "other"] as const;
export const coachingNoteCategories = [
  "observation",
  "decision",
  "follow-up",
  "temporary-constraint"
] as const;

export type CoachingSource = (typeof coachingSources)[number];
export type CoachingNoteCategory = (typeof coachingNoteCategories)[number];

export type CoachingContextSnapshot = {
  goalSummary: string;
  constraints: string[];
  preferences: string[];
  trainingPolicy: string;
  nextReviewDate?: string;
  version: number;
  updatedAt?: string;
  updatedBySource?: CoachingSource;
  changeReason?: string;
};

export type CoachingContextUpdateInput = {
  goalSummary: string;
  constraints: string[];
  preferences: string[];
  trainingPolicy: string;
  nextReviewDate?: string;
  expectedVersion: number;
  source: CoachingSource;
  changeReason: string;
};

export type CoachingNoteInput = {
  idempotencyKey: string;
  category: CoachingNoteCategory;
  content: string;
  validFromDate?: string;
  validToDate?: string;
  source: CoachingSource;
};

export type CoachingNote = {
  noteId: string;
  category: CoachingNoteCategory;
  content: string;
  validFromDate?: string;
  validToDate?: string;
  source: CoachingSource;
  createdAt: string;
  expiresAt: string;
};

export type CoachingRevision = CoachingContextSnapshot & {
  revisionId: string;
  source: CoachingSource;
  changeReason: string;
  createdAt: string;
};

export class CoachingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoachingValidationError";
  }
}

export class CoachingVersionConflictError extends Error {
  currentVersion: number;

  constructor(currentVersion: number) {
    super("The coaching context was updated by another request.");
    this.name = "CoachingVersionConflictError";
    this.currentVersion = currentVersion;
  }
}

export class CoachingNoteLimitError extends Error {
  constructor() {
    super(`Active coaching notes are limited to ${maxActiveCoachingNotes}.`);
    this.name = "CoachingNoteLimitError";
  }
}

function isYmd(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function normalizeRequiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new CoachingValidationError(`${field} is required.`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new CoachingValidationError(`${field} must be ${maxLength} characters or fewer.`);
  }
  return normalized;
}

function normalizeOptionalText(value: unknown, field: string, maxLength: number): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    throw new CoachingValidationError(`${field} must be a string.`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new CoachingValidationError(`${field} must be ${maxLength} characters or fewer.`);
  }
  return normalized;
}

function normalizeTextList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new CoachingValidationError(`${field} must be an array.`);
  }
  if (value.length > 20) {
    throw new CoachingValidationError(`${field} must have 20 items or fewer.`);
  }
  const normalized = value.map((item, index) =>
    normalizeRequiredText(item, `${field}[${index}]`, 300)
  );
  return Array.from(new Set(normalized));
}

function normalizeOptionalDate(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string" || !isYmd(value)) {
    throw new CoachingValidationError(`${field} must be a valid YYYY-MM-DD date.`);
  }
  return value;
}

function normalizeSource(value: unknown): CoachingSource {
  if (typeof value !== "string" || !coachingSources.includes(value as CoachingSource)) {
    throw new CoachingValidationError(`source must be one of: ${coachingSources.join(", ")}.`);
  }
  return value as CoachingSource;
}

export function normalizeCoachingContextUpdate(value: Record<string, unknown>): CoachingContextUpdateInput {
  if (!Number.isInteger(value.expectedVersion) || Number(value.expectedVersion) < 0) {
    throw new CoachingValidationError("expectedVersion must be a non-negative integer.");
  }
  return {
    goalSummary: normalizeOptionalText(value.goalSummary, "goalSummary", 1000),
    constraints: normalizeTextList(value.constraints, "constraints"),
    preferences: normalizeTextList(value.preferences, "preferences"),
    trainingPolicy: normalizeOptionalText(value.trainingPolicy, "trainingPolicy", 2000),
    nextReviewDate: normalizeOptionalDate(value.nextReviewDate, "nextReviewDate"),
    expectedVersion: Number(value.expectedVersion),
    source: normalizeSource(value.source),
    changeReason: normalizeRequiredText(value.changeReason, "changeReason", 500)
  };
}

export function normalizeCoachingNoteInput(value: Record<string, unknown>): CoachingNoteInput {
  const idempotencyKey = normalizeRequiredText(value.idempotencyKey, "idempotencyKey", 100);
  const category = value.category;
  if (
    typeof category !== "string" ||
    !coachingNoteCategories.includes(category as CoachingNoteCategory)
  ) {
    throw new CoachingValidationError(
      `category must be one of: ${coachingNoteCategories.join(", ")}.`
    );
  }
  const validFromDate = normalizeOptionalDate(value.validFromDate, "validFromDate");
  const validToDate = normalizeOptionalDate(value.validToDate, "validToDate");
  if (validFromDate && validToDate && validFromDate > validToDate) {
    throw new CoachingValidationError("validToDate must be on or after validFromDate.");
  }
  return {
    idempotencyKey,
    category: category as CoachingNoteCategory,
    content: normalizeRequiredText(value.content, "content", 1000),
    validFromDate,
    validToDate,
    source: normalizeSource(value.source)
  };
}

function emptyContext(): CoachingContextSnapshot {
  return {
    goalSummary: "",
    constraints: [],
    preferences: [],
    trainingPolicy: "",
    version: 0
  };
}

function normalizeStoredContext(item: Record<string, unknown> | undefined): CoachingContextSnapshot {
  if (!item) {
    return emptyContext();
  }
  return {
    goalSummary: typeof item.goalSummary === "string" ? item.goalSummary : "",
    constraints: Array.isArray(item.constraints)
      ? item.constraints.filter((value): value is string => typeof value === "string")
      : [],
    preferences: Array.isArray(item.preferences)
      ? item.preferences.filter((value): value is string => typeof value === "string")
      : [],
    trainingPolicy: typeof item.trainingPolicy === "string" ? item.trainingPolicy : "",
    ...(typeof item.nextReviewDate === "string" ? { nextReviewDate: item.nextReviewDate } : {}),
    version: typeof item.version === "number" ? item.version : 0,
    ...(typeof item.updatedAt === "string" ? { updatedAt: item.updatedAt } : {}),
    ...(typeof item.updatedBySource === "string" &&
    coachingSources.includes(item.updatedBySource as CoachingSource)
      ? { updatedBySource: item.updatedBySource as CoachingSource }
      : {}),
    ...(typeof item.changeReason === "string" ? { changeReason: item.changeReason } : {})
  };
}

function normalizeStoredNote(item: Record<string, unknown>): CoachingNote | undefined {
  if (
    typeof item.noteId !== "string" ||
    typeof item.content !== "string" ||
    typeof item.category !== "string" ||
    !coachingNoteCategories.includes(item.category as CoachingNoteCategory) ||
    typeof item.source !== "string" ||
    !coachingSources.includes(item.source as CoachingSource) ||
    typeof item.createdAt !== "string" ||
    typeof item.expiresAt !== "string"
  ) {
    return undefined;
  }
  return {
    noteId: item.noteId,
    category: item.category as CoachingNoteCategory,
    content: item.content,
    ...(typeof item.validFromDate === "string" ? { validFromDate: item.validFromDate } : {}),
    ...(typeof item.validToDate === "string" ? { validToDate: item.validToDate } : {}),
    source: item.source as CoachingSource,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt
  };
}

function normalizeStoredRevision(item: Record<string, unknown>): CoachingRevision | undefined {
  if (
    typeof item.revisionId !== "string" ||
    typeof item.source !== "string" ||
    !coachingSources.includes(item.source as CoachingSource) ||
    typeof item.changeReason !== "string" ||
    typeof item.createdAt !== "string"
  ) {
    return undefined;
  }
  return {
    ...normalizeStoredContext(item),
    revisionId: item.revisionId,
    source: item.source as CoachingSource,
    changeReason: item.changeReason,
    createdAt: item.createdAt
  };
}

async function queryByPrefix(
  tableName: string,
  userId: string,
  prefix: string
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "userId = :userId AND begins_with(recordKey, :prefix)",
        ExpressionAttributeValues: {
          ":userId": userId,
          ":prefix": prefix
        },
        ExclusiveStartKey: exclusiveStartKey
      })
    );
    items.push(...(result.Items ?? []));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

export async function getCoachingContextData(
  tableName: string,
  userId: string,
  now = new Date()
): Promise<{
  context: CoachingContextSnapshot;
  notes: CoachingNote[];
  revisions: CoachingRevision[];
}> {
  const nowEpoch = Math.floor(now.getTime() / 1000);
  const [contextResult, noteItems, revisionItems] = await Promise.all([
    ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { userId, recordKey: coachingContextKey }
      })
    ),
    queryByPrefix(tableName, userId, "NOTE#"),
    queryByPrefix(tableName, userId, "REVISION#")
  ]);

  const notes = noteItems
    .filter((item) => typeof item.expiresAtEpoch === "number" && item.expiresAtEpoch > nowEpoch)
    .map(normalizeStoredNote)
    .filter((item): item is CoachingNote => Boolean(item))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const revisions = revisionItems
    .filter((item) => typeof item.expiresAtEpoch === "number" && item.expiresAtEpoch > nowEpoch)
    .map(normalizeStoredRevision)
    .filter((item): item is CoachingRevision => Boolean(item))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, maxCoachingRevisions);

  return {
    context: normalizeStoredContext(contextResult.Item),
    notes,
    revisions
  };
}

async function trimCoachingRevisions(tableName: string, userId: string): Promise<void> {
  const revisions = (await queryByPrefix(tableName, userId, "REVISION#")).sort((a, b) =>
    String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""))
  );
  const stale = revisions.slice(maxCoachingRevisions);
  for (let index = 0; index < stale.length; index += 25) {
    let pending: NonNullable<
      NonNullable<BatchWriteCommandInput["RequestItems"]>[string]
    > = stale.slice(index, index + 25).map((item) => ({
      DeleteRequest: {
        Key: {
          userId,
          recordKey: item.recordKey
        }
      }
    }));
    for (let attempt = 0; pending.length > 0 && attempt < 3; attempt += 1) {
      const result = await ddb.send(
        new BatchWriteCommand({
          RequestItems: {
            [tableName]: pending
          }
        })
      );
      pending = result.UnprocessedItems?.[tableName] ?? [];
    }
  }
}

export async function updateCoachingContextData(
  tableName: string,
  userId: string,
  rawInput: Record<string, unknown>,
  now = new Date()
): Promise<CoachingContextSnapshot> {
  const input = normalizeCoachingContextUpdate(rawInput);
  const currentResult = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { userId, recordKey: coachingContextKey },
      ConsistentRead: true
    })
  );
  const current = normalizeStoredContext(currentResult.Item);
  if (current.version !== input.expectedVersion) {
    throw new CoachingVersionConflictError(current.version);
  }

  const updatedAt = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const version = current.version + 1;
  const createdAt =
    typeof currentResult.Item?.createdAt === "string" ? currentResult.Item.createdAt : updatedAt;
  const next: CoachingContextSnapshot = {
    goalSummary: input.goalSummary,
    constraints: input.constraints,
    preferences: input.preferences,
    trainingPolicy: input.trainingPolicy,
    ...(input.nextReviewDate ? { nextReviewDate: input.nextReviewDate } : {}),
    version,
    updatedAt,
    updatedBySource: input.source,
    changeReason: input.changeReason
  };
  const revisionId = randomUUID();
  const revisionExpiresAtEpoch =
    Math.floor(now.getTime() / 1000) + coachingRevisionRetentionDays * 24 * 60 * 60;
  const commonSnapshot = {
    goalSummary: next.goalSummary,
    constraints: next.constraints,
    preferences: next.preferences,
    trainingPolicy: next.trainingPolicy,
    ...(next.nextReviewDate ? { nextReviewDate: next.nextReviewDate } : {}),
    version,
    updatedAt,
    updatedBySource: input.source,
    changeReason: input.changeReason
  };

  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: {
                userId,
                recordKey: coachingContextKey,
                recordType: "context",
                ...commonSnapshot,
                createdAt
              },
              ConditionExpression:
                input.expectedVersion === 0
                  ? "attribute_not_exists(recordKey)"
                  : "version = :expectedVersion",
              ...(input.expectedVersion === 0
                ? {}
                : { ExpressionAttributeValues: { ":expectedVersion": input.expectedVersion } })
            }
          },
          {
            Put: {
              TableName: tableName,
              Item: {
                userId,
                recordKey: `REVISION#${updatedAt}#${revisionId}`,
                recordType: "revision",
                revisionId,
                ...commonSnapshot,
                source: input.source,
                createdAt: updatedAt,
                expiresAtEpoch: revisionExpiresAtEpoch
              }
            }
          }
        ]
      })
    );
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") {
      const latest = await ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { userId, recordKey: coachingContextKey },
          ConsistentRead: true
        })
      );
      throw new CoachingVersionConflictError(normalizeStoredContext(latest.Item).version);
    }
    throw error;
  }

  await trimCoachingRevisions(tableName, userId);
  return next;
}

export async function appendCoachingNoteData(
  tableName: string,
  userId: string,
  rawInput: Record<string, unknown>,
  now = new Date()
): Promise<{ note: CoachingNote; created: boolean }> {
  const input = normalizeCoachingNoteInput(rawInput);
  const noteId = createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 32);
  const recordKey = `NOTE#${noteId}`;
  const existing = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { userId, recordKey },
      ConsistentRead: true
    })
  );
  const nowEpoch = Math.floor(now.getTime() / 1000);
  const existingNote =
    existing.Item &&
    typeof existing.Item.expiresAtEpoch === "number" &&
    existing.Item.expiresAtEpoch > nowEpoch
      ? normalizeStoredNote(existing.Item)
      : undefined;
  if (existingNote) {
    return { note: existingNote, created: false };
  }
  if (existing.Item) {
    await ddb.send(
      new DeleteCommand({
        TableName: tableName,
        Key: { userId, recordKey }
      })
    );
  }

  const data = await getCoachingContextData(tableName, userId, now);
  if (data.notes.length >= maxActiveCoachingNotes) {
    throw new CoachingNoteLimitError();
  }

  const createdAt = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const expiresAtDate = new Date(now.getTime() + coachingNoteRetentionDays * 24 * 60 * 60 * 1000);
  const expiresAt = expiresAtDate.toISOString().replace(/\.\d{3}Z$/, "Z");
  const note: CoachingNote = {
    noteId,
    category: input.category,
    content: input.content,
    ...(input.validFromDate ? { validFromDate: input.validFromDate } : {}),
    ...(input.validToDate ? { validToDate: input.validToDate } : {}),
    source: input.source,
    createdAt,
    expiresAt
  };

  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          userId,
          recordKey,
          recordType: "note",
          idempotencyKey: input.idempotencyKey,
          ...note,
          expiresAtEpoch: Math.floor(expiresAtDate.getTime() / 1000)
        },
        ConditionExpression: "attribute_not_exists(recordKey)"
      })
    );
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") {
      const duplicate = await ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { userId, recordKey },
          ConsistentRead: true
        })
      );
      const duplicateNote = duplicate.Item ? normalizeStoredNote(duplicate.Item) : undefined;
      if (duplicateNote) {
        return { note: duplicateNote, created: false };
      }
    }
    throw error;
  }

  const afterWrite = await getCoachingContextData(tableName, userId, now);
  if (afterWrite.notes.length > maxActiveCoachingNotes) {
    await ddb.send(
      new DeleteCommand({
        TableName: tableName,
        Key: { userId, recordKey }
      })
    );
    throw new CoachingNoteLimitError();
  }

  return { note, created: true };
}

export async function deleteCoachingNoteData(
  tableName: string,
  userId: string,
  noteId: string
): Promise<void> {
  if (!/^[a-f0-9]{32}$/.test(noteId)) {
    throw new CoachingValidationError("noteId is invalid.");
  }
  await ddb.send(
    new DeleteCommand({
      TableName: tableName,
      Key: {
        userId,
        recordKey: `NOTE#${noteId}`
      }
    })
  );
}

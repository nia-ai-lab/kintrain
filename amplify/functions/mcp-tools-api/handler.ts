import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { ddb } from "../shared/ddb";

const trainingHistoryTableName = process.env.TRAINING_HISTORY_TABLE_NAME ?? "";
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
    };
  };
  client_context?: {
    custom?: {
      bedrockAgentCoreToolName?: string;
    };
  };
};

type ToolArgs = Record<string, unknown>;

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

function toBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function parseYmd(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

function ymdDaysAgo(days: number): string {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const y = date.getUTCFullYear().toString().padStart(4, "0");
  const m = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = date.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${d}`;
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
  return separatorIndex >= 0 ? normalized.slice(separatorIndex + 2) : normalized;
}

function requireConfiguredTables(): string | null {
  if (!trainingHistoryTableName || !dailyRecordTableName || !goalTableName || !aiSettingTableName || !aiAdviceLogTableName) {
    return "MCP lambda environment is not configured.";
  }
  return null;
}

function requireUserId(args: ToolArgs): string | null {
  return toNonEmptyString(args.userId) ?? null;
}

async function getRecentGymVisits(args: ToolArgs, userId: string): Promise<LambdaLikeResponse> {
  const days = toBoundedInt(args.days, 14, 1, 365);
  const limit = toBoundedInt(args.limit, 30, 1, 100);
  const fromDate = ymdDaysAgo(days);
  const toDate = nowIsoSeconds().slice(0, 10);

  const result = await ddb.send(
    new QueryCommand({
      TableName: trainingHistoryTableName,
      IndexName: "UserStartedAtIndex",
      KeyConditionExpression: "userId = :userId AND startedAtUtc BETWEEN :fromUtc AND :toUtc",
      ExpressionAttributeValues: {
        ":userId": userId,
        ":fromUtc": `${fromDate}T00:00:00Z`,
        ":toUtc": `${toDate}T23:59:59Z`
      },
      ScanIndexForward: false,
      Limit: limit
    })
  );

  return jsonResponse(200, {
    tool: "get_recent_gym_visits",
    items: result.Items ?? []
  });
}

async function getTrainingHistory(args: ToolArgs, userId: string): Promise<LambdaLikeResponse> {
  const trainingMenuItemId = toNonEmptyString(args.trainingMenuItemId);
  if (!trainingMenuItemId) {
    return jsonResponse(400, { message: "trainingMenuItemId is required." });
  }
  const limit = toBoundedInt(args.limit, 30, 1, 100);

  const visitsResult = await ddb.send(
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

  const entries: Array<Record<string, unknown>> = [];
  for (const visit of visitsResult.Items ?? []) {
    const visitId = toNonEmptyString((visit as Record<string, unknown>).visitId) ?? "";
    const visitDateLocal = toNonEmptyString((visit as Record<string, unknown>).visitDateLocal) ?? "";
    const visitEntries = Array.isArray((visit as Record<string, unknown>).entries)
      ? ((visit as Record<string, unknown>).entries as Array<Record<string, unknown>>)
      : [];

    for (const entry of visitEntries) {
      if ((entry.trainingMenuItemId as string | undefined) === trainingMenuItemId) {
        entries.push({
          ...entry,
          visitId,
          visitDateLocal
        });
      }
      if (entries.length >= limit) {
        break;
      }
    }
    if (entries.length >= limit) {
      break;
    }
  }

  return jsonResponse(200, {
    tool: "get_training_history",
    trainingMenuItemId,
    items: entries
  });
}

async function getDailyRecords(args: ToolArgs, userId: string): Promise<LambdaLikeResponse> {
  const to = parseYmd(args.to) ?? nowIsoSeconds().slice(0, 10);
  const from = parseYmd(args.from) ?? ymdDaysAgo(30);

  const result = await ddb.send(
    new QueryCommand({
      TableName: dailyRecordTableName,
      KeyConditionExpression: "userId = :userId AND recordDate BETWEEN :from AND :to",
      ExpressionAttributeValues: {
        ":userId": userId,
        ":from": from,
        ":to": to
      },
      ScanIndexForward: false
    })
  );

  return jsonResponse(200, {
    tool: "get_daily_records",
    items: result.Items ?? []
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
      return jsonResponse(400, { message: "userId is required." });
    }

    if (toolName === "get_recent_gym_visits") {
      return getRecentGymVisits(event, userId);
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
    if (toolName === "get_goal") {
      return getGoal(userId);
    }
    if (toolName === "get_ai_character_profile") {
      return getAiCharacterProfile(userId);
    }
    if (toolName === "save_advice_log") {
      return saveAdviceLog(event, userId);
    }

    return jsonResponse(404, { message: `Method not found: ${toolName}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    return jsonResponse(500, {
      message
    });
  }
};

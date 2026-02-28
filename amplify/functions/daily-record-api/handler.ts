import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ddb } from "../shared/ddb";
import { getUserId, normalizePath, nowIsoSeconds, parseBody, parseYmd, response, toMonthRange } from "../shared/http";

const dailyRecordTableName = process.env.DAILY_RECORD_TABLE_NAME ?? "";
const trainingHistoryTableName = process.env.TRAINING_HISTORY_TABLE_NAME ?? "";
const goalTableName = process.env.GOAL_TABLE_NAME ?? "";

type DailyRecordInput = {
  bodyWeightKg?: number;
  bodyFatPercent?: number;
  bodyMetricMeasuredAtUtc?: string;
  bodyMetricMeasuredAtLocal?: string;
  bodyMetricMeasuredTimeLocal?: string;
  timeZoneId?: string;
  conditionRating?: 1 | 2 | 3 | 4 | 5;
  conditionComment?: string;
  diary?: string;
  otherActivities?: string[];
};

type Goal = {
  targetWeightKg: number;
  targetBodyFatPercent: number;
  createdAt?: string;
  updatedAt?: string;
};

function defaultDailyRecord(userId: string, recordDate: string): Record<string, unknown> {
  return {
    userId,
    recordDate,
    timeZoneId: "Asia/Tokyo",
    otherActivities: []
  };
}

async function getDailyRecord(userId: string, recordDate: string): Promise<APIGatewayProxyResult> {
  const result = await ddb.send(
    new GetCommand({
      TableName: dailyRecordTableName,
      Key: {
        userId,
        recordDate
      }
    })
  );

  if (!result.Item) {
    return response(200, defaultDailyRecord(userId, recordDate));
  }

  return response(200, result.Item);
}

async function putDailyRecord(
  event: APIGatewayProxyEvent,
  userId: string,
  recordDate: string
): Promise<APIGatewayProxyResult> {
  const body = parseBody<DailyRecordInput>(event);
  if (!body) {
    return response(400, { message: "Invalid JSON body." });
  }

  const current = await ddb.send(
    new GetCommand({
      TableName: dailyRecordTableName,
      Key: {
        userId,
        recordDate
      }
    })
  );

  const ts = nowIsoSeconds();
  const item = {
    ...defaultDailyRecord(userId, recordDate),
    ...current.Item,
    ...body,
    userId,
    recordDate,
    createdAt: current.Item?.createdAt ?? ts,
    updatedAt: ts
  };

  await ddb.send(
    new PutCommand({
      TableName: dailyRecordTableName,
      Item: item
    })
  );

  return response(200, item);
}

async function listDailyRecords(event: APIGatewayProxyEvent, userId: string): Promise<APIGatewayProxyResult> {
  const from = parseYmd(event.queryStringParameters?.from);
  const to = parseYmd(event.queryStringParameters?.to);
  if (!from || !to) {
    return response(400, { message: "from and to are required in YYYY-MM-DD format." });
  }

  const result = await ddb.send(
    new QueryCommand({
      TableName: dailyRecordTableName,
      KeyConditionExpression: "userId = :userId AND recordDate BETWEEN :from AND :to",
      ExpressionAttributeValues: {
        ":userId": userId,
        ":from": from,
        ":to": to
      }
    })
  );

  return response(200, { items: result.Items ?? [] });
}

async function getCalendar(event: APIGatewayProxyEvent, userId: string): Promise<APIGatewayProxyResult> {
  const month = event.queryStringParameters?.month;
  if (!month) {
    return response(400, { message: "month is required in YYYY-MM format." });
  }
  const range = toMonthRange(month);
  if (!range) {
    return response(400, { message: "month must be YYYY-MM format." });
  }

  const [dailyRecords, visits] = await Promise.all([
    ddb.send(
      new QueryCommand({
        TableName: dailyRecordTableName,
        KeyConditionExpression: "userId = :userId AND recordDate BETWEEN :fromDate AND :toDate",
        ExpressionAttributeValues: {
          ":userId": userId,
          ":fromDate": range.fromDate,
          ":toDate": range.toDate
        }
      })
    ),
    trainingHistoryTableName
      ? ddb.send(
          new QueryCommand({
            TableName: trainingHistoryTableName,
            IndexName: "UserStartedAtIndex",
            KeyConditionExpression: "userId = :userId AND startedAtUtc BETWEEN :fromUtc AND :toUtc",
            ExpressionAttributeValues: {
              ":userId": userId,
              ":fromUtc": `${range.fromDate}T00:00:00Z`,
              ":toUtc": `${range.toDate}T23:59:59Z`
            }
          })
        )
      : Promise.resolve({ Items: [] })
  ]);

  const conditionByDate: Record<string, number> = {};
  for (const item of dailyRecords.Items ?? []) {
    const date = item.recordDate as string | undefined;
    const rating = item.conditionRating as number | undefined;
    if (date && rating) {
      conditionByDate[date] = rating;
    }
  }

  const trainedDates = new Set<string>();
  for (const visit of visits.Items ?? []) {
    const localDate = visit.visitDateLocal as string | undefined;
    if (localDate) {
      trainedDates.add(localDate);
    }
  }

  return response(200, {
    month,
    days: Array.from(new Set([...Object.keys(conditionByDate), ...Array.from(trainedDates)]))
      .sort()
      .map((date) => ({
        date,
        trained: trainedDates.has(date),
        conditionRating: conditionByDate[date] ?? null
      }))
  });
}

function defaultGoal(): Goal {
  return {
    targetWeightKg: 68,
    targetBodyFatPercent: 15
  };
}

async function getGoal(userId: string): Promise<APIGatewayProxyResult> {
  if (!goalTableName) {
    return response(500, { message: "Lambda environment is not configured." });
  }

  const result = await ddb.send(
    new GetCommand({
      TableName: goalTableName,
      Key: { userId }
    })
  );

  if (!result.Item) {
    return response(200, defaultGoal());
  }

  return response(200, {
    targetWeightKg: Number(result.Item.targetWeightKg),
    targetBodyFatPercent: Number(result.Item.targetBodyFatPercent),
    updatedAt: result.Item.updatedAt
  });
}

async function putGoal(event: APIGatewayProxyEvent, userId: string): Promise<APIGatewayProxyResult> {
  if (!goalTableName) {
    return response(500, { message: "Lambda environment is not configured." });
  }

  const body = parseBody<Partial<Goal>>(event);
  if (!body) {
    return response(400, { message: "Invalid JSON body." });
  }
  if (
    typeof body.targetWeightKg !== "number" ||
    !Number.isFinite(body.targetWeightKg) ||
    typeof body.targetBodyFatPercent !== "number" ||
    !Number.isFinite(body.targetBodyFatPercent)
  ) {
    return response(400, { message: "targetWeightKg and targetBodyFatPercent are required." });
  }

  const current = await ddb.send(
    new GetCommand({
      TableName: goalTableName,
      Key: { userId }
    })
  );

  const ts = nowIsoSeconds();
  const item = {
    userId,
    targetWeightKg: Math.round(body.targetWeightKg * 100) / 100,
    targetBodyFatPercent: Math.round(body.targetBodyFatPercent * 100) / 100,
    createdAt: current.Item?.createdAt ?? ts,
    updatedAt: ts
  };

  await ddb.send(
    new PutCommand({
      TableName: goalTableName,
      Item: item
    })
  );

  return response(200, item);
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  if (!dailyRecordTableName) {
    return response(500, { message: "Lambda environment is not configured." });
  }

  const userId = getUserId(event);
  if (!userId) {
    return response(401, { message: "Unauthorized" });
  }

  const path = normalizePath(event);
  const method = event.httpMethod.toUpperCase();

  if ((path === "/calendar" || path === "/calendar/") && method === "GET") {
    return getCalendar(event, userId);
  }
  if ((path === "/goals" || path === "/goals/") && method === "GET") {
    return getGoal(userId);
  }
  if ((path === "/goals" || path === "/goals/") && method === "PUT") {
    return putGoal(event, userId);
  }
  if ((path === "/daily-records" || path === "/daily-records/") && method === "GET") {
    return listDailyRecords(event, userId);
  }

  const dailyMatch = path.match(/^\/daily-records\/([^/]+)\/?$/);
  if (dailyMatch && method === "GET") {
    if (!parseYmd(dailyMatch[1])) {
      return response(400, { message: "date must be YYYY-MM-DD." });
    }
    return getDailyRecord(userId, dailyMatch[1]);
  }
  if (dailyMatch && method === "PUT") {
    if (!parseYmd(dailyMatch[1])) {
      return response(400, { message: "date must be YYYY-MM-DD." });
    }
    return putDailyRecord(event, userId, dailyMatch[1]);
  }

  return response(404, { message: "Not found" });
};

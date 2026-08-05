import assert from "node:assert/strict";
import test from "node:test";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { hasValidPainAreas } from "../amplify/functions/daily-record-api/handler";
import { ddb } from "../amplify/functions/shared/ddb";
import {
  buildMcpToolInvocationLog,
  calculateSleepHoursFromLocalDateTimes,
  normalizeDailyRecordForMcp,
  saveDailyAiCoachReview,
  saveDailyMealNotes,
  saveDailyReadiness
} from "../amplify/functions/mcp-tools-api/handler";

test("Daily pain areas require a bounded structured 1-10 severity record", () => {
  assert.equal(
    hasValidPainAreas([
      {
        area: "右肩",
        severity: 6,
        occursAtRest: false,
        occursDuringMovement: true,
        numbness: false,
        weakness: false
      }
    ]),
    true
  );
  assert.equal(
    hasValidPainAreas([
      {
        area: "右肩",
        severity: 11,
        occursAtRest: false,
        occursDuringMovement: true,
        numbness: false,
        weakness: false
      }
    ]),
    false
  );
});

test("MCP Daily output exposes readiness fields without leaking unknown fields", () => {
  const normalized = normalizeDailyRecordForMcp({
    userId: "private",
    recordDate: "2026-07-28",
    sleepHours: 7.5,
    sleepQuality: 8,
    fatigueLevel: 3,
    motivationLevel: 9,
    muscleSorenessLevel: 4,
    painAreas: [],
    restingHeartRate: 58,
    mealNotes: "朝：卵とヨーグルト\n昼：鶏肉とご飯",
    aiCoachReview: "フォームは安定しています。",
    aiCoachReviewedAt: "2026-07-29T12:00:00Z",
    internalFutureField: "private"
  });

  assert.equal(normalized.sleepHours, 7.5);
  assert.equal(normalized.restingHeartRate, 58);
  assert.equal(normalized.mealNotes, "朝：卵とヨーグルト\n昼：鶏肉とご飯");
  assert.equal(normalized.aiCoachReview, "フォームは安定しています。");
  assert.equal(normalized.aiCoachReviewedAt, "2026-07-29T12:00:00Z");
  assert.deepEqual(normalized.painAreas, []);
  assert.equal(Object.hasOwn(normalized, "carbohydrateIntakeGrams"), false);
  assert.equal(Object.hasOwn(normalized, "userId"), false);
  assert.equal(Object.hasOwn(normalized, "internalFutureField"), false);
});

test("MCP saves and explicitly overwrites an AI coach review without changing other Daily fields", async () => {
  const stored: Record<string, unknown> = {
    userId: "user-1",
    recordDate: "2026-07-29",
    timeZoneId: "Asia/Tokyo",
    diary: "既存の日記",
    mealNotes: "朝：オートミール",
    otherActivities: ["散歩"]
  };
  const originalSend = ddb.send.bind(ddb);
  (ddb as any).send = async (command: unknown) => {
    if (!(command instanceof UpdateCommand)) {
      throw new Error(`Unexpected command: ${(command as { constructor: { name: string } }).constructor.name}`);
    }
    if (command.input.ConditionExpression && stored.aiCoachReview !== undefined) {
      const error = new Error("review already exists");
      error.name = "ConditionalCheckFailedException";
      throw error;
    }
    const names = command.input.ExpressionAttributeNames ?? {};
    const values = command.input.ExpressionAttributeValues ?? {};
    stored.aiCoachReview = values[":aiCoachReview"];
    stored.aiCoachReviewedAt = values[":timestamp"];
    stored.updatedAt = values[":timestamp"];
    stored.createdAt ??= values[":timestamp"];
    stored.timeZoneId ??= values[":defaultTimeZoneId"];
    stored.otherActivities ??= values[":emptyActivities"];
    assert.equal(names["#aiCoachReview"], "aiCoachReview");
    return { Attributes: { ...stored } };
  };

  try {
    const created = await saveDailyAiCoachReview(
      {
        date: "2026-07-29",
        aiCoachReview: "  筋トレと食事のバランスが良好です。  "
      },
      "user-1"
    ) as Record<string, any>;
    assert.equal(created.item.aiCoachReview, "筋トレと食事のバランスが良好です。");
    assert.equal(stored.diary, "既存の日記");
    assert.equal(stored.mealNotes, "朝：オートミール");
    assert.deepEqual(stored.otherActivities, ["散歩"]);

    const conflict = await saveDailyAiCoachReview(
      {
        date: "2026-07-29",
        aiCoachReview: "新しいレビュー"
      },
      "user-1"
    );
    assert.equal((conflict.error as Record<string, unknown>).code, "CONFLICT");
    assert.equal(stored.aiCoachReview, "筋トレと食事のバランスが良好です。");

    const overwritten = await saveDailyAiCoachReview(
      {
        date: "2026-07-29",
        aiCoachReview: "新しいレビュー",
        overwriteExisting: true
      },
      "user-1"
    ) as Record<string, any>;
    assert.equal(overwritten.overwritten, true);
    assert.equal(overwritten.item.aiCoachReview, "新しいレビュー");
    assert.equal(stored.diary, "既存の日記");
  } finally {
    (ddb as any).send = originalSend;
  }
});

test("MCP saves, appends, and clears the same free-form meal notes used by Daily UI", async () => {
  let stored: Record<string, unknown> = {
    userId: "user-1",
    recordDate: "2026-07-29",
    timeZoneId: "Asia/Tokyo",
    mealNotes: "朝：オートミール",
    diary: "既存の日記",
    otherActivities: []
  };
  const originalSend = ddb.send.bind(ddb);
  (ddb as any).send = async (command: unknown) => {
    if (command instanceof GetCommand) {
      return { Item: stored };
    }
    if (command instanceof PutCommand) {
      stored = command.input.Item as Record<string, unknown>;
      return {};
    }
    throw new Error(`Unexpected command: ${(command as { constructor: { name: string } }).constructor.name}`);
  };

  try {
    const appended = await saveDailyMealNotes(
      {
        date: "2026-07-29",
        mealNotes: "昼：鶏肉とご飯",
        mode: "append",
        timeZoneId: "Asia/Tokyo"
      },
      "user-1"
    );
    assert.equal(appended.mealNotes, "朝：オートミール\n昼：鶏肉とご飯");
    assert.equal(stored.diary, "既存の日記");

    const cleared = await saveDailyMealNotes(
      {
        date: "2026-07-29",
        mealNotes: "",
        mode: "overwrite",
        timeZoneId: "Asia/Tokyo"
      },
      "user-1"
    );
    assert.equal(cleared.mealNotes, "");
    assert.equal(stored.mealNotes, "");
  } finally {
    (ddb as any).send = originalSend;
  }
});

test("sleep duration is calculated across midnight in the user's time zone", () => {
  assert.equal(
    calculateSleepHoursFromLocalDateTimes(
      "2026-07-28T23:30",
      "2026-07-29T07:00",
      "Asia/Tokyo"
    ),
    7.5
  );
  assert.equal(
    calculateSleepHoursFromLocalDateTimes(
      "2026-07-29T07:00",
      "2026-07-29T06:00",
      "Asia/Tokyo"
    ),
    undefined
  );
  assert.equal(
    calculateSleepHoursFromLocalDateTimes(
      "2026-03-08T01:30",
      "2026-03-08T03:30",
      "America/New_York"
    ),
    1
  );
});

test("MCP readiness save calculates sleep server-side and preserves unrelated Daily fields", async () => {
  const stored: Record<string, unknown> = {
    userId: "user-1",
    recordDate: "2026-07-29",
    diary: "既存の日記",
    mealNotes: "朝：オートミール",
    otherActivities: ["散歩"]
  };
  const originalSend = ddb.send.bind(ddb);
  (ddb as any).send = async (command: unknown) => {
    if (!(command instanceof UpdateCommand)) {
      throw new Error(`Unexpected command: ${(command as { constructor: { name: string } }).constructor.name}`);
    }
    const names = command.input.ExpressionAttributeNames ?? {};
    const values = command.input.ExpressionAttributeValues ?? {};
    for (const [alias, field] of Object.entries(names)) {
      if (!alias.startsWith("#field")) continue;
      const index = alias.slice("#field".length);
      stored[field] = values[`:field${index}`];
    }
    stored.timeZoneId = values[":timeZoneId"];
    stored.updatedAt = values[":updatedAt"];
    stored.createdAt ??= values[":createdAt"];
    return { Attributes: stored };
  };

  try {
    const result = await saveDailyReadiness(
      {
        sleepStartedAtLocal: "2026-07-28T23:30",
        wokeUpAtLocal: "2026-07-29T07:00",
        timeZoneId: "Asia/Tokyo",
        sleepQuality: 8,
        fatigueLevel: 3
      },
      "user-1"
    ) as Record<string, any>;
    assert.equal(result.recordDate, "2026-07-29");
    assert.equal(result.sleepCalculation.sleepHours, 7.5);
    assert.deepEqual(result.updatedFields, ["fatigueLevel", "sleepHours", "sleepQuality"]);
    assert.equal(stored.sleepHours, 7.5);
    assert.equal(stored.diary, "既存の日記");
    assert.equal(stored.mealNotes, "朝：オートミール");
    assert.deepEqual(stored.otherActivities, ["散歩"]);
  } finally {
    (ddb as any).send = originalSend;
  }
});

test("MCP readiness rejects incomplete or conflicting sleep inputs", async () => {
  const incomplete = await saveDailyReadiness(
    {
      sleepStartedAtLocal: "2026-07-28T23:30",
      timeZoneId: "Asia/Tokyo"
    },
    "user-1"
  );
  assert.equal((incomplete.error as Record<string, unknown>).code, "INVALID_REQUEST");

  const conflicting = await saveDailyReadiness(
    {
      sleepHours: 7.5,
      sleepStartedAtLocal: "2026-07-28T23:30",
      wokeUpAtLocal: "2026-07-29T07:00",
      timeZoneId: "Asia/Tokyo"
    },
    "user-1"
  );
  assert.equal((conflicting.error as Record<string, unknown>).code, "INVALID_REQUEST");
});

test("MCP invocation audit logs tool and argument names without values or identity", () => {
  const log = buildMcpToolInvocationLog(
    "save_daily_meal_notes",
    {
      __principalUserId: "private-user",
      mealNotes: "朝：卵とヨーグルト",
      date: "2026-07-29"
    },
    "request-1"
  );
  assert.deepEqual(log, {
    event: "mcp_tool_invocation",
    toolName: "save_daily_meal_notes",
    argumentKeys: ["date", "mealNotes"],
    requestId: "request-1"
  });
  assert.equal(JSON.stringify(log).includes("private-user"), false);
  assert.equal(JSON.stringify(log).includes("卵とヨーグルト"), false);

  const reviewLog = buildMcpToolInvocationLog(
    "save_daily_ai_coach_review",
    {
      __principalUserId: "private-user",
      date: "2026-07-29",
      aiCoachReview: "ログへ出してはいけないレビュー"
    },
    "request-2"
  );
  assert.deepEqual(reviewLog.argumentKeys, ["aiCoachReview", "date"]);
  assert.equal(JSON.stringify(reviewLog).includes("ログへ出してはいけないレビュー"), false);
});

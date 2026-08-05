import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { encodePageToken } from "../amplify/functions/shared/pagination.ts";
import { enumerateYmdRange } from "../amplify/functions/shared/date-range.ts";
import {
  type BodyMetricDdbSender,
  type TrainingMenuLookupSender,
  decodeNextToken,
  isValidBodyFatPercent,
  isValidMuscleMassKg,
  isValidBodyWeightKg,
  localDateInclusiveUpperKey,
  localDateStartUtc,
  mcpToolResponse,
  normalizeAiCharacterProfileForMcp,
  normalizeDailyRecordForMcp,
  normalizeGoalForMcp,
  normalizeGymVisitWeightSnapshots,
  normalizeNonNegativeDecimal,
  normalizeTrainingMenuItemForMcp,
  parseAnalysisExportSelection,
  parseLocalTime,
  parseYmd,
  resolveRecordDate,
  resolveTrainingMenuForHistory,
  resolveTimeZoneId,
  saveBodyMetrics,
  saveBodyMetricsBatch,
  trainingMenuItemVersion
} from "../amplify/functions/mcp-tools-api/handler.ts";

type JsonObject = Record<string, unknown>;
const silentLogger = () => undefined;

test("temporary menu validity enumerates inclusive dates and enforces the limit", () => {
  assert.deepEqual(
    enumerateYmdRange("2026-07-27", "2026-07-29"),
    ["2026-07-27", "2026-07-28", "2026-07-29"]
  );
  assert.equal(enumerateYmdRange("2026-07-29", "2026-07-27"), undefined);
  assert.equal(enumerateYmdRange("2026-07-27", "2026-08-27"), undefined);
});

function parseResponse(response: JsonObject): JsonObject {
  return response;
}

function createMemoryBodyMetricSender(
  initial: Record<string, Record<string, unknown>> = {},
  writeFailureDates: ReadonlySet<string> = new Set()
): {
  records: Map<string, Record<string, unknown>>;
  send: BodyMetricDdbSender;
  updateCount: () => number;
} {
  const records = new Map(
    Object.entries(initial).map(([date, item]) => [date, structuredClone(item)])
  );
  let updates = 0;
  const send: BodyMetricDdbSender = async (command) => {
    const date = command.input.Key?.recordDate as string;
    if (command instanceof GetCommand) {
      const item = records.get(date);
      return { Item: item ? structuredClone(item) : undefined };
    }
    assert.ok(command instanceof UpdateCommand);
    if (writeFailureDates.has(date)) {
      throw new Error("simulated write failure");
    }
    updates += 1;
    const item = structuredClone(records.get(date) ?? {});
    const names = command.input.ExpressionAttributeNames ?? {};
    const values = command.input.ExpressionAttributeValues ?? {};
    for (const [alias, field] of Object.entries(names)) {
      const shortAlias = alias.replace(/^#/, "");
      const nextKey = `:next_${shortAlias}`;
      if (Object.hasOwn(values, nextKey)) {
        item[field] = values[nextKey];
      }
      if (/^#field\d+$/.test(alias)) {
        const fieldValueKey = `:${shortAlias}`;
        if (Object.hasOwn(values, fieldValueKey)) {
          item[field] = values[fieldValueKey];
        }
      }
    }
    item.createdAt ??= values[":timestamp"];
    item.updatedAt = values[":timestamp"];
    item.otherActivities ??= values[":emptyActivities"];
    item.timeZoneId ??= values[":defaultTimeZoneId"];
    records.set(date, item);
    return { Attributes: structuredClone(item) };
  };
  return {
    records,
    send,
    updateCount: () => updates
  };
}

test("YYYY-MM-DD validation rejects impossible calendar dates", () => {
  assert.equal(parseYmd("2026-07-13"), "2026-07-13");
  assert.equal(parseYmd("2026-02-29"), undefined);
  assert.equal(parseYmd("2026-99-99"), undefined);
  assert.equal(parseYmd("2026/07/13"), undefined);
});

test("a supplied invalid diary date does not fall back to today", () => {
  const now = new Date("2026-07-13T03:00:00Z");
  assert.equal(resolveRecordDate(undefined, "Asia/Tokyo", now), "2026-07-13");
  assert.equal(resolveRecordDate("2026/07/12", "Asia/Tokyo", now), undefined);
  assert.equal(resolveRecordDate("2026-02-29", "Asia/Tokyo", now), undefined);
});

test("body metric measurement time accepts only a valid 24-hour HH:mm value", () => {
  assert.equal(parseLocalTime("00:00"), "00:00");
  assert.equal(parseLocalTime("23:59"), "23:59");
  assert.equal(parseLocalTime("24:00"), undefined);
  assert.equal(parseLocalTime("7:30"), undefined);
  assert.equal(parseLocalTime("12:60"), undefined);
});

test("body metric values enforce the supported numeric ranges", () => {
  assert.equal(isValidBodyWeightKg(65.2), true);
  assert.equal(isValidBodyWeightKg(500), true);
  assert.equal(isValidBodyWeightKg(0), false);
  assert.equal(isValidBodyWeightKg(500.01), false);
  assert.equal(isValidBodyWeightKg(65.123), false);
  assert.equal(isValidBodyWeightKg(Number.NaN), false);
  assert.equal(isValidBodyFatPercent(14.8), true);
  assert.equal(isValidBodyFatPercent(0), true);
  assert.equal(isValidBodyFatPercent(100), true);
  assert.equal(isValidBodyFatPercent(100.1), false);
  assert.equal(isValidBodyFatPercent(14.123), false);
  assert.equal(isValidMuscleMassKg(52.1), true);
  assert.equal(isValidMuscleMassKg(0), false);
  assert.equal(isValidMuscleMassKg(500.01), false);
  assert.equal(isValidMuscleMassKg(52.123), false);
});

test("AI menu weight accepts zero and rejects negative values", () => {
  assert.equal(normalizeNonNegativeDecimal(0), 0);
  assert.equal(normalizeNonNegativeDecimal(12.345), 12.35);
  assert.equal(normalizeNonNegativeDecimal(-0.01), undefined);
  assert.equal(normalizeNonNegativeDecimal(Number.NaN), undefined);
  assert.equal(normalizeNonNegativeDecimal(null), undefined);
  assert.equal(normalizeNonNegativeDecimal("0"), undefined);
});

test("local date boundaries are converted to UTC with daylight saving time", () => {
  assert.equal(localDateStartUtc("2026-07-13", "Asia/Tokyo"), "2026-07-12T15:00:00.000Z");
  assert.equal(localDateStartUtc("2026-01-15", "America/New_York"), "2026-01-15T05:00:00.000Z");
  assert.equal(localDateStartUtc("2026-07-15", "America/New_York"), "2026-07-15T04:00:00.000Z");
  assert.equal(localDateInclusiveUpperKey("2026-07-13", "Asia/Tokyo"), "2026-07-13T15:00:00.000");
  assert.ok("2026-07-13T14:59:59Z" < localDateInclusiveUpperKey("2026-07-13", "Asia/Tokyo"));
  assert.ok(localDateInclusiveUpperKey("2026-07-13", "Asia/Tokyo") < "2026-07-13T15:00:00Z");
});

test("invalid time zones are rejected instead of silently replaced", () => {
  assert.equal(resolveTimeZoneId({}), "Asia/Tokyo");
  assert.equal(resolveTimeZoneId({ timeZoneId: "Europe/Paris" }), "Europe/Paris");
  assert.equal(resolveTimeZoneId({ timeZoneId: "Not/AZone" }), undefined);
});

test("MCP tool responses return direct JSON without an API Gateway proxy envelope", () => {
  const success = mcpToolResponse(200, {
    tool: "get_goal",
    item: { targetWeightKg: 70 }
  });
  assert.deepEqual(success, {
    tool: "get_goal",
    item: { targetWeightKg: 70 }
  });
  assert.equal(Object.hasOwn(success, "statusCode"), false);
  assert.equal(Object.hasOwn(success, "headers"), false);
  assert.equal(Object.hasOwn(success, "body"), false);

  const failure = mcpToolResponse(400, {
    code: "INVALID_DATE",
    message: "date is invalid.",
    field: "date"
  });
  assert.deepEqual(failure, {
    error: {
      code: "INVALID_DATE",
      message: "date is invalid.",
      details: {
        field: "date"
      }
    }
  });
});

test("MCP read responses expose only allowlisted database fields", () => {
  const internalFields = {
    userId: "internal-user",
    secretInternalFlag: "must-not-leak"
  };
  const daily = normalizeDailyRecordForMcp({
    ...internalFields,
    recordDate: "2026-07-26",
    bodyWeightKg: 70,
    muscleMassKg: 52.1,
    diary: "記録"
  });
  assert.equal(daily.muscleMassKg, 52.1);
  const goal = normalizeGoalForMcp({
    ...internalFields,
    targetWeightKg: 68,
    comment: "目標"
  });
  const character = normalizeAiCharacterProfileForMcp({
    ...internalFields,
    characterId: "coach",
    characterName: "AIコーチ",
    coachAvatarObjectKey: "users/internal/avatar.png"
  });
  const visit = normalizeGymVisitWeightSnapshots({
    ...internalFields,
    visitId: "visit-1",
    entries: [
      {
        ...internalFields,
        trainingMenuItemId: "menu-1",
        trainingNameSnapshot: "ベンチプレス",
        weightKg: 60,
        reps: 10,
        sets: 3
      }
    ]
  });

  for (const item of [daily, goal, character, visit]) {
    const serialized = JSON.stringify(item);
    assert.equal(serialized.includes("internal-user"), false);
    assert.equal(serialized.includes("secretInternalFlag"), false);
    assert.equal(serialized.includes("coachAvatarObjectKey"), false);
  }
});

test("exercise master MCP output exposes version and impact without internal identity", () => {
  assert.equal(trainingMenuItemVersion(undefined), 0);
  assert.equal(trainingMenuItemVersion(3), 3);
  const normalized = normalizeTrainingMenuItemForMcp(
    {
      userId: "internal-user",
      trainingMenuItemId: "menu-1",
      trainingName: "ベンチプレス",
      exerciseFamilyId: "bench_press",
      muscleTargets: [{ muscleId: "chest_mid", role: "primary", effectiveSetFactor: 1 }],
      movementFamily: "push",
      jointActions: ["shoulder_horizontal_adduction", "elbow_extension"],
      laterality: "bilateral",
      loadModel: "external_load",
      equipmentType: "barbell",
      weightInputMode: "perSide",
      loadMultiplier: 2,
      fixedWeightKg: 20,
      isActive: true,
      version: 4,
      updatedAt: "2026-07-30T00:00:00Z",
      secretInternalFlag: "must-not-leak"
    },
    {
      usageCount: 2,
      activeMenuSetIds: ["set-1", "set-2"],
      assignedPlanDates: ["2026-07-30", "2026-07-31"],
      hasFutureAssignments: true
    }
  );
  assert.equal(normalized.version, 4);
  assert.equal(normalized.activeMenuSetCount, 2);
  assert.equal(normalized.assignedPlanDateCount, 2);
  assert.equal(JSON.stringify(normalized).includes("internal-user"), false);
  assert.equal(JSON.stringify(normalized).includes("secretInternalFlag"), false);
});

test("training history resolves a registered menu name without requiring its ID", async () => {
  let observedNormalizedName = "";
  const send: TrainingMenuLookupSender = async (command) => {
    assert.ok(command instanceof QueryCommand);
    observedNormalizedName = String(command.input.ExpressionAttributeValues?.[":normalizedTrainingName"]);
    return {
      Items: [
        {
          trainingMenuItemId: "menu-1",
          trainingName: "バーベルスクワット"
        }
      ]
    };
  };
  const resolved = await resolveTrainingMenuForHistory(
    { trainingMenuName: "  バーベルスクワット  " },
    "user-a",
    send
  );
  assert.equal(observedNormalizedName, "バーベルスクワット");
  assert.deepEqual(resolved, {
    value: {
      trainingMenuItemId: "menu-1",
      trainingMenuName: "バーベルスクワット"
    }
  });
});

test("training history rejects mismatched menu ID and name references", async () => {
  const send: TrainingMenuLookupSender = async () => ({
    Items: [
      {
        trainingMenuItemId: "menu-from-name",
        trainingName: "ベンチプレス"
      }
    ]
  });
  const resolved = await resolveTrainingMenuForHistory(
    {
      trainingMenuItemId: "different-menu",
      trainingMenuName: "ベンチプレス"
    },
    "user-a",
    send
  );
  assert.ok("response" in resolved);
  if ("response" in resolved) {
    assert.equal((resolved.response.error as JsonObject).code, "TRAINING_MENU_REFERENCE_MISMATCH");
  }
});

test("pagination tokens hide user identity and are bound to the original tool and range", async () => {
  const context = JSON.stringify(["get_daily_records", "2026-07-01", "2026-07-13", "Asia/Tokyo"]);
  const signingSecret = "test-pagination-signing-key-with-at-least-thirty-two-characters";
  const token = await encodePageToken(
    { userId: "user-a", recordDate: "2026-07-05" },
    context,
    "user-a",
    signingSecret
  );
  assert.ok(token);
  assert.equal(Buffer.from(token.split(".")[0], "base64url").toString("utf8").includes("user-a"), false);
  assert.deepEqual(await decodeNextToken(token, context, "user-a", signingSecret), {
    userId: "user-a",
    recordDate: "2026-07-05"
  });
  assert.equal(await decodeNextToken(token, `${context}:changed`, "user-a", signingSecret), null);
  assert.equal(await decodeNextToken(token, context, "user-b", signingSecret), null);
  assert.equal(await decodeNextToken("not-a-token", context, "user-a", signingSecret), null);
});

test("history list schemas share the paging and local-date interface", async () => {
  const schemas = JSON.parse(
    await readFile("amplify/agentcore/tool-schemas/mcp-tools.json", "utf8")
  ) as Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
  for (const name of ["get_gym_visits", "get_training_history", "get_daily_records"]) {
    const schema = schemas.find((candidate) => candidate.name === name);
    assert.ok(schema, `${name} schema is missing`);
    for (const property of ["from", "to", "timeZoneId", "limit", "nextToken"]) {
      assert.ok(Object.hasOwn(schema.inputSchema.properties, property), `${name}.${property} is missing`);
    }
  }
  const gymVisits = schemas.find((candidate) => candidate.name === "get_gym_visits");
  assert.equal(Object.hasOwn(gymVisits!.inputSchema.properties, "days"), false);
  const trainingHistory = schemas.find((candidate) => candidate.name === "get_training_history");
  assert.ok(Object.hasOwn(trainingHistory!.inputSchema.properties, "trainingMenuItemId"));
  assert.ok(Object.hasOwn(trainingHistory!.inputSchema.properties, "trainingMenuName"));
});

test("MCP schemas distinguish single-day lookup and constrain diary save mode", async () => {
  const schemas = JSON.parse(
    await readFile("amplify/agentcore/tool-schemas/mcp-tools.json", "utf8")
  ) as Array<{
    name: string;
    description: string;
    inputSchema: {
      properties: Record<string, { enum?: string[] }>;
      required?: string[];
    };
  }>;
  const history = schemas.find((candidate) => candidate.name === "get_training_history");
  const dailyRecord = schemas.find((candidate) => candidate.name === "get_daily_record");
  const dailyRecords = schemas.find((candidate) => candidate.name === "get_daily_records");
  const saveDiary = schemas.find((candidate) => candidate.name === "save_daily_diary");
  const saveAiCoachReview = schemas.find((candidate) => candidate.name === "save_daily_ai_coach_review");
  const saveMealNotes = schemas.find((candidate) => candidate.name === "save_daily_meal_notes");
  const saveReadiness = schemas.find((candidate) => candidate.name === "save_daily_readiness");
  assert.ok(history);
  assert.equal(history.inputSchema.required, undefined);
  assert.match(dailyRecord!.description, /1日/);
  assert.match(dailyRecords!.description, /複数日/);
  assert.deepEqual(saveDiary!.inputSchema.properties.mode.enum, ["append", "overwrite"]);
  assert.ok(saveAiCoachReview);
  assert.deepEqual(saveAiCoachReview.inputSchema.required, ["date", "aiCoachReview"]);
  assert.ok(Object.hasOwn(saveAiCoachReview.inputSchema.properties, "overwriteExisting"));
  assert.ok(saveMealNotes);
  assert.deepEqual(saveMealNotes.inputSchema.properties.mode.enum, ["append", "overwrite"]);
  assert.deepEqual(saveMealNotes.inputSchema.required, ["mealNotes"]);
  assert.ok(saveReadiness);
  assert.ok(Object.hasOwn(saveReadiness.inputSchema.properties, "sleepStartedAtLocal"));
  assert.ok(Object.hasOwn(saveReadiness.inputSchema.properties, "wokeUpAtLocal"));
  assert.ok(Object.hasOwn(saveReadiness.inputSchema.properties, "sleepHours"));
  assert.match(saveDiary!.description, /save_daily_meal_notes/);
  assert.match(saveMealNotes.description, /save_daily_diaryへ保存しない/);
  assert.match(saveReadiness.description, /バックエンドが睡眠時間を計算/);
});

test("runtime prompt routes Daily content to distinct tools", async () => {
  const prompt = await readFile(
    "amplify/agentcore/runtime/config/prompts/system-prompt.ja.txt",
    "utf8"
  );
  assert.match(prompt, /食事.*save_daily_meal_notes/);
  assert.match(prompt, /出来事.*save_daily_diary/);
  assert.match(prompt, /睡眠時間.*save_daily_readiness/);
  assert.match(prompt, /AIコーチレビュー.*save_daily_ai_coach_review/);
  assert.match(prompt, /overwriteExisting=true/);
  assert.match(prompt, /sleepStartedAtLocal.*wokeUpAtLocal/);
});

test("analysis export schemas expose manifest and section paging without set details", async () => {
  const schemas = JSON.parse(
    await readFile("amplify/agentcore/tool-schemas/mcp-tools.json", "utf8")
  ) as Array<{
    name: string;
    inputSchema: {
      properties: Record<string, { maximum?: number; enum?: string[] }>;
      required?: string[];
    };
  }>;
  const manifest = schemas.find((candidate) => candidate.name === "get_analysis_export_manifest");
  const page = schemas.find((candidate) => candidate.name === "get_analysis_export_page");
  assert.ok(manifest);
  assert.ok(page);
  assert.deepEqual(manifest.inputSchema.required, ["rangeMode"]);
  assert.deepEqual(page.inputSchema.required, ["rangeMode", "section"]);
  assert.equal(page.inputSchema.properties.limit.maximum, 50);
  assert.deepEqual(page.inputSchema.properties.section.enum, [
    "trainingMenus",
    "trainingMenuSets",
    "dailyRecords",
    "gymVisits",
    "recoveryExecutions"
  ]);
  assert.equal(JSON.stringify([manifest, page]).includes("setDetails"), false);
  const handlerSource = await readFile("amplify/functions/mcp-tools-api/handler.ts", "utf8");
  assert.match(handlerSource, /schemaVersion: 8/);
  assert.match(handlerSource, /actualDurationMinutes/);
  assert.match(handlerSource, /planRelationAtRegistration/);
  assert.match(handlerSource, /muscleTargets/);
  assert.match(handlerSource, /movementFamily/);
  assert.match(handlerSource, /jointActions/);
  assert.match(handlerSource, /loadModel/);
  assert.equal(handlerSource.includes("bodyPartSnapshot"), false);
  for (const field of [
    "weightInputMode",
    "loadMultiplier",
    "fixedWeightKg",
    "additionalLoadKg",
    "assistanceKg",
    "calculatedTotalWeightKg"
  ]) {
    assert.match(handlerSource, new RegExp(field), `${field} is missing from MCP output`);
  }
});

test("temporary menu lifecycle schemas expose safe versioned mutations", async () => {
  const schemas = JSON.parse(
    await readFile("amplify/agentcore/tool-schemas/mcp-tools.json", "utf8")
  ) as Array<{
    name: string;
    inputSchema: {
      additionalProperties?: boolean;
      properties: Record<string, { enum?: string[]; maximum?: number }>;
      required?: string[];
    };
  }>;
  for (const name of [
    "get_training_plan_for_date",
    "reschedule_temporary_training_plan",
    "cancel_temporary_training_plan",
    "update_temporary_training_menu_set"
  ]) {
    const schema = schemas.find((candidate) => candidate.name === name);
    assert.ok(schema, `${name} schema is missing`);
    assert.equal(schema.inputSchema.additionalProperties, false);
  }
  const reschedule = schemas.find(
    (candidate) => candidate.name === "reschedule_temporary_training_plan"
  )!;
  assert.deepEqual(reschedule.inputSchema.properties.conflictPolicy.enum, ["reject", "replace"]);
  assert.ok(reschedule.inputSchema.required?.includes("expectedVersion"));
  assert.ok(reschedule.inputSchema.required?.includes("idempotencyKey"));

  const update = schemas.find(
    (candidate) => candidate.name === "update_temporary_training_menu_set"
  )!;
  assert.ok(Object.hasOwn(update.inputSchema.properties, "itemUpdates"));
  assert.ok(Object.hasOwn(update.inputSchema.properties, "itemAdds"));
  assert.ok(Object.hasOwn(update.inputSchema.properties, "itemRemovals"));
  assert.ok(Object.hasOwn(update.inputSchema.properties, "itemOrder"));
  const itemAdds = update.inputSchema.properties.itemAdds as {
    items?: { properties?: Record<string, unknown> };
  };
  assert.ok(Object.hasOwn(itemAdds.items?.properties ?? {}, "newTrainingMenuItem"));
});

test("exercise master MCP schemas extend the existing list and require safe mutations", async () => {
  const schemas = JSON.parse(
    await readFile("amplify/agentcore/tool-schemas/mcp-tools.json", "utf8")
  ) as Array<{
    name: string;
    inputSchema: {
      additionalProperties?: boolean;
      properties: Record<string, { enum?: unknown[] }>;
      required?: string[];
    };
  }>;
  const list = schemas.find((candidate) => candidate.name === "list_training_menu_items");
  assert.ok(list);
  for (const property of ["query", "includeInactive", "onlyAiGenerated", "limit", "nextToken"]) {
    assert.ok(Object.hasOwn(list.inputSchema.properties, property), `${property} is missing`);
  }
  for (const name of ["update_training_menu_item", "archive_training_menu_item"]) {
    const schema = schemas.find((candidate) => candidate.name === name);
    assert.ok(schema, `${name} schema is missing`);
    assert.equal(schema.inputSchema.additionalProperties, false);
    assert.ok(schema.inputSchema.required?.includes("trainingMenuItemId"));
    assert.ok(schema.inputSchema.required?.includes("expectedVersion"));
    assert.ok(schema.inputSchema.required?.includes("idempotencyKey"));
    assert.deepEqual(schema.inputSchema.properties.userConfirmed.enum, [true]);
    assert.ok(Object.hasOwn(schema.inputSchema.properties, "dryRun"));
  }
});

test("analysis export selection requires a complete range or explicit all-available mode", () => {
  const selected = parseAnalysisExportSelection({
    rangeMode: "dateRange",
    from: "2026-01-01",
    to: "2026-07-26",
    timeZoneId: "Asia/Tokyo"
  });
  assert.ok("value" in selected);
  if ("value" in selected) {
    assert.deepEqual(selected.value, {
      rangeMode: "dateRange",
      from: "2026-01-01",
      to: "2026-07-26",
      timeZoneId: "Asia/Tokyo"
    });
  }

  const allAvailable = parseAnalysisExportSelection({
    rangeMode: "allAvailable",
    timeZoneId: "Asia/Tokyo"
  });
  assert.ok("value" in allAvailable);

  const incomplete = parseAnalysisExportSelection({
    rangeMode: "dateRange",
    from: "2026-01-01"
  });
  assert.ok("response" in incomplete);
  if ("response" in incomplete) {
    const error = incomplete.response.error as JsonObject;
    assert.equal(error.code, "INVALID_DATE_RANGE");
  }

  const reversed = parseAnalysisExportSelection({
    rangeMode: "dateRange",
    from: "2026-07-26",
    to: "2026-01-01"
  });
  assert.ok("response" in reversed);
});

test("single body metrics schema supports partial muscle-mass updates", async () => {
  const schemas = JSON.parse(
    await readFile("amplify/agentcore/tool-schemas/mcp-tools.json", "utf8")
  ) as Array<{
    name: string;
    inputSchema: { properties: Record<string, unknown>; required?: string[] };
  }>;
  const schema = schemas.find((candidate) => candidate.name === "save_body_metrics");
  assert.ok(schema, "save_body_metrics schema is missing");
  assert.deepEqual(schema.inputSchema.required, ["date"]);
  assert.ok(Object.hasOwn(schema.inputSchema.properties, "muscleMassKg"));
  assert.ok(Object.hasOwn(schema.inputSchema.properties, "timeZoneId"));
});

test("single body metrics adds muscle mass without replacing existing Daily fields", async () => {
  const memory = createMemoryBodyMetricSender({
    "2026-07-20": {
      bodyWeightKg: 70,
      bodyFatPercent: 18,
      diary: "keep this diary"
    }
  });

  const response = await saveBodyMetrics(
    { date: "2026-07-20", muscleMassKg: 52.1 },
    "user-a",
    { send: memory.send }
  );
  const item = response.item as JsonObject;

  assert.equal(item.muscleMassKg, 52.1);
  assert.equal(memory.records.get("2026-07-20")?.bodyWeightKg, 70);
  assert.equal(memory.records.get("2026-07-20")?.bodyFatPercent, 18);
  assert.equal(memory.records.get("2026-07-20")?.diary, "keep this diary");
});

test("AI menu schema declares zero as the minimum weight", async () => {
  const schemas = JSON.parse(
    await readFile("amplify/agentcore/tool-schemas/mcp-tools.json", "utf8")
  ) as Array<{
    name: string;
    inputSchema: {
      required?: string[];
      properties: {
        scheduledDates?: {
          uniqueItems?: boolean;
          items?: { type?: string };
        };
        items?: {
          items?: {
            properties?: Record<string, { minimum?: number; type?: string }>;
          };
        };
      };
    };
  }>;
  const schema = schemas.find((candidate) => candidate.name === "create_temporary_training_menu_set_from_ai");
  assert.ok(schema, "create_temporary_training_menu_set_from_ai schema is missing");
  assert.deepEqual(
    schema.inputSchema.required,
    ["idempotencyKey", "validFromDate", "validToDate", "setName", "menuSetKind", "scheduledDates", "items"]
  );
  assert.equal(schema.inputSchema.properties.scheduledDates?.items?.type, "string");
  assert.equal(schema.inputSchema.properties.scheduledDates?.uniqueItems, true);
  const itemProperties = schema.inputSchema.properties.items?.items?.properties as
    | Record<string, { properties?: Record<string, { minimum?: number; type?: string }> }>
    | undefined;
  assert.equal(itemProperties?.prescription?.properties?.targetWeightKg?.minimum, 0);
  assert.equal(itemProperties?.newTrainingMenuItem?.properties?.description?.type, "string");
  assert.equal(itemProperties?.newTrainingMenuItem?.properties?.fixedWeightKg?.minimum, 0);
  assert.equal(Object.hasOwn(schema.inputSchema.properties.items?.items?.properties ?? {}, "memo"), false);
});

test("batch body metrics schema exposes partial-success inputs without public identity fields", async () => {
  const schemas = JSON.parse(
    await readFile("amplify/agentcore/tool-schemas/mcp-tools.json", "utf8")
  ) as Array<{
    name: string;
    inputSchema: {
      properties: Record<
        string,
        {
          maxItems?: number;
          items?: {
            type?: string;
            additionalProperties?: boolean;
            properties?: Record<string, unknown>;
          };
        }
      >;
      required?: string[];
    };
  }>;
  const schema = schemas.find((candidate) => candidate.name === "save_body_metrics_batch");
  assert.ok(schema, "save_body_metrics_batch schema is missing");
  assert.deepEqual(schema.inputSchema.required, ["records", "dryRun"]);
  assert.equal(schema.inputSchema.properties.records.maxItems, 100);
  assert.equal(schema.inputSchema.properties.records.items?.type, "object");
  assert.equal(schema.inputSchema.properties.records.items?.additionalProperties, true);
  assert.ok(Object.hasOwn(schema.inputSchema.properties.records.items?.properties ?? {}, "date"));
  assert.ok(Object.hasOwn(schema.inputSchema.properties.records.items?.properties ?? {}, "muscleMassKg"));
  for (const property of ["records", "timeZoneId", "conflictPolicy", "dryRun"]) {
    assert.ok(Object.hasOwn(schema.inputSchema.properties, property), `${property} is missing`);
  }
});

test("batch body metrics returns success and failure for every record in input order", async () => {
  const logs: JsonObject[] = [];
  const memory = createMemoryBodyMetricSender(
    {
      "2026-07-22": {
        bodyFatPercent: 20,
        timeZoneId: "Asia/Tokyo",
        diary: "keep this diary"
      }
    },
    new Set(["2026-07-19"])
  );
  const response = await saveBodyMetricsBatch(
    {
      records: [
        { date: "2026-07-20", bodyWeightKg: 68.4 },
        { date: "2026-07-21", bodyWeightKg: 501 },
        { date: "2026-07-22", bodyFatPercent: 18 },
        { date: "2026-07-19", bodyWeightKg: 67 },
        { date: "2026-07-18", bodyWeightKg: 67.5 },
        { date: "2026-07-18", bodyWeightKg: 67.4 },
        { date: "2026-07-24", bodyWeightKg: 67.2 }
      ],
      timeZoneId: "Asia/Tokyo",
      conflictPolicy: "reject",
      dryRun: false
    },
    "user-a",
    {
      now: new Date("2026-07-23T03:00:00Z"),
      send: memory.send,
      logger: (entry) => logs.push(entry)
    }
  );

  const body = parseResponse(response);
  assert.equal(body.outcome, "partially_succeeded");
  assert.deepEqual(body.summary, {
    received: 7,
    succeeded: 1,
    failed: 6,
    created: 1,
    updated: 0,
    unchanged: 0,
    conflicts: 1
  });
  const results = body.results as Array<JsonObject>;
  assert.equal(results.length, 7);
  assert.deepEqual(results.map((result) => result.index), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(results[0].status, "success");
  assert.equal(results[0].action, "created");
  assert.equal((results[1].error as JsonObject).code, "OUT_OF_RANGE");
  assert.equal((results[2].error as JsonObject).code, "CONFLICT");
  assert.equal((results[3].error as JsonObject).code, "WRITE_FAILED");
  assert.equal((results[4].error as JsonObject).code, "DUPLICATE_DATE");
  assert.equal((results[5].error as JsonObject).code, "DUPLICATE_DATE");
  assert.equal((results[6].error as JsonObject).code, "FUTURE_DATE");
  assert.equal(memory.records.get("2026-07-20")?.bodyWeightKg, 68.4);
  assert.equal(memory.records.get("2026-07-22")?.diary, "keep this diary");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, "mcp_body_metrics_batch_completed");
  assert.equal(JSON.stringify(logs).includes("bodyWeightKg"), false);
});

test("batch body metrics dry-run does not write and reports planned actions", async () => {
  const memory = createMemoryBodyMetricSender({
    "2026-07-20": {
      bodyWeightKg: 68.4,
      timeZoneId: "Asia/Tokyo",
      updatedAt: "2026-07-20T00:00:00Z"
    }
  });
  const response = await saveBodyMetricsBatch(
    {
      records: [
        { date: "2026-07-20", bodyWeightKg: 68.4 },
        { date: "2026-07-21", bodyFatPercent: 17.5 }
      ],
      dryRun: true
    },
    "user-a",
    {
      now: new Date("2026-07-23T03:00:00Z"),
      send: memory.send,
      logger: silentLogger
    }
  );

  const body = parseResponse(response);
  assert.equal(body.outcome, "succeeded");
  const results = body.results as Array<JsonObject>;
  assert.deepEqual(results.map((result) => result.action), ["unchanged", "would_create"]);
  assert.equal(memory.updateCount(), 0);
  assert.equal(memory.records.has("2026-07-21"), false);
});

test("batch body metrics overwrite is idempotent and keeps unrelated Daily fields", async () => {
  const memory = createMemoryBodyMetricSender({
    "2026-07-20": {
      bodyWeightKg: 70,
      bodyFatPercent: 18,
      timeZoneId: "Asia/Tokyo",
      diary: "keep this diary",
      moodRating: 8
    }
  });
  const args = {
    records: [{ date: "2026-07-20", bodyWeightKg: 69.5 }],
    conflictPolicy: "overwrite",
    dryRun: false
  };
  const options = {
    now: new Date("2026-07-23T03:00:00Z"),
    send: memory.send,
    logger: silentLogger
  };
  const first = parseResponse(await saveBodyMetricsBatch(args, "user-a", options));
  const second = parseResponse(await saveBodyMetricsBatch(args, "user-a", options));

  assert.equal((first.results as Array<JsonObject>)[0].action, "updated");
  assert.equal((second.results as Array<JsonObject>)[0].action, "unchanged");
  assert.equal(memory.updateCount(), 1);
  assert.equal(memory.records.get("2026-07-20")?.bodyWeightKg, 69.5);
  assert.equal(memory.records.get("2026-07-20")?.bodyFatPercent, 18);
  assert.equal(memory.records.get("2026-07-20")?.diary, "keep this diary");
  assert.equal(memory.records.get("2026-07-20")?.moodRating, 8);
});

test("batch body metrics adds muscle mass to existing weight and fat records", async () => {
  const memory = createMemoryBodyMetricSender({
    "2026-07-20": {
      bodyWeightKg: 70,
      bodyFatPercent: 18,
      timeZoneId: "Asia/Tokyo",
      diary: "keep this diary"
    }
  });
  const response = await saveBodyMetricsBatch(
    {
      records: [{ date: "2026-07-20", muscleMassKg: 52.1 }],
      conflictPolicy: "reject",
      dryRun: false
    },
    "user-a",
    {
      now: new Date("2026-07-23T03:00:00Z"),
      send: memory.send,
      logger: silentLogger
    }
  );

  assert.equal((response.results as Array<JsonObject>)[0].action, "updated");
  assert.equal(memory.records.get("2026-07-20")?.muscleMassKg, 52.1);
  assert.equal(memory.records.get("2026-07-20")?.bodyWeightKg, 70);
  assert.equal(memory.records.get("2026-07-20")?.bodyFatPercent, 18);
  assert.equal(memory.records.get("2026-07-20")?.diary, "keep this diary");
});

test("batch body metrics rejects muscle mass greater than the same-day weight", async () => {
  const memory = createMemoryBodyMetricSender({
    "2026-07-20": { bodyWeightKg: 70, timeZoneId: "Asia/Tokyo" }
  });
  const response = await saveBodyMetricsBatch(
    {
      records: [{ date: "2026-07-20", muscleMassKg: 71 }],
      dryRun: true
    },
    "user-a",
    {
      now: new Date("2026-07-23T03:00:00Z"),
      send: memory.send,
      logger: silentLogger
    }
  );

  const result = (response.results as Array<JsonObject>)[0];
  assert.equal(result.status, "failed");
  assert.equal((result.error as JsonObject).code, "INCONSISTENT_BODY_METRICS");
  assert.equal(memory.updateCount(), 0);
});

test("batch body metrics rejects request-level errors before processing records", async () => {
  const memory = createMemoryBodyMetricSender();
  const response = await saveBodyMetricsBatch(
    {
      records: [{ date: "2026-07-20", bodyWeightKg: 68 }],
      timeZoneId: "Not/AZone",
      dryRun: false
    },
    "user-a",
    { send: memory.send, logger: silentLogger }
  );
  assert.equal((response.error as JsonObject).code, "INVALID_TIME_ZONE");
  assert.equal(memory.updateCount(), 0);
});

test("batch body metrics rejects an unknown record property without stopping other records", async () => {
  const memory = createMemoryBodyMetricSender();
  const response = await saveBodyMetricsBatch(
    {
      records: [
        { date: "2026-07-20", bodyWeightKg: 68, weightKg: 68 },
        { date: "2026-07-21", bodyFatPercent: 17 }
      ],
      dryRun: false
    },
    "user-a",
    {
      now: new Date("2026-07-23T03:00:00Z"),
      send: memory.send,
      logger: silentLogger
    }
  );

  const body = parseResponse(response);
  assert.equal(body.outcome, "partially_succeeded");
  const results = body.results as Array<JsonObject>;
  assert.equal((results[0].error as JsonObject).code, "UNKNOWN_PROPERTY");
  assert.equal(results[1].action, "created");
  assert.equal(memory.records.get("2026-07-21")?.bodyFatPercent, 17);
});

test("batch body metrics reports a concurrent update as a record-level failure", async () => {
  const send: BodyMetricDdbSender = async (command) => {
    if (command instanceof GetCommand) {
      return {
        Item: {
          bodyWeightKg: 70,
          timeZoneId: "Asia/Tokyo"
        }
      };
    }
    const error = new Error("simulated concurrent update");
    error.name = "ConditionalCheckFailedException";
    throw error;
  };
  const response = await saveBodyMetricsBatch(
    {
      records: [{ date: "2026-07-20", bodyWeightKg: 69.5 }],
      conflictPolicy: "overwrite",
      dryRun: false
    },
    "user-a",
    {
      now: new Date("2026-07-23T03:00:00Z"),
      send,
      logger: silentLogger
    }
  );

  const body = parseResponse(response);
  assert.equal(body.outcome, "failed");
  const result = (body.results as Array<JsonObject>)[0];
  assert.equal(result.status, "failed");
  assert.equal((result.error as JsonObject).code, "CONCURRENT_UPDATE");
});

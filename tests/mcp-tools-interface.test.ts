import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  type BodyMetricDdbSender,
  decodeNextToken,
  isValidBodyFatPercent,
  isValidBodyWeightKg,
  localDateInclusiveUpperKey,
  localDateStartUtc,
  normalizeNonNegativeDecimal,
  parseAnalysisExportSelection,
  parseLocalTime,
  parseYmd,
  resolveRecordDate,
  resolveTimeZoneId,
  saveBodyMetricsBatch
} from "../amplify/functions/mcp-tools-api/handler.ts";

type JsonObject = Record<string, unknown>;
const silentLogger = () => undefined;

function parseResponse(response: { body: string }): JsonObject {
  return JSON.parse(response.body) as JsonObject;
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
    }
    item.createdAt ??= values[":timestamp"];
    item.updatedAt = values[":timestamp"];
    item.otherActivities ??= values[":emptyActivities"];
    records.set(date, item);
    return {};
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

test("pagination tokens are bound to the original tool and range", () => {
  const context = JSON.stringify(["get_daily_records", "2026-07-01", "2026-07-13", "Asia/Tokyo"]);
  const token = Buffer.from(
    JSON.stringify({ version: 1, context, key: { userId: "user-a", recordDate: "2026-07-05" } }),
    "utf8"
  ).toString("base64url");
  assert.deepEqual(decodeNextToken(token, context), { userId: "user-a", recordDate: "2026-07-05" });
  assert.equal(decodeNextToken(token, `${context}:changed`), null);
  assert.equal(decodeNextToken("not-a-token", context), null);
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
    "gymVisits"
  ]);
  assert.equal(JSON.stringify([manifest, page]).includes("setDetails"), false);
  const handlerSource = await readFile("amplify/functions/mcp-tools-api/handler.ts", "utf8");
  assert.match(handlerSource, /schemaVersion: 2/);
  for (const field of [
    "weightInputMode",
    "loadMultiplier",
    "fixedWeightKg",
    "calculatedTotalWeightKg"
  ]) {
    assert.match(handlerSource, new RegExp(field), `${field} is missing from MCP output`);
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
    assert.equal(incomplete.response.statusCode, 400);
    assert.equal(parseResponse(incomplete.response).code, "INVALID_DATE_RANGE");
  }

  const reversed = parseAnalysisExportSelection({
    rangeMode: "dateRange",
    from: "2026-07-26",
    to: "2026-01-01"
  });
  assert.ok("response" in reversed);
});

test("body metrics schema requires the four Core API measurement fields", async () => {
  const schemas = JSON.parse(
    await readFile("amplify/agentcore/tool-schemas/mcp-tools.json", "utf8")
  ) as Array<{
    name: string;
    inputSchema: { properties: Record<string, unknown>; required?: string[] };
  }>;
  const schema = schemas.find((candidate) => candidate.name === "save_body_metrics");
  assert.ok(schema, "save_body_metrics schema is missing");
  assert.deepEqual(schema.inputSchema.required, [
    "bodyWeightKg",
    "bodyFatPercent",
    "date",
    "bodyMetricMeasuredTimeLocal"
  ]);
  assert.ok(Object.hasOwn(schema.inputSchema.properties, "timeZoneId"));
});

test("AI menu schema declares zero as the minimum weight", async () => {
  const schemas = JSON.parse(
    await readFile("amplify/agentcore/tool-schemas/mcp-tools.json", "utf8")
  ) as Array<{
    name: string;
    inputSchema: {
      properties: {
        items?: {
          items?: {
            properties?: Record<string, { minimum?: number; type?: string }>;
          };
        };
      };
    };
  }>;
  const schema = schemas.find((candidate) => candidate.name === "create_training_menu_set_from_ai");
  assert.ok(schema, "create_training_menu_set_from_ai schema is missing");
  assert.equal(schema.inputSchema.properties.items?.items?.properties?.defaultWeightKg?.minimum, 0);
  assert.equal(schema.inputSchema.properties.items?.items?.properties?.description?.type, "string");
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

  assert.equal(response.statusCode, 200);
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
  assert.equal(response.statusCode, 400);
  assert.equal(parseResponse(response).code, "INVALID_TIME_ZONE");
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

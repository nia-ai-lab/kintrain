import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  decodeNextToken,
  isValidBodyFatPercent,
  isValidBodyWeightKg,
  localDateInclusiveUpperKey,
  localDateStartUtc,
  parseLocalTime,
  parseYmd,
  resolveRecordDate,
  resolveTimeZoneId
} from "../amplify/functions/mcp-tools-api/handler.ts";

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
  assert.equal(isValidBodyWeightKg(0), false);
  assert.equal(isValidBodyWeightKg(Number.NaN), false);
  assert.equal(isValidBodyFatPercent(14.8), true);
  assert.equal(isValidBodyFatPercent(0), true);
  assert.equal(isValidBodyFatPercent(100), true);
  assert.equal(isValidBodyFatPercent(100.1), false);
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

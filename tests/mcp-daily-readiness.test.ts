import assert from "node:assert/strict";
import test from "node:test";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { hasValidPainAreas } from "../amplify/functions/daily-record-api/handler";
import { ddb } from "../amplify/functions/shared/ddb";
import {
  normalizeDailyRecordForMcp,
  saveDailyMealNotes
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
    internalFutureField: "private"
  });

  assert.equal(normalized.sleepHours, 7.5);
  assert.equal(normalized.restingHeartRate, 58);
  assert.equal(normalized.mealNotes, "朝：卵とヨーグルト\n昼：鶏肉とご飯");
  assert.deepEqual(normalized.painAreas, []);
  assert.equal(Object.hasOwn(normalized, "carbohydrateIntakeGrams"), false);
  assert.equal(Object.hasOwn(normalized, "userId"), false);
  assert.equal(Object.hasOwn(normalized, "internalFutureField"), false);
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

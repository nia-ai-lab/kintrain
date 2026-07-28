import assert from "node:assert/strict";
import test from "node:test";
import { buildTrainingCoachingSummary } from "../amplify/functions/mcp-tools-api/handler";

test("coaching summary aggregates sets, streaks, trends, and recorded-sample averages", () => {
  const summary = buildTrainingCoachingSummary(
    [
      {
        visitDateLocal: "2026-07-27",
        entries: [
          {
            trainingMenuItemId: "bench",
            trainingNameSnapshot: "ベンチプレス",
            bodyPartSnapshot: "胸",
            calculatedTotalWeightKg: 80,
            reps: 5,
            sets: 3,
            frequencySnapshot: 3
          }
        ]
      },
      {
        visitDateLocal: "2026-07-28",
        entries: [
          {
            trainingMenuItemId: "bench",
            trainingNameSnapshot: "ベンチプレス",
            bodyPartSnapshot: "胸",
            calculatedTotalWeightKg: 82.5,
            reps: 5,
            sets: 4,
            frequencySnapshot: 3
          }
        ]
      }
    ],
    [
      { recordDate: "2026-07-22", bodyWeightKg: 70 },
      {
        recordDate: "2026-07-28",
        bodyWeightKg: 72,
        sleepHours: 7.5,
        fatigueLevel: 4,
        painAreas: [],
        mealNotes: "昼：鶏肉とご飯"
      }
    ],
    "2026-07-22",
    "2026-07-28",
    "Asia/Tokyo"
  ) as Record<string, any>;

  assert.equal(summary.trainingDays, 2);
  assert.equal(summary.restDays, 5);
  assert.equal(summary.totalSets, 7);
  assert.equal(summary.longestTrainingStreak, 2);
  assert.equal(summary.currentTrainingStreakThroughEndDate, 2);
  assert.deepEqual(summary.bodyPartSets, [{ bodyPart: "胸", sets: 7 }]);
  assert.equal(summary.exercises[0].maxWeightKg, 82.5);
  assert.equal(summary.exercises[0].estimated1RmKg, 96.25);
  assert.equal(summary.exercises[0].elapsedDaysSinceLastPerformance, 0);
  assert.equal(summary.bodyMetrics.bodyWeightKg.sevenDay.average, 71);
  assert.equal(summary.bodyMetrics.bodyWeightKg.sevenDay.sampleCount, 2);
  assert.equal(summary.recentReadiness[0].sleepHours, 7.5);
  assert.equal(summary.recentReadiness[0].mealNotes, "昼：鶏肉とご飯");
});

test("coaching summary excludes visits outside the requested local-date range", () => {
  const summary = buildTrainingCoachingSummary(
    [
      {
        visitDateLocal: "2026-07-20",
        entries: [{ trainingMenuItemId: "squat", reps: 5, sets: 5, weightKg: 100 }]
      }
    ],
    [],
    "2026-07-21",
    "2026-07-28",
    "Asia/Tokyo"
  ) as Record<string, any>;

  assert.equal(summary.trainingDays, 0);
  assert.equal(summary.totalSets, 0);
  assert.deepEqual(summary.exercises, []);
});

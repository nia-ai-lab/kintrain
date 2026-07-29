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
            muscleTargetsSnapshot: [
              { muscleId: "chest_mid", role: "primary" },
              { muscleId: "triceps", role: "secondary" },
              { muscleId: "anterior_deltoid", role: "secondary" }
            ],
            movementPatternSnapshot: "horizontal_push",
            lateralitySnapshot: "bilateral",
            loadModelSnapshot: "external_load",
            classificationVersionSnapshot: 1,
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
            muscleTargetsSnapshot: [
              { muscleId: "chest_mid", role: "primary" },
              { muscleId: "triceps", role: "secondary" },
              { muscleId: "anterior_deltoid", role: "secondary" }
            ],
            movementPatternSnapshot: "horizontal_push",
            lateralitySnapshot: "bilateral",
            loadModelSnapshot: "external_load",
            classificationVersionSnapshot: 1,
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
  assert.deepEqual(summary.muscleGroupSets, [
    { groupId: "chest", label: "胸", primarySets: 7, secondarySets: 0, effectiveSets: 7 },
    { groupId: "arms", label: "腕", primarySets: 0, secondarySets: 7, effectiveSets: 3.5 },
    { groupId: "shoulders", label: "肩", primarySets: 0, secondarySets: 7, effectiveSets: 3.5 }
  ]);
  assert.deepEqual(summary.muscleSets, [
    { muscleId: "chest_mid", label: "胸（中部）", primarySets: 7, secondarySets: 0, effectiveSets: 7 },
    { muscleId: "triceps", label: "上腕三頭筋", primarySets: 0, secondarySets: 7, effectiveSets: 3.5 },
    {
      muscleId: "anterior_deltoid",
      label: "三角筋前部",
      primarySets: 0,
      secondarySets: 7,
      effectiveSets: 3.5
    }
  ]);
  assert.equal(summary.exercises[0].bestResistanceKg, 82.5);
  assert.equal(summary.exercises[0].estimated1RmKg, 96.25);
  assert.equal(summary.exercises[0].elapsedDaysSinceLastPerformance, 0);
  assert.equal(summary.bodyMetrics.bodyWeightKg.sevenDay.average, 71);
  assert.equal(summary.bodyMetrics.bodyWeightKg.sevenDay.sampleCount, 2);
  assert.equal(summary.recentReadiness[0].sleepHours, 7.5);
  assert.equal(summary.recentReadiness[0].mealNotes, "昼：鶏肉とご飯");
});

test("assisted bodyweight strength improves when assistance decreases", () => {
  const summary = buildTrainingCoachingSummary(
    [
      {
        visitDateLocal: "2026-07-27",
        entries: [
          {
            trainingMenuItemId: "assisted-pull-up",
            trainingNameSnapshot: "アシストチンニング",
            muscleTargetsSnapshot: [{ muscleId: "latissimus", role: "primary" }],
            movementPatternSnapshot: "vertical_pull",
            lateralitySnapshot: "bilateral",
            loadModelSnapshot: "assisted_bodyweight",
            classificationVersionSnapshot: 1,
            bodyWeightKgSnapshot: 72,
            calculatedTotalWeightKg: 19,
            reps: 8,
            sets: 3
          }
        ]
      },
      {
        visitDateLocal: "2026-07-28",
        entries: [
          {
            trainingMenuItemId: "assisted-pull-up",
            trainingNameSnapshot: "アシストチンニング",
            muscleTargetsSnapshot: [{ muscleId: "latissimus", role: "primary" }],
            movementPatternSnapshot: "vertical_pull",
            lateralitySnapshot: "bilateral",
            loadModelSnapshot: "assisted_bodyweight",
            classificationVersionSnapshot: 1,
            bodyWeightKgSnapshot: 72,
            calculatedTotalWeightKg: 12,
            reps: 8,
            sets: 3
          }
        ]
      }
    ],
    [],
    "2026-07-27",
    "2026-07-28",
    "Asia/Tokyo"
  ) as Record<string, any>;

  assert.equal(summary.exercises[0].bestResistanceKg, 60);
  assert.equal(summary.exercises[0].estimated1RmKg, 76);
  assert.deepEqual(
    summary.exercises[0].recentPerformanceTrend.map((performance: Record<string, unknown>) => ({
      inputWeightKg: performance.inputWeightKg,
      resistanceKg: performance.resistanceKg
    })),
    [
      { inputWeightKg: 19, resistanceKg: 53 },
      { inputWeightKg: 12, resistanceKg: 60 }
    ]
  );
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

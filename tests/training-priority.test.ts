import assert from "node:assert/strict";
import test from "node:test";
import { getPrioritizedTrainingSessionItems } from "../frontend/src/utils/training.ts";

type PriorityTestItem = {
  name: string;
  order: number;
  recommendedIntervalDays: number;
  lastPerformanceSnapshot?: {
    visitDateLocal?: string;
  };
};

const items: PriorityTestItem[] = [
  {
    name: "セット順1・本日実施",
    order: 1,
    recommendedIntervalDays: 8,
    lastPerformanceSnapshot: { visitDateLocal: "2026-07-28" }
  },
  {
    name: "セット順2・未実施",
    order: 2,
    recommendedIntervalDays: 1
  },
  {
    name: "セット順3・27日前",
    order: 3,
    recommendedIntervalDays: 1,
    lastPerformanceSnapshot: { visitDateLocal: "2026-07-01" }
  },
  {
    name: "セット順4・8日前",
    order: 4,
    recommendedIntervalDays: 8,
    lastPerformanceSnapshot: { visitDateLocal: "2026-07-20" }
  }
];

test("reusable menu combines set order and elapsed-time rank", () => {
  const result = getPrioritizedTrainingSessionItems({
    items,
    todayYmd: "2026-07-28",
    menuSetType: "reusable"
  });

  assert.deepEqual(
    result.map((item) => item.name),
    [
      "セット順2・未実施",
      "セット順1・本日実施",
      "セット順3・27日前",
      "セット順4・8日前"
    ]
  );
});

test("temporary menu preserves its configured order", () => {
  const result = getPrioritizedTrainingSessionItems({
    items,
    todayYmd: "2026-07-28",
    menuSetType: "temporary"
  });

  assert.deepEqual(
    result.map((item) => item.name),
    [
      "セット順1・本日実施",
      "セット順2・未実施",
      "セット順3・27日前",
      "セット順4・8日前"
    ]
  );
});

test("recommended interval does not affect the session order", () => {
  const reversedIntervals = items.map((item) => ({
    ...item,
    recommendedIntervalDays: 9 - item.recommendedIntervalDays
  }));

  const original = getPrioritizedTrainingSessionItems({
    items,
    todayYmd: "2026-07-28",
    menuSetType: "reusable"
  });
  const changed = getPrioritizedTrainingSessionItems({
    items: reversedIntervals,
    todayYmd: "2026-07-28",
    menuSetType: "reusable"
  });

  assert.deepEqual(
    changed.map((item) => item.name),
    original.map((item) => item.name)
  );
});

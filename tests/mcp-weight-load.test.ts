import assert from "node:assert/strict";
import test from "node:test";
import { normalizeEntries } from "../amplify/functions/training-history-api/handler.ts";

function entry(overrides: Record<string, unknown> = {}) {
  return {
    trainingMenuItemId: "menu-1",
    trainingNameSnapshot: "ベンチプレス",
    weightKg: 20,
    reps: 10,
    sets: 3,
    performedAtUtc: "2026-07-26T03:00:00Z",
    ...overrides
  };
}

test("per-side weight snapshots calculate total load on the backend", () => {
  const [normalized] = normalizeEntries([
    entry({
      weightInputModeSnapshot: "perSide",
      loadMultiplierSnapshot: 2,
      fixedWeightKgSnapshot: 20
    })
  ]);
  assert.equal(normalized.weightKg, 20);
  assert.equal(normalized.calculatedTotalWeightKg, 60);
});

test("direct weight mode always uses the entered total", () => {
  const [normalized] = normalizeEntries([
    entry({
      weightInputModeSnapshot: "direct",
      loadMultiplierSnapshot: 2,
      fixedWeightKgSnapshot: 20
    })
  ]);
  assert.equal(normalized.loadMultiplierSnapshot, 1);
  assert.equal(normalized.fixedWeightKgSnapshot, 0);
  assert.equal(normalized.calculatedTotalWeightKg, 20);
});

test("legacy weight records remain unspecified instead of being inferred", () => {
  const [normalized] = normalizeEntries([entry()]);
  assert.equal(normalized.weightInputModeSnapshot, "legacyUnspecified");
  assert.equal(normalized.loadMultiplierSnapshot, undefined);
  assert.equal(normalized.fixedWeightKgSnapshot, undefined);
  assert.equal(normalized.calculatedTotalWeightKg, undefined);
});

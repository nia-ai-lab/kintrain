import assert from "node:assert/strict";
import test from "node:test";
import { normalizeEntries } from "../amplify/functions/training-history-api/handler.ts";
import {
  calculateTotalWeightKg,
  formatWeightLoad
} from "../frontend/src/utils/weightLoad.ts";

function entry(overrides: Record<string, unknown> = {}) {
  return {
    trainingMenuItemId: "menu-1",
    trainingNameSnapshot: "ベンチプレス",
    muscleTargetsSnapshot: [
      { muscleId: "chest_mid", role: "primary" },
      { muscleId: "triceps", role: "secondary" }
    ],
    movementFamilySnapshot: "push",
    jointActionsSnapshot: ["shoulder_horizontal_adduction", "elbow_extension"],
    lateralitySnapshot: "bilateral",
    loadModelSnapshot: "external_load",
    classificationVersionSnapshot: 2,
    equipmentTypeSnapshot: "barbell",
    weightKg: 20,
    reps: 10,
    sets: 3,
    performedAtUtc: "2026-07-26T03:00:00Z",
    ...overrides
  };
}

test("per-side weight snapshots include the fixed bar weight", () => {
  const [normalized] = normalizeEntries([
    entry({
      weightInputModeSnapshot: "perSide",
      loadMultiplierSnapshot: 2,
      fixedWeightKgSnapshot: 20
    })
  ]);
  assert.equal(normalized.weightKg, 20);
  assert.equal(normalized.fixedWeightKgSnapshot, 20);
  assert.equal(normalized.calculatedTotalWeightKg, 60);
  assert.equal(calculateTotalWeightKg(20, "perSide", 2, 20), 60);
  assert.equal(
    formatWeightLoad({
      weightKg: 20,
      weightInputModeSnapshot: "perSide",
      loadMultiplierSnapshot: 2,
      fixedWeightKgSnapshot: 20
    }),
    "片側20kg（総重量60kg = ×2 + 固定20kg）"
  );
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

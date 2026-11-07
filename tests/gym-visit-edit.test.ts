import assert from "node:assert/strict";
import test from "node:test";
import type { GymVisitDto } from "../frontend/src/api/coreApi.ts";
import { validateEntries } from "../amplify/functions/training-history-api/handler.ts";
import { buildGymVisitUpdate, getWeightFieldKind, toEntryEdit } from "../frontend/src/utils/gymVisitEdit.ts";

function squatVisit(): GymVisitDto {
  // Shaped like a GET /gym-visits/{visitId} response, including the nulls the API returns.
  return {
    visitId: "visit-1",
    startedAtUtc: "2026-11-07T08:30:54Z",
    endedAtUtc: "2026-11-07T09:43:39Z",
    timeZoneId: "Asia/Tokyo",
    visitDateLocal: "2026-11-07",
    note: null,
    createdAt: "2026-11-07T09:43:39Z",
    updatedAt: "2026-11-07T09:43:39Z",
    entries: [
      {
        trainingMenuItemId: "squat",
        trainingNameSnapshot: "バーベルスクワット",
        muscleTargetsSnapshot: [{ muscleId: "quadriceps", role: "primary" }],
        movementFamilySnapshot: "squat",
        jointActionsSnapshot: ["knee_extension"],
        lateralitySnapshot: "bilateral",
        loadModelSnapshot: "external_load",
        classificationVersionSnapshot: 2,
        bodyWeightKgSnapshot: null,
        equipmentTypeSnapshot: "barbell",
        equipmentProfileIdSnapshot: null,
        cableSettingsSnapshot: null,
        weightKg: 25,
        additionalLoadKg: null,
        assistanceKg: null,
        weightInputModeSnapshot: "perSide",
        loadMultiplierSnapshot: 2,
        fixedWeightKgSnapshot: 20,
        calculatedTotalWeightKg: 70,
        reps: 10,
        sets: 1,
        performedAtUtc: "2026-11-07T09:43:39Z",
        note: null
      },
      {
        trainingMenuItemId: "chin",
        trainingNameSnapshot: "アシストチンニング",
        muscleTargetsSnapshot: [{ muscleId: "latissimus", role: "primary" }],
        movementFamilySnapshot: "pull",
        jointActionsSnapshot: ["shoulder_adduction"],
        lateralitySnapshot: "bilateral",
        loadModelSnapshot: "assisted_bodyweight",
        classificationVersionSnapshot: 2,
        equipmentTypeSnapshot: "assisted_machine",
        weightKg: 12,
        assistanceKg: 12,
        weightInputModeSnapshot: "direct",
        reps: 8,
        sets: 3,
        performedAtUtc: "2026-11-07T09:43:39Z",
        note: "リバース"
      }
    ]
  } as unknown as GymVisitDto;
}

test("corrects the set count and keeps everything else that was recorded", () => {
  const visit = squatVisit();
  const edits = visit.entries.map(toEntryEdit);
  edits[0] = { ...edits[0], sets: "3" };

  const result = buildGymVisitUpdate(visit, edits);
  assert.ok(result.ok);
  const [squat, chin] = result.input.entries;
  assert.equal(squat.sets, 3);
  assert.equal(squat.reps, 10);
  assert.equal(squat.weightKg, 25);
  assert.equal(squat.weightInputModeSnapshot, "perSide");
  assert.equal(squat.fixedWeightKgSnapshot, 20);
  assert.equal(squat.performedAtUtc, "2026-11-07T09:43:39Z");
  assert.equal(chin.note, "リバース");
  assert.equal(result.input.visitDateLocal, "2026-11-07");
  assert.equal(result.input.startedAtUtc, "2026-11-07T08:30:54Z");
});

test("drops the nulls the update API rejects and lets the server recalculate the total", () => {
  const visit = squatVisit();
  const result = buildGymVisitUpdate(visit, visit.entries.map(toEntryEdit));
  assert.ok(result.ok);
  const [squat] = result.input.entries;
  for (const key of ["bodyWeightKgSnapshot", "equipmentProfileIdSnapshot", "cableSettingsSnapshot", "additionalLoadKg", "note"]) {
    assert.equal(key in squat, false, `${key} should be omitted`);
  }
  assert.equal(squat.assistanceKg, null);
  assert.equal("calculatedTotalWeightKg" in squat, false);
  assert.equal("note" in result.input, false);
});

test("builds entries the update API accepts, unlike the raw API response", () => {
  const visit = squatVisit();
  // Sending the stored entries back as-is fails because of their null fields.
  assert.equal(validateEntries(visit.entries as never), false);
  const result = buildGymVisitUpdate(visit, visit.entries.map(toEntryEdit));
  assert.ok(result.ok);
  assert.equal(validateEntries(result.input.entries as never), true);
});

test("keeps the assistance value in step with a corrected weight", () => {
  const visit = squatVisit();
  assert.equal(getWeightFieldKind(visit.entries[1]), "assistance");
  const edits = visit.entries.map(toEntryEdit);
  edits[1] = { ...edits[1], weightKg: "10" };
  const result = buildGymVisitUpdate(visit, edits);
  assert.ok(result.ok);
  assert.equal(result.input.entries[1].weightKg, 10);
  assert.equal(result.input.entries[1].assistanceKg, 10);
});

test("removes an exercise but never every exercise", () => {
  const visit = squatVisit();
  const edits = visit.entries.map(toEntryEdit);
  edits[1] = { ...edits[1], removed: true };
  const result = buildGymVisitUpdate(visit, edits);
  assert.ok(result.ok);
  assert.deepEqual(result.input.entries.map((entry) => entry.trainingMenuItemId), ["squat"]);

  const allRemoved = buildGymVisitUpdate(visit, edits.map((edit) => ({ ...edit, removed: true })));
  assert.equal(allRemoved.ok, false);
});

test("rejects counts that are not positive integers and empty weights", () => {
  const visit = squatVisit();
  for (const patch of [{ sets: "0" }, { reps: "2.5" }, { reps: "" }, { weightKg: "" }, { weightKg: "-1" }]) {
    const edits = visit.entries.map(toEntryEdit);
    edits[0] = { ...edits[0], ...patch };
    assert.equal(buildGymVisitUpdate(visit, edits).ok, false, JSON.stringify(patch));
  }
});

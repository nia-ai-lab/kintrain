import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("menu updates preserve fixed weight and taxonomy migration does not strip it", async () => {
  const [menuHandler, migration] = await Promise.all([
    readFile("amplify/functions/training-menu-api/handler.ts", "utf8"),
    readFile("scripts/migrate-muscle-targets.ts", "utf8")
  ]);

  assert.match(menuHandler, /fixedWeightKg=:fixedWeightKg/);
  assert.doesNotMatch(menuHandler, /REMOVE[^\n"]*fixedWeightKg/);

  const legacyMenuKeys = /const legacyMenuKeys = \[([\s\S]*?)\];/.exec(migration)?.[1] ?? "";
  const legacySnapshotKeys = /const legacySnapshotKeys = \[([\s\S]*?)\];/.exec(migration)?.[1] ?? "";
  assert.equal(legacyMenuKeys.includes("fixedWeightKg"), false);
  assert.equal(legacySnapshotKeys.includes("fixedWeightKgSnapshot"), false);
  assert.match(migration, /fixedWeightKgSnapshot: entry\.fixedWeightKgSnapshot/);
});

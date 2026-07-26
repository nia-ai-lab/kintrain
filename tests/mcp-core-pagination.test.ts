import assert from "node:assert/strict";
import test from "node:test";
import { decodePageToken, encodePageToken } from "../amplify/functions/shared/pagination.ts";

test("Core API page tokens are bound to their range and authenticated user", () => {
  const context = JSON.stringify(["daily-records", "2026-01-01", "2026-07-26"]);
  const token = encodePageToken(
    {
      userId: "user-a",
      recordDate: "2026-03-01"
    },
    context
  );
  assert.ok(token);
  assert.deepEqual(decodePageToken(token, context, "user-a"), {
    userId: "user-a",
    recordDate: "2026-03-01"
  });
  assert.equal(decodePageToken(token, context, "user-b"), null);
  assert.equal(decodePageToken(token, `${context}:changed`, "user-a"), null);
  assert.equal(decodePageToken("invalid", context, "user-a"), null);
});

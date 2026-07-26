import assert from "node:assert/strict";
import test from "node:test";
import { decodePageToken, encodePageToken } from "../amplify/functions/shared/pagination.ts";

const signingSecret = "test-pagination-signing-key-with-at-least-thirty-two-characters";

test("Core API page tokens hide user identity and reject tampering or reuse", async () => {
  const context = JSON.stringify(["daily-records", "2026-01-01", "2026-07-26"]);
  const token = await encodePageToken(
    {
      userId: "user-a",
      recordDate: "2026-03-01"
    },
    context,
    "user-a",
    signingSecret
  );
  assert.ok(token);
  const [encodedPayload, signature] = token.split(".");
  const decodedPayload = Buffer.from(encodedPayload, "base64url").toString("utf8");
  assert.equal(decodedPayload.includes("userId"), false);
  assert.equal(decodedPayload.includes("user-a"), false);
  assert.deepEqual(await decodePageToken(token, context, "user-a", signingSecret), {
    userId: "user-a",
    recordDate: "2026-03-01"
  });
  assert.equal(await decodePageToken(token, context, "user-b", signingSecret), null);
  assert.equal(await decodePageToken(token, `${context}:changed`, "user-a", signingSecret), null);

  const modifiedPayload = Buffer.from(
    JSON.stringify({ version: 2, cursor: { recordDate: "2026-03-02" } }),
    "utf8"
  ).toString("base64url");
  assert.equal(
    await decodePageToken(`${modifiedPayload}.${signature}`, context, "user-a", signingSecret),
    null
  );

  const legacyToken = Buffer.from(
    JSON.stringify({
      version: 1,
      context,
      key: { userId: "user-a", recordDate: "2026-03-01" }
    }),
    "utf8"
  ).toString("base64url");
  assert.equal(await decodePageToken(legacyToken, context, "user-a", signingSecret), null);
  assert.equal(await decodePageToken("invalid", context, "user-a", signingSecret), null);
  assert.equal(await decodePageToken("a".repeat(4097), context, "user-a", signingSecret), null);
  await assert.rejects(() =>
    encodePageToken(
      { userId: "user-b", recordDate: "2026-03-01" },
      context,
      "user-a",
      signingSecret
    )
  );
});

test("page tokens round-trip every current DynamoDB pagination key shape without userId", async () => {
  const keyShapes: Record<string, unknown>[] = [
    { userId: "user-a", recordDate: "2026-03-01" },
    {
      userId: "user-a",
      visitId: "visit-1",
      startedAtUtc: "2026-03-01T09:00:00Z"
    },
    {
      userId: "user-a",
      trainingPerformanceId: "performance-1",
      trainingMenuItemPerformedAtKey: "menu-1#2026-03-01T09:00:00Z"
    },
    {
      userId: "user-a",
      trainingMenuItemId: "menu-1",
      displayOrder: 3
    },
    {
      userId: "user-a",
      trainingMenuSetId: "set-1",
      menuSetOrder: 2
    }
  ];

  for (const [index, key] of keyShapes.entries()) {
    const context = JSON.stringify(["pagination-shape", index]);
    const token = await encodePageToken(key, context, "user-a", signingSecret);
    assert.ok(token);
    const decodedPayload = Buffer.from(token.split(".")[0], "base64url").toString("utf8");
    assert.equal(decodedPayload.includes("userId"), false);
    assert.equal(decodedPayload.includes("user-a"), false);
    assert.deepEqual(await decodePageToken(token, context, "user-a", signingSecret), key);
  }
});

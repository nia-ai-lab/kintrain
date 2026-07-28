import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand
} from "@aws-sdk/lib-dynamodb";
import {
  appendCoachingNoteData,
  CoachingValidationError,
  CoachingVersionConflictError,
  coachingNoteRetentionDays,
  coachingRevisionRetentionDays,
  maxActiveCoachingNotes,
  maxCoachingRevisions,
  maxReturnedCoachingNotes,
  normalizeCoachingContextUpdate,
  normalizeCoachingNoteInput,
  getCoachingContextData,
  updateCoachingContextData
} from "../amplify/functions/shared/coaching-context-store.ts";
import { ddb } from "../amplify/functions/shared/ddb.ts";

test("coaching context normalizes lists and requires optimistic versioning", () => {
  const normalized = normalizeCoachingContextUpdate({
    goalSummary: " 筋力を維持する ",
    constraints: [" 平日は60分 ", "平日は60分"],
    preferences: ["フリーウェイトを優先"],
    trainingPolicy: " フォームを優先 ",
    nextReviewDate: "2026-08-31",
    expectedVersion: 2,
    source: "claude",
    changeReason: " 4週間の振り返り "
  });

  assert.deepEqual(normalized, {
    goalSummary: "筋力を維持する",
    constraints: ["平日は60分"],
    preferences: ["フリーウェイトを優先"],
    trainingPolicy: "フォームを優先",
    nextReviewDate: "2026-08-31",
    expectedVersion: 2,
    source: "claude",
    changeReason: "4週間の振り返り"
  });

  assert.throws(
    () =>
      normalizeCoachingContextUpdate({
        goalSummary: "",
        constraints: [],
        preferences: [],
        trainingPolicy: "",
        expectedVersion: -1,
        source: "chatgpt",
        changeReason: "更新"
      }),
    CoachingValidationError
  );
});

test("coaching note validates category and effective date order", () => {
  assert.deepEqual(
    normalizeCoachingNoteInput({
      idempotencyKey: "chat-1-note-1",
      category: "follow-up",
      content: " 次回は肩の違和感を確認 ",
      validFromDate: "2026-07-28",
      validToDate: "2026-08-04",
      source: "chatgpt"
    }),
    {
      idempotencyKey: "chat-1-note-1",
      category: "follow-up",
      content: "次回は肩の違和感を確認",
      validFromDate: "2026-07-28",
      validToDate: "2026-08-04",
      source: "chatgpt"
    }
  );

  assert.throws(
    () =>
      normalizeCoachingNoteInput({
        idempotencyKey: "invalid-range",
        category: "observation",
        content: "確認",
        validFromDate: "2026-08-04",
        validToDate: "2026-07-28",
        source: "claude"
      }),
    CoachingValidationError
  );
});

test("coaching storage limits remain bounded", () => {
  assert.equal(coachingNoteRetentionDays, 90);
  assert.equal(coachingRevisionRetentionDays, 365);
  assert.equal(maxActiveCoachingNotes, 50);
  assert.equal(maxCoachingRevisions, 50);
  assert.equal(maxReturnedCoachingNotes, 10);
});

test("coaching store versions current state and deduplicates temporary notes", async () => {
  const records = new Map<string, Record<string, unknown>>();
  const originalSend = ddb.send.bind(ddb);
  const keyFor = (userId: unknown, recordKey: unknown) => `${String(userId)}|${String(recordKey)}`;
  const memorySend = async (command: unknown): Promise<Record<string, unknown>> => {
    if (command instanceof GetCommand) {
      const key = command.input.Key ?? {};
      const item = records.get(keyFor(key.userId, key.recordKey));
      return { Item: item ? structuredClone(item) : undefined };
    }
    if (command instanceof QueryCommand) {
      const values = command.input.ExpressionAttributeValues ?? {};
      const userId = values[":userId"];
      const prefix = String(values[":prefix"] ?? "");
      return {
        Items: Array.from(records.values())
          .filter((item) => item.userId === userId && String(item.recordKey).startsWith(prefix))
          .map((item) => structuredClone(item))
      };
    }
    if (command instanceof PutCommand) {
      const item = structuredClone(command.input.Item ?? {});
      records.set(keyFor(item.userId, item.recordKey), item);
      return {};
    }
    if (command instanceof DeleteCommand) {
      const key = command.input.Key ?? {};
      records.delete(keyFor(key.userId, key.recordKey));
      return {};
    }
    if (command instanceof TransactWriteCommand) {
      for (const write of command.input.TransactItems ?? []) {
        if (write.Put?.Item) {
          const item = structuredClone(write.Put.Item);
          records.set(keyFor(item.userId, item.recordKey), item);
        }
      }
      return {};
    }
    if (command instanceof BatchWriteCommand) {
      for (const writes of Object.values(command.input.RequestItems ?? {})) {
        for (const write of writes ?? []) {
          const key = write.DeleteRequest?.Key;
          if (key) {
            records.delete(keyFor(key.userId, key.recordKey));
          }
        }
      }
      return { UnprocessedItems: {} };
    }
    throw new Error(`Unexpected command: ${String(command)}`);
  };

  ddb.send = memorySend as typeof ddb.send;
  try {
    const context = await updateCoachingContextData(
      "CoachingTable",
      "user-a",
      {
        goalSummary: "筋力維持",
        constraints: ["平日は60分"],
        preferences: [],
        trainingPolicy: "フォーム優先",
        expectedVersion: 0,
        source: "chatgpt",
        changeReason: "初回設定"
      },
      new Date("2026-07-28T00:00:00Z")
    );
    assert.equal(context.version, 1);

    await assert.rejects(
      () =>
        updateCoachingContextData(
          "CoachingTable",
          "user-a",
          {
            goalSummary: "競合",
            constraints: [],
            preferences: [],
            trainingPolicy: "",
            expectedVersion: 0,
            source: "claude",
            changeReason: "古い版"
          },
          new Date("2026-07-28T00:01:00Z")
        ),
      CoachingVersionConflictError
    );

    const noteInput = {
      idempotencyKey: "same-chat-note",
      category: "follow-up",
      content: "次回は肩の状態を確認",
      source: "claude"
    };
    const first = await appendCoachingNoteData(
      "CoachingTable",
      "user-a",
      noteInput,
      new Date("2026-07-28T00:02:00Z")
    );
    const duplicate = await appendCoachingNoteData(
      "CoachingTable",
      "user-a",
      noteInput,
      new Date("2026-07-28T00:03:00Z")
    );
    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.note.noteId, first.note.noteId);
    assert.equal(first.note.expiresAt, "2026-10-26T00:02:00Z");

    const stored = await getCoachingContextData(
      "CoachingTable",
      "user-a",
      new Date("2026-07-28T00:04:00Z")
    );
    assert.equal(stored.context.version, 1);
    assert.equal(stored.notes.length, 1);
    assert.equal(stored.revisions.length, 1);
  } finally {
    ddb.send = originalSend as typeof ddb.send;
  }
});

test("MCP exposes coaching context tools and removes save_advice_log", async () => {
  const schemas = JSON.parse(
    await readFile("amplify/agentcore/tool-schemas/mcp-tools.json", "utf8")
  ) as Array<{
    name: string;
    inputSchema: {
      properties: Record<string, { enum?: unknown[]; maxItems?: number }>;
      required?: string[];
    };
  }>;
  const names = schemas.map((schema) => schema.name);

  assert.equal(names.includes("save_advice_log"), false);
  assert.equal(names.includes("get_coaching_context"), true);
  assert.equal(names.includes("update_coaching_context"), true);
  assert.equal(names.includes("append_coaching_note"), true);

  const update = schemas.find((schema) => schema.name === "update_coaching_context");
  const append = schemas.find((schema) => schema.name === "append_coaching_note");
  assert.deepEqual(update?.inputSchema.properties.userConfirmed.enum, [true]);
  assert.equal(update?.inputSchema.properties.constraints.maxItems, 20);
  assert.deepEqual(append?.inputSchema.properties.userConfirmed.enum, [true]);
});

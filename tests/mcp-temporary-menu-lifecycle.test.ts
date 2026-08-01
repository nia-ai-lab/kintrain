import assert from "node:assert/strict";
import test from "node:test";
import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "../amplify/functions/shared/ddb";
import {
  createTemporaryTrainingMenuSetFromAi,
  getTrainingPlanForDate,
  rescheduleTemporaryTrainingPlan
} from "../amplify/functions/mcp-tools-api/handler";

test("AI temporary menu stores complete rest days as explicit daily plan types", async () => {
  const originalSend = ddb.send.bind(ddb);
  let writes: any[] = [];
  (ddb as any).send = async (command: any) => {
    if (command instanceof GetCommand) {
      const key = command.input.Key as Record<string, string>;
      if (key.planDate) return {};
      if (key.trainingMenuItemId === "menu-1") {
        return { Item: { userId: "user-1", trainingMenuItemId: "menu-1", isActive: true } };
      }
    }
    if (command instanceof QueryCommand) {
      return { Items: [] };
    }
    if (command instanceof TransactWriteCommand) {
      writes = command.input.TransactItems ?? [];
      return {};
    }
    throw new Error(`Unexpected command: ${command.constructor.name}`);
  };

  try {
    const result = await createTemporaryTrainingMenuSetFromAi({
      idempotencyKey: "weekly-plan-1",
      validFromDate: "2026-08-01",
      validToDate: "2026-08-03",
      setName: "週間メニュー",
      restDates: ["2026-08-02"],
      items: [{
        existingTrainingMenuItemId: "menu-1",
        prescription: {
          targetWeightKg: 50,
          targetRepsMin: 8,
          targetRepsMax: 12,
          targetSets: 3,
          recommendedIntervalDays: 2,
          instruction: "フォーム優先"
        }
      }]
    }, "user-1") as Record<string, any>;

    assert.deepEqual(result.restDates, ["2026-08-02"]);
    const setWrite = writes.find((write) => write.Put?.Item?.setType === "temporary");
    assert.deepEqual(setWrite.Put.Item.restDates, ["2026-08-02"]);
    const dailyPlans = writes
      .map((write) => write.Put?.Item)
      .filter((item) => item?.planDate)
      .map((item) => [item.planDate, item.planType]);
    assert.deepEqual(dailyPlans, [
      ["2026-08-01", "training"],
      ["2026-08-02", "rest"],
      ["2026-08-03", "training"]
    ]);
  } finally {
    (ddb as any).send = originalSend;
  }
});

test("reschedule keeps the same set and item content, moves the date, and replays idempotently", async () => {
  const userId = "user-1";
  const set: Record<string, any> = {
    userId,
    trainingMenuSetId: "set-1",
    setName: "今日のメニュー",
    setType: "temporary",
    source: "ai",
    validFromDate: "2026-07-28",
    validToDate: "2026-07-28",
    isActive: true,
    version: 0,
    createdAt: "2026-07-28T00:00:00Z",
    updatedAt: "2026-07-28T00:00:00Z"
  };
  const link = {
    userId,
    trainingMenuSetItemId: "set-item-1",
    trainingMenuSetId: "set-1",
    trainingMenuItemId: "menu-1",
    displayOrder: 1,
    targetWeightKg: 80,
    targetRepsMin: 5,
    targetRepsMax: 8,
    targetSets: 3,
    recommendedIntervalDays: 3,
    instruction: "フォーム優先"
  };
  const menu = {
    userId,
    trainingMenuItemId: "menu-1",
    trainingName: "ベンチプレス",
    muscleTargets: [
      { muscleId: "chest_mid", role: "primary" },
      { muscleId: "triceps", role: "secondary" },
      { muscleId: "anterior_deltoid", role: "secondary" }
    ],
    movementPattern: "horizontal_push",
    laterality: "bilateral",
    loadModel: "external_load",
    classificationVersion: 1,
    equipment: "フリー",
    isActive: true
  };
  const plans = new Map<string, Record<string, any>>([
    [
      "2026-07-28",
      {
        userId,
        planDate: "2026-07-28",
        trainingMenuSetId: "set-1",
        source: "ai",
        createdAt: "2026-07-28T00:00:00Z",
        updatedAt: "2026-07-28T00:00:00Z"
      }
    ]
  ]);
  const itemBefore = structuredClone(link);
  const originalSend = ddb.send.bind(ddb);
  (ddb as any).send = async (command: any) => {
    if (command instanceof GetCommand) {
      const key = command.input.Key as Record<string, string>;
      if (key.trainingMenuSetId) return { Item: set };
      if (key.planDate) return { Item: plans.get(key.planDate) };
      if (key.trainingMenuItemId) return { Item: menu };
    }
    if (command instanceof QueryCommand) {
      if (command.input.IndexName === "UserSetItemsBySetOrderIndex") {
        return { Items: [link] };
      }
      return { Items: Array.from(plans.values()) };
    }
    if (command instanceof BatchGetCommand) {
      return { Responses: { "": [menu] } };
    }
    if (command instanceof TransactWriteCommand) {
      for (const transaction of command.input.TransactItems ?? []) {
        if (transaction.Update?.Key?.trainingMenuSetId) {
          const values = transaction.Update.ExpressionAttributeValues as Record<string, any>;
          Object.assign(set, {
            validFromDate: values[":validFromDate"] ?? set.validFromDate,
            validToDate: values[":validToDate"] ?? set.validToDate,
            version: values[":nextVersion"],
            updatedAt: values[":updatedAt"],
            updatedBy: values[":updatedBy"],
            updateReason: values[":updateReason"],
            lastMutationKey: values[":lastMutationKey"],
            lastMutationHash: values[":lastMutationHash"],
            lastMutationChanges: values[":lastMutationChanges"]
          });
        }
        if (transaction.Delete?.Key?.planDate) {
          plans.delete(String(transaction.Delete.Key.planDate));
        }
        if (transaction.Put?.Item?.planDate) {
          plans.set(String(transaction.Put.Item.planDate), transaction.Put.Item as Record<string, any>);
        }
      }
      return {};
    }
    throw new Error(`Unexpected command: ${command.constructor.name}`);
  };

  try {
    const request = {
      trainingMenuSetId: "set-1",
      newValidFromDate: "2026-07-29",
      newValidToDate: "2026-07-29",
      expectedVersion: 0,
      idempotencyKey: "move-2026-07-29",
      conflictPolicy: "reject"
    };
    const result = await rescheduleTemporaryTrainingPlan(request, userId);
    assert.equal(result.trainingMenuSetId, "set-1");
    assert.equal(result.version, 1);
    assert.equal(plans.has("2026-07-28"), false);
    assert.equal(plans.get("2026-07-29")?.trainingMenuSetId, "set-1");
    assert.equal(plans.get("2026-07-29")?.planType, "training");
    assert.deepEqual(link, itemBefore);

    const resolved = await getTrainingPlanForDate({ date: "2026-07-29" }, userId) as Record<string, any>;
    assert.equal(resolved.plan.trainingMenuSetId, "set-1");
    assert.equal(resolved.plan.items[0].trainingMenuSetItemId, "set-item-1");
    assert.equal(resolved.plan.items[0].trainingName, "ベンチプレス");
    assert.equal(resolved.plan.items[0].targetWeightKg, 80);

    const replay = await rescheduleTemporaryTrainingPlan(request, userId);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(plans.size, 1);

    const stale = await rescheduleTemporaryTrainingPlan(
      { ...request, idempotencyKey: "stale-request", newValidFromDate: "2026-07-30", newValidToDate: "2026-07-30" },
      userId
    ) as Record<string, any>;
    assert.equal(stale.error.code, "VERSION_CONFLICT");
    assert.equal(plans.get("2026-07-29")?.trainingMenuSetId, "set-1");

    plans.set("2026-07-30", {
      userId,
      planDate: "2026-07-30",
      trainingMenuSetId: "set-2",
      source: "ai"
    });
    const conflict = await rescheduleTemporaryTrainingPlan(
      {
        trainingMenuSetId: "set-1",
        newValidFromDate: "2026-07-30",
        newValidToDate: "2026-07-30",
        expectedVersion: 1,
        idempotencyKey: "conflict-request",
        conflictPolicy: "reject"
      },
      userId
    ) as Record<string, any>;
    assert.equal(conflict.error.code, "DATE_CONFLICT");
    assert.equal(plans.get("2026-07-29")?.trainingMenuSetId, "set-1");

    plans.set("2026-07-31", {
      userId,
      planDate: "2026-07-31",
      trainingMenuSetId: "set-1",
      planType: "rest",
      source: "ai"
    });
    const rest = await getTrainingPlanForDate({ date: "2026-07-31" }, userId) as Record<string, any>;
    assert.equal(rest.plan.planType, "rest");
    assert.equal(rest.plan.menuSet.trainingMenuSetId, "set-1");
    assert.equal(Object.hasOwn(rest.plan, "items"), false);
  } finally {
    (ddb as any).send = originalSend;
  }
});

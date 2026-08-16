import assert from "node:assert/strict";
import test from "node:test";
import type { APIGatewayProxyEvent } from "aws-lambda";

test("menu set list separates inactive temporary sets from the active list", async () => {
  process.env.TRAINING_MENU_TABLE_NAME = "menus";
  process.env.TRAINING_MENU_SET_TABLE_NAME = "menu-sets";
  process.env.TRAINING_MENU_SET_ITEM_TABLE_NAME = "menu-set-items";
  process.env.DAILY_TRAINING_PLAN_TABLE_NAME = "daily-plans";

  const [{ ddb }, { handler }] = await Promise.all([
    import("../amplify/functions/shared/ddb"),
    import("../amplify/functions/training-menu-api/handler")
  ]);
  const client = ddb as unknown as {
    send: (command: { input: { TableName?: string } }) => Promise<{ Items: Record<string, unknown>[] }>;
  };
  const originalSend = client.send;
  client.send = async (command) => {
    if (command.input.TableName === "menu-sets") {
      return {
        Items: [
          {
            userId: "user-1",
            trainingMenuSetId: "active-1",
            setName: "Active",
            setType: "temporary",
            isActive: true,
            menuSetOrder: 1
          },
          {
            userId: "user-1",
            trainingMenuSetId: "inactive-temporary-1",
            setName: "Inactive temporary",
            setType: "temporary",
            isActive: false,
            menuSetOrder: 2,
            canceledAt: "2026-08-01T00:00:00Z",
            cancelReason: "Canceled"
          },
          {
            userId: "user-1",
            trainingMenuSetId: "inactive-reusable-1",
            setName: "Inactive reusable",
            setType: "reusable",
            isActive: false,
            menuSetOrder: 3
          }
        ]
      };
    }
    return { Items: [] };
  };

  const event = {
    httpMethod: "GET",
    path: "/training-menu-sets",
    queryStringParameters: { state: "inactive-temporary" },
    requestContext: {
      stage: "$default",
      authorizer: { claims: { sub: "user-1" } }
    }
  } as unknown as APIGatewayProxyEvent;

  try {
    const inactiveResponse = await handler(event);
    assert.equal(inactiveResponse.statusCode, 200);
    const inactiveItems = JSON.parse(inactiveResponse.body).items;
    assert.deepEqual(inactiveItems.map((item: { trainingMenuSetId: string }) => item.trainingMenuSetId), [
      "inactive-temporary-1"
    ]);
    assert.equal(inactiveItems[0].canceledAt, "2026-08-01T00:00:00Z");
    assert.equal(inactiveItems[0].cancelReason, "Canceled");

    const activeResponse = await handler({ ...event, queryStringParameters: null });
    const activeItems = JSON.parse(activeResponse.body).items;
    assert.deepEqual(activeItems.map((item: { trainingMenuSetId: string }) => item.trainingMenuSetId), ["active-1"]);
  } finally {
    client.send = originalSend;
  }
});

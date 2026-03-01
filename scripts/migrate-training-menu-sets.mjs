#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const userMenuByOrderIndex = "UserDisplayOrderIndex";
const defaultSetMarker = "DEFAULT";

function nowIsoSeconds() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/migrate-training-menu-sets.mjs --user-id <cognito-sub> [--set-name <name>] [--dry-run]",
      "",
      "Required env vars:",
      "  TRAINING_MENU_TABLE_NAME",
      "  TRAINING_MENU_SET_TABLE_NAME",
      "  TRAINING_MENU_SET_ITEM_TABLE_NAME"
    ].join("\n")
  );
}

function getArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return "";
  }
  return process.argv[index + 1] ?? "";
}

function hasArg(name) {
  return process.argv.includes(name);
}

async function queryMenuItems(ddb, tableName, userId) {
  const items = [];
  let lastEvaluatedKey;

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: userMenuByOrderIndex,
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: {
          ":userId": userId
        },
        ExclusiveStartKey: lastEvaluatedKey
      })
    );
    for (const item of result.Items ?? []) {
      items.push(item);
    }
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return items
    .filter((item) => item.isActive !== false && typeof item.trainingMenuItemId === "string")
    .sort((a, b) => Number(a.displayOrder ?? 0) - Number(b.displayOrder ?? 0));
}

async function hasAnyMenuSet(ddb, tableName, userId) {
  const result = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "userId = :userId",
      ExpressionAttributeValues: {
        ":userId": userId
      },
      Limit: 1
    })
  );
  return (result.Items?.length ?? 0) > 0;
}

async function main() {
  const userId = getArg("--user-id");
  const setName = getArg("--set-name") || "メインメニュー";
  const dryRun = hasArg("--dry-run");

  const trainingMenuTableName = process.env.TRAINING_MENU_TABLE_NAME ?? "";
  const trainingMenuSetTableName = process.env.TRAINING_MENU_SET_TABLE_NAME ?? "";
  const trainingMenuSetItemTableName = process.env.TRAINING_MENU_SET_ITEM_TABLE_NAME ?? "";

  if (!userId || !trainingMenuTableName || !trainingMenuSetTableName || !trainingMenuSetItemTableName) {
    usage();
    process.exit(1);
  }

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const existingSet = await hasAnyMenuSet(ddb, trainingMenuSetTableName, userId);
  if (existingSet) {
    console.log("Skip: training menu set already exists for this user.");
    return;
  }

  const menuItems = await queryMenuItems(ddb, trainingMenuTableName, userId);
  const trainingMenuSetId = randomUUID();
  const ts = nowIsoSeconds();

  console.log(
    JSON.stringify(
      {
        userId,
        setName,
        trainingMenuSetId,
        itemCount: menuItems.length,
        dryRun
      },
      null,
      2
    )
  );

  if (dryRun) {
    return;
  }

  await ddb.send(
    new PutCommand({
      TableName: trainingMenuSetTableName,
      Item: {
        userId,
        trainingMenuSetId,
        setName,
        menuSetOrder: 1,
        isDefault: true,
        isActive: true,
        defaultSetMarker,
        createdAt: ts,
        updatedAt: ts
      },
      ConditionExpression: "attribute_not_exists(userId) AND attribute_not_exists(trainingMenuSetId)"
    })
  );

  let order = 1;
  for (const menuItem of menuItems) {
    const trainingMenuSetItemId = randomUUID();
    const trainingMenuItemId = String(menuItem.trainingMenuItemId);
    const padded = String(order).padStart(6, "0");
    await ddb.send(
      new PutCommand({
        TableName: trainingMenuSetItemTableName,
        Item: {
          userId,
          trainingMenuSetItemId,
          trainingMenuSetId,
          trainingMenuItemId,
          displayOrder: order,
          menuSetOrderKey: `${trainingMenuSetId}#${padded}`,
          menuSetItemKey: `${trainingMenuSetId}#${trainingMenuItemId}`,
          createdAt: ts,
          updatedAt: ts
        },
        ConditionExpression: "attribute_not_exists(userId) AND attribute_not_exists(trainingMenuSetItemId)"
      })
    );
    order += 1;
  }

  console.log(`Done: migrated ${menuItems.length} menu items into set ${trainingMenuSetId}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

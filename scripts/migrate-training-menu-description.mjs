#!/usr/bin/env node

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand
} from "@aws-sdk/lib-dynamodb";

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/migrate-training-menu-description.mjs --table-name <table> [--dry-run]",
      "",
      "The migration copies each menu item's memo to description and removes memo."
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

async function main() {
  const tableName = getArg("--table-name") || process.env.TRAINING_MENU_TABLE_NAME || "";
  const dryRun = hasArg("--dry-run");
  if (!tableName) {
    usage();
    process.exit(1);
  }

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  let lastEvaluatedKey;
  let scannedCount = 0;
  let migrationTargetCount = 0;
  let migratedCount = 0;
  let skippedCount = 0;

  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression: "userId, trainingMenuItemId, #memo, #description",
        ExpressionAttributeNames: {
          "#memo": "memo",
          "#description": "description"
        },
        ExclusiveStartKey: lastEvaluatedKey
      })
    );

    const items = result.Items ?? [];
    scannedCount += items.length;

    for (const item of items) {
      if (
        typeof item.userId !== "string" ||
        typeof item.trainingMenuItemId !== "string" ||
        typeof item.memo !== "string"
      ) {
        continue;
      }
      migrationTargetCount += 1;
      if (dryRun) {
        continue;
      }

      const hasDescription = typeof item.description === "string";
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: tableName,
            Key: {
              userId: item.userId,
              trainingMenuItemId: item.trainingMenuItemId
            },
            UpdateExpression: hasDescription
              ? "REMOVE #memo"
              : "SET #description = :description REMOVE #memo",
            ConditionExpression: "#memo = :expectedMemo",
            ExpressionAttributeNames: {
              "#memo": "memo",
              ...(hasDescription ? {} : { "#description": "description" })
            },
            ExpressionAttributeValues: {
              ":expectedMemo": item.memo,
              ...(hasDescription ? {} : { ":description": item.memo })
            }
          })
        );
        migratedCount += 1;
      } catch (error) {
        if (error instanceof Error && error.name === "ConditionalCheckFailedException") {
          skippedCount += 1;
          continue;
        }
        throw error;
      }
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  console.log(
    JSON.stringify(
      {
        tableName,
        dryRun,
        scannedCount,
        migrationTargetCount,
        migratedCount,
        skippedCount
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const userId = readArg("--user-id");
const dryRun = process.argv.includes("--dry-run");
const trainingMenuTableName = process.env.TRAINING_MENU_TABLE_NAME;
const trainingMenuSetTableName = process.env.TRAINING_MENU_SET_TABLE_NAME;
const trainingMenuSetItemTableName = process.env.TRAINING_MENU_SET_ITEM_TABLE_NAME;

if (!userId) {
  throw new Error("--user-id is required.");
}
if (!trainingMenuTableName || !trainingMenuSetTableName || !trainingMenuSetItemTableName) {
  throw new Error(
    "TRAINING_MENU_TABLE_NAME, TRAINING_MENU_SET_TABLE_NAME and TRAINING_MENU_SET_ITEM_TABLE_NAME are required."
  );
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

async function queryAll(input) {
  const items = [];
  let exclusiveStartKey;
  do {
    const result = await ddb.send(new QueryCommand({ ...input, ExclusiveStartKey: exclusiveStartKey }));
    items.push(...(result.Items ?? []));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

const [sets, links, allMenuItems] = await Promise.all([
  queryAll({
    TableName: trainingMenuSetTableName,
    IndexName: "UserMenuSetByOrderIndex",
    KeyConditionExpression: "userId = :userId",
    ExpressionAttributeValues: { ":userId": userId }
  }),
  queryAll({
    TableName: trainingMenuSetItemTableName,
    IndexName: "UserSetItemsBySetOrderIndex",
    KeyConditionExpression: "userId = :userId",
    ExpressionAttributeValues: { ":userId": userId }
  }),
  queryAll({
    TableName: trainingMenuTableName,
    IndexName: "UserDisplayOrderIndex",
    KeyConditionExpression: "userId = :userId",
    ExpressionAttributeValues: { ":userId": userId }
  })
]);

const menuItems = new Map(
  allMenuItems
    .filter((item) => typeof item.trainingMenuItemId === "string")
    .map((item) => [item.trainingMenuItemId, item])
);
for (const link of links) {
  if (!menuItems.has(link.trainingMenuItemId)) {
    throw new Error(`TrainingMenuItem not found: ${link.trainingMenuItemId}`);
  }
}

let migratedSets = 0;
let migratedLinks = 0;
let cleanedMenuItems = 0;

for (const set of sets) {
  const needsUpdate = set.setType !== "reusable" || (set.source !== "manual" && set.source !== "ai");
  if (!needsUpdate) {
    continue;
  }
  migratedSets += 1;
  if (!dryRun) {
    await ddb.send(
      new UpdateCommand({
        TableName: trainingMenuSetTableName,
        Key: { userId, trainingMenuSetId: set.trainingMenuSetId },
        UpdateExpression: "SET setType = :setType, #source = :source, updatedAt = :updatedAt REMOVE isAiGenerated",
        ExpressionAttributeNames: { "#source": "source" },
        ExpressionAttributeValues: {
          ":setType": "reusable",
          ":source": set.isAiGenerated === true ? "ai" : "manual",
          ":updatedAt": now
        }
      })
    );
  }
}

for (const link of links) {
  const alreadyMigrated =
    typeof link.targetWeightKg === "number" &&
    typeof link.targetRepsMin === "number" &&
    typeof link.targetRepsMax === "number" &&
    typeof link.targetSets === "number" &&
    typeof link.recommendedIntervalDays === "number";
  if (alreadyMigrated) {
    continue;
  }
  const menuItem = menuItems.get(link.trainingMenuItemId);
  const legacyReps = Number(menuItem.defaultReps);
  const targetRepsMin = Number(menuItem.defaultRepsMin ?? legacyReps);
  const targetRepsMax = Number(menuItem.defaultRepsMax ?? legacyReps);
  const targetWeightKg = Number(menuItem.defaultWeightKg);
  const targetSets = Number(menuItem.defaultSets);
  const recommendedIntervalDays = Number(menuItem.frequency);
  if (
    !Number.isFinite(targetWeightKg) ||
    targetWeightKg < 0 ||
    !Number.isInteger(targetRepsMin) ||
    targetRepsMin < 1 ||
    !Number.isInteger(targetRepsMax) ||
    targetRepsMax < targetRepsMin ||
    !Number.isInteger(targetSets) ||
    targetSets < 1 ||
    !Number.isInteger(recommendedIntervalDays) ||
    recommendedIntervalDays < 1 ||
    recommendedIntervalDays > 8
  ) {
    throw new Error(`Invalid legacy prescription for TrainingMenuItem: ${link.trainingMenuItemId}`);
  }
  migratedLinks += 1;
  if (!dryRun) {
    await ddb.send(
      new UpdateCommand({
        TableName: trainingMenuSetItemTableName,
        Key: { userId, trainingMenuSetItemId: link.trainingMenuSetItemId },
        UpdateExpression:
          "SET targetWeightKg = :targetWeightKg, targetRepsMin = :targetRepsMin, targetRepsMax = :targetRepsMax, targetSets = :targetSets, recommendedIntervalDays = :recommendedIntervalDays, instruction = :instruction, createdBy = :createdBy, updatedAt = :updatedAt",
        ExpressionAttributeValues: {
          ":targetWeightKg": targetWeightKg,
          ":targetRepsMin": targetRepsMin,
          ":targetRepsMax": targetRepsMax,
          ":targetSets": targetSets,
          ":recommendedIntervalDays": recommendedIntervalDays,
          ":instruction": "",
          ":createdBy": menuItem.isAiGenerated === true ? "ai" : "manual",
          ":updatedAt": now
        }
      })
    );
  }
}

for (const menuItem of menuItems.values()) {
  const hasLegacyPrescription =
    menuItem.frequency !== undefined ||
    menuItem.defaultWeightKg !== undefined ||
    menuItem.defaultRepsMin !== undefined ||
    menuItem.defaultRepsMax !== undefined ||
    menuItem.defaultReps !== undefined ||
    menuItem.defaultSets !== undefined;
  if (!hasLegacyPrescription) {
    continue;
  }
  cleanedMenuItems += 1;
  if (!dryRun) {
    await ddb.send(
      new UpdateCommand({
        TableName: trainingMenuTableName,
        Key: { userId, trainingMenuItemId: menuItem.trainingMenuItemId },
        UpdateExpression:
          "SET updatedAt = :updatedAt REMOVE frequency, defaultWeightKg, defaultRepsMin, defaultRepsMax, defaultReps, defaultSets",
        ExpressionAttributeValues: { ":updatedAt": now }
      })
    );
  }
}

console.log(JSON.stringify({
  dryRun,
  userId,
  scanned: {
    menuSets: sets.length,
    menuSetItems: links.length,
    menuItems: menuItems.size
  },
  changed: {
    menuSets: migratedSets,
    menuSetItems: migratedLinks,
    cleanedMenuItems
  }
}, null, 2));

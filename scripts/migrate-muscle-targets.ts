#!/usr/bin/env node

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput
} from "@aws-sdk/lib-dynamodb";
import {
  MUSCLE_TAXONOMY_VERSION,
  knownExerciseClassifications,
  type ExerciseClassification
} from "../amplify/functions/shared/muscle-targets";

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredArg(name: string): string {
  const value = readArg(name);
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

const userId = requiredArg("--user-id");
const suffix = readArg("--table-suffix") ?? "main";
const apply = process.argv.includes("--apply");
const region = readArg("--region") ?? process.env.AWS_REGION ?? "ap-northeast-1";
const trainingMenuTableName =
  readArg("--training-menu-table") ?? `KinTrain-TrainingMenuTable-${suffix}`;
const trainingHistoryTableName =
  readArg("--training-history-table") ?? `KinTrain-TrainingHistoryTable-${suffix}`;
const trainingPerformanceTableName =
  readArg("--training-performance-table") ?? `KinTrain-TrainingPerformanceTable-${suffix}`;
const dailyRecordTableName =
  readArg("--daily-record-table") ?? `KinTrain-DailyRecordTable-${suffix}`;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true }
});

async function queryAll(tableName: string): Promise<Array<Record<string, unknown>>> {
  const items: Array<Record<string, unknown>> = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: { ":userId": userId },
        ExclusiveStartKey: exclusiveStartKey
      })
    );
    items.push(...((result.Items ?? []) as Array<Record<string, unknown>>));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return items;
}

function withoutKeys(item: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(item).filter(([key]) => !keys.includes(key)));
}

function classificationFor(trainingMenuItemId: unknown): ExerciseClassification {
  if (typeof trainingMenuItemId !== "string") {
    throw new Error("A training record has no trainingMenuItemId.");
  }
  const classification = knownExerciseClassifications[trainingMenuItemId];
  if (!classification) {
    throw new Error(`No curated muscle classification exists for ${trainingMenuItemId}.`);
  }
  return classification;
}

function migrateEntry(
  rawEntry: unknown,
  bodyWeightKg: number | undefined
): Record<string, unknown> {
  if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
    throw new Error("A gym visit contains an invalid entry.");
  }
  const entry = rawEntry as Record<string, unknown>;
  const classification = classificationFor(entry.trainingMenuItemId);
  return {
    ...withoutKeys(entry, ["bodyPartSnapshot"]),
    muscleTargetsSnapshot: classification.muscleTargets,
    movementPatternSnapshot: classification.movementPattern,
    lateralitySnapshot: classification.laterality,
    loadModelSnapshot: classification.loadModel,
    classificationVersionSnapshot: classification.classificationVersion,
    bodyWeightKgSnapshot: bodyWeightKg
  };
}

function buildPerformanceItem(
  visit: Record<string, unknown>,
  entry: Record<string, unknown>,
  index: number,
  existing?: Record<string, unknown>
): Record<string, unknown> {
  const visitId = String(visit.visitId);
  const performedAtUtc = String(entry.performedAtUtc ?? visit.endedAtUtc);
  const trainingMenuItemId = String(entry.trainingMenuItemId);
  return {
    ...withoutKeys(existing ?? {}, ["bodyPartSnapshot"]),
    userId,
    trainingPerformanceId: `${visitId}#${String(index + 1).padStart(3, "0")}`,
    visitId,
    trainingMenuItemId,
    trainingMenuItemPerformedAtKey: `${trainingMenuItemId}#${performedAtUtc}`,
    performedAtUtc,
    visitDateLocal: visit.visitDateLocal,
    timeZoneId: visit.timeZoneId,
    trainingNameSnapshot: entry.trainingNameSnapshot,
    muscleTargetsSnapshot: entry.muscleTargetsSnapshot,
    movementPatternSnapshot: entry.movementPatternSnapshot,
    lateralitySnapshot: entry.lateralitySnapshot,
    loadModelSnapshot: entry.loadModelSnapshot,
    classificationVersionSnapshot: entry.classificationVersionSnapshot,
    bodyWeightKgSnapshot: entry.bodyWeightKgSnapshot,
    equipmentSnapshot: entry.equipmentSnapshot ?? "",
    isAiGeneratedSnapshot: entry.isAiGeneratedSnapshot === true,
    frequencySnapshot: entry.frequencySnapshot,
    weightKg: entry.weightKg,
    weightInputModeSnapshot: entry.weightInputModeSnapshot ?? "legacyUnspecified",
    loadMultiplierSnapshot: entry.loadMultiplierSnapshot,
    fixedWeightKgSnapshot: entry.fixedWeightKgSnapshot,
    calculatedTotalWeightKg: entry.calculatedTotalWeightKg,
    reps: entry.reps,
    sets: entry.sets,
    note: entry.note ?? "",
    sourceTrainingMenuSetId: entry.sourceTrainingMenuSetId,
    sourceTrainingMenuSetNameSnapshot: entry.sourceTrainingMenuSetNameSnapshot,
    sourceTrainingMenuSetItemId: entry.sourceTrainingMenuSetItemId,
    sourceTrainingMenuSetTypeSnapshot: entry.sourceTrainingMenuSetTypeSnapshot,
    targetWeightKgSnapshot: entry.targetWeightKgSnapshot,
    targetRepsMinSnapshot: entry.targetRepsMinSnapshot,
    targetRepsMaxSnapshot: entry.targetRepsMaxSnapshot,
    targetSetsSnapshot: entry.targetSetsSnapshot,
    targetInstructionSnapshot: entry.targetInstructionSnapshot,
    createdAt: existing?.createdAt ?? visit.createdAt,
    updatedAt: existing?.updatedAt ?? visit.updatedAt
  };
}

const [menuItems, visits, performances, dailyRecords] = await Promise.all([
  queryAll(trainingMenuTableName),
  queryAll(trainingHistoryTableName),
  queryAll(trainingPerformanceTableName),
  queryAll(dailyRecordTableName)
]);

const menuIds = new Set(
  menuItems
    .map((item) => item.trainingMenuItemId)
    .filter((value): value is string => typeof value === "string")
);
const unmappedMenuIds = [...menuIds].filter((id) => !knownExerciseClassifications[id]);
if (unmappedMenuIds.length) {
  throw new Error(`Unmapped menu items: ${unmappedMenuIds.join(", ")}`);
}

const bodyWeightByDate = new Map(
  dailyRecords.flatMap((record): Array<[string, number]> => {
    const date = typeof record.recordDate === "string" ? record.recordDate : "";
    const weight = typeof record.bodyWeightKg === "number" ? record.bodyWeightKg : undefined;
    return date && weight ? [[date, weight]] : [];
  })
);
const performanceById = new Map(
  performances.flatMap((item): Array<[string, Record<string, unknown>]> =>
    typeof item.trainingPerformanceId === "string" ? [[item.trainingPerformanceId, item]] : []
  )
);

let benchHistoryEntries = 0;
let removedLegacyHistorySnapshots = 0;
let assistedEntries = 0;
let assistedEntriesWithBodyWeight = 0;
let createdPerformanceItems = 0;
const migrationTimestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

if (apply) {
  for (const menuItem of menuItems) {
    const trainingMenuItemId = String(menuItem.trainingMenuItemId);
    const classification = classificationFor(trainingMenuItemId);
    const migrated = {
      ...withoutKeys(menuItem, ["bodyPart"]),
      ...classification,
      classificationMigratedAt: migrationTimestamp
    };
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: trainingMenuTableName,
              Item: migrated,
              ConditionExpression: "attribute_exists(userId) AND attribute_exists(trainingMenuItemId)"
            }
          }
        ]
      })
    );
  }
}

for (const visit of visits) {
  const visitId = String(visit.visitId);
  const visitDate = typeof visit.visitDateLocal === "string" ? visit.visitDateLocal : "";
  const bodyWeightKg = bodyWeightByDate.get(visitDate);
  const rawEntries = Array.isArray(visit.entries) ? visit.entries : [];
  const entries = rawEntries.map((entry) => migrateEntry(entry, bodyWeightKg));
  const migratedVisit = {
    ...visit,
    entries,
    classificationVersion: MUSCLE_TAXONOMY_VERSION,
    classificationMigratedAt: migrationTimestamp
  };
  const transactItems: NonNullable<TransactWriteCommandInput["TransactItems"]> = [
    {
      Put: {
        TableName: trainingHistoryTableName,
        Item: migratedVisit,
        ConditionExpression: "attribute_exists(userId) AND attribute_exists(visitId)"
      }
    }
  ];

  entries.forEach((entry, index) => {
    const performanceId = `${visitId}#${String(index + 1).padStart(3, "0")}`;
    const existing = performanceById.get(performanceId);
    if (!existing) {
      createdPerformanceItems += 1;
    }
    const migratedPerformance = buildPerformanceItem(visit, entry, index, existing);
    transactItems.push({
      Put: {
        TableName: trainingPerformanceTableName,
        Item: migratedPerformance,
        ConditionExpression: existing
          ? "attribute_exists(userId) AND attribute_exists(trainingPerformanceId)"
          : "attribute_not_exists(userId) AND attribute_not_exists(trainingPerformanceId)"
      }
    });

    if ((entry as Record<string, unknown>).trainingMenuItemId === "11a23116-20ef-4029-9a76-5ad2a54ee925") {
      benchHistoryEntries += 1;
    }
    if (
      rawEntries[index] &&
      typeof rawEntries[index] === "object" &&
      !Array.isArray(rawEntries[index]) &&
      "bodyPartSnapshot" in rawEntries[index]
    ) {
      removedLegacyHistorySnapshots += 1;
    }
    if (entry.loadModelSnapshot === "assisted_bodyweight") {
      assistedEntries += 1;
      if (entry.bodyWeightKgSnapshot !== undefined) {
        assistedEntriesWithBodyWeight += 1;
      }
    }
  });

  if (transactItems.length > 25) {
    throw new Error(`Visit ${visitId} exceeds the DynamoDB transaction limit.`);
  }
  if (apply) {
    await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  }
}

console.log(
  JSON.stringify(
    {
      mode: apply ? "apply" : "dry-run",
      region,
      userId,
      tables: {
        trainingMenuTableName,
        trainingHistoryTableName,
        trainingPerformanceTableName,
        dailyRecordTableName
      },
      scanned: {
        menuItems: menuItems.length,
        visits: visits.length,
        performances: performances.length,
        dailyRecords: dailyRecords.length
      },
      migration: {
        taxonomyVersion: MUSCLE_TAXONOMY_VERSION,
        removedLegacyMenuFields: menuItems.filter((item) => "bodyPart" in item).length,
        removedLegacyHistorySnapshots,
        benchHistoryEntries,
        assistedEntries,
        assistedEntriesWithBodyWeight,
        createdPerformanceItems
      }
    },
    null,
    2
  )
);

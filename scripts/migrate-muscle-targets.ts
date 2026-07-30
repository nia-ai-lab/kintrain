#!/usr/bin/env node

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput
} from "@aws-sdk/lib-dynamodb";
import {
  MUSCLE_TAXONOMY_VERSION,
  knownExerciseClassifications,
  type EquipmentType,
  type ExerciseClassification,
  type MuscleTarget
} from "../amplify/functions/shared/muscle-targets";

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredArg(name: string): string {
  const value = readArg(name);
  if (!value) throw new Error(`${name} is required.`);
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

const BACK_EXTENSION_LEGACY_ID = "44b86d64-8cc1-4825-89e7-cb175239ebe7";
const CALF_RAISE_BILATERAL_ID = "30297175-f743-42b6-ba18-d08a1260a52f";
const BULGARIAN_SPLIT_SQUAT_ID = "dce8641a-3170-49f6-9940-b0067c8f8f2d";
const ROMAN_CHAIR_HIP_ID = "ed047bd6-3be2-47df-a0ce-cdec07fb3ce2";
const ROMAN_CHAIR_BACK_ID = "66ddf57f-eedb-49b0-be27-08a2fc40c146";
const SUPERMAN_ID = "a4e20114-3752-43d5-826d-d2075128cdd5";
const CALF_RAISE_UNILATERAL_ID = "a9aeea30-95b5-4581-8781-5141794947b2";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true }
});

async function queryAll(tableName: string): Promise<Array<Record<string, unknown>>> {
  const items: Array<Record<string, unknown>> = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await ddb.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "userId = :userId",
      ExpressionAttributeValues: { ":userId": userId },
      ExclusiveStartKey: exclusiveStartKey
    }));
    items.push(...((result.Items ?? []) as Array<Record<string, unknown>>));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return items;
}

function withoutKeys(item: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(item).filter(([key]) => !keys.includes(key)));
}

const primary = (muscleId: MuscleTarget["muscleId"]): MuscleTarget => ({
  muscleId,
  role: "primary",
  effectiveSetFactor: 1
});
const secondary = (
  muscleId: MuscleTarget["muscleId"],
  effectiveSetFactor = 0.5
): MuscleTarget => ({ muscleId, role: "secondary", effectiveSetFactor });
const stabilizer = (muscleId: MuscleTarget["muscleId"]): MuscleTarget => ({
  muscleId,
  role: "stabilizer",
  effectiveSetFactor: 0
});

const extraClassifications: Record<string, ExerciseClassification> = {
  [ROMAN_CHAIR_HIP_ID]: {
    muscleTargets: [primary("glute_max"), primary("hamstrings"), stabilizer("spinal_erectors")],
    movementFamily: "hinge",
    jointActions: ["hip_extension"],
    laterality: "bilateral",
    loadModel: "bodyweight",
    classificationVersion: MUSCLE_TAXONOMY_VERSION
  },
  [ROMAN_CHAIR_BACK_ID]: {
    muscleTargets: [primary("spinal_erectors"), secondary("glute_max"), secondary("hamstrings", 0.25)],
    movementFamily: "trunk",
    jointActions: ["trunk_extension"],
    laterality: "bilateral",
    loadModel: "bodyweight",
    classificationVersion: MUSCLE_TAXONOMY_VERSION
  },
  [SUPERMAN_ID]: {
    muscleTargets: [primary("spinal_erectors"), stabilizer("glute_max")],
    movementFamily: "trunk",
    jointActions: ["trunk_extension"],
    laterality: "bilateral",
    loadModel: "bodyweight",
    classificationVersion: MUSCLE_TAXONOMY_VERSION
  },
  [CALF_RAISE_UNILATERAL_ID]: {
    muscleTargets: [primary("calves")],
    movementFamily: "isolation",
    jointActions: ["ankle_plantar_flexion"],
    laterality: "unilateral",
    loadModel: "bodyweight_plus_external_load",
    classificationVersion: MUSCLE_TAXONOMY_VERSION
  }
};

function classificationFor(trainingMenuItemId: unknown): ExerciseClassification {
  if (typeof trainingMenuItemId !== "string") {
    throw new Error("A training record has no trainingMenuItemId.");
  }
  const base = knownExerciseClassifications[trainingMenuItemId] ?? extraClassifications[trainingMenuItemId];
  if (!base) throw new Error(`No curated classification exists for ${trainingMenuItemId}.`);
  if (trainingMenuItemId === CALF_RAISE_BILATERAL_ID) {
    return { ...base, loadModel: "bodyweight_plus_external_load" };
  }
  if (trainingMenuItemId === BULGARIAN_SPLIT_SQUAT_ID) {
    return { ...base, loadModel: "bodyweight_plus_external_load" };
  }
  return base;
}

function equipmentTypeFor(name: string): EquipmentType {
  if (name.includes("ケーブル")) return "cable_machine";
  if (name.includes("スミス")) return "smith_machine";
  if (name.includes("バーベル")) return "barbell";
  if (name.includes("ダンベル")) return "dumbbell";
  if (name.includes("アシスト")) return "assisted_machine";
  if (name.includes("チンニング")) return "pullup_bar";
  if (name.includes("プッシュアップ") || name.includes("スーパーマン")) return "bodyweight_space";
  if (name.includes("アブローラー")) return "ab_wheel";
  if (name.includes("ローマンチェア") || name.includes("バックエクステンション")) return "roman_chair";
  if (name.includes("スクワット")) return "barbell";
  if (name === "サイドレイズ") return "dumbbell";
  if (name.includes("ヒップスラスト")) return "dumbbell";
  return "selectorized_machine";
}

function exerciseFamilyIdFor(name: string): string {
  if (name.includes("フライ") || name === "ペクトルフライ") return "chest_fly";
  if (name.includes("サイドレイズ")) return "lateral_raise";
  if (name.includes("ヒップスラスト")) return "hip_thrust";
  if (name.includes("デッドリフト")) return "deadlift";
  if (name.includes("チンニング")) return "chin_up";
  if (name.includes("カーフレイズ")) return "calf_raise";
  if (name.includes("バックエクステンション") || name.includes("ローマンチェア")) return "back_extension";
  if (name.includes("スーパーマン")) return "superman";
  return name;
}

function cableSettingsFor(equipmentType: EquipmentType) {
  return equipmentType === "cable_machine"
    ? { pulleyPosition: "adjustable", attachmentType: "other", cableSides: "single" }
    : null;
}

const legacyMenuKeys = [
  "bodyPart",
  "movementPattern",
  "equipment",
  "frequency",
  "defaultWeightKg",
  "defaultRepsMin",
  "defaultRepsMax",
  "defaultReps",
  "defaultSets"
];
const legacySnapshotKeys = [
  "bodyPartSnapshot",
  "movementPatternSnapshot",
  "equipmentSnapshot"
];

function migrateMenuItem(item: Record<string, unknown>, migratedAt: string): Record<string, unknown> {
  const trainingMenuItemId = String(item.trainingMenuItemId);
  const classification = classificationFor(trainingMenuItemId);
  const originalName = String(item.trainingName ?? "");
  const trainingName =
    trainingMenuItemId === BACK_EXTENSION_LEGACY_ID
      ? "バックエクステンション（旧・種別不明）"
      : trainingMenuItemId === CALF_RAISE_BILATERAL_ID
        ? "カーフレイズ（両脚）"
        : originalName;
  const equipmentType = equipmentTypeFor(trainingName);
  return {
    ...withoutKeys(item, legacyMenuKeys),
    trainingName,
    normalizedTrainingName: trainingName.trim().toLowerCase(),
    exerciseFamilyId: exerciseFamilyIdFor(trainingName),
    ...classification,
    equipmentType,
    equipmentProfileId: "",
    cableSettings: cableSettingsFor(equipmentType),
    isActive: trainingMenuItemId === BACK_EXTENSION_LEGACY_ID ? false : item.isActive !== false,
    classificationMigratedAt: migratedAt
  };
}

function migrateEntry(rawEntry: unknown, bodyWeightKg: number | undefined): Record<string, unknown> {
  if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
    throw new Error("A gym visit contains an invalid entry.");
  }
  const entry = rawEntry as Record<string, unknown>;
  const id = String(entry.trainingMenuItemId);
  const classification = classificationFor(id);
  const trainingName = String(entry.trainingNameSnapshot ?? "");
  const equipmentType = equipmentTypeFor(trainingName);
  const weightKg = typeof entry.weightKg === "number" ? entry.weightKg : 0;
  const assisted = classification.loadModel === "assisted_bodyweight";
  return {
    ...withoutKeys(entry, legacySnapshotKeys),
    muscleTargetsSnapshot: classification.muscleTargets,
    movementFamilySnapshot: classification.movementFamily,
    jointActionsSnapshot: classification.jointActions,
    lateralitySnapshot: classification.laterality,
    loadModelSnapshot: classification.loadModel,
    classificationVersionSnapshot: classification.classificationVersion,
    classificationStatus: id === BACK_EXTENSION_LEGACY_ID ? "ambiguous_legacy_variant" : "canonical",
    lateralityConfidence:
      id === CALF_RAISE_BILATERAL_ID || id === BULGARIAN_SPLIT_SQUAT_ID ? "unknown" : "known",
    bodyWeightKgSnapshot: bodyWeightKg,
    equipmentTypeSnapshot: equipmentType,
    equipmentProfileIdSnapshot: "",
    cableSettingsSnapshot: cableSettingsFor(equipmentType),
    additionalLoadKg:
      classification.loadModel === "bodyweight_plus_external_load" ? weightKg : undefined,
    assistanceKg: assisted ? (weightKg <= 1 ? null : weightKg) : undefined
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
    ...withoutKeys(existing ?? {}, legacySnapshotKeys),
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
    movementFamilySnapshot: entry.movementFamilySnapshot,
    jointActionsSnapshot: entry.jointActionsSnapshot,
    lateralitySnapshot: entry.lateralitySnapshot,
    loadModelSnapshot: entry.loadModelSnapshot,
    classificationVersionSnapshot: entry.classificationVersionSnapshot,
    classificationStatus: entry.classificationStatus,
    lateralityConfidence: entry.lateralityConfidence,
    bodyWeightKgSnapshot: entry.bodyWeightKgSnapshot,
    equipmentTypeSnapshot: entry.equipmentTypeSnapshot,
    equipmentProfileIdSnapshot: entry.equipmentProfileIdSnapshot,
    cableSettingsSnapshot: entry.cableSettingsSnapshot,
    isAiGeneratedSnapshot: entry.isAiGeneratedSnapshot === true,
    frequencySnapshot: entry.frequencySnapshot,
    weightKg: entry.weightKg,
    additionalLoadKg: entry.additionalLoadKg,
    assistanceKg: entry.assistanceKg,
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
    updatedAt: visit.updatedAt
  };
}

function newMenuTemplates(
  maxDisplayOrder: number,
  timestamp: string
): Array<Record<string, unknown>> {
  const definitions = [
    {
      id: ROMAN_CHAIR_HIP_ID,
      name: "ローマンチェア・ヒップエクステンション",
      description: "股関節を支点に動き、大臀筋とハムストリングを狙う。腰を反らしすぎない。",
      equipmentType: "roman_chair" as const
    },
    {
      id: ROMAN_CHAIR_BACK_ID,
      name: "ローマンチェア・バックエクステンション",
      description: "脊柱起立筋を狙う体幹伸展。股関節主導の種目と区別して記録する。",
      equipmentType: "roman_chair" as const
    },
    {
      id: SUPERMAN_ID,
      name: "スーパーマン",
      description: "床にうつ伏せになり、体幹を伸展する自重種目。",
      equipmentType: "bodyweight_space" as const
    },
    {
      id: CALF_RAISE_UNILATERAL_ID,
      name: "カーフレイズ（片脚）",
      description: "片脚ずつ実施する。左右の回数を同じセット内で記録する。",
      equipmentType: "bodyweight_space" as const
    }
  ];
  return definitions.map((definition, index) => {
    const classification = classificationFor(definition.id);
    return {
      userId,
      trainingMenuItemId: definition.id,
      trainingName: definition.name,
      normalizedTrainingName: definition.name.toLowerCase(),
      exerciseFamilyId: exerciseFamilyIdFor(definition.name),
      ...classification,
      equipmentType: definition.equipmentType,
      equipmentProfileId: "",
      cableSettings: null,
      description: definition.description,
      weightInputMode: "direct",
      loadMultiplier: 1,
      fixedWeightKg: 0,
      isAiGenerated: false,
      isActive: true,
      displayOrder: maxDisplayOrder + index + 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      classificationMigratedAt: timestamp
    };
  });
}

const [menuItems, visits, performances, dailyRecords] = await Promise.all([
  queryAll(trainingMenuTableName),
  queryAll(trainingHistoryTableName),
  queryAll(trainingPerformanceTableName),
  queryAll(dailyRecordTableName)
]);

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
const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const existingMenuIds = new Set(menuItems.map((item) => String(item.trainingMenuItemId)));
const newItems = newMenuTemplates(
  Math.max(0, ...menuItems.map((item) => Number(item.displayOrder ?? 0))),
  timestamp
).filter((item) => !existingMenuIds.has(String(item.trainingMenuItemId)));

let historyEntryCount = 0;
let ambiguousBackExtensionCount = 0;
let unknownAssistanceCount = 0;
let createdPerformanceItems = 0;

if (apply) {
  for (const menuItem of menuItems) {
    await ddb.send(new PutCommand({
      TableName: trainingMenuTableName,
      Item: migrateMenuItem(menuItem, timestamp),
      ConditionExpression: "attribute_exists(userId) AND attribute_exists(trainingMenuItemId)"
    }));
  }
  for (const newItem of newItems) {
    await ddb.send(new PutCommand({
      TableName: trainingMenuTableName,
      Item: newItem,
      ConditionExpression: "attribute_not_exists(userId) AND attribute_not_exists(trainingMenuItemId)"
    }));
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
    classificationMigratedAt: timestamp
  };
  const transactItems: NonNullable<TransactWriteCommandInput["TransactItems"]> = [{
    Put: {
      TableName: trainingHistoryTableName,
      Item: migratedVisit,
      ConditionExpression: "attribute_exists(userId) AND attribute_exists(visitId)"
    }
  }];

  entries.forEach((entry, index) => {
    historyEntryCount += 1;
    if (entry.classificationStatus === "ambiguous_legacy_variant") ambiguousBackExtensionCount += 1;
    if (entry.loadModelSnapshot === "assisted_bodyweight" && entry.assistanceKg === null) {
      unknownAssistanceCount += 1;
    }
    const performanceId = `${visitId}#${String(index + 1).padStart(3, "0")}`;
    const existing = performanceById.get(performanceId);
    if (!existing) createdPerformanceItems += 1;
    transactItems.push({
      Put: {
        TableName: trainingPerformanceTableName,
        Item: buildPerformanceItem(visit, entry, index, existing),
        ConditionExpression: existing
          ? "attribute_exists(userId) AND attribute_exists(trainingPerformanceId)"
          : "attribute_not_exists(userId) AND attribute_not_exists(trainingPerformanceId)"
      }
    });
  });

  if (transactItems.length > 25) {
    throw new Error(`Visit ${visitId} exceeds the DynamoDB transaction limit.`);
  }
  if (apply) await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
}

console.log(JSON.stringify({
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
    updatedMenuItems: menuItems.length,
    newMenuItems: newItems.map((item) => ({
      trainingMenuItemId: item.trainingMenuItemId,
      trainingName: item.trainingName
    })),
    retiredMenuItems: [BACK_EXTENSION_LEGACY_ID],
    historyEntries: historyEntryCount,
    ambiguousBackExtensionEntries: ambiguousBackExtensionCount,
    assistedEntriesMarkedUnknown: unknownAssistanceCount,
    createdPerformanceItems
  }
}, null, 2));

export const MUSCLE_TAXONOMY_VERSION = 2;

export const muscleGroups = [
  { id: "chest", label: "胸" },
  { id: "back", label: "背中" },
  { id: "shoulders", label: "肩" },
  { id: "arms", label: "腕" },
  { id: "lower_body", label: "下半身" },
  { id: "core", label: "体幹" }
] as const;

export const muscles = [
  { id: "chest_upper", groupId: "chest", label: "胸（上部）" },
  { id: "chest_mid", groupId: "chest", label: "胸（中部）" },
  { id: "chest_lower", groupId: "chest", label: "胸（下部）" },
  { id: "latissimus", groupId: "back", label: "広背筋" },
  { id: "upper_back", groupId: "back", label: "上背部" },
  { id: "spinal_erectors", groupId: "back", label: "脊柱起立筋" },
  { id: "anterior_deltoid", groupId: "shoulders", label: "三角筋前部" },
  { id: "lateral_deltoid", groupId: "shoulders", label: "三角筋中部" },
  { id: "posterior_deltoid", groupId: "shoulders", label: "三角筋後部" },
  { id: "biceps", groupId: "arms", label: "上腕二頭筋" },
  { id: "triceps", groupId: "arms", label: "上腕三頭筋" },
  { id: "forearms", groupId: "arms", label: "前腕" },
  { id: "quadriceps", groupId: "lower_body", label: "大腿四頭筋" },
  { id: "hamstrings", groupId: "lower_body", label: "ハムストリング" },
  { id: "glute_max", groupId: "lower_body", label: "大臀筋" },
  { id: "glute_med", groupId: "lower_body", label: "中臀筋" },
  { id: "adductors", groupId: "lower_body", label: "内転筋" },
  { id: "calves", groupId: "lower_body", label: "ふくらはぎ" },
  { id: "rectus_abdominis", groupId: "core", label: "腹直筋" },
  { id: "obliques", groupId: "core", label: "腹斜筋" },
  { id: "core_stability", groupId: "core", label: "体幹安定" }
] as const;

export type MuscleId = (typeof muscles)[number]["id"];
export type MuscleGroupId = (typeof muscleGroups)[number]["id"];
export type MuscleRole = "primary" | "secondary" | "stabilizer";
type LegacyMovementPattern =
  | "horizontal_push"
  | "vertical_push"
  | "horizontal_pull"
  | "vertical_pull"
  | "squat"
  | "hip_hinge"
  | "hip_extension"
  | "hip_abduction"
  | "hip_adduction"
  | "knee_extension"
  | "knee_flexion"
  | "calf_raise"
  | "elbow_flexion"
  | "elbow_extension"
  | "trunk_flexion"
  | "trunk_rotation"
  | "anti_extension";
export type Laterality = "bilateral" | "unilateral" | "alternating";
export type LoadModel =
  | "external_load"
  | "bodyweight"
  | "bodyweight_plus_external_load"
  | "assisted_bodyweight";
export type MovementFamily = "push" | "pull" | "squat" | "hinge" | "trunk" | "isolation";
export type JointAction =
  | "shoulder_horizontal_adduction"
  | "shoulder_horizontal_abduction"
  | "shoulder_abduction"
  | "shoulder_adduction"
  | "shoulder_flexion"
  | "elbow_flexion"
  | "elbow_extension"
  | "hip_extension"
  | "hip_abduction"
  | "hip_adduction"
  | "knee_extension"
  | "knee_flexion"
  | "ankle_plantar_flexion"
  | "trunk_flexion"
  | "trunk_extension"
  | "trunk_rotation"
  | "trunk_anti_extension";
export type EquipmentType =
  | "barbell"
  | "dumbbell"
  | "kettlebell"
  | "cable_machine"
  | "smith_machine"
  | "selectorized_machine"
  | "plate_loaded_machine"
  | "assisted_machine"
  | "pullup_bar"
  | "dip_station"
  | "roman_chair"
  | "bodyweight_space"
  | "ab_wheel"
  | "other";

export type MuscleTarget = {
  muscleId: MuscleId;
  role: MuscleRole;
  effectiveSetFactor: number;
};

export type ExerciseClassification = {
  muscleTargets: MuscleTarget[];
  movementFamily: MovementFamily;
  jointActions: JointAction[];
  laterality: Laterality;
  loadModel: LoadModel;
  classificationVersion: number;
};

const muscleById = new Map(muscles.map((muscle) => [muscle.id, muscle]));
const muscleGroupById = new Map(muscleGroups.map((group) => [group.id, group]));

const lateralities = new Set<Laterality>(["bilateral", "unilateral", "alternating"]);
const loadModels = new Set<LoadModel>([
  "external_load",
  "bodyweight",
  "bodyweight_plus_external_load",
  "assisted_bodyweight"
]);
const movementFamilies = new Set<MovementFamily>(["push", "pull", "squat", "hinge", "trunk", "isolation"]);
const jointActions = new Set<JointAction>([
  "shoulder_horizontal_adduction",
  "shoulder_horizontal_abduction",
  "shoulder_abduction",
  "shoulder_adduction",
  "shoulder_flexion",
  "elbow_flexion",
  "elbow_extension",
  "hip_extension",
  "hip_abduction",
  "hip_adduction",
  "knee_extension",
  "knee_flexion",
  "ankle_plantar_flexion",
  "trunk_flexion",
  "trunk_extension",
  "trunk_rotation",
  "trunk_anti_extension"
]);
const equipmentTypes = new Set<EquipmentType>([
  "barbell",
  "dumbbell",
  "kettlebell",
  "cable_machine",
  "smith_machine",
  "selectorized_machine",
  "plate_loaded_machine",
  "assisted_machine",
  "pullup_bar",
  "dip_station",
  "roman_chair",
  "bodyweight_space",
  "ab_wheel",
  "other"
]);

export const defaultEffectiveSetFactor = (role: MuscleRole): number =>
  role === "primary" ? 1 : role === "secondary" ? 0.5 : 0;

export function isMuscleId(value: unknown): value is MuscleId {
  return typeof value === "string" && muscleById.has(value as MuscleId);
}

export function normalizeMuscleTargets(value: unknown): MuscleTarget[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    return null;
  }
  const result: MuscleTarget[] = [];
  const seen = new Set<MuscleId>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return null;
    }
    const record = item as Record<string, unknown>;
    if (
      !isMuscleId(record.muscleId) ||
      (record.role !== "primary" && record.role !== "secondary" && record.role !== "stabilizer")
    ) {
      return null;
    }
    if (seen.has(record.muscleId)) {
      return null;
    }
    seen.add(record.muscleId);
    const factor =
      typeof record.effectiveSetFactor === "number" &&
      Number.isFinite(record.effectiveSetFactor) &&
      record.effectiveSetFactor >= 0 &&
      record.effectiveSetFactor <= 1
        ? Math.round(record.effectiveSetFactor * 100) / 100
        : defaultEffectiveSetFactor(record.role);
    result.push({ muscleId: record.muscleId, role: record.role, effectiveSetFactor: factor });
  }
  return result.some((target) => target.role === "primary") ? result : null;
}

export function normalizeMovementFamily(value: unknown): MovementFamily | null {
  return typeof value === "string" && movementFamilies.has(value as MovementFamily)
    ? (value as MovementFamily)
    : null;
}

export function normalizeJointActions(value: unknown): JointAction[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) return null;
  const result = value.filter(
    (candidate, index): candidate is JointAction =>
      typeof candidate === "string" &&
      jointActions.has(candidate as JointAction) &&
      value.indexOf(candidate) === index
  );
  return result.length === value.length ? result : null;
}

export function normalizeEquipmentType(value: unknown): EquipmentType | null {
  return typeof value === "string" && equipmentTypes.has(value as EquipmentType)
    ? (value as EquipmentType)
    : null;
}

export function normalizeLaterality(value: unknown): Laterality | null {
  return typeof value === "string" && lateralities.has(value as Laterality)
    ? (value as Laterality)
    : null;
}

export function normalizeLoadModel(value: unknown): LoadModel | null {
  return typeof value === "string" && loadModels.has(value as LoadModel)
    ? (value as LoadModel)
    : null;
}

export function muscleLabel(muscleId: MuscleId): string {
  return muscleById.get(muscleId)?.label ?? muscleId;
}

export function muscleGroupId(muscleId: MuscleId): MuscleGroupId {
  return muscleById.get(muscleId)?.groupId ?? "core";
}

export function muscleGroupLabel(groupId: MuscleGroupId): string {
  return muscleGroupById.get(groupId)?.label ?? groupId;
}

export function formatMuscleTargets(targets: MuscleTarget[]): string {
  const primary = targets.filter((target) => target.role === "primary").map((target) => muscleLabel(target.muscleId));
  const secondary = targets
    .filter((target) => target.role === "secondary")
    .map((target) => muscleLabel(target.muscleId));
  const stabilizers = targets
    .filter((target) => target.role === "stabilizer")
    .map((target) => muscleLabel(target.muscleId));
  const details = [
    secondary.length ? `補助: ${secondary.join("・")}` : "",
    stabilizers.length ? `安定: ${stabilizers.join("・")}` : ""
  ].filter(Boolean);
  return details.length ? `${primary.join("・")}（${details.join(" / ")}）` : primary.join("・");
}

const legacyPatternMap: Record<LegacyMovementPattern, { family: MovementFamily; actions: JointAction[] }> = {
  horizontal_push: { family: "push", actions: ["shoulder_horizontal_adduction", "elbow_extension"] },
  vertical_push: { family: "push", actions: ["shoulder_flexion", "elbow_extension"] },
  horizontal_pull: { family: "pull", actions: ["shoulder_horizontal_abduction", "elbow_flexion"] },
  vertical_pull: { family: "pull", actions: ["shoulder_adduction", "elbow_flexion"] },
  squat: { family: "squat", actions: ["knee_extension", "hip_extension"] },
  hip_hinge: { family: "hinge", actions: ["hip_extension"] },
  hip_extension: { family: "hinge", actions: ["hip_extension"] },
  hip_abduction: { family: "isolation", actions: ["hip_abduction"] },
  hip_adduction: { family: "isolation", actions: ["hip_adduction"] },
  knee_extension: { family: "isolation", actions: ["knee_extension"] },
  knee_flexion: { family: "isolation", actions: ["knee_flexion"] },
  calf_raise: { family: "isolation", actions: ["ankle_plantar_flexion"] },
  elbow_flexion: { family: "isolation", actions: ["elbow_flexion"] },
  elbow_extension: { family: "isolation", actions: ["elbow_extension"] },
  trunk_flexion: { family: "trunk", actions: ["trunk_flexion"] },
  trunk_rotation: { family: "trunk", actions: ["trunk_rotation"] },
  anti_extension: { family: "trunk", actions: ["trunk_anti_extension"] }
};

function classification(
  muscleTargets: MuscleTarget[],
  movementPattern: LegacyMovementPattern,
  laterality: Laterality,
  loadModel: LoadModel
): ExerciseClassification {
  const movement = legacyPatternMap[movementPattern];
  return {
    muscleTargets,
    movementFamily: movement.family,
    jointActions: movement.actions,
    laterality,
    loadModel,
    classificationVersion: MUSCLE_TAXONOMY_VERSION
  };
}

function classificationV2(
  muscleTargets: MuscleTarget[],
  movementFamily: MovementFamily,
  jointActions: JointAction[],
  laterality: Laterality,
  loadModel: LoadModel
): ExerciseClassification {
  return {
    muscleTargets,
    movementFamily,
    jointActions,
    laterality,
    loadModel,
    classificationVersion: MUSCLE_TAXONOMY_VERSION
  };
}

const p = (muscleId: MuscleId): MuscleTarget => ({ muscleId, role: "primary", effectiveSetFactor: 1 });
const s = (muscleId: MuscleId, effectiveSetFactor = 0.5): MuscleTarget => ({
  muscleId,
  role: "secondary",
  effectiveSetFactor
});
const z = (muscleId: MuscleId): MuscleTarget => ({ muscleId, role: "stabilizer", effectiveSetFactor: 0 });

export const knownExerciseClassifications: Record<string, ExerciseClassification> = {
  "2ae17c38-2c76-408a-ab7e-4dc47bed6b2c": classification(
    [p("quadriceps"), s("glute_max")],
    "squat",
    "bilateral",
    "external_load"
  ),
  "7ed55d22-8b03-47db-93f2-de60026c3029": classification(
    [p("chest_mid"), s("triceps"), s("anterior_deltoid")],
    "horizontal_push",
    "bilateral",
    "external_load"
  ),
  "14dce8a3-2acb-4911-a307-6ec5d4760f25": classification(
    [p("anterior_deltoid"), s("lateral_deltoid"), s("triceps")],
    "vertical_push",
    "bilateral",
    "external_load"
  ),
  "c2d2814e-880c-4825-89a9-a76befb1f3be": classification(
    [p("hamstrings")],
    "knee_flexion",
    "bilateral",
    "external_load"
  ),
  "deea232f-24c9-4229-9351-50a9e23a3ca3": classification(
    [p("rectus_abdominis")],
    "trunk_flexion",
    "bilateral",
    "external_load"
  ),
  "b38fde8d-5ef3-47a0-8042-7274ae1cb6b8": classification(
    [p("latissimus"), s("upper_back"), s("biceps")],
    "vertical_pull",
    "bilateral",
    "external_load"
  ),
  "4ef84df7-476b-4fc1-8d5e-1da96cc01a75": classification(
    [p("upper_back"), p("latissimus"), s("biceps"), s("posterior_deltoid")],
    "horizontal_pull",
    "bilateral",
    "external_load"
  ),
  "b1f79193-09a8-41bd-b634-b56be829f046": classification(
    [p("glute_med")],
    "hip_abduction",
    "bilateral",
    "external_load"
  ),
  "bb740323-814a-4b29-ba6b-46eb4e05f1ec": classification(
    [p("quadriceps")],
    "knee_extension",
    "bilateral",
    "external_load"
  ),
  "0e13e164-4255-40c3-9674-bf8aa61bdefe": classification(
    [p("obliques"), s("core_stability")],
    "trunk_rotation",
    "bilateral",
    "external_load"
  ),
  "0c7933ae-7789-415a-880a-09fb2b28c637": classification(
    [p("chest_mid"), s("anterior_deltoid")],
    "horizontal_push",
    "bilateral",
    "external_load"
  ),
  "570dcb44-999e-49ee-a0aa-07d011f7dea6": classification(
    [p("posterior_deltoid"), s("upper_back")],
    "horizontal_pull",
    "bilateral",
    "external_load"
  ),
  "3b82ad98-8cb2-4e36-8268-57f8447aef95": classification(
    [p("latissimus"), s("upper_back"), s("biceps")],
    "vertical_pull",
    "bilateral",
    "assisted_bodyweight"
  ),
  "4b4b506f-aeab-461d-b7ff-e84cb0dd739d": classification(
    [p("chest_lower"), s("triceps"), s("anterior_deltoid")],
    "vertical_push",
    "bilateral",
    "assisted_bodyweight"
  ),
  "e12a4651-8b21-4c44-8005-711e81522fc2": classification(
    [p("biceps")],
    "elbow_flexion",
    "bilateral",
    "external_load"
  ),
  "95799c63-19b9-46e9-9929-9ae62f837fc1": classification(
    [p("triceps")],
    "elbow_extension",
    "bilateral",
    "external_load"
  ),
  "5ce42ed6-c585-4320-a95b-3abdfae5f06e": classification(
    [p("chest_mid"), s("triceps"), s("anterior_deltoid")],
    "horizontal_push",
    "bilateral",
    "external_load"
  ),
  "5297a8e7-29ba-4f90-b45f-14d5c949fe5a": classification(
    [p("chest_mid"), s("anterior_deltoid")],
    "horizontal_push",
    "bilateral",
    "external_load"
  ),
  "08c1a393-2ddd-4adb-b18f-c19699277154": classification(
    [p("glute_max"), p("hamstrings"), s("spinal_erectors")],
    "hip_hinge",
    "bilateral",
    "external_load"
  ),
  "57c07175-89d4-4e3c-812a-12805b7c9672": classification(
    [p("quadriceps"), p("glute_max"), z("hamstrings"), z("core_stability")],
    "squat",
    "bilateral",
    "external_load"
  ),
  "25b65637-20c9-4f77-86e7-97e778a86429": classification(
    [p("glute_max"), p("hamstrings"), s("spinal_erectors"), s("upper_back")],
    "hip_hinge",
    "bilateral",
    "external_load"
  ),
  "62a98f6e-33a2-4dc1-842c-8d787ea4b81c": classification(
    [p("rectus_abdominis"), p("core_stability")],
    "anti_extension",
    "bilateral",
    "bodyweight"
  ),
  "6848bd44-e0b9-4341-88b2-3f9606832d3c": classification(
    [p("rectus_abdominis"), p("core_stability")],
    "anti_extension",
    "bilateral",
    "bodyweight"
  ),
  "9ae3f9f9-0079-4719-9a92-1b2a0c4d5511": classification(
    [p("adductors")],
    "hip_adduction",
    "bilateral",
    "external_load"
  ),
  "486da371-442d-4e73-bd63-1d9d53076695": classification(
    [p("latissimus"), s("biceps"), s("upper_back")],
    "vertical_pull",
    "bilateral",
    "bodyweight"
  ),
  "c13671e7-77a7-436b-a762-7aaa3ab61595": classification(
    [p("latissimus"), s("biceps"), s("upper_back")],
    "vertical_pull",
    "bilateral",
    "bodyweight"
  ),
  "11a23116-20ef-4029-9a76-5ad2a54ee925": classification(
    [p("chest_mid"), s("triceps"), s("anterior_deltoid")],
    "horizontal_push",
    "bilateral",
    "external_load"
  ),
  "a04147a1-5e0a-4410-970b-5dac84ed1e7a": classification(
    [p("upper_back"), p("latissimus"), s("biceps"), s("posterior_deltoid")],
    "horizontal_pull",
    "bilateral",
    "external_load"
  ),
  "de863e8a-fe84-4549-ad72-060ad5bf197f": classification(
    [p("latissimus"), s("biceps")],
    "vertical_pull",
    "unilateral",
    "external_load"
  ),
  "67465002-f966-4c8a-832f-f8ef9b4c9063": classification(
    [p("glute_max"), p("hamstrings"), s("spinal_erectors")],
    "hip_hinge",
    "bilateral",
    "external_load"
  ),
  "57497093-2f68-4754-a637-b744e1364a2a": classification(
    [p("rectus_abdominis")],
    "trunk_flexion",
    "bilateral",
    "bodyweight"
  ),
  "3b99e032-20dc-40e7-84c0-a92a9ae5681f": classification(
    [p("biceps")],
    "elbow_flexion",
    "bilateral",
    "external_load"
  ),
  "af77aabe-6357-4f0d-9601-e6f8dfdc31d3": classification(
    [p("glute_max"), z("hamstrings")],
    "hip_extension",
    "bilateral",
    "external_load"
  ),
  "44b86d64-8cc1-4825-89e7-cb175239ebe7": classification(
    [p("spinal_erectors"), s("glute_max"), s("hamstrings")],
    "hip_extension",
    "bilateral",
    "bodyweight"
  ),
  "dce8641a-3170-49f6-9940-b0067c8f8f2d": classification(
    [p("quadriceps"), p("glute_max"), s("hamstrings", 0.25)],
    "squat",
    "unilateral",
    "external_load"
  ),
  "30297175-f743-42b6-ba18-d08a1260a52f": classification(
    [p("calves")],
    "calf_raise",
    "bilateral",
    "external_load"
  ),
  "105eb05c-6459-4308-8c35-4ed3ccbf4026": classificationV2(
    [p("lateral_deltoid")],
    "isolation",
    ["shoulder_abduction"],
    "bilateral",
    "external_load"
  ),
  "688a13c5-4e77-4b2b-8d49-abd4eefcacc3": classification(
    [p("glute_max"), z("hamstrings")],
    "hip_extension",
    "bilateral",
    "external_load"
  ),
  "8e6b60d9-11ac-4bb8-acac-884e73209963": classification(
    [p("chest_mid"), s("triceps"), s("anterior_deltoid")],
    "horizontal_push",
    "bilateral",
    "bodyweight"
  )
};

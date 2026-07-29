export const MUSCLE_TAXONOMY_VERSION = 1;

export const muscleGroups = [
  { id: 'chest', label: '胸' },
  { id: 'back', label: '背中' },
  { id: 'shoulders', label: '肩' },
  { id: 'arms', label: '腕' },
  { id: 'lower_body', label: '下半身' },
  { id: 'core', label: '体幹' }
] as const;

export const muscles = [
  { id: 'chest_upper', groupId: 'chest', label: '胸（上部）' },
  { id: 'chest_mid', groupId: 'chest', label: '胸（中部）' },
  { id: 'chest_lower', groupId: 'chest', label: '胸（下部）' },
  { id: 'latissimus', groupId: 'back', label: '広背筋' },
  { id: 'upper_back', groupId: 'back', label: '上背部' },
  { id: 'spinal_erectors', groupId: 'back', label: '脊柱起立筋' },
  { id: 'anterior_deltoid', groupId: 'shoulders', label: '三角筋前部' },
  { id: 'lateral_deltoid', groupId: 'shoulders', label: '三角筋中部' },
  { id: 'posterior_deltoid', groupId: 'shoulders', label: '三角筋後部' },
  { id: 'biceps', groupId: 'arms', label: '上腕二頭筋' },
  { id: 'triceps', groupId: 'arms', label: '上腕三頭筋' },
  { id: 'forearms', groupId: 'arms', label: '前腕' },
  { id: 'quadriceps', groupId: 'lower_body', label: '大腿四頭筋' },
  { id: 'hamstrings', groupId: 'lower_body', label: 'ハムストリング' },
  { id: 'glute_max', groupId: 'lower_body', label: '大臀筋' },
  { id: 'glute_med', groupId: 'lower_body', label: '中臀筋' },
  { id: 'adductors', groupId: 'lower_body', label: '内転筋' },
  { id: 'calves', groupId: 'lower_body', label: 'ふくらはぎ' },
  { id: 'rectus_abdominis', groupId: 'core', label: '腹直筋' },
  { id: 'obliques', groupId: 'core', label: '腹斜筋' },
  { id: 'core_stability', groupId: 'core', label: '体幹安定' }
] as const;

export type MuscleId = (typeof muscles)[number]['id'];
export type MuscleRole = 'primary' | 'secondary';
export type MuscleTarget = {
  muscleId: MuscleId;
  role: MuscleRole;
};
export type MovementPattern =
  | 'horizontal_push'
  | 'vertical_push'
  | 'horizontal_pull'
  | 'vertical_pull'
  | 'squat'
  | 'hip_hinge'
  | 'hip_extension'
  | 'hip_abduction'
  | 'hip_adduction'
  | 'knee_extension'
  | 'knee_flexion'
  | 'calf_raise'
  | 'elbow_flexion'
  | 'elbow_extension'
  | 'trunk_flexion'
  | 'trunk_rotation'
  | 'anti_extension';
export type Laterality = 'bilateral' | 'unilateral' | 'alternating';
export type LoadModel = 'external_load' | 'bodyweight' | 'assisted_bodyweight';

export const movementPatternOptions: Array<{ value: MovementPattern; label: string }> = [
  { value: 'horizontal_push', label: '水平プッシュ' },
  { value: 'vertical_push', label: '垂直プッシュ' },
  { value: 'horizontal_pull', label: '水平プル' },
  { value: 'vertical_pull', label: '垂直プル' },
  { value: 'squat', label: 'スクワット' },
  { value: 'hip_hinge', label: 'ヒップヒンジ' },
  { value: 'hip_extension', label: '股関節伸展' },
  { value: 'hip_abduction', label: '股関節外転' },
  { value: 'hip_adduction', label: '股関節内転' },
  { value: 'knee_extension', label: '膝伸展' },
  { value: 'knee_flexion', label: '膝屈曲' },
  { value: 'calf_raise', label: '足関節底屈' },
  { value: 'elbow_flexion', label: '肘屈曲' },
  { value: 'elbow_extension', label: '肘伸展' },
  { value: 'trunk_flexion', label: '体幹屈曲' },
  { value: 'trunk_rotation', label: '体幹回旋' },
  { value: 'anti_extension', label: '伸展抵抗' }
];

export const lateralityOptions: Array<{ value: Laterality; label: string }> = [
  { value: 'bilateral', label: '両側・両手両脚' },
  { value: 'unilateral', label: '片側ずつ' },
  { value: 'alternating', label: '左右交互' }
];

export const loadModelOptions: Array<{ value: LoadModel; label: string }> = [
  { value: 'external_load', label: '外部重量' },
  { value: 'bodyweight', label: '自重' },
  { value: 'assisted_bodyweight', label: '補助付き自重' }
];

const muscleById = new Map(muscles.map((muscle) => [muscle.id, muscle]));

export function muscleLabel(muscleId: MuscleId): string {
  return muscleById.get(muscleId)?.label ?? muscleId;
}

export function formatMuscleTargets(targets: MuscleTarget[]): string {
  const primary = targets.filter((target) => target.role === 'primary').map((target) => muscleLabel(target.muscleId));
  const secondary = targets
    .filter((target) => target.role === 'secondary')
    .map((target) => muscleLabel(target.muscleId));
  return secondary.length ? `${primary.join('・')}（補助: ${secondary.join('・')}）` : primary.join('・');
}

export function normalizeMuscleTargets(value: unknown): MuscleTarget[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<MuscleId>();
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    const muscle = muscles.find((candidate) => candidate.id === record.muscleId);
    if (!muscle || seen.has(muscle.id) || (record.role !== 'primary' && record.role !== 'secondary')) {
      return [];
    }
    seen.add(muscle.id);
    return [{ muscleId: muscle.id, role: record.role }];
  });
}

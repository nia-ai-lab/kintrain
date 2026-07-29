export const MUSCLE_TAXONOMY_VERSION = 2;

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
export type MuscleRole = 'primary' | 'secondary' | 'stabilizer';
export type MuscleTarget = {
  muscleId: MuscleId;
  role: MuscleRole;
  effectiveSetFactor: number;
};
export type MovementFamily = 'push' | 'pull' | 'squat' | 'hinge' | 'trunk' | 'isolation';
export type JointAction =
  | 'shoulder_horizontal_adduction'
  | 'shoulder_horizontal_abduction'
  | 'shoulder_abduction'
  | 'shoulder_adduction'
  | 'shoulder_flexion'
  | 'elbow_flexion'
  | 'elbow_extension'
  | 'hip_extension'
  | 'hip_abduction'
  | 'hip_adduction'
  | 'knee_extension'
  | 'knee_flexion'
  | 'ankle_plantar_flexion'
  | 'trunk_flexion'
  | 'trunk_extension'
  | 'trunk_rotation'
  | 'trunk_anti_extension';
export type Laterality = 'bilateral' | 'unilateral' | 'alternating';
export type LoadModel =
  | 'external_load'
  | 'bodyweight'
  | 'bodyweight_plus_external_load'
  | 'assisted_bodyweight';
export type EquipmentType =
  | 'barbell'
  | 'dumbbell'
  | 'kettlebell'
  | 'cable_machine'
  | 'smith_machine'
  | 'selectorized_machine'
  | 'plate_loaded_machine'
  | 'assisted_machine'
  | 'pullup_bar'
  | 'dip_station'
  | 'roman_chair'
  | 'bodyweight_space'
  | 'ab_wheel'
  | 'other';
export type PulleyPosition = 'high' | 'middle' | 'low' | 'adjustable';
export type AttachmentType =
  | 'single_handle'
  | 'rope'
  | 'straight_bar'
  | 'ez_bar'
  | 'ankle_strap'
  | 'none'
  | 'other';
export type CableSides = 'single' | 'dual';

export const movementFamilyOptions: Array<{ value: MovementFamily; label: string }> = [
  { value: 'push', label: '押す' },
  { value: 'pull', label: '引く' },
  { value: 'squat', label: 'スクワット' },
  { value: 'hinge', label: 'ヒップヒンジ' },
  { value: 'trunk', label: '体幹' },
  { value: 'isolation', label: '単関節・分離動作' }
];

export const jointActionOptions: Array<{ value: JointAction; label: string }> = [
  { value: 'shoulder_horizontal_adduction', label: '肩の水平内転' },
  { value: 'shoulder_horizontal_abduction', label: '肩の水平外転' },
  { value: 'shoulder_abduction', label: '肩の外転' },
  { value: 'shoulder_adduction', label: '肩の内転' },
  { value: 'shoulder_flexion', label: '肩の屈曲' },
  { value: 'elbow_flexion', label: '肘の屈曲' },
  { value: 'elbow_extension', label: '肘の伸展' },
  { value: 'hip_extension', label: '股関節の伸展' },
  { value: 'hip_abduction', label: '股関節の外転' },
  { value: 'hip_adduction', label: '股関節の内転' },
  { value: 'knee_extension', label: '膝の伸展' },
  { value: 'knee_flexion', label: '膝の屈曲' },
  { value: 'ankle_plantar_flexion', label: '足首の底屈' },
  { value: 'trunk_flexion', label: '体幹の屈曲' },
  { value: 'trunk_extension', label: '体幹の伸展' },
  { value: 'trunk_rotation', label: '体幹の回旋' },
  { value: 'trunk_anti_extension', label: '体幹の伸展抵抗' }
];

export const equipmentTypeOptions: Array<{ value: EquipmentType; label: string }> = [
  { value: 'barbell', label: 'バーベル' },
  { value: 'dumbbell', label: 'ダンベル' },
  { value: 'kettlebell', label: 'ケトルベル' },
  { value: 'cable_machine', label: 'ケーブルマシン' },
  { value: 'smith_machine', label: 'スミスマシン' },
  { value: 'selectorized_machine', label: 'ウェイトスタック式マシン' },
  { value: 'plate_loaded_machine', label: 'プレート式マシン' },
  { value: 'assisted_machine', label: 'アシストマシン' },
  { value: 'pullup_bar', label: '懸垂バー' },
  { value: 'dip_station', label: 'ディップス台' },
  { value: 'roman_chair', label: 'ローマンチェア' },
  { value: 'bodyweight_space', label: '器具なし・自重スペース' },
  { value: 'ab_wheel', label: '腹筋ローラー' },
  { value: 'other', label: 'その他' }
];

export const lateralityOptions: Array<{ value: Laterality; label: string }> = [
  { value: 'bilateral', label: '両側同時' },
  { value: 'unilateral', label: '片側ずつ' },
  { value: 'alternating', label: '左右交互' }
];

export const loadModelOptions: Array<{ value: LoadModel; label: string }> = [
  { value: 'external_load', label: '外部重量' },
  { value: 'bodyweight', label: '自重' },
  { value: 'bodyweight_plus_external_load', label: '自重＋追加重量' },
  { value: 'assisted_bodyweight', label: '補助付き自重' }
];

export const pulleyPositionOptions: Array<{ value: PulleyPosition; label: string }> = [
  { value: 'high', label: '高い位置' },
  { value: 'middle', label: '中央' },
  { value: 'low', label: '低い位置' },
  { value: 'adjustable', label: '種目に合わせて調整' }
];

export const attachmentTypeOptions: Array<{ value: AttachmentType; label: string }> = [
  { value: 'single_handle', label: 'シングルハンドル' },
  { value: 'rope', label: 'ロープ' },
  { value: 'straight_bar', label: 'ストレートバー' },
  { value: 'ez_bar', label: 'EZバー' },
  { value: 'ankle_strap', label: 'アンクルストラップ' },
  { value: 'none', label: 'アタッチメントなし' },
  { value: 'other', label: 'その他' }
];

const muscleById = new Map(muscles.map((muscle) => [muscle.id, muscle]));

export const defaultEffectiveSetFactor = (role: MuscleRole): number =>
  role === 'primary' ? 1 : role === 'secondary' ? 0.5 : 0;

export function muscleLabel(muscleId: MuscleId): string {
  return muscleById.get(muscleId)?.label ?? muscleId;
}

export function formatMuscleTargets(targets: MuscleTarget[]): string {
  const byRole = (role: MuscleRole) =>
    targets.filter((target) => target.role === role).map((target) => muscleLabel(target.muscleId));
  const primary = byRole('primary');
  const secondary = byRole('secondary');
  const stabilizers = byRole('stabilizer');
  const details = [
    secondary.length ? `補助: ${secondary.join('・')}` : '',
    stabilizers.length ? `安定: ${stabilizers.join('・')}` : ''
  ].filter(Boolean);
  return details.length ? `${primary.join('・')}（${details.join(' / ')}）` : primary.join('・');
}

export function equipmentTypeLabel(value: EquipmentType): string {
  return equipmentTypeOptions.find((option) => option.value === value)?.label ?? value;
}

export function normalizeMuscleTargets(value: unknown): MuscleTarget[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<MuscleId>();
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const muscle = muscles.find((candidate) => candidate.id === record.muscleId);
    const role =
      record.role === 'primary' || record.role === 'secondary' || record.role === 'stabilizer'
        ? record.role
        : null;
    if (!muscle || !role || seen.has(muscle.id)) return [];
    seen.add(muscle.id);
    const factor =
      typeof record.effectiveSetFactor === 'number' &&
      record.effectiveSetFactor >= 0 &&
      record.effectiveSetFactor <= 1
        ? record.effectiveSetFactor
        : defaultEffectiveSetFactor(role);
    return [{ muscleId: muscle.id, role, effectiveSetFactor: factor }];
  });
}

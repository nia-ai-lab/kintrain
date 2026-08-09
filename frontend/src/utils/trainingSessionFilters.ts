import type { EquipmentType } from '../muscleTaxonomy';

function toKatakana(value: string): string {
  return value.replace(/[\u3041-\u3096]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 0x60)
  );
}
export function normalizeSessionSearchText(value: string): string {
  return toKatakana(value.normalize('NFKC').toLocaleLowerCase('ja-JP'))
    .trim()
    .replace(/\s+/g, ' ');
}

export function matchesSessionName(trainingName: string, query: string): boolean {
  const normalizedQuery = normalizeSessionSearchText(query);
  if (!normalizedQuery) {
    return true;
  }
  const normalizedName = normalizeSessionSearchText(trainingName);
  return normalizedQuery.split(' ').every((token) => normalizedName.includes(token));
}

export function matchesSessionEquipment(
  equipmentType: EquipmentType,
  selectedEquipmentTypes: ReadonlySet<EquipmentType>
): boolean {
  return selectedEquipmentTypes.size === 0 || selectedEquipmentTypes.has(equipmentType);
}

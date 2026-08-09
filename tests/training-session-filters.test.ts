import assert from 'node:assert/strict';
import test from 'node:test';
import {
  matchesSessionEquipment,
  matchesSessionName,
  normalizeSessionSearchText
} from '../frontend/src/utils/trainingSessionFilters';

test('種目名検索は全半角・大小文字・ひらがなカタカナを同一視する', () => {
  assert.equal(normalizeSessionSearchText(' ＤｕｍｂＢｅｌｌ　ぷれす '), 'dumbbell プレス');
  assert.equal(matchesSessionName('ダンベルプレス', 'だんべる ぷれ'), true);
  assert.equal(matchesSessionName('ダンベルフライ', 'だんべる ぷれ'), false);
});
test('器具は未選択なら全件、複数選択ならOR一致する', () => {
  assert.equal(matchesSessionEquipment('barbell', new Set()), true);
  const selected = new Set(['barbell', 'dumbbell'] as const);
  assert.equal(matchesSessionEquipment('dumbbell', selected), true);
  assert.equal(matchesSessionEquipment('cable_machine', selected), false);
});

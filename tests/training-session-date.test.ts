import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addYmdDays,
  combineYmdWithInstantTimeUtc,
  isValidYmd,
  toYmdInTimeZone
} from '../frontend/src/utils/date.ts';

test('実在する日付だけを受理し、日付加算はUTC境界の影響を受けない', () => {
  assert.equal(isValidYmd('2024-02-29'), true);
  assert.equal(isValidYmd('2025-02-29'), false);
  assert.equal(addYmdDays('2026-08-05', -1), '2026-08-04');
  assert.equal(addYmdDays('2026-01-01', -1), '2025-12-31');
});

test('選択日と現在の現地時刻を組み合わせてAsia/TokyoのUTC時刻を作る', () => {
  const source = new Date('2026-08-05T12:34:56Z'); // Asia/Tokyo 21:34:56
  const combined = combineYmdWithInstantTimeUtc('2026-08-04', source, 'Asia/Tokyo');

  assert.equal(combined, '2026-08-04T12:34:56Z');
  assert.equal(toYmdInTimeZone(new Date(combined), 'Asia/Tokyo'), '2026-08-04');
});

test('DSTを持つタイムゾーンでも選択したローカル日付を保持する', () => {
  const source = new Date('2026-07-15T14:30:00Z'); // America/New_York 10:30
  const combined = combineYmdWithInstantTimeUtc('2026-01-15', source, 'America/New_York');

  assert.equal(combined, '2026-01-15T15:30:00Z');
  assert.equal(toYmdInTimeZone(new Date(combined), 'America/New_York'), '2026-01-15');
});

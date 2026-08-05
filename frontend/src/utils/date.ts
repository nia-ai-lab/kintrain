export function pad2(num: number): string {
  return String(num).padStart(2, '0');
}

export function toYmd(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function isValidYmd(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function getDateTimePartsInTimeZone(date: Date, timeZoneId: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZoneId,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
  };
}

export function toYmdInTimeZone(date: Date, timeZoneId: string): string {
  try {
    const parts = getDateTimePartsInTimeZone(date, timeZoneId);
    return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
  } catch {
    return toYmd(date);
  }
}

export function addYmdDays(value: string, days: number): string {
  if (!isValidYmd(value)) {
    return value;
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

export function combineYmdWithInstantTimeUtc(
  targetYmd: string,
  timeSource: Date,
  timeZoneId: string
): string {
  const safeTimeSource = Number.isNaN(timeSource.getTime()) ? new Date() : timeSource;
  if (!isValidYmd(targetYmd)) {
    return safeTimeSource.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  try {
    const [year, month, day] = targetYmd.split('-').map(Number);
    const timeParts = getDateTimePartsInTimeZone(safeTimeSource, timeZoneId);
    const desiredClockAsUtc = Date.UTC(
      year,
      month - 1,
      day,
      timeParts.hour,
      timeParts.minute,
      timeParts.second
    );
    let candidate = desiredClockAsUtc;

    // IntlだけでIANAタイムゾーンのオフセットを解決する。DST境界でも日付と現地時刻を優先する。
    for (let index = 0; index < 4; index += 1) {
      const observed = getDateTimePartsInTimeZone(new Date(candidate), timeZoneId);
      const observedClockAsUtc = Date.UTC(
        observed.year,
        observed.month - 1,
        observed.day,
        observed.hour,
        observed.minute,
        observed.second
      );
      const adjustment = desiredClockAsUtc - observedClockAsUtc;
      candidate += adjustment;
      if (adjustment === 0) {
        break;
      }
    }

    return new Date(candidate).toISOString().replace(/\.\d{3}Z$/, 'Z');
  } catch {
    return safeTimeSource.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
}

export function toYmdLocalTime(targetYmd: string, timeSource: Date, timeZoneId: string): string {
  try {
    const parts = getDateTimePartsInTimeZone(timeSource, timeZoneId);
    return `${targetYmd}T${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`;
  } catch {
    return `${targetYmd}T${pad2(timeSource.getHours())}:${pad2(timeSource.getMinutes())}:${pad2(timeSource.getSeconds())}`;
  }
}

export function toLocalIsoWithOffset(date: Date): string {
  const tzOffsetMin = -date.getTimezoneOffset();
  const sign = tzOffsetMin >= 0 ? '+' : '-';
  const absMin = Math.abs(tzOffsetMin);
  const hh = pad2(Math.floor(absMin / 60));
  const mm = pad2(absMin % 60);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}${sign}${hh}:${mm}`;
}

export function ymdToDisplay(ymd: string): string {
  const [y, m, d] = ymd.split('-');
  return `${y}/${m}/${d}`;
}

export function isoToDisplayDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return `${date.getFullYear()}/${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function startOfMonth(ym: string): Date {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1);
}

export function toYm(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

export function addMonths(ym: string, diff: number): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + diff, 1);
  return toYm(d);
}

export function getDaysInMonth(ym: string): number {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

export function weekdayIndex(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

export function diffDays(fromYmd: string, toYmd: string): number {
  const from = new Date(fromYmd);
  const to = new Date(toYmd);
  const ms = to.getTime() - from.getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

import { parseYmd } from "./http";

export function enumerateYmdRange(
  validFromDate: string,
  validToDate: string,
  maxDays = 31
): string[] | undefined {
  if (!parseYmd(validFromDate) || !parseYmd(validToDate) || validFromDate > validToDate) {
    return undefined;
  }
  const start = new Date(`${validFromDate}T00:00:00Z`);
  const dates: string[] = [];
  for (let offset = 0; offset < maxDays; offset += 1) {
    const current = new Date(start);
    current.setUTCDate(start.getUTCDate() + offset);
    const date = current.toISOString().slice(0, 10);
    if (date > validToDate) {
      return dates;
    }
    dates.push(date);
  }
  return undefined;
}

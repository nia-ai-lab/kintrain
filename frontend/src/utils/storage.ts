// v2: clear legacy local mock snapshots that contained seeded training menu/history
const STORAGE_KEY = 'kintrain-mock-ui-v2';

export function loadFromStorage<T>(fallback: T): T {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return fallback;
    }
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function saveToStorage<T>(value: T): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

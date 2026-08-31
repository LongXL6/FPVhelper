export const WORKSTATION_ID_STORAGE_KEY = "fpvhelper.workstation.v1";

const WORKSTATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface WorkstationIdStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isWorkstationId(value: unknown): value is string {
  return typeof value === "string" && WORKSTATION_ID_PATTERN.test(value);
}

export function getOrCreateWorkstationId(
  storage: WorkstationIdStorage,
  randomUuid: () => string,
) {
  try {
    const existing = storage.getItem(WORKSTATION_ID_STORAGE_KEY);
    if (isWorkstationId(existing)) return existing;

    const created = randomUuid();
    if (!isWorkstationId(created)) throw new Error("无法生成有效的工作站 ID");
    storage.setItem(WORKSTATION_ID_STORAGE_KEY, created);
    return storage.getItem(WORKSTATION_ID_STORAGE_KEY) === created ? created : null;
  } catch {
    return null;
  }
}

export function getOrCreateBrowserWorkstationId() {
  if (typeof window === "undefined" || typeof crypto === "undefined" || !("randomUUID" in crypto)) return null;
  return getOrCreateWorkstationId(window.localStorage, () => crypto.randomUUID());
}

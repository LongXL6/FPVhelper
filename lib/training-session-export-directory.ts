import { createTrainingSessionBlob } from "./training-session-export";
import { trainingSessionFilename, type TrainingSession } from "./training-session";

const DIRECTORY_DATABASE_NAME = "fpvhelper-training-export";
const DIRECTORY_DATABASE_VERSION = 1;
const DIRECTORY_STORE_NAME = "settings";
const DIRECTORY_HANDLE_KEY = "training-session-directory";

export interface TrainingSessionDirectoryWritable {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}

interface TrainingSessionDirectoryFileHandle {
  createWritable(): Promise<TrainingSessionDirectoryWritable>;
}

export type TrainingSessionDirectoryPermission = "granted" | "denied" | "prompt";

export interface TrainingSessionDirectoryHandle {
  kind: "directory";
  name: string;
  queryPermission?(descriptor: { mode: "readwrite" }): Promise<TrainingSessionDirectoryPermission>;
  requestPermission?(descriptor: { mode: "readwrite" }): Promise<TrainingSessionDirectoryPermission>;
  getFileHandle(name: string, options: { create: true }): Promise<TrainingSessionDirectoryFileHandle>;
}

export type TrainingSessionDirectoryPicker = (options: {
  id: string;
  mode: "readwrite";
  startIn: "downloads";
}) => Promise<TrainingSessionDirectoryHandle>;

export interface TrainingSessionDirectoryStore {
  load(): Promise<TrainingSessionDirectoryHandle | null>;
  save(handle: TrainingSessionDirectoryHandle): Promise<void>;
  clear(): Promise<void>;
  close(): Promise<void>;
}

export type TrainingSessionDirectoryAction = "reauthorize" | "replace";

export interface TrainingSessionDirectoryActionResult {
  handle: TrainingSessionDirectoryHandle | null;
  granted: boolean;
}

function requestValue<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB 请求失败")));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("IndexedDB 事务已中止")));
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("IndexedDB 事务失败")));
  });
}

export function createTrainingSessionDirectoryStore(
  factory: IDBFactory = indexedDB,
  databaseName = DIRECTORY_DATABASE_NAME,
): TrainingSessionDirectoryStore {
  let databasePromise: Promise<IDBDatabase> | null = null;

  const open = () => {
    if (databasePromise) return databasePromise;
    const pendingDatabase = new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(databaseName, DIRECTORY_DATABASE_VERSION);
      let settled = false;
      request.addEventListener("upgradeneeded", () => {
        if (!request.result.objectStoreNames.contains(DIRECTORY_STORE_NAME)) {
          request.result.createObjectStore(DIRECTORY_STORE_NAME);
        }
      });
      request.addEventListener("success", () => {
        if (settled) {
          request.result.close();
          return;
        }
        settled = true;
        resolve(request.result);
      });
      request.addEventListener("error", () => {
        if (settled) return;
        settled = true;
        reject(request.error ?? new Error("无法打开导出目录设置"));
      });
      request.addEventListener("blocked", () => {
        if (settled) return;
        settled = true;
        reject(new Error("导出目录设置数据库升级被其他页面阻止"));
      });
    });
    databasePromise = pendingDatabase;
    void pendingDatabase.catch(() => {
      if (databasePromise === pendingDatabase) databasePromise = null;
    });
    return pendingDatabase;
  };

  return {
    async load() {
      const database = await open();
      const transaction = database.transaction(DIRECTORY_STORE_NAME, "readonly");
      const value = await requestValue(transaction.objectStore(DIRECTORY_STORE_NAME).get(DIRECTORY_HANDLE_KEY));
      await transactionDone(transaction);
      return (value as TrainingSessionDirectoryHandle | undefined) ?? null;
    },
    async save(handle) {
      const database = await open();
      const transaction = database.transaction(DIRECTORY_STORE_NAME, "readwrite");
      transaction.objectStore(DIRECTORY_STORE_NAME).put(handle, DIRECTORY_HANDLE_KEY);
      await transactionDone(transaction);
    },
    async clear() {
      const database = await open();
      const transaction = database.transaction(DIRECTORY_STORE_NAME, "readwrite");
      transaction.objectStore(DIRECTORY_STORE_NAME).delete(DIRECTORY_HANDLE_KEY);
      await transactionDone(transaction);
    },
    async close() {
      const pendingDatabase = databasePromise;
      if (!pendingDatabase) return;
      try {
        const database = await pendingDatabase;
        database.close();
      } finally {
        if (databasePromise === pendingDatabase) databasePromise = null;
      }
    },
  };
}

export function getBrowserTrainingSessionDirectoryPicker(): TrainingSessionDirectoryPicker | null {
  if (typeof window === "undefined") return null;
  const picker = (window as Window & { showDirectoryPicker?: TrainingSessionDirectoryPicker }).showDirectoryPicker;
  return picker ? picker.bind(window) : null;
}

export async function getTrainingSessionDirectoryPermission(
  handle: TrainingSessionDirectoryHandle,
): Promise<TrainingSessionDirectoryPermission> {
  if (!handle.queryPermission) return "denied";
  try {
    return await handle.queryPermission({ mode: "readwrite" });
  } catch {
    return "denied";
  }
}

export async function requestTrainingSessionDirectoryPermission(
  handle: TrainingSessionDirectoryHandle,
): Promise<boolean> {
  const current = await getTrainingSessionDirectoryPermission(handle);
  if (current === "granted") return true;
  if (current !== "prompt" || !handle.requestPermission) return false;
  try {
    return await handle.requestPermission({ mode: "readwrite" }) === "granted";
  } catch {
    return false;
  }
}

export async function runTrainingSessionDirectoryAction({
  action,
  existingHandle,
  picker,
}: {
  action: TrainingSessionDirectoryAction;
  existingHandle: TrainingSessionDirectoryHandle | null;
  picker: TrainingSessionDirectoryPicker | null;
}): Promise<TrainingSessionDirectoryActionResult> {
  if (action === "reauthorize") {
    if (!existingHandle) return { handle: null, granted: false };
    return {
      handle: existingHandle,
      granted: await requestTrainingSessionDirectoryPermission(existingHandle),
    };
  }

  if (!picker) return { handle: null, granted: false };
  const handle = await picker({
    id: "fpvhelper-training-sessions",
    mode: "readwrite",
    startIn: "downloads",
  });
  return {
    handle,
    granted: await requestTrainingSessionDirectoryPermission(handle),
  };
}

export async function closeTrainingSessionDirectoryStoreSafely(
  store: TrainingSessionDirectoryStore,
): Promise<boolean> {
  try {
    await store.close();
    return true;
  } catch {
    return false;
  }
}

export async function saveTrainingSessionToDirectory(
  session: TrainingSession,
  handle: TrainingSessionDirectoryHandle,
) {
  const blob = createTrainingSessionBlob(session);
  const writable = await createTrainingSessionDirectoryWritable(handle, trainingSessionFilename(session));
  await writable.write(blob);
  await writable.close();
  return blob.size;
}

export async function createTrainingSessionDirectoryWritable(
  handle: TrainingSessionDirectoryHandle,
  filename: string,
) {
  if (!filename || filename !== filename.trim() || /[\\/]/.test(filename)) {
    throw new Error("本地文件名无效");
  }
  const fileHandle = await handle.getFileHandle(filename, { create: true });
  return fileHandle.createWritable();
}

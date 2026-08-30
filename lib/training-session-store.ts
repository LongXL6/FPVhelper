import {
  parseTrainingSession,
  parseTrainingSessionDraft,
  type TrainingSession,
  type TrainingSessionDraft,
} from "./training-session";

const DEFAULT_DATABASE_NAME = "fpvhelper-training";
const DATABASE_VERSION = 1;
const DRAFTS_STORE = "drafts";
const SESSIONS_STORE = "sessions";

export interface TrainingSessionStorageIntegrity {
  readableDraftCount: number;
  readableSessionCount: number;
  quarantinedDraftCount: number;
  quarantinedSessionCount: number;
}

export const EMPTY_TRAINING_SESSION_STORAGE_INTEGRITY: TrainingSessionStorageIntegrity = {
  readableDraftCount: 0,
  readableSessionCount: 0,
  quarantinedDraftCount: 0,
  quarantinedSessionCount: 0,
};

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB 请求失败")));
  });
}

function transactionComplete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("IndexedDB 事务已中止")));
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("IndexedDB 事务失败")));
  });
}

function parseStoredRecords<T>(storedRecords: unknown[], parse: (raw: unknown) => T) {
  const readableRecords: T[] = [];
  let quarantinedRecordCount = 0;

  for (const storedRecord of storedRecords) {
    try {
      readableRecords.push(parse(storedRecord));
    } catch {
      quarantinedRecordCount += 1;
    }
  }

  return { readableRecords, quarantinedRecordCount };
}

async function readStoredRecords<T>(
  database: IDBDatabase,
  storeName: typeof DRAFTS_STORE | typeof SESSIONS_STORE,
  parse: (raw: unknown) => T,
) {
  const transaction = database.transaction(storeName, "readonly");
  const storedRecords = await requestResult(transaction.objectStore(storeName).getAll()) as unknown[];
  await transactionComplete(transaction);
  return parseStoredRecords(storedRecords, parse);
}

export interface TrainingSessionStore {
  getActiveDraft: () => Promise<TrainingSessionDraft | null>;
  saveDraft: (draft: TrainingSessionDraft) => Promise<void>;
  deleteDraft: (id: string) => Promise<void>;
  listSessions: (limit?: number) => Promise<TrainingSession[]>;
  countSessions: () => Promise<number>;
  countUnexportedValidSessions: () => Promise<number>;
  getStorageIntegrity: () => Promise<TrainingSessionStorageIntegrity>;
  saveSession: (session: TrainingSession) => Promise<void>;
  completeSession: (session: TrainingSession) => Promise<void>;
  close: () => Promise<void>;
}

export function createTrainingSessionStore(
  indexedDbFactory: IDBFactory = indexedDB,
  databaseName = DEFAULT_DATABASE_NAME,
): TrainingSessionStore {
  const databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDbFactory.open(databaseName, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DRAFTS_STORE)) database.createObjectStore(DRAFTS_STORE, { keyPath: "id" });
      if (!database.objectStoreNames.contains(SESSIONS_STORE)) database.createObjectStore(SESSIONS_STORE, { keyPath: "id" });
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("无法打开训练记录数据库")));
    request.addEventListener("blocked", () => reject(new Error("训练记录数据库被其他页面阻塞")));
  });

  return {
    async getActiveDraft() {
      const database = await databasePromise;
      const { readableRecords } = await readStoredRecords(database, DRAFTS_STORE, parseTrainingSessionDraft);
      return readableRecords.sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0] ?? null;
    },

    async saveDraft(draft) {
      const database = await databasePromise;
      const transaction = database.transaction(DRAFTS_STORE, "readwrite");
      transaction.objectStore(DRAFTS_STORE).put(draft);
      await transactionComplete(transaction);
    },

    async deleteDraft(id) {
      const database = await databasePromise;
      const transaction = database.transaction(DRAFTS_STORE, "readwrite");
      transaction.objectStore(DRAFTS_STORE).delete(id);
      await transactionComplete(transaction);
    },

    async listSessions(limit) {
      const database = await databasePromise;
      const { readableRecords } = await readStoredRecords(database, SESSIONS_STORE, parseTrainingSession);
      const sorted = readableRecords.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
      return limit === undefined ? sorted : sorted.slice(0, Math.max(0, limit));
    },

    async countSessions() {
      const database = await databasePromise;
      const { readableRecords } = await readStoredRecords(database, SESSIONS_STORE, parseTrainingSession);
      return readableRecords.length;
    },

    async countUnexportedValidSessions() {
      const database = await databasePromise;
      const { readableRecords } = await readStoredRecords(database, SESSIONS_STORE, parseTrainingSession);
      return readableRecords
        .filter((session) => session.validity.valid && session.exportedAt === null)
        .length;
    },

    async getStorageIntegrity() {
      const database = await databasePromise;
      const [drafts, sessions] = await Promise.all([
        readStoredRecords(database, DRAFTS_STORE, parseTrainingSessionDraft),
        readStoredRecords(database, SESSIONS_STORE, parseTrainingSession),
      ]);
      return {
        readableDraftCount: drafts.readableRecords.length,
        readableSessionCount: sessions.readableRecords.length,
        quarantinedDraftCount: drafts.quarantinedRecordCount,
        quarantinedSessionCount: sessions.quarantinedRecordCount,
      };
    },

    async saveSession(session) {
      const database = await databasePromise;
      const transaction = database.transaction(SESSIONS_STORE, "readwrite");
      transaction.objectStore(SESSIONS_STORE).put(session);
      await transactionComplete(transaction);
    },

    async completeSession(session) {
      const database = await databasePromise;
      const transaction = database.transaction([DRAFTS_STORE, SESSIONS_STORE], "readwrite");
      transaction.objectStore(SESSIONS_STORE).put(session);
      transaction.objectStore(DRAFTS_STORE).delete(session.id);
      await transactionComplete(transaction);
    },

    async close() {
      const database = await databasePromise;
      database.close();
    },
  };
}

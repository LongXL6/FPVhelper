import {
  parseTrainingSession,
  parseTrainingSessionDraft,
  type TrainingSession,
  type TrainingSessionDraft,
  type TrainingSessionSample,
} from "./training-session";
import { toTrainingSessionSummary, type TrainingSessionSummary } from "./training-session-index";

const DEFAULT_DATABASE_NAME = "fpvhelper-training";
const DATABASE_VERSION = 2;
const DRAFTS_STORE = "drafts";
const SESSIONS_STORE = "sessions";
const DRAFT_INDEX = "draftIndex";
const SESSION_INDEX = "sessionIndex";
const SAMPLE_CHUNKS = "sampleChunks";
const ALL_STORES = [DRAFTS_STORE, SESSIONS_STORE, DRAFT_INDEX, SESSION_INDEX, SAMPLE_CHUNKS];
export const TRAINING_SAMPLE_CHUNK_SIZE = 500;

type DraftSummary = Omit<TrainingSessionDraft, "samples">;
type RecordSummary = TrainingSessionSummary | DraftSummary;
type IndexName = typeof DRAFT_INDEX | typeof SESSION_INDEX;

interface ChunkDescriptor {
  start: number;
  count: number;
  checksum: string;
}

interface StoredRecord {
  id: string;
  status: "ready";
  format: 1;
  metadata: RecordSummary;
  metadataChecksum: string;
  sampleCount: number;
  chunks: ChunkDescriptor[];
}

interface SampleChunk {
  id: string;
  index: number;
  samples: TrainingSessionSample[];
}

export interface TrainingSessionStorageIntegrity {
  readableDraftCount: number;
  readableSessionCount: number;
  quarantinedDraftCount: number;
  quarantinedSessionCount: number;
  migrationWarning?: string;
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

async function inTransaction<T>(
  database: IDBDatabase,
  stores: string | string[],
  mode: IDBTransactionMode,
  operation: (transaction: IDBTransaction) => Promise<T>,
): Promise<T> {
  const transaction = database.transaction(stores, mode);
  const complete = new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("IndexedDB 事务已中止")));
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("IndexedDB 事务失败")));
  });
  // Request failures can abort before the operation reaches its final await.
  void complete.catch(() => undefined);
  try {
    const result = await operation(transaction);
    await complete;
    return result;
  } catch (error) {
    try { transaction.abort(); } catch { /* The transaction may already be inactive. */ }
    await complete.catch(() => undefined);
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// A local corruption check, not a cryptographic archive signature.
function checksum(value: unknown) {
  const serialized = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash = Math.imul(hash ^ serialized.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function metadataOf(record: TrainingSession | TrainingSessionDraft): RecordSummary {
  const { samples: _samples, ...metadata } = record;
  void _samples;
  return metadata;
}

function readManifest(raw: unknown, kind: IndexName): StoredRecord {
  if (!isRecord(raw) || raw.status !== "ready" || raw.format !== 1 || typeof raw.id !== "string"
    || !isRecord(raw.metadata) || raw.metadata.id !== raw.id || raw.metadata.schemaVersion !== 2
    || !Array.isArray(raw.chunks) || !Number.isSafeInteger(raw.sampleCount) || Number(raw.sampleCount) < 0
    || raw.metadataChecksum !== checksum(raw.metadata)) throw new Error("训练记录索引损坏");
  let expectedStart = 0;
  for (const descriptor of raw.chunks) {
    if (!isRecord(descriptor) || descriptor.start !== expectedStart || !Number.isSafeInteger(descriptor.count)
      || Number(descriptor.count) < 1 || Number(descriptor.count) > TRAINING_SAMPLE_CHUNK_SIZE
      || typeof descriptor.checksum !== "string") throw new Error("训练记录样本块索引损坏");
    expectedStart += Number(descriptor.count);
  }
  if (expectedStart !== raw.sampleCount) throw new Error("训练记录样本计数不一致");
  // Validate metadata without loading sample payloads; their integrity is checked on demand.
  if (kind === DRAFT_INDEX) parseTrainingSessionDraft({ ...raw.metadata, samples: [] });
  else {
    parseTrainingSession({ ...raw.metadata, captureQuality: undefined, samples: [] });
    if (raw.metadata.sampleCount !== raw.sampleCount || !isRecord(raw.metadata.validity)
      || typeof raw.metadata.validity.valid !== "boolean" || !Array.isArray(raw.metadata.validity.reasons)
      || !Array.isArray(raw.metadata.dataSources)) throw new Error("训练记录摘要损坏");
  }
  return raw as unknown as StoredRecord;
}

async function checkChunkKeys(transaction: IDBTransaction, record: StoredRecord) {
  const keys = await requestResult(transaction.objectStore(SAMPLE_CHUNKS).index("id").getAllKeys(record.id));
  if (keys.length !== record.chunks.length || keys.some((key, index) => !Array.isArray(key)
    || key[0] !== record.id || key[1] !== index)) throw new Error("训练记录样本块缺失或编号不连续");
}

function quarantine(transaction: IDBTransaction, kind: IndexName, id: string, original: unknown) {
  transaction.objectStore(kind).put({ id, status: "quarantined", original });
}

function writeNewChunks(
  transaction: IDBTransaction,
  id: string,
  newSamples: TrainingSessionSample[],
  start = 0,
  previous: ChunkDescriptor[] = [],
) {
  const chunks = [...previous];
  for (let offset = 0; offset < newSamples.length; offset += TRAINING_SAMPLE_CHUNK_SIZE) {
    const values = newSamples.slice(offset, offset + TRAINING_SAMPLE_CHUNK_SIZE);
    const index = chunks.length;
    const descriptor = { start: start + offset, count: values.length, checksum: checksum(values) };
    // add prevents an existing raw sample block from being silently replaced.
    transaction.objectStore(SAMPLE_CHUNKS).add({ id, index, samples: values } satisfies SampleChunk);
    chunks.push(descriptor);
  }
  return chunks;
}

function manifestFor(metadata: RecordSummary, sampleCount: number, chunks: ChunkDescriptor[]): StoredRecord {
  return { id: metadata.id, status: "ready", format: 1, metadata, metadataChecksum: checksum(metadata), sampleCount, chunks };
}

async function migrateLegacyRecords(database: IDBDatabase) {
  await inTransaction(database, ALL_STORES, "readwrite", async (transaction) => {
    for (const [legacyName, indexName] of [[SESSIONS_STORE, SESSION_INDEX], [DRAFTS_STORE, DRAFT_INDEX]] as const) {
      const legacy = transaction.objectStore(legacyName);
      const index = transaction.objectStore(indexName);
      const [legacyKeys, indexedKeys] = await Promise.all([requestResult(legacy.getAllKeys()), requestResult(index.getAllKeys())]);
      const known = new Set(indexedKeys);
      for (const key of legacyKeys) {
        if (known.has(key)) continue;
        const raw: unknown = await requestResult(legacy.get(key));
        const id = String(key);
        if (indexName === DRAFT_INDEX && await requestResult(transaction.objectStore(SESSION_INDEX).get(id))) {
          index.put({ id, status: "quarantined", legacy: true, reason: "conflicting_session_id" });
          continue;
        }
        let record: TrainingSession | TrainingSessionDraft;
        try {
          record = indexName === SESSION_INDEX ? parseTrainingSession(raw) : parseTrainingSessionDraft(raw);
          if (record.id !== id) throw new Error("训练记录 ID 不一致");
        } catch {
          // The complete legacy value remains in its original store for recovery.
          index.put({ id, status: "quarantined", legacy: true });
          continue;
        }
        if ((await requestResult(transaction.objectStore(SAMPLE_CHUNKS).index("id").getAllKeys(id))).length > 0) {
          // A missing index with surviving blocks needs explicit recovery, not an overwrite.
          index.put({ id, status: "quarantined", legacy: true, reason: "orphan_sample_chunks" });
          continue;
        }
        const chunks = writeNewChunks(transaction, id, record.samples);
        index.add(manifestFor(metadataOf(record), record.samples.length, chunks));
      }
    }
  });
}

async function readIndexes(database: IDBDatabase, kind: IndexName, readOnly = false, knownQuarantined = new Set<string>()) {
  return inTransaction(database, [kind, SAMPLE_CHUNKS], readOnly ? "readonly" : "readwrite", async (transaction) => {
    const records: StoredRecord[] = [];
    let quarantined = 0;
    const rawRecords: unknown[] = await requestResult(transaction.objectStore(kind).getAll());
    for (const raw of rawRecords) {
      if (isRecord(raw) && raw.status === "deleted") continue;
      if (isRecord(raw) && raw.status === "quarantined") { quarantined += 1; continue; }
      try {
        if (isRecord(raw) && knownQuarantined.has(`${kind}/${raw.id}`)) throw new Error("训练记录已隔离");
        const record = readManifest(raw, kind);
        await checkChunkKeys(transaction, record);
        records.push(record);
      } catch {
        quarantined += 1;
        if (isRecord(raw) && typeof raw.id === "string") {
          knownQuarantined.add(`${kind}/${raw.id}`);
          if (!readOnly) quarantine(transaction, kind, raw.id, raw);
        }
      }
    }
    return { records, quarantined };
  });
}

async function readRecord(database: IDBDatabase, kind: IndexName, id: string, readOnly = false, knownQuarantined = new Set<string>()) {
  return inTransaction(database, [kind, SAMPLE_CHUNKS], readOnly ? "readonly" : "readwrite", async (transaction) => {
    const raw: unknown = await requestResult(transaction.objectStore(kind).get(id));
    if (raw === undefined || (isRecord(raw) && (raw.status === "deleted" || raw.status === "quarantined"))) return null;
    try {
      if (knownQuarantined.has(`${kind}/${id}`)) throw new Error("训练记录已隔离");
      const record = readManifest(raw, kind);
      await checkChunkKeys(transaction, record);
      const samples: TrainingSessionSample[] = [];
      for (const [index, descriptor] of record.chunks.entries()) {
        const chunk: unknown = await requestResult(transaction.objectStore(SAMPLE_CHUNKS).get([id, index]));
        if (!isRecord(chunk) || chunk.id !== id || chunk.index !== index || !Array.isArray(chunk.samples)
          || chunk.samples.length !== descriptor.count || checksum(chunk.samples) !== descriptor.checksum) {
          throw new Error("训练记录样本块校验失败");
        }
        samples.push(...chunk.samples as TrainingSessionSample[]);
      }
      return kind === DRAFT_INDEX
        ? parseTrainingSessionDraft({ ...record.metadata, samples })
        : parseTrainingSession({ ...record.metadata, samples });
    } catch {
      knownQuarantined.add(`${kind}/${id}`);
      if (!readOnly) quarantine(transaction, kind, id, raw);
      return null;
    }
  });
}

async function readUnmigratedLegacy(database: IDBDatabase, kind: IndexName, detailId?: string) {
  return inTransaction(database, ALL_STORES, "readonly", async (transaction) => {
    const legacy = transaction.objectStore(kind === SESSION_INDEX ? SESSIONS_STORE : DRAFTS_STORE);
    const index = transaction.objectStore(kind);
    const [legacyKeys, indexedKeys] = await Promise.all([
      detailId === undefined ? requestResult(legacy.getAllKeys()) : requestResult(legacy.getKey(detailId)).then((key) => key === undefined ? [] : [key]),
      detailId === undefined ? requestResult(index.getAllKeys()) : requestResult(index.getKey(detailId)).then((key) => key === undefined ? [] : [key]),
    ]);
    const known = new Set(indexedKeys);
    const summaries: RecordSummary[] = [];
    let detail: TrainingSession | TrainingSessionDraft | null = null;
    let quarantined = 0;
    for (const key of legacyKeys) {
      // A current index (including deleted/quarantined) always wins over the old backup.
      if (known.has(key)) continue;
      const id = String(key);
      if (kind === DRAFT_INDEX && (
        await requestResult(transaction.objectStore(SESSION_INDEX).getKey(id)) !== undefined
        || await requestResult(transaction.objectStore(SESSIONS_STORE).getKey(id)) !== undefined
      )) { quarantined += 1; continue; }
      if ((await requestResult(transaction.objectStore(SAMPLE_CHUNKS).index("id").getAllKeys(id))).length > 0) {
        quarantined += 1;
        continue;
      }
      const raw: unknown = await requestResult(legacy.get(key));
      try {
        const parsed = kind === SESSION_INDEX ? parseTrainingSession(raw) : parseTrainingSessionDraft(raw);
        if (parsed.id !== id) throw new Error("训练记录 ID 不一致");
        summaries.push(metadataOf(parsed));
        if (detailId !== undefined) detail = parsed;
      } catch { quarantined += 1; }
    }
    return { summaries, detail, quarantined };
  });
}

export interface TrainingSessionStore {
  getActiveDraft: () => Promise<TrainingSessionDraft | null>;
  saveDraft: (draft: TrainingSessionDraft) => Promise<void>;
  deleteDraft: (id: string) => Promise<void>;
  getSession: (id: string) => Promise<TrainingSession | null>;
  listSessionSummaries: () => Promise<TrainingSessionSummary[]>;
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
  let closed = false;
  let closing = false;
  let queue: Promise<unknown> = Promise.resolve();
  let migrated = false;
  let migrationWarning: string | null = null;
  const knownQuarantined = new Set<string>();
  const databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    let failed = false;
    const request = indexedDbFactory.open(databaseName, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      for (const name of [DRAFTS_STORE, SESSIONS_STORE, DRAFT_INDEX, SESSION_INDEX]) {
        if (!database.objectStoreNames.contains(name)) database.createObjectStore(name, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(SAMPLE_CHUNKS)) {
        const chunks = database.createObjectStore(SAMPLE_CHUNKS, { keyPath: ["id", "index"] });
        chunks.createIndex("id", "id");
      }
    });
    request.addEventListener("success", () => {
      const database = request.result;
      if (failed || closed) { database.close(); return; }
      database.addEventListener("versionchange", () => { closed = true; database.close(); });
      resolve(database);
    });
    request.addEventListener("error", () => { failed = true; reject(request.error ?? new Error("无法打开训练记录数据库")); });
    request.addEventListener("blocked", () => { failed = true; reject(new Error("训练记录数据库被其他页面阻塞，请关闭旧页面后重试")); });
  });
  void databasePromise.catch(() => undefined);

  function run<T>(operation: (database: IDBDatabase) => Promise<T>, readOperation = false): Promise<T> {
    if (closing || closed) return Promise.reject(new Error("训练记录数据库已关闭"));
    const pending = queue.then(async () => {
      const database = await databasePromise;
      if (closed) throw new Error("训练记录数据库已关闭，请重新打开页面");
      if (!migrated || readOperation) {
        try {
          await migrateLegacyRecords(database);
          migrated = true;
          migrationWarning = null;
        } catch (error) {
          migrated = false;
          const reason = error instanceof Error ? error.message : "本机存储暂不可写";
          migrationWarning = `训练记录分块迁移未完成，历史记录仍可只读查看和导出，写入暂不可用：${reason}`;
          if (!readOperation) throw new Error(migrationWarning, { cause: error });
        }
      }
      return operation(database);
    });
    queue = pending.catch(() => undefined);
    return pending;
  }

  async function availableIndexes(database: IDBDatabase, kind: IndexName) {
    const indexed = await readIndexes(database, kind, migrationWarning !== null, knownQuarantined);
    const legacy = migrationWarning ? await readUnmigratedLegacy(database, kind) : null;
    return {
      records: [
        ...indexed.records.map(({ id, metadata }) => ({ id, metadata })),
        ...(legacy?.summaries.map((metadata) => ({ id: metadata.id, metadata })) ?? []),
      ],
      quarantined: indexed.quarantined + (legacy?.quarantined ?? 0),
    };
  }

  async function availableRecord(database: IDBDatabase, kind: IndexName, id: string) {
    const indexed = await readRecord(database, kind, id, migrationWarning !== null, knownQuarantined);
    return indexed ?? (migrationWarning ? (await readUnmigratedLegacy(database, kind, id)).detail : null);
  }

  function saveCompleted(input: TrainingSession, removeDraft: boolean) {
    const metadata = structuredClone(toTrainingSessionSummary(input));
    const samples = input.samples.slice();
    return run(async (database) => {
      const session = parseTrainingSession({ ...metadata, samples });
      await inTransaction(database, [SESSION_INDEX, DRAFT_INDEX, SAMPLE_CHUNKS], "readwrite", async (transaction) => {
        const sessions = transaction.objectStore(SESSION_INDEX);
        const draftIndex = transaction.objectStore(DRAFT_INDEX);
        const existing: unknown = await requestResult(sessions.get(session.id));
        const draft: unknown = await requestResult(draftIndex.get(session.id));
        const previousRaw = existing ?? (isRecord(draft) && draft.status !== "deleted" ? draft : undefined);
        const previous = previousRaw === undefined ? null : readManifest(previousRaw, existing ? SESSION_INDEX : DRAFT_INDEX);
        if (previous) {
          await checkChunkKeys(transaction, previous);
          if (samples.length < previous.sampleCount || (existing && samples.length !== previous.sampleCount)) {
            throw new Error("已保存的原始样本不可缩短或替换");
          }
          for (const descriptor of previous.chunks) {
            if (checksum(session.samples.slice(descriptor.start, descriptor.start + descriptor.count)) !== descriptor.checksum) {
              throw new Error("已保存的原始样本不可改写");
            }
          }
        }
        const start = previous?.sampleCount ?? 0;
        const chunks = writeNewChunks(transaction, session.id, session.samples.slice(start), start, previous?.chunks);
        sessions.put(manifestFor(toTrainingSessionSummary(session), session.samples.length, chunks));
        if (removeDraft || draft !== undefined) draftIndex.put({ id: session.id, status: "deleted" });
      });
    });
  }

  return {
    getActiveDraft: () => run(async (database) => {
      const { records } = await availableIndexes(database, DRAFT_INDEX);
      records.sort((left, right) => right.metadata.startedAt.localeCompare(left.metadata.startedAt));
      for (const record of records) {
        const draft = await availableRecord(database, DRAFT_INDEX, record.id);
        if (draft) return draft as TrainingSessionDraft;
      }
      return null;
    }, true),

    saveDraft(input) {
      const metadata = structuredClone(metadataOf(input)) as DraftSummary;
      // Appending can continue while IndexedDB is busy. Only this call's boundary is committed.
      const samples = input.samples;
      const sampleCount = samples.length;
      return run(async (database) => {
        await inTransaction(database, [DRAFT_INDEX, SESSION_INDEX, SAMPLE_CHUNKS], "readwrite", async (transaction) => {
          if (await requestResult(transaction.objectStore(SESSION_INDEX).get(metadata.id))) {
            throw new Error("训练记录已经结束，不能写回过期草稿");
          }
          const drafts = transaction.objectStore(DRAFT_INDEX);
          const raw: unknown = await requestResult(drafts.get(metadata.id));
          if (isRecord(raw) && raw.status === "deleted") throw new Error("训练草稿已结束或删除");
          const previous = raw === undefined ? null : readManifest(raw, DRAFT_INDEX);
          if (previous) {
            await checkChunkKeys(transaction, previous);
            if (sampleCount < previous.sampleCount || metadata.markers.length < previous.metadata.markers.length) {
              throw new Error("不能用过期草稿覆盖已保存的数据");
            }
            if (previous.sampleCount > 0) {
              const descriptor = previous.chunks.at(-1)!;
              if (checksum(samples.slice(descriptor.start, descriptor.start + descriptor.count)) !== descriptor.checksum) {
                throw new Error("草稿样本必须在已保存数据后追加");
              }
            }
          }
          const start = previous?.sampleCount ?? 0;
          const parsed = parseTrainingSessionDraft({ ...metadata, samples: samples.slice(start, sampleCount) });
          const chunks = writeNewChunks(transaction, metadata.id, parsed.samples, start, previous?.chunks);
          drafts.put(manifestFor(metadataOf(parsed), sampleCount, chunks));
        });
      });
    },

    deleteDraft: (id) => run(async (database) => {
      await inTransaction(database, [DRAFT_INDEX, SESSION_INDEX, SAMPLE_CHUNKS], "readwrite", async (transaction) => {
        const raw: unknown = await requestResult(transaction.objectStore(DRAFT_INDEX).get(id));
        if (raw !== undefined && (!isRecord(raw) || raw.status !== "deleted")) readManifest(raw, DRAFT_INDEX);
        if (!await requestResult(transaction.objectStore(SESSION_INDEX).get(id))) {
          const keys = await requestResult(transaction.objectStore(SAMPLE_CHUNKS).index("id").getAllKeys(id));
          for (const key of keys) transaction.objectStore(SAMPLE_CHUNKS).delete(key);
        }
        transaction.objectStore(DRAFT_INDEX).put({ id, status: "deleted" });
      });
    }),

    getSession: (id) => run(async (database) => await availableRecord(database, SESSION_INDEX, id) as TrainingSession | null, true),

    listSessionSummaries: () => run(async (database) => {
      const { records } = await availableIndexes(database, SESSION_INDEX);
      return records.map((record) => record.metadata as TrainingSessionSummary)
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    }, true),

    listSessions: (limit) => run(async (database) => {
      const { records } = await availableIndexes(database, SESSION_INDEX);
      const sorted = records.sort((left, right) => right.metadata.startedAt.localeCompare(left.metadata.startedAt));
      const sessions: TrainingSession[] = [];
      const requestedLimit = limit === undefined ? Infinity : Math.max(0, Math.trunc(limit) || 0);
      for (const record of sorted) {
        if (sessions.length >= requestedLimit) break;
        const session = await availableRecord(database, SESSION_INDEX, record.id);
        if (session) sessions.push(session as TrainingSession);
      }
      return sessions;
    }, true),

    countSessions: () => run(async (database) => (await availableIndexes(database, SESSION_INDEX)).records.length, true),

    countUnexportedValidSessions: () => run(async (database) => (await availableIndexes(database, SESSION_INDEX)).records
      .filter((record) => (record.metadata as TrainingSessionSummary).validity.valid
        && (record.metadata as TrainingSessionSummary).exportedAt === null).length, true),

    getStorageIntegrity: () => run(async (database) => {
      const drafts = await availableIndexes(database, DRAFT_INDEX);
      const sessions = await availableIndexes(database, SESSION_INDEX);
      return {
        readableDraftCount: drafts.records.length,
        readableSessionCount: sessions.records.length,
        quarantinedDraftCount: drafts.quarantined,
        quarantinedSessionCount: sessions.quarantined,
        ...(migrationWarning ? { migrationWarning } : {}),
      };
    }, true),

    saveSession: (session) => saveCompleted(session, false),
    completeSession: (session) => saveCompleted(session, true),

    async close() {
      closing = true;
      await queue;
      const database = await databasePromise;
      database.close();
      closed = true;
    },
  };
}

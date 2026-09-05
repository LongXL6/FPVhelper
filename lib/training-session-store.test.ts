import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_TELEMETRY } from "./telemetry";
import { createTrainingSessionStore, TRAINING_SAMPLE_CHUNK_SIZE } from "./training-session-store";
import {
  appendTrainingSessionSample,
  createTrainingSessionDraft,
  finishTrainingSession,
  markTrainingSessionExported,
  recoverInterruptedTrainingSession,
  withTrainingSessionNotes,
  parseTrainingSession,
  serializeTrainingSession,
  type TrainingSessionDraft,
} from "./training-session";

const WORKSTATION_ID = "10000000-0000-4000-8000-000000000001";
const BUILD = "0.2.0+test";

function createDraft(id = "stored-draft", startedAtEpochMs = 1_700_000_000_000) {
  const draft = createTrainingSessionDraft({
    id,
    workstationId: WORKSTATION_ID,
    build: BUILD,
    athleteCode: "PILOT-11",
    source: "serial",
    startedAtEpochMs,
    startedMonotonicMs: 1_000,
  });
  appendTrainingSessionSample(draft, {
    ...EMPTY_TELEMETRY,
    monotonicTimestampMs: 1_100,
    sequence: 1,
    rcChannelsUs: [1500, 1500, 1500, 1200, 1800],
  }, "serial");
  return draft;
}

function requestValue<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
}

async function openDatabase(factory: IDBFactory, name: string) {
  return requestValue(factory.open(name));
}

async function putRawRecord(database: IDBDatabase, storeName: string, record: object) {
  const transaction = database.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).put(record);
  await transactionDone(transaction);
}

function appendSamples(draft: TrainingSessionDraft, count: number) {
  for (let offset = 0; offset < count; offset += 1) {
    const sequence = draft.samples.length + 1;
    appendTrainingSessionSample(draft, {
      ...EMPTY_TELEMETRY,
      monotonicTimestampMs: 1_100 + sequence * 10,
      sequence,
      rcChannelsUs: [1500, 1500, 1500, 1200, 1800],
    }, "serial");
  }
}

async function storedValue(database: IDBDatabase, storeName: string, key: IDBValidKey) {
  const transaction = database.transaction(storeName, "readonly");
  const value: unknown = await requestValue(transaction.objectStore(storeName).get(key));
  await transactionDone(transaction);
  return value;
}

async function removeStoredValue(database: IDBDatabase, storeName: string, key: IDBValidKey) {
  const transaction = database.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).delete(key);
  await transactionDone(transaction);
}

describe("IndexedDB training session store", () => {
  it("persists and reloads a real schema v2 draft", async () => {
    const factory = new IDBFactory();
    const writer = createTrainingSessionStore(factory, "draft-round-trip");
    const draft = createDraft();
    await writer.saveDraft(draft);
    draft.samples[0].channelsUs[0] = 999;

    const reader = createTrainingSessionStore(factory, "draft-round-trip");
    const stored = await reader.getActiveDraft();
    expect(stored).toMatchObject({ id: "stored-draft", athleteCode: "PILOT-11", schemaVersion: 2 });
    expect(stored?.samples[0].channelsUs).toEqual([1500, 1500, 1500, 1200, 1800]);

    await writer.close();
    await reader.close();
  });

  it("atomically replaces a draft with its completed session", async () => {
    const store = createTrainingSessionStore(new IDBFactory(), "complete-session");
    const draft = createDraft();
    await store.saveDraft(draft);
    const session = finishTrainingSession(draft, 1_700_000_001_000, 2_000);

    await store.completeSession(session);

    expect(await store.getActiveDraft()).toBeNull();
    expect(await store.countSessions()).toBe(1);
    expect(await store.listSessions()).toEqual([session]);
    await store.close();
  });

  it("keeps a refreshed draft as an explicit interrupted session", async () => {
    const store = createTrainingSessionStore(new IDBFactory(), "recover-session");
    await store.saveDraft(createDraft("refresh-draft"));

    const persistedDraft = await store.getActiveDraft();
    expect(persistedDraft).not.toBeNull();
    const recovered = recoverInterruptedTrainingSession(persistedDraft!);
    await store.completeSession(recovered);

    expect(await store.getActiveDraft()).toBeNull();
    expect((await store.listSessions())[0]).toMatchObject({
      id: "refresh-draft",
      interrupted: true,
      validity: { valid: false, reasons: expect.arrayContaining(["interrupted"]) },
    });
    await store.close();
  });

  it("keeps multiple completed records and updates one record without overwriting the others", async () => {
    const store = createTrainingSessionStore(new IDBFactory(), "multiple-sessions");
    const first = finishTrainingSession(createDraft("session-one"), 1_700_000_001_000, 2_000);
    const second = finishTrainingSession(createDraft("session-two"), 1_700_000_002_000, 3_000);

    await store.saveSession(first);
    await store.saveSession(second);
    await store.saveSession(withTrainingSessionNotes(first, "保留这一条"));

    const sessions = await store.listSessions();
    expect(await store.countSessions()).toBe(2);
    expect(new Set(sessions.map((session) => session.id))).toEqual(new Set(["session-one", "session-two"]));
    expect(sessions.find((session) => session.id === "session-one")?.notes).toBe("保留这一条");
    await store.close();
  });

  it("tracks unexported valid sessions and persists repeat export status", async () => {
    const store = createTrainingSessionStore(new IDBFactory(), "export-status");
    const draft = createTrainingSessionDraft({
      id: "valid-session",
      workstationId: WORKSTATION_ID,
      build: BUILD,
      athleteCode: "PILOT-12",
      source: "serial",
      startedAtEpochMs: 1_700_000_000_000,
      startedMonotonicMs: 1_000,
    });
    for (let sequence = 1; sequence <= 300; sequence += 1) {
      appendTrainingSessionSample(draft, {
        ...EMPTY_TELEMETRY,
        monotonicTimestampMs: 1_000 + sequence * 200,
        sequence,
        rcChannelsUs: [1500, 1500, 1500, 1200],
      }, "serial");
    }
    const session = finishTrainingSession(draft, 1_700_000_060_000, 61_000);
    await store.saveSession(session);

    expect(await store.countUnexportedValidSessions()).toBe(1);
    const exported = markTrainingSessionExported(session, 1_700_000_061_000);
    await store.saveSession(exported);

    expect(await store.countUnexportedValidSessions()).toBe(0);
    expect((await store.listSessions())[0]).toMatchObject({ id: "valid-session", exportCount: 1, exportedAt: exported.exportedAt });
    await store.close();
  });

  it("lists cross-day history without a limit and keeps older sessions available for repeat export", async () => {
    const store = createTrainingSessionStore(new IDBFactory(), "cross-day-history");
    const previousDayEpochMs = Date.parse("2026-08-30T08:00:00.000Z");
    const currentDayEpochMs = Date.parse("2026-08-31T08:00:00.000Z");
    const previousDay = finishTrainingSession(
      createDraft("previous-day", previousDayEpochMs),
      previousDayEpochMs + 1_000,
      2_000,
    );
    const currentDay = finishTrainingSession(
      createDraft("current-day", currentDayEpochMs),
      currentDayEpochMs + 1_000,
      2_000,
    );
    await store.saveSession(previousDay);
    await store.saveSession(markTrainingSessionExported(currentDay, currentDayEpochMs + 2_000));

    expect((await store.listSessions()).map((session) => session.id)).toEqual(["current-day", "previous-day"]);
    const firstRepeat = markTrainingSessionExported(previousDay, currentDayEpochMs + 3_000);
    await store.saveSession(firstRepeat);
    const secondRepeat = markTrainingSessionExported(firstRepeat, currentDayEpochMs + 4_000);
    await store.saveSession(secondRepeat);

    expect((await store.listSessions()).find((session) => session.id === "previous-day")).toMatchObject({
      exportCount: 2,
      exportedAt: secondRepeat.exportedAt,
    });
    await store.close();
  });

  it("quarantines unreadable records while preserving every readable and raw record", async () => {
    const factory = new IDBFactory();
    const databaseName = "corrupt-record-isolation";
    const store = createTrainingSessionStore(factory, databaseName);
    const draft = createDraft("readable-draft");
    const session = finishTrainingSession(createDraft("readable-session"), 1_700_000_001_000, 2_000);
    await store.saveDraft(draft);
    await store.saveSession(session);

    const database = await openDatabase(factory, databaseName);
    const badDraft = { id: "bad-draft", schemaVersion: 999, startedAt: "future" };
    const badSession = { id: "bad-session", schemaVersion: 999, startedAt: "future" };
    await putRawRecord(database, "drafts", badDraft);
    await putRawRecord(database, "sessions", badSession);

    expect(await store.getActiveDraft()).toMatchObject({ id: "readable-draft" });
    expect(await store.listSessions()).toEqual([session]);
    expect(await store.countSessions()).toBe(1);
    expect(await store.countUnexportedValidSessions()).toBe(0);
    expect(await store.getStorageIntegrity()).toEqual({
      readableDraftCount: 1,
      readableSessionCount: 1,
      quarantinedDraftCount: 1,
      quarantinedSessionCount: 1,
    });

    const draftTransaction = database.transaction("drafts", "readonly");
    expect(await requestValue(draftTransaction.objectStore("drafts").get("bad-draft"))).toEqual(badDraft);
    await transactionDone(draftTransaction);
    const sessionTransaction = database.transaction("sessions", "readonly");
    expect(await requestValue(sessionTransaction.objectStore("sessions").get("bad-session"))).toEqual(badSession);
    await transactionDone(sessionTransaction);

    database.close();
    await store.close();
  });

  it("rejects writes after the database closes instead of reporting a silent success", async () => {
    const store = createTrainingSessionStore(new IDBFactory(), "closed-store-error");
    const session = finishTrainingSession(createDraft("closed-session"), 1_700_000_001_000, 2_000);
    await store.close();

    await expect(store.saveSession(session)).rejects.toThrow();
  });

  it("migrates v1 databases and schema v1 sessions while preserving legacy originals", async () => {
    const factory = new IDBFactory();
    const opening = factory.open("legacy-migration", 1);
    opening.addEventListener("upgradeneeded", () => {
      opening.result.createObjectStore("drafts", { keyPath: "id" });
      opening.result.createObjectStore("sessions", { keyPath: "id" });
    });
    const legacyDatabase = await requestValue(opening);
    const draft = createDraft("legacy-draft");
    const session = finishTrainingSession(createDraft("legacy-session"), 1_700_000_001_000, 2_000);
    const legacy = { ...session, schemaVersion: 1 };
    const unreadable = { id: "future-session", schemaVersion: 999, samples: ["original"] };
    await putRawRecord(legacyDatabase, "drafts", draft);
    await putRawRecord(legacyDatabase, "sessions", legacy);
    await putRawRecord(legacyDatabase, "sessions", unreadable);
    legacyDatabase.close();

    const store = createTrainingSessionStore(factory, "legacy-migration");
    expect(await store.getActiveDraft()).toEqual(draft);
    expect(await store.getSession(session.id)).toMatchObject({ id: session.id, schemaVersion: 2, migratedFromSchemaVersion: 1 });
    expect(await store.getStorageIntegrity()).toMatchObject({ readableDraftCount: 1, readableSessionCount: 1, quarantinedSessionCount: 1 });
    const database = await openDatabase(factory, "legacy-migration");
    expect(database.version).toBe(2);
    expect(await storedValue(database, "drafts", draft.id)).toEqual(draft);
    expect(await storedValue(database, "sessions", session.id)).toEqual(legacy);
    expect(await storedValue(database, "sessions", unreadable.id)).toEqual(unreadable);
    await store.deleteDraft(draft.id);
    await store.close();
    const reopened = createTrainingSessionStore(factory, "legacy-migration");
    expect(await reopened.getActiveDraft()).toBeNull();
    expect(await reopened.countSessions()).toBe(1);
    database.close();
    await reopened.close();
  });

  it("writes only new immutable sample blocks and fixes each save's sample boundary", async () => {
    const factory = new IDBFactory();
    const store = createTrainingSessionStore(factory, "incremental-saves");
    const draft = createDraft();
    appendSamples(draft, TRAINING_SAMPLE_CHUNK_SIZE * 2);
    const add = vi.spyOn(IDBObjectStore.prototype, "add");
    const put = vi.spyOn(IDBObjectStore.prototype, "put");
    try {
      const saving = store.saveDraft(draft);
      const savedCount = draft.samples.length;
      appendSamples(draft, 30);
      await saving;
      expect((await store.getActiveDraft())?.samples).toHaveLength(savedCount);
      const firstChunkWrites = add.mock.calls.filter((_, index) => (add.mock.contexts[index] as IDBObjectStore).name === "sampleChunks");
      expect(firstChunkWrites.map(([value]) => value.samples.length)).toEqual([500, 500, 1]);
      add.mockClear();
      await store.saveDraft(draft);
      expect(add.mock.calls.filter((_, index) => (add.mock.contexts[index] as IDBObjectStore).name === "sampleChunks")
        .map(([value]) => value.samples.length)).toEqual([30]);
      expect(put.mock.calls.filter((_, index) => (put.mock.contexts[index] as IDBObjectStore).name === "sampleChunks")).toEqual([]);
      await store.close();
      const reader = createTrainingSessionStore(factory, "incremental-saves");
      expect((await reader.getActiveDraft())?.samples).toEqual(draft.samples);
      await reader.close();
    } finally {
      add.mockRestore();
      put.mockRestore();
    }
  });

  it("keeps summary lists and counts away from full samples, including metadata-only updates", async () => {
    const store = createTrainingSessionStore(new IDBFactory(), "summary-reads");
    const draft = createDraft();
    appendSamples(draft, 1200);
    const session = finishTrainingSession(draft, 1_700_000_060_000, 61_000);
    await store.completeSession(session);
    const get = vi.spyOn(IDBObjectStore.prototype, "get");
    const getAll = vi.spyOn(IDBObjectStore.prototype, "getAll");
    const add = vi.spyOn(IDBObjectStore.prototype, "add");
    const put = vi.spyOn(IDBObjectStore.prototype, "put");
    try {
      expect((await store.listSessionSummaries())[0]).toMatchObject({ id: session.id, sampleCount: 1201 });
      expect((await store.listSessionSummaries())[0]).not.toHaveProperty("samples");
      expect(await store.countSessions()).toBe(1);
      expect(await store.countUnexportedValidSessions()).toBe(1);
      await store.getStorageIntegrity();
      await store.saveSession(markTrainingSessionExported(withTrainingSessionNotes(session, "分析备注"), 1_700_000_061_000));
      expect(get.mock.contexts.filter((context) => (context as IDBObjectStore).name === "sampleChunks")).toEqual([]);
      expect(getAll.mock.contexts.map((context) => (context as IDBObjectStore).name)).not.toContain("sampleChunks");
      expect(getAll.mock.contexts.map((context) => (context as IDBObjectStore).name)).not.toContain("sessions");
      expect(add.mock.contexts.filter((context) => (context as IDBObjectStore).name === "sampleChunks")).toEqual([]);
      expect(put.mock.contexts.filter((context) => (context as IDBObjectStore).name === "sampleChunks")).toEqual([]);
      expect(await store.getSession(session.id)).toMatchObject({ notes: "分析备注", exportCount: 1, samples: session.samples });
    } finally {
      get.mockRestore(); getAll.mockRestore(); add.mockRestore(); put.mockRestore();
      await store.close();
    }
  });

  it("quarantines missing or corrupted blocks without deleting raw data or changing other sessions", async () => {
    const factory = new IDBFactory();
    const store = createTrainingSessionStore(factory, "block-corruption");
    const missing = finishTrainingSession(createDraft("missing"), 1_700_000_001_000, 2_000);
    const corrupt = finishTrainingSession(createDraft("corrupt"), 1_700_000_001_000, 2_000);
    const healthy = finishTrainingSession(createDraft("healthy"), 1_700_000_001_000, 2_000);
    await store.saveSession(missing);
    await store.saveSession(corrupt);
    await store.saveSession(healthy);
    const database = await openDatabase(factory, "block-corruption");
    await removeStoredValue(database, "sampleChunks", [missing.id, 0]);
    const original = await storedValue(database, "sampleChunks", [corrupt.id, 0]) as { id: string; index: number; samples: unknown[] };
    const changed = { ...original, samples: [{ ...corrupt.samples[0], elapsedMs: 999 }] };
    await putRawRecord(database, "sampleChunks", changed);
    expect(await store.getSession(missing.id)).toBeNull();
    expect(await store.getSession(corrupt.id)).toBeNull();
    expect((await store.listSessionSummaries()).map((summary) => summary.id)).toEqual([healthy.id]);
    expect(await store.getStorageIntegrity()).toMatchObject({ readableSessionCount: 1, quarantinedSessionCount: 2 });
    expect(await storedValue(database, "sampleChunks", [corrupt.id, 0])).toEqual(changed);
    expect(await storedValue(database, "sessionIndex", corrupt.id)).toHaveProperty("original");
    await expect(store.saveSession(corrupt)).rejects.toThrow();
    expect(await store.getSession(healthy.id)).toEqual(healthy);
    database.close();
    await store.close();
  });

  it("does not rebuild a missing legacy index over surviving sample blocks", async () => {
    const factory = new IDBFactory();
    const store = createTrainingSessionStore(factory, "orphaned-legacy-index");
    await store.countSessions();
    const database = await openDatabase(factory, "orphaned-legacy-index");
    const session = finishTrainingSession(createDraft("legacy"), 1_700_000_001_000, 2_000);
    await putRawRecord(database, "sessions", session);
    expect(await store.getSession(session.id)).toEqual(session);
    const chunk = await storedValue(database, "sampleChunks", [session.id, 0]);
    await removeStoredValue(database, "sessionIndex", session.id);
    expect(await store.getSession(session.id)).toBeNull();
    expect(await storedValue(database, "sampleChunks", [session.id, 0])).toEqual(chunk);
    expect(await storedValue(database, "sessions", session.id)).toEqual(session);
    expect(await store.getStorageIntegrity()).toMatchObject({ quarantinedSessionCount: 1 });
    database.close();
    await store.close();
  });

  it("keeps conflicting legacy drafts visible as quarantined, including an unreadable session with the same id", async () => {
    const factory = new IDBFactory();
    const store = createTrainingSessionStore(factory, "legacy-conflict");
    await store.countSessions();
    const database = await openDatabase(factory, "legacy-conflict");
    const draft = createDraft("same-id");
    const unreadable = { id: draft.id, schemaVersion: 999, original: "preserved" };
    await putRawRecord(database, "drafts", draft);
    await putRawRecord(database, "sessions", unreadable);
    expect(await store.getActiveDraft()).toBeNull();
    expect(await store.getStorageIntegrity()).toEqual({
      readableDraftCount: 0, readableSessionCount: 0, quarantinedDraftCount: 1, quarantinedSessionCount: 1,
    });
    expect(await storedValue(database, "drafts", draft.id)).toEqual(draft);
    expect(await storedValue(database, "sessions", draft.id)).toEqual(unreadable);
    await expect(store.saveDraft(draft)).rejects.toThrow();
    database.close();
    await store.close();
  });

  it("rejects an incremental storage failure without advancing the recoverable draft", async () => {
    const store = createTrainingSessionStore(new IDBFactory(), "failed-autosave");
    const draft = createDraft();
    await store.saveDraft(draft);
    appendSamples(draft, 500);
    const originalAdd = IDBObjectStore.prototype.add;
    const add = vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === "sampleChunks") throw new DOMException("Storage full", "QuotaExceededError");
      return originalAdd.call(this, value, key);
    });
    await expect(store.saveDraft(draft)).rejects.toThrow("Storage full");
    add.mockRestore();
    expect((await store.getActiveDraft())?.samples).toHaveLength(1);
    await store.saveDraft(draft);
    expect((await store.getActiveDraft())?.samples).toHaveLength(501);
    await store.close();
  });

  it("rolls back appended chunks when completing fails and safely retries", async () => {
    const factory = new IDBFactory();
    const store = createTrainingSessionStore(factory, "atomic-failure");
    const draft = createDraft();
    await store.saveDraft(draft);
    appendSamples(draft, 20);
    const session = finishTrainingSession(draft, 1_700_000_001_000, 2_000);
    const originalPut = IDBObjectStore.prototype.put;
    const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === "sessionIndex") throw new DOMException("Storage full", "QuotaExceededError");
      return originalPut.call(this, value, key);
    });
    await expect(store.completeSession(session)).rejects.toThrow("Storage full");
    put.mockRestore();
    expect((await store.getActiveDraft())?.samples).toHaveLength(1);
    expect(await store.countSessions()).toBe(0);
    await store.completeSession(session);
    expect(await store.getSession(session.id)).toEqual(session);
    expect(await store.getActiveDraft()).toBeNull();
    await store.close();
  });

  it("rejects stale drafts after completion across two writers and never regresses saved samples", async () => {
    const factory = new IDBFactory();
    const writer = createTrainingSessionStore(factory, "concurrent-writers");
    const other = createTrainingSessionStore(factory, "concurrent-writers");
    const draft = createDraft();
    await writer.saveDraft(draft);
    const stale = structuredClone(draft);
    appendSamples(draft, 30);
    await writer.saveDraft(draft);
    await expect(other.saveDraft(stale)).rejects.toThrow("过期草稿");
    const session = finishTrainingSession(draft, 1_700_000_001_000, 2_000);
    const completing = writer.completeSession(session);
    const lateSave = writer.saveDraft(draft);
    await completing;
    await expect(lateSave).rejects.toThrow("过期草稿");
    await expect(other.saveDraft(draft)).rejects.toThrow("过期草稿");
    expect(await writer.getActiveDraft()).toBeNull();
    expect(await other.getSession(session.id)).toEqual(session);
    await writer.close();
    await other.close();
  });

  it("drains pending saves on close and releases its database on versionchange", async () => {
    const factory = new IDBFactory();
    const store = createTrainingSessionStore(factory, "closing-save");
    const draft = createDraft();
    const saving = store.saveDraft(draft);
    const closing = store.close();
    await expect(store.saveDraft(draft)).rejects.toThrow("已关闭");
    await saving;
    await closing;
    const reader = createTrainingSessionStore(factory, "closing-save");
    expect(await reader.getActiveDraft()).toEqual(draft);
    const newer = await requestValue(factory.open("closing-save", 3));
    await expect(reader.countSessions()).rejects.toThrow("已关闭");
    newer.close();
    await reader.close();
  });

  it("keeps legacy history readable and exportable when migration runs out of quota, then retries after recovery", async () => {
    const factory = new IDBFactory();
    const opening = factory.open("legacy-quota-fallback", 1);
    opening.addEventListener("upgradeneeded", () => {
      opening.result.createObjectStore("drafts", { keyPath: "id" });
      opening.result.createObjectStore("sessions", { keyPath: "id" });
    });
    const original = await requestValue(opening);
    const draft = createDraft("recoverable-draft");
    const sessionDraft = createDraft("valid-history");
    appendSamples(sessionDraft, 600);
    const session = finishTrainingSession(sessionDraft, 1_700_000_060_000, 61_000);
    const corrupt = { id: "bad-history", schemaVersion: 999, original: "unchanged" };
    const conflictingDraft = createDraft(corrupt.id);
    await putRawRecord(original, "drafts", draft);
    await putRawRecord(original, "drafts", conflictingDraft);
    await putRawRecord(original, "sessions", session);
    await putRawRecord(original, "sessions", corrupt);
    original.close();

    const originalAdd = IDBObjectStore.prototype.add;
    let attemptedChunks = 0;
    const add = vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === "sampleChunks" && ++attemptedChunks % 2 === 0) {
        throw new DOMException("Storage full", "QuotaExceededError");
      }
      return originalAdd.call(this, value, key);
    });
    const store = createTrainingSessionStore(factory, "legacy-quota-fallback");
    try {
      for (let retry = 0; retry < 2; retry += 1) {
        expect((await store.listSessionSummaries()).map((item) => item.id)).toEqual([session.id]);
        expect((await store.listSessionSummaries())[0]).not.toHaveProperty("samples");
        const exportable = await store.getSession(session.id);
        expect(exportable).toEqual(session);
        expect(parseTrainingSession(serializeTrainingSession(exportable!))).toEqual(session);
        expect(await store.listSessions()).toEqual([session]);
        expect(await store.getActiveDraft()).toEqual(draft);
        expect(await store.getSession(corrupt.id)).toBeNull();
        expect(await store.countSessions()).toBe(1);
        expect(await store.countUnexportedValidSessions()).toBe(1);
        expect(await store.getStorageIntegrity()).toEqual({
          readableDraftCount: 1, readableSessionCount: 1,
          quarantinedDraftCount: 1, quarantinedSessionCount: 1,
          migrationWarning: expect.stringContaining("分块迁移未完成"),
        });
      }
      await expect(store.saveDraft(createDraft("new-draft"))).rejects.toThrow("写入暂不可用");
      await expect(store.saveSession(withTrainingSessionNotes(session, "must not overwrite"))).rejects.toThrow("写入暂不可用");
      const database = await openDatabase(factory, "legacy-quota-fallback");
      const transaction = database.transaction(["sampleChunks", "sessionIndex"], "readonly");
      expect(await requestValue(transaction.objectStore("sampleChunks").count())).toBe(0);
      expect(await requestValue(transaction.objectStore("sessionIndex").count())).toBe(0);
      await transactionDone(transaction);
      expect(await storedValue(database, "sessions", session.id)).toEqual(session);
      expect(await storedValue(database, "sessions", corrupt.id)).toEqual(corrupt);
      expect(await storedValue(database, "drafts", draft.id)).toEqual(draft);
      expect(await storedValue(database, "drafts", corrupt.id)).toEqual(conflictingDraft);

      add.mockRestore();
      expect((await store.listSessionSummaries()).map((item) => item.id)).toEqual([session.id]);
      expect(await store.getStorageIntegrity()).toEqual({
        readableDraftCount: 1, readableSessionCount: 1, quarantinedDraftCount: 1, quarantinedSessionCount: 1,
      });
      expect(await store.getSession(session.id)).toEqual(session);
      expect(await storedValue(database, "sessionIndex", session.id)).toMatchObject({ status: "ready", sampleCount: 601 });
      await store.saveSession(withTrainingSessionNotes(session, "capacity recovered"));
      expect((await store.getSession(session.id))?.notes).toBe("capacity recovered");
      expect(await storedValue(database, "sessions", session.id)).toEqual(session);
      database.close();
    } finally {
      add.mockRestore();
      await store.close();
    }
  });

  it("keeps current chunked records authoritative during read-only fallback, including corrupt blocks", async () => {
    const factory = new IDBFactory();
    const store = createTrainingSessionStore(factory, "mixed-quota-fallback");
    const session = finishTrainingSession(createDraft("existing"), 1_700_000_001_000, 2_000);
    const current = withTrainingSessionNotes(session, "current chunked metadata");
    await store.saveSession(current);
    const database = await openDatabase(factory, "mixed-quota-fallback");
    const legacy = finishTrainingSession(createDraft("new-legacy"), 1_700_000_001_000, 2_000);
    await putRawRecord(database, "sessions", session);
    await putRawRecord(database, "sessions", legacy);
    const originalAdd = IDBObjectStore.prototype.add;
    const add = vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === "sampleChunks") throw new DOMException("Storage full", "QuotaExceededError");
      return originalAdd.call(this, value, key);
    });
    try {
      expect(await store.getSession(session.id)).toEqual(current);
      expect((await store.listSessionSummaries()).map((item) => item.id).sort()).toEqual(["existing", "new-legacy"]);
      const corruptedChunk = { id: session.id, index: 0, samples: [{ ...session.samples[0], elapsedMs: 999 }] };
      await putRawRecord(database, "sampleChunks", corruptedChunk);
      expect(await store.getSession(session.id)).toBeNull();
      expect((await store.listSessionSummaries()).map((item) => item.id)).toEqual([legacy.id]);
      expect(await store.getStorageIntegrity()).toMatchObject({
        readableSessionCount: 1, quarantinedSessionCount: 1, migrationWarning: expect.any(String),
      });
      // Quarantine can be tracked without another write while the database is full.
      expect(await storedValue(database, "sessionIndex", session.id)).toMatchObject({ status: "ready" });
      expect(await storedValue(database, "sampleChunks", [session.id, 0])).toEqual(corruptedChunk);
      expect(await storedValue(database, "sessions", session.id)).toEqual(session);
      add.mockRestore();
      expect(await store.getStorageIntegrity()).toEqual({
        readableDraftCount: 0, readableSessionCount: 1, quarantinedDraftCount: 0, quarantinedSessionCount: 1,
      });
      expect(await storedValue(database, "sessionIndex", session.id)).toMatchObject({ status: "quarantined" });
      expect(await store.getSession(session.id)).toBeNull();
      expect(await store.getSession(legacy.id)).toEqual(legacy);
    } finally {
      add.mockRestore();
      database.close();
      await store.close();
    }
  });
});

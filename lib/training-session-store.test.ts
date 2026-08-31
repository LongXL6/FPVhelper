import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { EMPTY_TELEMETRY } from "./telemetry";
import { createTrainingSessionStore } from "./training-session-store";
import {
  appendTrainingSessionSample,
  createTrainingSessionDraft,
  finishTrainingSession,
  markTrainingSessionExported,
  recoverInterruptedTrainingSession,
  withTrainingSessionNotes,
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

async function putRawRecord(database: IDBDatabase, storeName: "drafts" | "sessions", record: object) {
  const transaction = database.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).put(record);
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
});

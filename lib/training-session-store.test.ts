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

function createDraft(id = "stored-draft") {
  const draft = createTrainingSessionDraft({
    id,
    athleteCode: "PILOT-11",
    source: "serial",
    startedAtEpochMs: 1_700_000_000_000,
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

  it("rejects writes after the database closes instead of reporting a silent success", async () => {
    const store = createTrainingSessionStore(new IDBFactory(), "closed-store-error");
    const session = finishTrainingSession(createDraft("closed-session"), 1_700_000_001_000, 2_000);
    await store.close();

    await expect(store.saveSession(session)).rejects.toThrow();
  });
});

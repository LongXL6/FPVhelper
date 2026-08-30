import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { EMPTY_TELEMETRY } from "./telemetry";
import { createTrainingSessionStore } from "./training-session-store";
import {
  appendTrainingSessionSample,
  createTrainingSessionDraft,
  finishTrainingSession,
  recoverInterruptedTrainingSession,
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
});

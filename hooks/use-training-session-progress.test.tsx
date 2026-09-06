import { applyTrainingSessionMetadataPatch } from "../lib/training-session-metadata";
import { useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_TELEMETRY, type FlightTelemetry, type SubscribeTelemetrySamples, type TelemetrySampleListener } from "../lib/telemetry";
import { toTrainingSessionSummary } from "../lib/training-session-index";
import type { TrainingSession, TrainingSessionDraft } from "../lib/training-session";
import * as storage from "../lib/training-session-store";
import * as directory from "../lib/training-session-export-directory";
import * as workstation from "../lib/workstation-id";
import { useTrainingSession } from "./use-training-session";

type Options = Parameters<typeof useTrainingSession>[0];
type Interval = { id: number; delay: number; callback: () => void; cleared: boolean };
type VisibleProgress = { sessionId: string | null; sampleCount: number; uniqueSampleCount: number };
const WORKSTATION_ID = "10000000-0000-4000-8000-000000000001";
const CHANNELS = [1600, 1500, 1500, 1250, 1000, 1000, 1000, 1000];
let controller: ReturnType<typeof useTrainingSession>;
let renderer: ReactTestRenderer | null;
let options: Options;
let now: number;
let intervalHistory: Interval[];
let activeIntervals: Map<number, Interval>;
let listeners: Set<TelemetrySampleListener>;
let subscribeSamples: SubscribeTelemetrySamples;
let store: storage.TrainingSessionStore;
let activeDraft: TrainingSessionDraft | null;
let persistedDraft: TrainingSessionDraft | null;
let records: Map<string, TrainingSession>;
let visibleProgress: VisibleProgress[];

function Harness({ view = "workbench" }: { view?: string }) {
  const value = useTrainingSession(options);
  useEffect(() => { controller = value; }, [value]);
  useEffect(() => {
    visibleProgress.push({ sessionId: value.sessionId, sampleCount: value.sampleCount, uniqueSampleCount: value.uniqueSampleCount });
  }, [value.sampleCount, value.sessionId, value.uniqueSampleCount]);
  return <section data-view={view}><output data-session-id={value.sessionId} data-count={value.sampleCount} data-unique={value.uniqueSampleCount}>{value.sampleCount}/{value.uniqueSampleCount}</output></section>;
}

function shown() {
  const output = renderer!.root.findByType("output");
  return { sessionId: output.props["data-session-id"], sampleCount: output.props["data-count"], uniqueSampleCount: output.props["data-unique"] };
}

function sample(sequence: number, timestamp = now): FlightTelemetry {
  return { ...EMPTY_TELEMETRY, sequence, monotonicTimestampMs: timestamp, rcChannelsUs: [...CHANNELS], rcThrottleUs: 1250 };
}

async function emit(sequence: number, timestamp: number) {
  now = timestamp;
  await act(async () => { for (const listener of listeners) listener(sample(sequence), "serial"); });
}

function interval(delay: number) {
  const matches = [...activeIntervals.values()].filter((timer) => timer.delay === delay);
  expect(matches).toHaveLength(1);
  return matches[0];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function tick(delay: number, timestamp: number) {
  now = timestamp;
  await act(async () => { interval(delay).callback(); });
}

async function start() {
  let id: string | null = null;
  await act(async () => { id = await controller.startRecording(); });
  expect(id).toBeTruthy();
  expect(controller.isRecording).toBe(true);
  return id!;
}

beforeEach(async () => {
  now = 1000;
  intervalHistory = [];
  activeIntervals = new Map();
  listeners = new Set();
  activeDraft = null;
  persistedDraft = null;
  records = new Map();
  visibleProgress = [];
  renderer = null;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(Date, "now").mockImplementation(() => 1_800_000_000_000 + now - 1000);
  const browser = Object.assign(new EventTarget(), {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: vi.fn((callback: () => void, delay: number) => {
      const timer = { id: intervalHistory.length + 1, delay, callback, cleared: false };
      intervalHistory.push(timer); activeIntervals.set(timer.id, timer); return timer.id;
    }),
    clearInterval: vi.fn((id: number) => {
      const timer = activeIntervals.get(id); if (timer) timer.cleared = true;
      activeIntervals.delete(id);
    }),
  });
  vi.stubGlobal("window", browser);
  subscribeSamples = vi.fn((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; });
  const orderedRecords = () => [...records.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  store = {
    getActiveDraft: vi.fn(async () => null),
    saveDraft: vi.fn(async (draft) => {
      // The live argument proves immediate append; only this separate clone represents a confirmed write.
      activeDraft = draft; persistedDraft = structuredClone(draft);
    }),
    deleteDraft: vi.fn(async () => undefined),
    listSessions: vi.fn(async () => orderedRecords()),
    listSessionSummaries: vi.fn(async () => orderedRecords().map(toTrainingSessionSummary)),
    getSession: vi.fn(async (id) => records.get(id) ?? null),
    countSessions: vi.fn(async () => records.size),
    countUnexportedValidSessions: vi.fn(async () => 0),
    getStorageIntegrity: vi.fn(async () => ({ readableDraftCount: 0, readableSessionCount: records.size, quarantinedDraftCount: 0, quarantinedSessionCount: 0 })),
    saveSession: vi.fn(async (session) => { records.set(session.id, structuredClone(session)); }),
    completeSession: vi.fn(async (session) => { records.set(session.id, structuredClone(session)); persistedDraft = null; }),
    patchSession: vi.fn(async (id, patch) => {
      const current = records.get(id);
      if (!current) throw new Error("Missing session");
      const updated = applyTrainingSessionMetadataPatch(toTrainingSessionSummary(current), patch);
      records.set(id, { ...current, ...updated });
      return updated;
    }),
    close: vi.fn(async () => undefined),
  };
  vi.spyOn(storage, "createTrainingSessionStore").mockReturnValue(store);
  vi.spyOn(directory, "getBrowserTrainingSessionDirectoryPicker").mockReturnValue(null);
  vi.spyOn(workstation, "getOrCreateBrowserWorkstationId").mockReturnValue(WORKSTATION_ID);
  options = { telemetry: EMPTY_TELEMETRY, source: "serial", connection: "live", linkState: "ok", athleteCode: "PROGRESS-TEST", autoExport: false, inputKey: "pilot-A", subscribeSamples };
  await act(async () => { renderer = create(<Harness />); });
  expect(controller.storageReady).toBe(true);
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = null;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("recording progress publication", () => {
  it("keeps immediate raw append and existing deduplication while publishing a paired count only on the existing 250 ms tick", async () => {
    const id = await start();
    const publicationsAtStart = visibleProgress.length;
    for (const [index, sequence] of [1, 1, 2, 1].entries()) await emit(sequence, 1010 + index * 10);
    expect(activeDraft!.samples.map((entry) => entry.sequence)).toEqual([1, 2, 1]);
    expect(activeDraft!.samples.map((entry) => entry.elapsedMs)).toEqual([10, 30, 40]);
    expect(persistedDraft!.samples).toHaveLength(0);
    expect(shown()).toEqual({ sessionId: id, sampleCount: 0, uniqueSampleCount: 0 });
    expect(visibleProgress).toHaveLength(publicationsAtStart);
    expect([...activeIntervals.values()].map((timer) => timer.delay).sort((left, right) => left - right)).toEqual([250, 1000]);

    await tick(250, 1250);
    expect(shown()).toEqual({ sessionId: id, sampleCount: 3, uniqueSampleCount: 2 });
    expect(visibleProgress).toHaveLength(publicationsAtStart + 1);
    const publications = visibleProgress.length;
    await tick(250, 1500);
    expect(visibleProgress).toHaveLength(publications);
    expect(controller.elapsedMs).toBe(500);
    expect(controller.persistedSampleCount).toBe(0);
  });

  it.each([50, 100])("retains equal channel values and jittered %i Hz identities without scheduling work per frame", async (hz) => {
    const id = await start();
    const intervalCount = intervalHistory.length;
    const publications = visibleProgress.length;
    const times = Array.from({ length: 8 }, (_, index) => 1000 + (index + 1) * (1000 / hz) + [0, 2, -1, 1][index % 4]);
    for (const [index, timestamp] of times.entries()) await emit(index + 1, timestamp);
    await emit(8, times[7] + 1);
    expect(activeDraft!.samples.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(activeDraft!.samples.map((entry) => entry.elapsedMs)).toEqual(times.map((time) => time - 1000));
    expect(activeDraft!.samples.every((entry) => JSON.stringify(entry.channelsUs) === JSON.stringify(CHANNELS))).toBe(true);
    expect(shown()).toEqual({ sessionId: id, sampleCount: 0, uniqueSampleCount: 0 });
    expect(visibleProgress).toHaveLength(publications);
    expect(intervalHistory).toHaveLength(intervalCount);
    await tick(250, 1250);
    expect(shown()).toEqual({ sessionId: id, sampleCount: 8, uniqueSampleCount: 8 });
    now = 1251;
    await act(async () => { await controller.stopRecording(); });
    expect(records.get(id)!.samples.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("freezes the last post-tick frame before deferred video finalization without waiting for another tick", async () => {
    const video = deferred<null>();
    options = { ...options, finishCompanionRecording: vi.fn(() => video.promise) };
    await act(async () => { renderer!.update(<Harness />); });
    const id = await start();
    await emit(1, 1010);
    await tick(250, 1250);
    const queued = interval(250).callback;
    await emit(2, 1260);
    expect(shown()).toEqual({ sessionId: id, sampleCount: 1, uniqueSampleCount: 1 });
    let finishing!: Promise<void>;
    now = 1261;
    await act(async () => { finishing = controller.stopRecording(); });
    expect(shown()).toEqual({ sessionId: id, sampleCount: 2, uniqueSampleCount: 2 });
    expect(controller).toMatchObject({ isRecording: false, isFinishing: false, hasPendingSave: false, hasPendingMedia: true, persistedSampleCount: 2 });
    expect(controller.lastSession?.samples.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(store.completeSession).toHaveBeenCalledOnce();
    expect(activeIntervals.size).toBe(0);
    const publications = visibleProgress.length;
    await emit(3, 1270);
    await act(async () => { queued(); });
    expect(visibleProgress).toHaveLength(publications);
    expect(controller.lastSession?.sampleCount).toBe(2);
    await act(async () => { video.resolve(null); await finishing; });
    expect(records.get(id)!.samples.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(controller).toMatchObject({ isFinishing: false, hasPendingSave: false, sampleCount: 2, uniqueSampleCount: 2, persistedSampleCount: 2 });
  });

  it("does not let an old queued progress callback publish into the next Session", async () => {
    const firstId = await start();
    await emit(1, 1010); await emit(2, 1020); await emit(1, 1030);
    await tick(250, 1250);
    const oldTimer = interval(250);
    now = 1251;
    await act(async () => { await controller.stopRecording(); });
    expect(oldTimer.cleared).toBe(true);
    now = 2000;
    const secondId = await start();
    expect(secondId).not.toBe(firstId);
    await emit(7, 2010);
    const publications = visibleProgress.length;
    await act(async () => { oldTimer.callback(); });
    expect(shown()).toEqual({ sessionId: secondId, sampleCount: 0, uniqueSampleCount: 0 });
    expect(visibleProgress).toHaveLength(publications);
    expect(activeDraft!.samples.map((entry) => entry.sequence)).toEqual([7]);
    expect(records.get(firstId)).toMatchObject({ sampleCount: 3 });
    await tick(250, 2250);
    expect(shown()).toEqual({ sessionId: secondId, sampleCount: 1, uniqueSampleCount: 1 });
    expect(visibleProgress.filter((entry) => entry.sessionId === secondId)).toEqual([
      { sessionId: secondId, sampleCount: 0, uniqueSampleCount: 0 },
      { sessionId: secondId, sampleCount: 1, uniqueSampleCount: 1 },
    ]);
  });

  it("publishes only the latest pair when a delayed progress callback finally runs", async () => {
    const id = await start();
    for (let sequence = 1; sequence <= 8; sequence++) await emit(sequence, 1000 + sequence * 100);
    const publications = visibleProgress.length;
    await tick(250, 3000);
    expect(shown()).toEqual({ sessionId: id, sampleCount: 8, uniqueSampleCount: 8 });
    expect(visibleProgress).toHaveLength(publications + 1);
    expect(intervalHistory.map((timer) => timer.delay)).toEqual([250, 1000]);
  });

  it.each([0, 1])("immediately freezes an invalid short recording with %i sample and keeps the validity threshold", async (count) => {
    const id = await start();
    if (count) await emit(1, 1010);
    now = 1011;
    await act(async () => { await controller.stopRecording(); });
    expect(shown()).toEqual({ sessionId: id, sampleCount: count, uniqueSampleCount: count });
    expect(records.get(id)).toMatchObject({ sampleCount: count, validity: { valid: false } });
    expect(records.get(id)!.validity.reasons).toEqual(expect.arrayContaining(["too_short", "too_few_unique_samples"]));
    expect(activeIntervals.size).toBe(0);
  });

  it("leaves failed startup feedback immediate and creates no recording timer or raw append", async () => {
    vi.mocked(store.saveDraft).mockRejectedValueOnce(new Error("start transaction failed"));
    let id: string | null = "not-called";
    await act(async () => { id = await controller.startRecording(); });
    expect(id).toBeNull();
    expect(controller).toMatchObject({ isRecording: false, isStarting: false, sampleCount: 0, uniqueSampleCount: 0 });
    expect(controller.storageError).toContain("start transaction failed");
    await emit(1, 1010);
    expect(activeDraft).toBeNull();
    expect(activeIntervals.size).toBe(0);
    expect(store.completeSession).not.toHaveBeenCalled();
  });

  it.each([
    { change: { linkState: "lost" } as Partial<Options>, reason: "rx_link_lost" },
    { change: { source: "demo" } as Partial<Options>, reason: "telemetry_unavailable" },
    { change: { inputKey: "pilot-B" } as Partial<Options>, reason: "channel_changed" },
  ])("freezes pending counts immediately on $reason and excludes later input", async ({ change, reason }) => {
    const id = await start();
    await emit(1, 1010); await tick(250, 1250); await emit(2, 1260);
    options = { ...options, ...change };
    now = 1261;
    await act(async () => { renderer!.update(<Harness />); });
    expect(shown()).toEqual({ sessionId: id, sampleCount: 2, uniqueSampleCount: 2 });
    expect(controller).toMatchObject({ isRecording: false, lastSession: { interrupted: true, interruptionReason: reason, sampleCount: 2 } });
    await emit(3, 1270);
    expect(records.get(id)!.samples.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(activeIntervals.size).toBe(0);
  });

  it("keeps navigation, raw subscription and pagehide recovery independent of displayed progress", async () => {
    const id = await start();
    await emit(1, 1010);
    const subscribeCount = vi.mocked(subscribeSamples).mock.calls.length;
    const timerIds = [...activeIntervals.keys()];
    await act(async () => { renderer!.update(<Harness view="records" />); });
    await emit(2, 1020);
    expect(controller.isRecording).toBe(true);
    expect(vi.mocked(subscribeSamples).mock.calls).toHaveLength(subscribeCount);
    expect([...activeIntervals.keys()]).toEqual(timerIds);
    expect(activeDraft!.samples.map((entry) => entry.sequence)).toEqual([1, 2]);
    await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    const savedForRecovery = structuredClone(persistedDraft!);
    expect(savedForRecovery.samples).toHaveLength(2);
    await act(async () => { renderer!.unmount(); renderer = null; });
    expect(listeners.size).toBe(0);
    expect(activeIntervals.size).toBe(0);
    vi.mocked(store.getActiveDraft).mockResolvedValueOnce(savedForRecovery);
    await act(async () => { renderer = create(<Harness />); });
    expect(shown()).toEqual({ sessionId: id, sampleCount: 2, uniqueSampleCount: 2 });
    expect(controller.lastSession).toMatchObject({ id, interrupted: true, interruptionReason: "page_closed", sampleCount: 2 });
    expect(controller.persistedSampleCount).toBe(2);
    expect(activeIntervals.size).toBe(0);
  });

  it("advances persisted progress only after the matching checkpoint resolves, not after UI ticks", async () => {
    await start(); await emit(1, 1010);
    const transaction = deferred<void>();
    vi.mocked(store.saveDraft).mockImplementationOnce(async (draft) => {
      const snapshot = structuredClone(draft);
      await transaction.promise; persistedDraft = snapshot;
    });
    await tick(1000, 2000);
    expect(controller.persistedSampleCount).toBe(0);
    await emit(2, 2010);
    await tick(250, 2250);
    expect(shown()).toMatchObject({ sampleCount: 2, uniqueSampleCount: 2 });
    expect(controller).toMatchObject({ persistedSampleCount: 0, persistedElapsedMs: 0 });
    await act(async () => { transaction.resolve(); });
    expect(controller).toMatchObject({ persistedSampleCount: 1, persistedElapsedMs: 10 });
    expect(persistedDraft!.samples.map((entry) => entry.sequence)).toEqual([1]);
    expect(activeDraft!.samples.map((entry) => entry.sequence)).toEqual([1, 2]);
  });

  it("keeps marker and save failure feedback immediate while count publication waits", async () => {
    const id = await start(); await emit(1, 1010);
    vi.mocked(store.saveDraft).mockRejectedValueOnce(new Error("marker checkpoint failed"));
    await act(async () => { await controller.addMarker("crash"); });
    expect(controller.markerCount).toBe(1);
    expect(controller.storageError).toContain("marker checkpoint failed");
    expect(shown()).toEqual({ sessionId: id, sampleCount: 0, uniqueSampleCount: 0 });
    expect(controller.persistedSampleCount).toBe(0);
    expect(activeDraft!.markers).toHaveLength(1);
  });

  it("retains the precise frozen display through completion failure and pending-save retry", async () => {
    const id = await start(); await emit(1, 1010);
    vi.mocked(store.completeSession).mockRejectedValueOnce(new Error("completion transaction failed"));
    now = 1011;
    await act(async () => { await controller.stopRecording(); });
    expect(controller).toMatchObject({ isRecording: false, hasPendingSave: true, sampleCount: 1, uniqueSampleCount: 1, persistedSampleCount: 1 });
    expect(controller.storageError).toContain("completion transaction failed");
    expect(records.has(id)).toBe(false);
    await emit(2, 1020);
    await act(async () => { await controller.retryPendingSave(); });
    expect(shown()).toEqual({ sessionId: id, sampleCount: 1, uniqueSampleCount: 1 });
    expect(controller.hasPendingSave).toBe(false);
    expect(records.get(id)!.samples.map((entry) => entry.sequence)).toEqual([1]);
    expect(activeIntervals.size).toBe(0);
  });
});


describe("independent RC finalization", () => {
  it("commits post-checkpoint tail and terminal state while media remains pending", async () => {
    const video = deferred<null>();
    options = { ...options, finishCompanionRecording: vi.fn(() => video.promise) };
    await act(async () => { renderer!.update(<Harness />); });
    const id = await start();
    await emit(1, 1010);
    await tick(1000, 2000);
    await tick(250, 2250);
    await emit(2, 2251);
    let stopping!: Promise<void>;
    await act(async () => { stopping = controller.stopRecording(); });
    try {
      await act(async () => { await controller.retryPendingSave(); });
      expect(records.get(id)?.samples.map((sample) => sample.sequence)).toEqual([1, 2]);
      expect(records.get(id)?.interrupted).toBe(false);
      expect(controller.hasPendingSave).toBe(false);
      expect(controller.persistedSampleCount).toBe(2);
    } finally {
      await act(async () => { video.resolve(null); await stopping; });
    }
  });
});


describe("RC retries and terminal transaction facts", () => {
  it("retries RC while video is pending and keeps the start guard", async () => {
    const video = deferred<null>();
    options = { ...options, finishCompanionRecording: () => video.promise };
    await act(async () => renderer!.update(<Harness />));
    const id = await start(); await emit(1,1010); await tick(1000,2000); await emit(2,2001);
    vi.mocked(store.completeSession).mockRejectedValueOnce(new Error("RC transaction failed"));
    await act(async () => controller.stopRecording());
    expect(records.has(id)).toBe(false); expect(controller.rcConfirmedSessionId).toBeNull(); expect(controller.hasPendingSave).toBe(true);
    await act(async () => controller.retryPendingSave());
    expect(records.get(id)?.samples.map(s=>s.sequence)).toEqual([1,2]); expect(controller.rcConfirmedSessionId).toBe(id); expect(controller.hasPendingSave).toBe(false); expect(controller.hasPendingMedia).toBe(true);
    await act(async () => {expect(await controller.startRecording()).toBeNull();});
    await act(async () => {video.resolve(null);});
  });
  it("keeps confirmed sample count and separate termination retry after the terminal transaction succeeds", async () => {
    const video=deferred<null>(),commit=deferred<void>();
    options={...options,finishCompanionRecording:()=>video.promise};await act(async()=>renderer!.update(<Harness />));
    const id=await start();await emit(1,1010);await tick(1000,2000);await tick(250,2250);await emit(2,2251);
    vi.mocked(store.completeSession).mockImplementationOnce(async(session)=>{await commit.promise;records.set(id,structuredClone(session));persistedDraft=null;});
    let stopping!:Promise<void>;await act(async()=>{stopping=controller.stopRecording();});
    vi.mocked(store.patchSession).mockRejectedValueOnce(new Error("terminal metadata failed"));options={...options,linkState:"lost"};await act(async()=>renderer!.update(<Harness />));
    await act(async()=>{commit.resolve();await stopping;});
    expect(records.get(id)?.samples.map(s=>s.sequence)).toEqual([1,2]);expect(controller.persistedSampleCount).toBe(2);expect(controller.rcConfirmedSessionId).toBe(id);expect(controller.pendingTerminationSessionId).toBe(id);expect(controller.hasPendingSave).toBe(true);
    await act(async()=>controller.retryPendingSave());expect(records.get(id)?.interruptionReason).toBe("rx_link_lost");expect(controller.pendingTerminationSessionId).toBeNull();expect(store.completeSession).toHaveBeenCalledOnce();
    await act(async()=>{video.resolve(null);});
  });
});

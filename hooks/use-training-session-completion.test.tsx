import { useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_TELEMETRY, type ConnectionState, type LinkState, type TelemetrySource } from "../lib/telemetry";
import type { TrainingSession, TrainingSessionDraft } from "../lib/training-session";
import type { LocalVideoRecordingReceipt } from "../lib/local-video-recording";
import { toTrainingSessionSummary } from "../lib/training-session-index";
import * as storeModule from "../lib/training-session-store";
import * as directoryModule from "../lib/training-session-export-directory";
import * as workstationModule from "../lib/workstation-id";
import { useTrainingSession } from "./use-training-session";

const RECEIPT: LocalVideoRecordingReceipt = {
  filename: "current-flight.mp4", mimeType: "video/mp4", bytes: 2048,
  startedAtEpochMs: 1_700_000_000_000, finishedAtEpochMs: 1_700_000_005_000,
};
let controller: ReturnType<typeof useTrainingSession>;
let renderer: ReactTestRenderer | null = null;
let records: Map<string, TrainingSession>;
let drafts: Map<string, TrainingSessionDraft>;
let store: storeModule.TrainingSessionStore;
let finishCompanion: ReturnType<typeof vi.fn<() => Promise<LocalVideoRecordingReceipt | null>>>;
let connection: ConnectionState;
let linkState: LinkState;
let source: TelemetrySource;
let stopOnTelemetryLoss: boolean | undefined;
const subscribeSamples = () => () => undefined;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function Harness() {
  const next = useTrainingSession({
    telemetry: EMPTY_TELEMETRY,
    source, connection, linkState, stopOnTelemetryLoss,
    athleteCode: "PILOT-01", autoExport: false, inputKey: "arm-auto-record",
    subscribeSamples, finishCompanionRecording: finishCompanion,
  });
  useEffect(() => { controller = next; }, [next]);
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
  }));
  records = new Map();
  drafts = new Map();
  connection = "live";
  linkState = "ok";
  source = "serial";
  stopOnTelemetryLoss = undefined;
  finishCompanion = vi.fn(async () => RECEIPT);
  store = {
    getActiveDraft: vi.fn(async () => null),
    saveDraft: vi.fn(async (draft) => {
      if (records.has(draft.id)) throw new Error("Completed sessions must not become drafts again");
      drafts.set(draft.id, draft);
    }),
    deleteDraft: vi.fn(async (id) => { drafts.delete(id); }),
    listSessions: vi.fn(async () => [...records.values()]),
    listSessionSummaries: vi.fn(async () => [...records.values()].map(toTrainingSessionSummary)),
    getSession: vi.fn(async (id) => records.get(id) ?? null),
    countSessions: vi.fn(async () => records.size),
    countUnexportedValidSessions: vi.fn(async () => 0),
    getStorageIntegrity: vi.fn(async () => ({
      readableDraftCount: drafts.size, readableSessionCount: records.size,
      quarantinedDraftCount: 0, quarantinedSessionCount: 0,
    })),
    saveSession: vi.fn(async (session) => { records.set(session.id, session); }),
    completeSession: vi.fn(async (session) => { records.set(session.id, session); drafts.delete(session.id); }),
    close: vi.fn(async () => undefined),
  };
  vi.spyOn(storeModule, "createTrainingSessionStore").mockReturnValue(store);
  vi.spyOn(directoryModule, "getBrowserTrainingSessionDirectoryPicker").mockReturnValue(null);
  vi.spyOn(workstationModule, "getOrCreateBrowserWorkstationId").mockReturnValue("10000000-0000-4000-8000-000000000001");
  await act(async () => { renderer = create(<Harness />); });
  expect(controller.canStart).toBe(true);
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function start() {
  let id: string | null = null;
  await act(async () => { id = await controller.startRecording(); });
  expect(id).not.toBeNull();
  expect(controller.isRecording).toBe(true);
  return id!;
}

describe("training Session completion promises", () => {
  it("keeps both concurrent stops pending through companion and storage completion and preserves the upgraded reason", async () => {
    const videoClosed = deferred<LocalVideoRecordingReceipt>();
    const storageCommitted = deferred<void>();
    finishCompanion.mockReturnValue(videoClosed.promise);
    vi.mocked(store.completeSession).mockImplementation(async (session) => {
      await storageCommitted.promise;
      records.set(session.id, session);
      drafts.delete(session.id);
    });
    const id = await start();
    let firstDone = false;
    let secondDone = false;
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = controller.stopRecording().then(() => { firstDone = true; });
      second = controller.stopRecording("telemetry_unavailable").then(() => { secondDone = true; });
    });
    expect(finishCompanion).toHaveBeenCalledTimes(1);
    expect(store.completeSession).not.toHaveBeenCalled();
    expect([firstDone, secondDone]).toEqual([false, false]);
    expect(controller.lastSession).toMatchObject({ interrupted: true, interruptionReason: "telemetry_unavailable" });

    await act(async () => { videoClosed.resolve(RECEIPT); });
    expect(store.completeSession).toHaveBeenCalledTimes(1);
    expect([firstDone, secondDone]).toEqual([false, false]);
    expect(records.size).toBe(0);
    expect(controller.hasPendingSave).toBe(true);

    await act(async () => { storageCommitted.resolve(); await Promise.all([first, second]); });
    expect([firstDone, secondDone]).toEqual([true, true]);
    expect(controller.hasPendingSave).toBe(false);
    expect(controller.isFinishing).toBe(false);
    expect(records.get(id)).toMatchObject({
      interrupted: true, interruptionReason: "telemetry_unavailable",
      video: { recorded: true, filename: RECEIPT.filename, bytes: RECEIPT.bytes, overlay: "sticks" },
    });
  });

  it("waits for a second metadata commit when interruption upgrades during the first storage write", async () => {
    const firstCommit = deferred<void>();
    const secondCommit = deferred<void>();
    vi.mocked(store.completeSession)
      .mockImplementationOnce(async (session) => { await firstCommit.promise; records.set(session.id, session); drafts.delete(session.id); })
      .mockImplementationOnce(async (session) => { await secondCommit.promise; records.set(session.id, session); });
    const id = await start();
    let firstDone = false;
    let secondDone = false;
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => { first = controller.stopRecording().then(() => { firstDone = true; }); });
    expect(store.completeSession).toHaveBeenCalledTimes(1);
    await act(async () => { second = controller.stopRecording("rx_link_lost").then(() => { secondDone = true; }); });
    expect([firstDone, secondDone]).toEqual([false, false]);

    await act(async () => { firstCommit.resolve(); });
    expect(store.completeSession).toHaveBeenCalledTimes(2);
    expect(records.get(id)?.interrupted).toBe(false);
    expect([firstDone, secondDone]).toEqual([false, false]);
    await act(async () => { secondCommit.resolve(); await Promise.all([first, second]); });
    expect(records.get(id)).toMatchObject({ interrupted: true, interruptionReason: "rx_link_lost" });
    expect(finishCompanion).toHaveBeenCalledTimes(1);
    expect(controller.storageError).toBeNull();
    expect(controller.hasPendingSave).toBe(false);
  });

  it("keeps a failed save explicitly pending after concurrent stop attempts and retries without recording video again", async () => {
    const videoClosed = deferred<LocalVideoRecordingReceipt>();
    finishCompanion.mockReturnValue(videoClosed.promise);
    vi.mocked(store.completeSession).mockRejectedValueOnce(new Error("disk full"));
    const id = await start();
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => { first = controller.stopRecording(); second = controller.stopRecording("telemetry_unavailable"); });
    await act(async () => { videoClosed.resolve(RECEIPT); await Promise.all([first, second]); });
    expect(controller.hasPendingSave).toBe(true);
    expect(controller.storageError).toContain("尚未安全保存");
    expect(records.size).toBe(0);
    expect(controller.canStart).toBe(false);
    await act(async () => { await controller.retryPendingSave(); });
    expect(records.get(id)).toMatchObject({ interrupted: true, interruptionReason: "telemetry_unavailable", video: { recorded: true } });
    expect(finishCompanion).toHaveBeenCalledTimes(1);
    expect(controller.hasPendingSave).toBe(false);
  });
});

describe("training Session telemetry-loss policy", () => {
  it.each(["rx_lost", "serial_stale", "demo_fallback"] as const)("keeps recording through %s when explicitly disabled", async (loss) => {
    stopOnTelemetryLoss = false;
    await act(async () => { renderer!.update(<Harness />); });
    const id = await start();
    if (loss === "rx_lost") linkState = "lost";
    if (loss === "serial_stale") connection = "stale";
    if (loss === "demo_fallback") source = "demo";
    await act(async () => { renderer!.update(<Harness />); });
    expect(controller.isRecording).toBe(true);
    expect(controller.hasPendingSave).toBe(false);
    expect(finishCompanion).not.toHaveBeenCalled();
    expect(store.completeSession).not.toHaveBeenCalled();
    await act(async () => { await controller.stopRecording("telemetry_unavailable"); });
    expect(records.get(id)).toMatchObject({ interrupted: true, interruptionReason: "telemetry_unavailable" });
    expect(finishCompanion).toHaveBeenCalledTimes(1);
  });

  it.each(["rx_lost", "serial_stale", "demo_fallback"] as const)("preserves automatic interrupted finalization for %s by default", async (loss) => {
    const id = await start();
    if (loss === "rx_lost") linkState = "lost";
    if (loss === "serial_stale") connection = "stale";
    if (loss === "demo_fallback") source = "demo";
    await act(async () => { renderer!.update(<Harness />); });
    expect(controller.isRecording).toBe(false);
    expect(controller.hasPendingSave).toBe(false);
    expect(records.get(id)).toMatchObject({
      interrupted: true, interruptionReason: loss === "rx_lost" ? "rx_link_lost" : "telemetry_unavailable",
    });
    expect(finishCompanion).toHaveBeenCalledTimes(1);
  });
});

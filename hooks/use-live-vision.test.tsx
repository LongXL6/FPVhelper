import { useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLiveVision } from "./use-live-vision";
import type { LiveVisionController, LiveVisionOptions, LiveVisionRun } from "../lib/live-vision-types";
import type { VisionGateProfile } from "../lib/vision-lab-types";
import * as storage from "../lib/live-vision-store";
import * as profiles from "../lib/vision-lab-store";
import * as media from "../lib/vision-lab-media";
import * as models from "../lib/vision-model-client";
import { VISION_MODEL_MANIFEST, type VisionModelFrameResult } from "../lib/vision-model";

let clockMs: number;
let controller: LiveVisionController;
let renderer: ReactTestRenderer | null;
let input: LiveVisionOptions;
let runs: Map<string, LiveVisionRun>;
let videos: FakeVideo[];
let documentTarget: EventTarget & { visibilityState: string; createElement: ReturnType<typeof vi.fn> };
const RECT = { x: 0, y: 0, width: 1, height: 1 };
const gate: VisionGateProfile = { schemaVersion: 1, id: "gate-1", revision: 1, name: "Gate", image: new Blob(["fixture"], { type: "image/png" }), imageSha256: "a".repeat(64), rect: RECT, createdAt: "2026-09-05T00:00:00.000Z" };

class FakeTrack extends EventTarget {
  id = "track-1";
  readyState = "live";
  stop = vi.fn(() => { this.readyState = "ended"; });
}
class FakeStream extends EventTarget {
  id = "stream-1";
  track = new FakeTrack();
  getVideoTracks = () => [this.track];
  getTracks = () => [this.track];
}
class FakeVideo extends EventTarget {
  srcObject: MediaStream | null = null;
  readyState = 2;
  videoWidth = 1280;
  videoHeight = 720;
  currentTime = 0;
  frameCount = 0;
  callbacks = new Map<number, VideoFrameRequestCallback>();
  nextId = 0;
  play = vi.fn(async () => undefined);
  pause = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn();
  requestVideoFrameCallback = vi.fn((callback: VideoFrameRequestCallback) => { const id = ++this.nextId; this.callbacks.set(id, callback); return id; });
  cancelVideoFrameCallback = vi.fn((id: number) => this.callbacks.delete(id));
  frame() {
    this.currentTime = clockMs / 1000;
    const callbacks = [...this.callbacks];
    this.callbacks.clear();
    for (const [, callback] of callbacks) callback(clockMs, { presentedFrames: ++this.frameCount, mediaTime: this.currentTime, presentationTime: clockMs, expectedDisplayTime: clockMs + 10, width: 1280, height: 720, processingDuration: 0 } as VideoFrameCallbackMetadata);
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function result(timeMs: number): VisionModelFrameResult { return { frameTimeMs: timeMs, inferenceMs: 100, candidates: [], modelId: VISION_MODEL_MANIFEST.id, modelRevision: VISION_MODEL_MANIFEST.revision }; }
function client() {
  return { load: vi.fn(async () => VISION_MODEL_MANIFEST), setReference: vi.fn(async (image: ImageBitmap) => { image.close(); return { width: 224, height: 224 }; }), analyze: vi.fn(async (image: ImageBitmap, timeMs: number) => { image.close(); return result(timeMs); }), dispose: vi.fn() };
}
function Harness({ options }: { options: LiveVisionOptions }) {
  const value = useLiveVision(options);
  useEffect(() => { controller = value; }, [value]);
  return null;
}
async function advance(ms: number, frame = true) {
  await act(async () => { clockMs += ms; await vi.advanceTimersByTimeAsync(ms); if (frame) videos.at(-1)?.frame(); });
}
async function start() { await act(async () => { await controller.start(); }); }
async function change(patch: Partial<LiveVisionOptions>) {
  input = { ...input, ...patch };
  await act(async () => { renderer!.update(<Harness options={input} />); });
}

beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-05T00:00:00Z")); clockMs = 0;
  vi.stubGlobal("performance", { now: () => clockMs, timeOrigin: Date.now() });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", new EventTarget());
  videos = []; runs = new Map(); renderer = null;
  documentTarget = Object.assign(new EventTarget(), { visibilityState: "visible", createElement: vi.fn(() => { const video = new FakeVideo(); videos.push(video); return video; }) });
  vi.stubGlobal("document", documentTarget);
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 224, height: 224, close: vi.fn() })));
  vi.spyOn(profiles, "getVisionProfile").mockResolvedValue(gate);
  vi.spyOn(profiles, "listVisionProfiles").mockResolvedValue([{ id: gate.id, name: gate.name, revision: gate.revision, createdAt: gate.createdAt }]);
  vi.spyOn(storage, "getLiveVisionRun").mockImplementation(async (id) => runs.get(id) ?? null);
  vi.spyOn(storage, "listLiveVisionRuns").mockImplementation(async () => [...runs.values()].map(({ id, createdAt, source, profile, state, elapsedMs }) => ({ id, createdAt, pilotName: source.pilotName, gateName: profile.name, state, elapsedMs })));
  vi.spyOn(storage, "saveLiveVisionRun").mockImplementation(async (run) => { runs.set(run.id, storage.parseLiveVisionRun(run)); });
  vi.spyOn(media, "visionFrameCanvas").mockImplementation(() => ({ width: 224, height: 224 }) as HTMLCanvasElement);
  vi.spyOn(media, "downloadVisionText").mockImplementation(() => undefined);
  vi.spyOn(models, "createVisionModelClient").mockImplementation(client);
  input = { stream: new FakeStream() as unknown as MediaStream, sourceId: "source-1", pilotChannelId: "pilot-1", pilotName: "Pilot", crop: { ...RECT }, profileId: gate.id, trainingSessionId: null };
  await act(async () => { renderer = create(<Harness options={input} />); });
});
afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("live vision runtime isolation", () => {
  it("does not start a model before explicit start and borrows capture without stopping its tracks", async () => {
    expect(controller.canStart).toBe(true);
    expect(models.createVisionModelClient).not.toHaveBeenCalled();
    await start(); await advance(500);
    expect(controller.state).toBe("monitoring");
    expect(controller.run?.observations).toHaveLength(1);
    expect(controller.run?.clock).toMatchObject({ kind: "host_presentation_estimate", physicalCaptureTimeKnown: false, trainingSynchronized: false });
    expect(controller.run?.source).toMatchObject({ sourceId: "source-1", pilotChannelId: "pilot-1", trainingSessionId: null });
    await act(async () => { await controller.stop(); });
    const stream = input.stream as unknown as FakeStream;
    expect(stream.track.stop).not.toHaveBeenCalled();
    expect(stream.track.readyState).toBe("live");
    expect(videos[0].srcObject).toBeNull();
    expect(videos[0].callbacks.size).toBe(0);
    expect(controller.run?.state).toBe("stopped");
  });

  it("keeps one inference in flight and samples a fresh frame after it finishes", async () => {
    const pending = deferred<VisionModelFrameResult>();
    const model = client(); model.analyze.mockImplementationOnce(async () => pending.promise);
    vi.mocked(models.createVisionModelClient).mockReturnValue(model);
    await start(); await advance(500);
    await advance(500); await advance(500);
    expect(model.analyze).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(result(500)); });
    await advance(500);
    expect(model.analyze.mock.calls.map(([, timeMs]) => timeMs)).toEqual([500, 2000]);
    expect(controller.run?.gaps).toContainEqual({ startMs: 500, endMs: 2000, reason: "本机推理未及时覆盖这一观察区间" });
    expect(controller.events).toEqual([]);
    expect(controller.laps).toEqual([]);
  });

  it("can stop model loading and ignores a late load without taking another source's frames", async () => {
    const loading = deferred<typeof VISION_MODEL_MANIFEST>();
    const old = client(); old.load.mockImplementationOnce(() => loading.promise);
    vi.mocked(models.createVisionModelClient).mockReturnValueOnce(old);
    let pending!: Promise<void>;
    await act(async () => { pending = controller.start(); });
    expect(controller.state).toBe("loading");
    await act(async () => { await controller.stop(); });
    const stoppedId = controller.run!.id;
    await start();
    const currentId = controller.run!.id;
    await act(async () => { loading.resolve(VISION_MODEL_MANIFEST); await pending; });
    expect(currentId).not.toBe(stoppedId);
    expect(controller.run?.id).toBe(currentId);
    expect(old.setReference).not.toHaveBeenCalled();
    expect(old.dispose).toHaveBeenCalledOnce();
    expect(controller.state).toBe("monitoring");
  });

  it.each([
    ["pilot", { pilotChannelId: "pilot-2", pilotName: "Other" }],
    ["crop", { crop: { x: 0, y: 0, width: 0.5, height: 0.5 } }],
    ["training session", { trainingSessionId: "recording-2" }],
  ])("interrupts on %s changes and keeps source identity frozen", async (_, patch) => {
    await start(); await advance(500);
    const original = structuredClone(controller.run!.source);
    await advance(300, false);
    await change(patch);
    expect(controller.state).toBe("interrupted");
    expect(controller.run?.source).toEqual(original);
    expect(controller.run?.gaps).toContainEqual(expect.objectContaining({ startMs: 500, endMs: 800 }));
    expect((input.stream as unknown as FakeStream).track.stop).not.toHaveBeenCalled();
  });

  it("ignores a late inference after switching pilots and starting a separate run", async () => {
    const pending = deferred<VisionModelFrameResult>(); const old = client();
    old.analyze.mockImplementationOnce(() => pending.promise);
    vi.mocked(models.createVisionModelClient).mockReturnValueOnce(old);
    await start(); await advance(500);
    const oldId = controller.run!.id;
    await change({ pilotName: "Other", pilotChannelId: "pilot-2" }); await start();
    const current = structuredClone(controller.run);
    await act(async () => { pending.resolve({ ...result(500), candidates: [{ similarity: 0.99, box: RECT }] }); });
    expect(controller.run).toEqual(current);
    expect(runs.get(oldId)?.state).toBe("interrupted");
    expect(controller.run?.source.pilotName).toBe("Other");
  });

  it("interrupts on hidden pages and does not resume automatically", async () => {
    await start(); await advance(500); await advance(100, false);
    await act(async () => { documentTarget.visibilityState = "hidden"; documentTarget.dispatchEvent(new Event("visibilitychange")); });
    expect(controller.state).toBe("interrupted");
    expect(controller.run?.gaps.at(-1)).toMatchObject({ startMs: 500, endMs: 600 });
    await act(async () => { documentTarget.visibilityState = "visible"; documentTarget.dispatchEvent(new Event("visibilitychange")); });
    expect(controller.isActive).toBe(false);
  });

  it("interrupts on track loss and prolonged missing frames", async () => {
    await start(); await advance(500);
    await advance(3000, false);
    expect(controller.state).toBe("interrupted");
    expect(controller.run?.stopReason).toContain("没有新视频帧");
    await start();
    await act(async () => { (input.stream as unknown as FakeStream).track.dispatchEvent(new Event("ended")); });
    expect(controller.state).toBe("interrupted");
    expect((input.stream as unknown as FakeStream).track.stop).not.toHaveBeenCalled();
  });

  it("uses monotonic observation time even when the wall clock changes", async () => {
    await start(); await advance(500);
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    await advance(500);
    expect(controller.run?.observations.map((entry) => entry.timeMs)).toEqual([500, 1000]);
    expect(controller.run?.observations[1]).toMatchObject({ hostObservedAtMs: 1000, method: "video_frame_callback", callback: { mediaTimeSeconds: 1, presentedFrames: 2 } });
    expect(controller.getCurrentTimeMs()).toBe(1000);
  });

  it("checkpoints every ten analyzed frames instead of writing every frame", async () => {
    await start();
    for (let index = 0; index < 9; index += 1) await advance(500);
    expect(storage.saveLiveVisionRun).toHaveBeenCalledTimes(1);
    await advance(500);
    expect(storage.saveLiveVisionRun).toHaveBeenCalledTimes(2);
    expect([...runs.values()][0].observations).toHaveLength(10);
  });
});

describe("live review and recovery", () => {
  it("counts only explicit manual confirmations and retains gaps between them", async () => {
    await start(); await advance(500);
    await act(async () => { await controller.addEvent(controller.getCurrentTimeMs(), "人工看到穿越"); });
    expect(controller.laps).toEqual([]);
    await advance(500);
    await act(async () => { await controller.addEvent(controller.getCurrentTimeMs(), "人工看到再次穿越"); });
    expect(controller.laps).toEqual([expect.objectContaining({ durationMs: 500, status: "reviewed" })]);
    const first = controller.events[0];
    await act(async () => { await controller.reviewEvent(first.id, "reject", first.timeMs, "复盘排除误判"); });
    expect(controller.laps).toEqual([]);
    expect(controller.run?.reviews).toHaveLength(3);
  });

  it("keeps failed saves protected until retry or explicit JSON download confirmation", async () => {
    await start(); await advance(500);
    vi.mocked(storage.saveLiveVisionRun).mockRejectedValue(new Error("存储配额不足"));
    await act(async () => { await expect(controller.stop()).rejects.toThrow("配额"); });
    const snapshot = structuredClone(controller.run);
    expect(controller.canStart).toBe(false);
    const leaving = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);
    await act(async () => { await expect(controller.start()).rejects.toThrow("尚未保存"); await expect(controller.loadRun("other")).rejects.toThrow("尚未保存"); });
    await act(async () => { await controller.exportRun("json"); });
    expect(controller.run).toEqual(snapshot);
    expect(controller.hasUnsavedChanges).toBe(true);
    expect(controller.canStart).toBe(false);
    expect(controller.backupAwaitingConfirmation).toBe(true);
    await act(async () => { controller.acknowledgeBackup(); });
    expect(controller.canStart).toBe(true);
    expect(controller.hasUnsavedChanges).toBe(true);
    const acknowledgedLeave = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(acknowledgedLeave);
    expect(acknowledgedLeave.defaultPrevented).toBe(false);
    expect(JSON.parse(vi.mocked(media.downloadVisionText).mock.calls[0][0])).toEqual(snapshot);
  });

  it("restores an interrupted checkpoint without inventing an end timestamp or resuming inference", async () => {
    await start();
    const initial = structuredClone(controller.run!);
    await act(async () => { await controller.stop(); });
    runs.set("abandoned", { ...initial, id: "abandoned" });
    const calls = vi.mocked(models.createVisionModelClient).mock.calls.length;
    await act(async () => { await controller.loadRun("abandoned"); });
    expect(controller.run).toMatchObject({ state: "interrupted", endedAtEpochMs: null, stopReason: expect.stringContaining("结束时刻未知") });
    expect(models.createVisionModelClient).toHaveBeenCalledTimes(calls);
    expect(controller.isActive).toBe(false);
  });

  it("marks the known unobserved checkpoint tail as a gap when recovering manual events", async () => {
    await start(); await advance(500);
    const initial = structuredClone(controller.run!);
    await act(async () => { await controller.stop(); });
    runs.set("abandoned", { ...initial, id: "abandoned", elapsedMs: 1800, reviews: [1000, 1600].map((timeMs, index) => ({ id: `review-${index}`, eventId: `manual-${index}`, action: "add", timeMs, reason: "人工补记", createdAt: new Date().toISOString() })) });
    await act(async () => { await controller.loadRun("abandoned"); });
    expect(controller.run?.gaps).toContainEqual({ startMs: 500, endMs: 1800, reason: "恢复检查点中尚未分析的已知尾段" });
    expect(controller.laps).toEqual([expect.objectContaining({ durationMs: 600, status: "incomplete" })]);
    expect(controller.run?.endedAtEpochMs).toBeNull();
  });
});

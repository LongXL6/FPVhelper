import { useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as store from "../lib/vision-lab-store";
import * as media from "../lib/vision-lab-media";
import * as model from "../lib/vision-model-client";
import { VISION_MODEL_MANIFEST, type VisionModelFrameResult } from "../lib/vision-model";
import type { VisionGateProfile, VisionTimingRun } from "../lib/vision-lab-types";
import { useVisionLab } from "./use-vision-lab";

const VIDEO_SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);
const IMAGE_SHA = "c".repeat(64);
const CREATED_AT = "2026-09-05T00:00:00.000Z";
const FULL_RECT = { x: 0, y: 0, width: 1, height: 1 };
let controller: ReturnType<typeof useVisionLab>;
let renderer: ReactTestRenderer | null = null;
let profiles: Map<string, VisionGateProfile>;
let runs: Map<string, VisionTimingRun>;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function makeProfile(): VisionGateProfile {
  return { schemaVersion: 1, id: "profile-1", revision: 1, name: "原始计时门", image: new Blob(["fake decoded image"], { type: "image/png" }), imageSha256: IMAGE_SHA, rect: { ...FULL_RECT }, createdAt: CREATED_AT };
}

function makeRun(): VisionTimingRun {
  const { image: _image, ...profile } = makeProfile();
  void _image;
  return {
    schemaVersion: 1, pipelineVersion: "reference-motion-v1", timestampSource: "video_seek_position", provenance: "local", id: "saved-run", createdAt: CREATED_AT,
    profile, video: { name: "original.mp4", size: 10, lastModified: 0, sha256: VIDEO_SHA, durationMs: 10_000, width: 1280, height: 720 },
    settings: { crop: "full", fromMs: 0, toMs: 1000, sampleFps: 5, similarityThreshold: 0.65 },
    model: { id: VISION_MODEL_MANIFEST.id, revision: VISION_MODEL_MANIFEST.revision, weightsSha256: VISION_MODEL_MANIFEST.weightsSha256, backend: "wasm" },
    state: "complete", analyzedFrames: 5, analyzedUntilMs: 1000,
    candidates: [{ id: "candidate-1", timeMs: 200, startMs: 100, endMs: 300, similarity: 0.8, box: { ...FULL_RECT }, reason: "待人工确认的相似目标" }], reviews: [], gaps: [],
  };
}

function frameResult(frameTimeMs: number): VisionModelFrameResult {
  return { frameTimeMs, candidates: [], inferenceMs: 1, modelId: VISION_MODEL_MANIFEST.id, modelRevision: VISION_MODEL_MANIFEST.revision };
}

function makeClient() {
  return {
    load: vi.fn(async () => VISION_MODEL_MANIFEST),
    setReference: vi.fn(async (_image: ImageBitmap) => { void _image; return { width: 224, height: 224 }; }),
    analyze: vi.fn(async (_image: ImageBitmap, timeMs: number, _threshold?: number) => { void _image; void _threshold; return frameResult(timeMs); }),
    dispose: vi.fn(),
  };
}

function Harness() {
  const next = useVisionLab();
  useEffect(() => { controller = next; }, [next]);
  return null;
}

async function mount() {
  await act(async () => { renderer = create(<Harness />); });
}

async function prepareAnalysis() {
  await act(async () => { await controller.loadProfile("profile-1"); });
  await act(async () => { await controller.importVideo(new File(["fake video"], "original.mp4")); });
  await act(async () => { controller.updateSettings({ fromMs: 0, toMs: 1000, sampleFps: 5 }); });
  expect(controller.canAnalyze).toBe(true);
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 224, height: 224, close: vi.fn() })));
  let urlIndex = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:fixture-${++urlIndex}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  profiles = new Map([["profile-1", makeProfile()]]);
  runs = new Map();
  vi.spyOn(store, "listVisionProfiles").mockImplementation(async () => [...profiles.values()].map(({ id, name, revision, createdAt }) => ({ id, name, revision, createdAt })));
  vi.spyOn(store, "listVisionRuns").mockImplementation(async () => [...runs.values()].map(({ id, profile, video, createdAt, state }) => ({ id, gateName: profile.name, videoName: video.name, createdAt, state })));
  vi.spyOn(store, "getVisionProfile").mockImplementation(async (id) => profiles.get(id) ?? null);
  vi.spyOn(store, "getVisionRun").mockImplementation(async (id) => runs.get(id) ?? null);
  vi.spyOn(store, "saveVisionProfile").mockImplementation(async (profile) => { profiles.set(profile.id, profile); });
  vi.spyOn(store, "saveVisionRun").mockImplementation(async (run) => { runs.set(run.id, store.parseVisionRun(run)); });
  vi.spyOn(media, "hashVisionFile").mockImplementation(async (file) => file instanceof File && file.name === "other.mp4" ? OTHER_SHA : VIDEO_SHA);
  vi.spyOn(media, "openVisionVideo").mockImplementation(async (_url, signal) => {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    return { duration: 10, videoWidth: 1280, videoHeight: 720 } as HTMLVideoElement;
  });
  vi.spyOn(media, "releaseVisionVideo").mockImplementation(() => undefined);
  vi.spyOn(media, "seekVisionVideo").mockResolvedValue(undefined);
  vi.spyOn(media, "visionFrameCanvas").mockImplementation(() => ({ width: 224, height: 224 }) as HTMLCanvasElement);
  vi.spyOn(media, "downloadVisionText").mockImplementation(() => undefined);
  vi.spyOn(model, "createVisionModelClient").mockImplementation(() => makeClient());
  await mount();
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("vision lab run lifecycle", () => {
  it("cancels while the first save is pending without starting a model download", async () => {
    await prepareAnalysis();
    const firstSave = deferred<void>();
    vi.mocked(store.saveVisionRun).mockImplementationOnce(async (run) => { await firstSave.promise; runs.set(run.id, store.parseVisionRun(run)); });
    let pending!: Promise<void>;
    await act(async () => { pending = controller.analyze(); });
    expect(controller.run?.state).toBe("analyzing");
    expect(model.createVisionModelClient).not.toHaveBeenCalled();
    await act(async () => { controller.cancel(); });
    expect(controller.run).toMatchObject({ state: "cancelled", analyzedFrames: 0, gaps: [{ startMs: 0, endMs: 1000 }] });
    await act(async () => { firstSave.resolve(); await pending; });
    expect(model.createVisionModelClient).not.toHaveBeenCalled();
    expect(controller.busy).toBe(false);
    expect(runs.get(controller.run!.id)).toMatchObject({ state: "cancelled", gaps: [{ startMs: 0, endMs: 1000 }] });
  });

  it("ignores a cancelled model response after a newer run has completed", async () => {
    await prepareAnalysis();
    const oldResponse = deferred<VisionModelFrameResult>();
    const oldClient = makeClient();
    oldClient.analyze.mockImplementationOnce(() => oldResponse.promise);
    const newClient = makeClient();
    vi.mocked(model.createVisionModelClient).mockReturnValueOnce(oldClient).mockReturnValueOnce(newClient);
    let oldAnalysis!: Promise<void>;
    await act(async () => { oldAnalysis = controller.analyze(); });
    expect(oldClient.analyze).toHaveBeenCalledOnce();
    const oldId = controller.run!.id;
    await act(async () => { controller.cancel(); });
    await act(async () => { await controller.analyze(); });
    const newRun = structuredClone(controller.run!);
    expect(newRun).toMatchObject({ state: "complete", analyzedFrames: 5, candidates: [] });
    expect(newRun.id).not.toBe(oldId);
    await act(async () => { oldResponse.resolve(frameResult(0)); await oldAnalysis; });
    expect(controller.run).toEqual(newRun);
    expect(controller.status).toBe("complete");
    expect(runs.get(oldId)?.state).toBe("cancelled");
    expect(oldClient.dispose).toHaveBeenCalled();
  });

  it("keeps an exactly 20-frame run cancelled when its final checkpoint finishes late", async () => {
    await prepareAnalysis();
    await act(async () => { controller.updateSettings({ toMs: 4000 }); });
    const checkpoint = deferred<void>();
    vi.mocked(store.saveVisionRun).mockImplementation(async (run) => {
      if (run.state === "analyzing" && run.analyzedFrames === 20) await checkpoint.promise;
      runs.set(run.id, store.parseVisionRun(run));
    });
    let pending!: Promise<void>;
    await act(async () => { pending = controller.analyze(); });
    expect(controller.run).toMatchObject({ state: "analyzing", analyzedFrames: 20, analyzedUntilMs: 3800 });
    await act(async () => { controller.cancel(); });
    const cancelled = structuredClone(controller.run!);
    expect(cancelled).toMatchObject({ state: "cancelled", gaps: [{ startMs: 3800, endMs: 4000 }] });
    await act(async () => { checkpoint.resolve(); await pending; });
    expect(controller.run).toEqual(cancelled);
    expect(controller.status).toBe("cancelled");
    expect(controller.busy).toBe(false);
    expect(runs.get(cancelled.id)).toEqual(cancelled);
    expect(vi.mocked(store.saveVisionRun).mock.calls.some(([run]) => run.state === "complete")).toBe(false);
  });

  it("does not replace cancelled UI with a late analysis error after failure persistence finishes", async () => {
    await prepareAnalysis();
    const failedSave = deferred<void>();
    const client = makeClient();
    client.analyze.mockRejectedValueOnce(new Error("模型解码失败"));
    vi.mocked(model.createVisionModelClient).mockReturnValue(client);
    vi.mocked(store.saveVisionRun).mockImplementation(async (run) => {
      if (run.state === "failed") await failedSave.promise;
      runs.set(run.id, store.parseVisionRun(run));
    });
    let pending!: Promise<void>;
    await act(async () => { pending = controller.analyze(); });
    expect(controller.run).toMatchObject({ state: "failed", gaps: [{ startMs: 0, endMs: 1000 }] });
    expect(controller.busy).toBe(true);
    await act(async () => { controller.cancel(); });
    expect(controller.status).toBe("cancelled");
    expect(controller.notice).toContain("操作已取消");
    await act(async () => { failedSave.resolve(); await pending; });
    expect(controller.status).toBe("cancelled");
    expect(controller.busy).toBe(false);
    expect(controller.error).toBeNull();
    expect(controller.notice).toContain("操作已取消");
    expect(runs.get(controller.run!.id)).toMatchObject({ state: "failed", gaps: [{ startMs: 0, endMs: 1000 }] });
  });

  it("clears an unrelated reference when restoring a run whose image is unavailable", async () => {
    await prepareAnalysis();
    const oldUrl = controller.reference!.url;
    const restored = makeRun();
    restored.profile = { ...restored.profile, id: "unavailable-profile", name: "另一个门" };
    runs.set(restored.id, restored);
    await act(async () => { await controller.loadRun(restored.id); });
    expect(controller.run?.id).toBe(restored.id);
    expect(controller.gateName).toBe("另一个门");
    expect(controller.reference).toBeNull();
    expect(controller.canAnalyze).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(oldUrl);
  });

  it("restores the run's frozen rectangle and name even when the saved profile was edited later", async () => {
    await prepareAnalysis();
    const restored = makeRun();
    restored.profile.rect = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
    restored.profile.name = "分析时的原始门";
    profiles.set("profile-1", { ...makeProfile(), revision: 9, name: "后来改名", rect: { ...FULL_RECT } });
    runs.set(restored.id, restored);
    await act(async () => { await controller.loadRun(restored.id); });
    expect(controller.reference?.rect).toEqual(restored.profile.rect);
    expect(controller.gateName).toBe(restored.profile.name);
    expect(controller.canAnalyze).toBe(true);
  });

  it("requires the matching video hash before saving a human review", async () => {
    const original = makeRun();
    runs.set(original.id, original);
    await act(async () => { await controller.importVideo(new File(["different video"], "other.mp4")); });
    await act(async () => { await controller.loadRun(original.id); });
    await act(async () => { await controller.reviewEvent("candidate-1", "confirm", 200, "逐帧确认"); });
    expect(controller.error).toContain("匹配的原录像");
    expect(controller.run?.reviews).toHaveLength(0);
    expect(store.saveVisionRun).not.toHaveBeenCalled();
    await act(async () => { await controller.importVideo(new File(["original video"], "original.mp4")); });
    await act(async () => { await controller.reviewEvent("candidate-1", "confirm", 200, "逐帧确认"); });
    expect(controller.error).toBeNull();
    expect(runs.get(original.id)?.reviews).toMatchObject([{ eventId: "candidate-1", action: "confirm", timeMs: 200 }]);
    expect(controller.events[0].status).toBe("confirmed");
  });

  it("requires the recorded crop as well as the matching video before saving a review", async () => {
    await prepareAnalysis();
    const original = makeRun();
    runs.set(original.id, original);
    await act(async () => { await controller.loadRun(original.id); });
    expect(controller.video?.sha256).toBe(original.video.sha256);
    await act(async () => { controller.updateSettings({ crop: "bottom-right" }); });
    await act(async () => { await controller.reviewEvent("candidate-1", "confirm", 200, "当前看到的选手已过门"); });
    expect(controller.error).toContain("裁切范围");
    expect(controller.run?.reviews).toHaveLength(0);
    expect(store.saveVisionRun).not.toHaveBeenCalled();
    await act(async () => { controller.updateSettings({ crop: original.settings.crop }); });
    await act(async () => { await controller.reviewEvent("candidate-1", "confirm", 200, "已对照原画面确认"); });
    expect(controller.error).toBeNull();
    expect(runs.get(original.id)?.reviews).toHaveLength(1);
  });

  it("retains an unsaved correction for export without claiming that persistence succeeded", async () => {
    await prepareAnalysis();
    const original = makeRun();
    runs.set(original.id, original);
    await act(async () => { await controller.loadRun(original.id); });
    vi.mocked(store.saveVisionRun).mockRejectedValueOnce(new Error("测试存储配额不足"));
    await act(async () => { await controller.reviewEvent("candidate-1", "adjust", 250, "逐帧改时刻并确认"); });
    expect(controller.error).toContain("存储配额不足");
    expect(controller.notice).toBeNull();
    expect(controller.run?.reviews).toMatchObject([{ action: "adjust", timeMs: 250 }]);
    expect(runs.get(original.id)?.reviews).toHaveLength(0);
    await act(async () => { await controller.exportRun("json"); });
    const [json, filename, mimeType] = vi.mocked(media.downloadVisionText).mock.calls.at(-1)!;
    expect(JSON.parse(json).reviews).toMatchObject([{ action: "adjust", timeMs: 250 }]);
    expect(filename).toMatch(/\.json$/);
    expect(mimeType).toBe("application/json");
    expect(controller.notice).toContain("已发起下载");
  });

  it("imports a colliding run as an explicitly imported copy without overwriting the original", async () => {
    const original = makeRun();
    runs.set(original.id, original);
    const imported = { ...original, reviews: [{ id: "external-review", eventId: "candidate-1", action: "confirm", timeMs: 200, reason: "外部确认", createdAt: CREATED_AT }] };
    await act(async () => { await controller.importRun(new File([JSON.stringify(imported)], "imported.json", { type: "application/json" })); });
    expect(controller.error).toBeNull();
    expect(controller.run?.id).not.toBe(original.id);
    expect(controller.run?.provenance).toBe("imported");
    expect(controller.notice).toContain("未经本机重新分析");
    expect(runs.get(original.id)).toEqual(original);
    expect(runs.size).toBe(2);
    expect(runs.get(controller.run!.id)?.reviews).toHaveLength(1);
  });

  it("marks an interrupted saved run's unprocessed tail as a gap after remount", async () => {
    const interrupted = makeRun();
    interrupted.state = "analyzing";
    interrupted.analyzedFrames = 3;
    interrupted.analyzedUntilMs = 400;
    runs.set(interrupted.id, interrupted);
    await act(async () => { renderer?.unmount(); });
    await mount();
    await act(async () => { await controller.loadRun(interrupted.id); });
    expect(controller.run).toMatchObject({ state: "cancelled", analyzedFrames: 3, analyzedUntilMs: 400, gaps: [{ startMs: 400, endMs: 1000 }] });
    expect(controller.run?.candidates).toEqual(interrupted.candidates);
    expect(controller.status).toBe("cancelled");
    await act(async () => { await controller.saveRun(); });
    expect(runs.get(interrupted.id)).toMatchObject({ state: "cancelled", gaps: [{ startMs: 400, endMs: 1000 }] });
  });
});

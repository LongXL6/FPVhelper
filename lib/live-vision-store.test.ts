import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLiveVisionRun, listLiveVisionRuns, liveVisionExportFilename, liveVisionLapsCsv, parseLiveVisionRun, saveLiveVisionRun } from "./live-vision-store";
import { LIVE_VISION_MAX_DURATION_MS, type LiveVisionRun } from "./live-vision-types";

function fixture(): LiveVisionRun {
  return {
    schemaVersion: 1, kind: "fpvhelper-live-vision", pipelineVersion: "reference-motion-v1", provenance: "local", id: "live-1", createdAt: "2026-09-05T00:00:00.000Z",
    source: { sourceId: "source-1", pilotChannelId: "pilot-1", pilotName: "Pilot", streamId: "stream-1", videoTrackId: "track-1", width: 1280, height: 720, crop: { x: 0, y: 0, width: 0.5, height: 0.5 }, trainingSessionId: null },
    profile: { schemaVersion: 1, id: "gate-1", revision: 1, name: "Gate", imageSha256: "a".repeat(64), rect: { x: 0, y: 0, width: 1, height: 1 }, createdAt: "2026-09-05T00:00:00.000Z" },
    model: { id: "fixture", revision: "fixture", weightsSha256: "b".repeat(64), backend: "wasm" },
    clock: { kind: "host_presentation_estimate", timeOriginEpochMs: 1000, startedAtPerformanceMs: 100, startedAtEpochMs: 1100, physicalCaptureTimeKnown: false, trainingSynchronized: false },
    settings: { sampleFps: 2, similarityThreshold: 0.65, maxDurationMs: LIVE_VISION_MAX_DURATION_MS },
    state: "stopped", endedAtEpochMs: 5100, elapsedMs: 4000, analyzedUntilMs: 2000, stopReason: "用户停止", gaps: [],
    observations: [1000, 1500, 2000].map((timeMs) => ({ timeMs, hostObservedAtMs: timeMs + 100, method: "current_time_poll", callback: null, inferenceMs: 100 })),
    candidates: [{ id: "candidate-1", timeMs: 1500, startMs: 1000, endMs: 2000, similarity: 0.8, box: { x: 0, y: 0, width: 0.5, height: 0.5 }, reason: "待复核" }], reviews: [],
  };
}
const review = (id: string, timeMs: number) => ({ id: `review-${id}`, eventId: id, action: "add" as const, timeMs, reason: "人工观察确认", createdAt: "2026-09-05T00:00:00.000Z" });
beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("live vision schema and clocks", () => {
  it("round trips dedicated live identity without inventing a video file hash or synchronization", () => {
    const run = fixture();
    expect(parseLiveVisionRun(run)).toEqual(run);
    expect(run).not.toHaveProperty("video");
    expect(run.source.trainingSessionId).toBeNull();
    expect(run.clock.trainingSynchronized).toBe(false);
  });
  it.each([
    ["offline kind", (run: LiveVisionRun) => { Object.assign(run, { kind: "offline" }); }],
    ["invented recording metadata", (run: LiveVisionRun) => { Object.assign(run, { video: { sha256: "a".repeat(64) } }); }],
    ["physical timestamp claim", (run: LiveVisionRun) => { Object.assign(run.clock, { physicalCaptureTimeKnown: true }); }],
    ["synchronization claim", (run: LiveVisionRun) => { Object.assign(run.clock, { trainingSynchronized: true }); }],
    ["clock mismatch", (run: LiveVisionRun) => { run.observations[0].hostObservedAtMs += 100; }],
    ["reversed observation", (run: LiveVisionRun) => { run.observations.reverse(); }],
    ["candidate outside observation", (run: LiveVisionRun) => { run.candidates[0].endMs = 3000; }],
    ["past run bound", (run: LiveVisionRun) => { run.elapsedMs = LIVE_VISION_MAX_DURATION_MS + 1; }],
    ["crop outside source", (run: LiveVisionRun) => { run.source.crop.x = 0.9; }],
    ["implicit model approval", (run: LiveVisionRun) => { Object.assign(run.candidates[0], { status: "confirmed" }); }],
    ["review without evidence", (run: LiveVisionRun) => { run.reviews = [{ ...review("manual-1", 3000), reason: "" }]; }],
  ])("rejects %s", (_, change) => {
    const run = fixture(); change(run);
    expect(() => parseLiveVisionRun(run)).toThrow("实时视觉记录无效");
  });
  it("retains manual-only review intervals and marks gaps incomplete in CSV", () => {
    const run = fixture();
    run.source.pilotName = "=BAD()";
    run.reviews = [review("manual-a", 2200), review("manual-b", 3500)];
    expect(liveVisionLapsCsv(run)).toContain('"reviewed"');
    expect(liveVisionLapsCsv(run)).toContain('"\'=BAD()"');
    run.gaps = [{ startMs: 3000, endMs: 3400, reason: "视频中断" }];
    expect(liveVisionLapsCsv(run)).toContain('"incomplete"');
    expect(liveVisionLapsCsv(run)).toContain('"host_presentation_estimate","false"');
  });
});

describe("independent live run persistence", () => {
  it("stores and restores a live run in its own database", async () => {
    const run = fixture(); await saveLiveVisionRun(run);
    expect(await getLiveVisionRun(run.id)).toEqual(run);
    expect(await getLiveVisionRun("missing")).toBeNull();
    expect(await listLiveVisionRuns()).toEqual([{ id: run.id, createdAt: run.createdAt, pilotName: "Pilot", gateName: "Gate", state: "stopped", elapsedMs: 4000 }]);
  });
  it("accepts only one concurrent divergent review history and leaves both local inputs unchanged", async () => {
    const run = fixture(); await saveLiveVisionRun(run);
    const a = { ...run, reviews: [review("manual-a", 2500)] };
    const b = { ...run, reviews: [review("manual-b", 2800)] };
    const copies = [JSON.stringify(a), JSON.stringify(b)];
    const results = await Promise.allSettled([saveLiveVisionRun(a), saveLiveVisionRun(b)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: expect.objectContaining({ message: expect.stringMatching(/冲突.*导出.*重新载入/) }) });
    expect(await getLiveVisionRun(run.id)).toEqual(results[0].status === "fulfilled" ? a : b);
    expect([JSON.stringify(a), JSON.stringify(b)]).toEqual(copies);
    await expect(saveLiveVisionRun(run)).rejects.toThrow("冲突");
  });
  it("refuses source changes and older frame histories for an existing ID", async () => {
    const run = fixture(); await saveLiveVisionRun(run);
    await expect(saveLiveVisionRun({ ...run, source: { ...run.source, pilotName: "Other" } })).rejects.toThrow("冲突");
    await expect(saveLiveVisionRun({ ...run, analyzedUntilMs: 1500, observations: run.observations.slice(0, 2), candidates: [] })).rejects.toThrow("冲突");
    expect(await getLiveVisionRun(run.id)).toEqual(run);
  });
  it("waits for commit and rejects a transaction aborted after put success", async () => {
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = original.apply(this, args);
      request.addEventListener("success", () => this.transaction.abort());
      return request;
    });
    await expect(saveLiveVisionRun(fixture())).rejects.toThrow("中止");
    expect(await getLiveVisionRun("live-1")).toBeNull();
  });
  it("uses different filenames for repeated export snapshots", () => {
    expect(liveVisionExportFilename("run-1", "json", "export-1")).not.toBe(liveVisionExportFilename("run-1", "json", "export-2"));
    expect(liveVisionExportFilename("../run", "csv", "../export")).toBe("fpv-live-vision-run-export.csv");
  });
});

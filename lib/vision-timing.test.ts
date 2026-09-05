import { describe, expect, it } from "vitest";
import type { VisionReview, VisionTimingRun } from "./vision-lab-types";
import { createVisionCandidateTracker, deriveVisionLaps, resolveVisionEvents, validateVisionRange, visionCropRect, visionExportFilename, visionLapsCsv } from "./vision-timing";

function fixture(): VisionTimingRun {
  return {
    schemaVersion: 1, pipelineVersion: "reference-motion-v1", timestampSource: "video_seek_position", provenance: "local", id: "test-run", createdAt: "2026-09-05T00:00:00Z",
    profile: { schemaVersion: 1, id: "gate", revision: 1, name: "Gate", imageSha256: "a".repeat(64), rect: { x: 0, y: 0, width: 1, height: 1 }, createdAt: "2026-09-05T00:00:00Z" },
    video: { name: "recording.mp4", size: 1000, lastModified: 0, sha256: "b".repeat(64), durationMs: 30_000, width: 1920, height: 1080 },
    settings: { crop: "full", fromMs: 0, toMs: 30_000, sampleFps: 5, similarityThreshold: 0.65 },
    model: { id: "fixture", revision: "fixture", weightsSha256: "c".repeat(64), backend: "test" },
    state: "complete", analyzedFrames: 150, analyzedUntilMs: 30_000,
    candidates: [1000, 5000, 10_000].map((timeMs, i) => ({ id: `candidate-${i}`, timeMs, startMs: timeMs - 200, endMs: timeMs + 200, similarity: 0.9, box: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 }, reason: "候选" })),
    reviews: [], gaps: [],
  };
}
const review = (eventId: string, timeMs: number, action: VisionReview["action"] = "confirm"): VisionReview => ({ id: `review-${eventId}-${action}-${timeMs}`, eventId, timeMs, action, reason: "对照原录像复核", createdAt: "2026-09-05T00:00:00Z" });

describe("reviewed vision laps", () => {
  it("never turns a similarity score into a confirmed crossing", () => {
    const run = fixture();
    expect(resolveVisionEvents(run).every((e) => e.status === "pending")).toBe(true);
    expect(deriveVisionLaps(run)).toEqual([]);
    run.reviews = [review("candidate-0", 1000)];
    expect(deriveVisionLaps(run)).toEqual([]);
  });

  it("blocks a merged interval when it contains an unresolved candidate", () => {
    const run = fixture();
    run.reviews = [review("candidate-0", 1000), review("candidate-2", 10_000)];
    expect(deriveVisionLaps(run)[0]).toMatchObject({ status: "incomplete", durationMs: 9000 });
    run.reviews.push(review("candidate-1", 5000, "reject"));
    expect(deriveVisionLaps(run)[0]).toMatchObject({ status: "reviewed", durationMs: 9000 });
  });

  it("preserves model time while explicit adjust-and-confirm recalculates both neighboring laps", () => {
    const run = fixture();
    run.reviews = run.candidates.map((e) => review(e.id, e.timeMs));
    run.reviews.push(review("candidate-1", 5500, "adjust"));
    expect(run.candidates[1].timeMs).toBe(5000);
    expect(deriveVisionLaps(run).map((lap) => lap.durationMs)).toEqual([4500, 4500]);
    expect(resolveVisionEvents(run)[1]).toMatchObject({ timeMs: 5500, status: "confirmed" });
  });

  it("retains gaps and equal timestamps as incomplete instead of fastest laps", () => {
    const run = fixture();
    run.reviews = run.candidates.map((e) => review(e.id, e.timeMs));
    run.gaps = [{ startMs: 7000, endMs: 7500, reason: "解码缺口" }];
    expect(deriveVisionLaps(run).map((lap) => lap.status)).toEqual(["reviewed", "incomplete"]);
    run.reviews.push(review("candidate-1", 1000, "adjust"));
    expect(deriveVisionLaps(run)[0]).toMatchObject({ status: "incomplete", durationMs: 0 });
  });

  it("keeps manually added and rejected events separate from the original predictions", () => {
    const run = fixture();
    run.reviews = [review("manual", 2000, "add"), review("manual", 2000, "reject")];
    expect(run.candidates).toHaveLength(3);
    expect(resolveVisionEvents(run).find((e) => e.id === "manual")).toMatchObject({ origin: "manual", status: "rejected", similarity: null });
  });

  it("writes CSV safely for user supplied gate and file names", () => {
    const run = fixture();
    run.profile.name = "=SUM(A1:A2)";
    run.video.name = 'line,"quote".mp4';
    run.reviews = run.candidates.map((e) => review(e.id, e.timeMs));
    const csv = visionLapsCsv(run);
    expect(csv).toContain('"\'=SUM(A1:A2)"');
    expect(csv).toContain('"line,""quote"".mp4"');
    expect(csv.split("\r\n")).toHaveLength(4);
  });
});

describe("reference motion proposals", () => {
  const candidate = (side: number) => [{ box: { x: 0.2, y: 0.2, width: side, height: side }, similarity: 0.9 }];
  it("requires temporal approach rather than counting a still reference on every frame", () => {
    const tracker = createVisionCandidateTracker({ sampleFps: 5, idFactory: () => "proposal" });
    for (const time of [0, 200, 400, 600]) expect(tracker.push(time, candidate(0.4))).toEqual([]);
    expect(tracker.finish()).toEqual([]);
  });

  it("proposes one review point after approach and disappearance, using source sample times", () => {
    const tracker = createVisionCandidateTracker({ sampleFps: 5, idFactory: () => "proposal" });
    tracker.push(1000, candidate(0.2)); tracker.push(1200, candidate(0.3)); tracker.push(1400, candidate(0.5));
    expect(tracker.push(1600, [])).toEqual([]);
    expect(tracker.push(1800, [])).toEqual([expect.objectContaining({ id: "proposal", timeMs: 1400, startMs: 1000, endMs: 1400 })]);
    expect(tracker.push(2000, [])).toEqual([]);
    expect(tracker.finish()).toEqual([]);
  });

  it("does not bridge long observation gaps or accept backwards time", () => {
    const tracker = createVisionCandidateTracker({ sampleFps: 5, idFactory: () => "proposal" });
    tracker.push(0, candidate(0.2)); tracker.push(200, candidate(0.3)); tracker.push(1000, candidate(0.5));
    expect(tracker.finish()).toEqual([]);
    expect(() => tracker.push(999, [])).toThrow("严格递增");
  });
});

it("bounds offline work to a valid, finite, three minute source interval", () => {
  const settings = fixture().settings;
  expect(() => validateVisionRange(settings, 30_000)).not.toThrow();
  for (const patch of [{ toMs: 180_001 }, { fromMs: -1 }, { sampleFps: 0 }, { similarityThreshold: NaN }, { fromMs: 10, toMs: 10 }]) {
    expect(() => validateVisionRange({ ...settings, ...patch } as typeof settings, 300_000)).toThrow();
  }
  expect(visionCropRect("bottom-right")).toEqual({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 });
});

it("gives repeated exports different snapshot filenames", () => {
  expect(visionExportFilename("run-1", 2, "json", "export-1")).not.toBe(visionExportFilename("run-1", 2, "json", "export-2"));
  expect(visionExportFilename("../run", 1, "csv", "../export")).toBe("fpv-vision-run-v1-export.csv");
});

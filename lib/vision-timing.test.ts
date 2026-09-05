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

  it.each([2, 5, 10])("retains the three-observation requirement at %i fps", (sampleFps) => {
    const step = 1000 / sampleFps;
    for (const count of [1, 2, 3]) {
      const tracker = createVisionCandidateTracker({ sampleFps, idFactory: () => "proposal" });
      for (let index = 0; index < count; index++) tracker.push(index * step, candidate(0.2 + index * 0.1));
      expect(tracker.finish()).toHaveLength(count === 3 ? 1 : 0);
      expect(tracker.getDiagnostics()).toMatchObject({
        observations: count, matchedObservations: count,
        lastRejection: count < 3 ? "insufficient_observations" : null,
      });
    }
  });

  it("keeps live observation continuity independent of a faster target and closes on the next empty frame", () => {
    const oldDefaults = createVisionCandidateTracker({ sampleFps: 30, idFactory: () => "old" });
    const live = createVisionCandidateTracker({ sampleFps: 30, maxObservationGapMs: 1500, exitDelayMs: 150, idFactory: () => "live" });
    for (const tracker of [oldDefaults, live]) {
      tracker.push(0, candidate(0.2)); tracker.push(278, candidate(0.3)); tracker.push(556, candidate(0.4));
    }
    expect(oldDefaults.push(834, [])).toEqual([]);
    expect(live.push(834, [])).toEqual([expect.objectContaining({ id: "live", timeMs: 556 })]);
    expect(live.getDiagnostics()).toMatchObject({ status: "proposed", proposals: 1, observations: 4,
      matchedObservations: 3, noMatchObservations: 1, maxObservationGapMs: 1500, exitDelayMs: 150 });
    expect(live.finish()).toEqual([]);
    expect(live.getDiagnostics().proposals).toBe(1);
  });

  it("starts a new track from the valid observation that exceeds the matched-frame gap", () => {
    const tracker = createVisionCandidateTracker({ sampleFps: 2, idFactory: () => "new-track" });
    tracker.push(0, candidate(0.2));
    tracker.push(500, []);
    tracker.push(1500, candidate(0.2));
    expect(tracker.getDiagnostics()).toMatchObject({ status: "tracking", trackObservations: 1, lastMatchMs: 1500,
      lastRejection: "matched_gap", rejectionCounts: { matched_gap: 1, observation_gap: 0 } });
    tracker.push(2000, candidate(0.3)); tracker.push(2500, candidate(0.4));
    expect(tracker.finish()).toEqual([expect.objectContaining({ startMs: 1500, endMs: 2500 })]);
  });

  it("drops old endpoints across an observation gap but retains the new hit", () => {
    const tracker = createVisionCandidateTracker({ sampleFps: 5, idFactory: () => "new-track" });
    tracker.push(0, candidate(0.2)); tracker.push(200, candidate(0.3)); tracker.push(1000, candidate(0.2));
    expect(tracker.getDiagnostics()).toMatchObject({ trackObservations: 1, lastMatchMs: 1000,
      rejectionCounts: { observation_gap: 1, matched_gap: 0 } });
    tracker.push(1200, candidate(0.3)); tracker.push(1400, candidate(0.4));
    expect(tracker.finish()).toEqual([expect.objectContaining({ startMs: 1000 })]);
  });

  it("reports waiting for exit and keeps diagnostic snapshots separate from mutable state", () => {
    const tracker = createVisionCandidateTracker({ sampleFps: 2, idFactory: () => "proposal" });
    tracker.push(0, candidate(0.2)); tracker.push(500, candidate(0.3)); tracker.push(1000, candidate(0.4));
    const snapshot = tracker.getDiagnostics();
    expect(snapshot).toMatchObject({ status: "tracking", trackObservations: 3, growthRatio: 4,
      requiredObservations: 3, requiredGrowthRatio: 1.3, shrinkRatio: 0.55, cooldownMs: 1500 });
    expect(tracker.push(1500, [])).toEqual([]);
    expect(tracker.getDiagnostics().status).toBe("waiting_exit");
    expect(snapshot.noMatchObservations).toBe(0);
    expect(Object.isFrozen(snapshot.rejectionCounts)).toBe(true);
    expect(tracker.push(2000, [])).toHaveLength(1);
    const finished = tracker.getDiagnostics();
    expect(() => tracker.push(2000, [])).toThrow("严格递增");
    expect(tracker.getDiagnostics()).toEqual(finished);
  });

  it.each([1.29, 1.3])("requires area growth of at least 1.30, observed %f", (growth) => {
    const tracker = createVisionCandidateTracker({ sampleFps: 5, idFactory: () => "proposal" });
    const area = (value: number) => [{ box: { x: 0, y: 0, width: 1, height: value }, similarity: 0.9 }];
    tracker.push(0, area(0.1)); tracker.push(200, area(0.12)); tracker.push(400, area(0.1 * growth));
    expect(tracker.finish()).toHaveLength(growth >= 1.3 ? 1 : 0);
    expect(tracker.getDiagnostics().lastRejection).toBe(growth >= 1.3 ? null : "insufficient_growth");
  });

  it("only closes a shrinking match below 55% of peak area and keeps that frame as a new start", () => {
    const tracker = createVisionCandidateTracker({ sampleFps: 5, idFactory: () => "proposal" });
    const area = (value: number) => [{ box: { x: 0, y: 0, width: 1, height: value }, similarity: 0.9 }];
    tracker.push(0, area(0.5)); tracker.push(200, area(0.75)); tracker.push(400, area(1));
    expect(tracker.push(600, area(0.55))).toEqual([]);
    expect(tracker.push(800, area(0.549))).toHaveLength(1);
    expect(tracker.getDiagnostics()).toMatchObject({ trackObservations: 1, lastMatchMs: 800, proposals: 1 });
  });

  it.each([1499, 1500])("keeps the peak-time cooldown boundary at %i ms", (separation) => {
    const tracker = createVisionCandidateTracker({ sampleFps: 30, maxObservationGapMs: 1500, exitDelayMs: 150, idFactory: () => "proposal" });
    tracker.push(0, candidate(0.2)); tracker.push(100, candidate(0.3)); tracker.push(200, candidate(0.4));
    expect(tracker.finish()).toHaveLength(1);
    tracker.push(1200, candidate(0.2)); tracker.push(1300, candidate(0.3)); tracker.push(200 + separation, candidate(0.4));
    expect(tracker.finish()).toHaveLength(separation >= 1500 ? 1 : 0);
    expect(tracker.getDiagnostics().lastRejection).toBe(separation >= 1500 ? null : "cooldown");
  });

  it("rejects invalid timing options instead of silently disabling observation fences", () => {
    for (const options of [{ sampleFps: 0 }, { sampleFps: Infinity }, { maxObservationGapMs: NaN }, { exitDelayMs: -1 }]) {
      expect(() => createVisionCandidateTracker({ sampleFps: 5, idFactory: () => "proposal", ...options })).toThrow("有限正数");
    }
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

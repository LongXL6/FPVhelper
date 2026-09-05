import { describe, expect, it } from "vitest";
import { createLiveVisionDiagnostics, type LiveVisionDiagnosticSample } from "./live-vision-diagnostics";
import { createVisionCandidateTracker } from "./vision-timing";

const tracker = () => createVisionCandidateTracker({ sampleFps: 30, idFactory: () => "candidate" }).getDiagnostics();
function sample(timeMs: number): LiveVisionDiagnosticSample {
  return { timeMs, inferenceMs: 100, captureMs: 2, roundTripMs: 110, preprocessMs: 1, modelMs: 90, matchingMs: 9, bestMatch: null, acceptedMatches: 0, tracker: tracker() };
}
const create = () => createLiveVisionDiagnostics({ runId: "test", backend: "webgpu", fallbackReason: null, targetFps: 30, threshold: .65 });
describe("bounded local live diagnostics", () => {
  it("computes throughput from completion times and distinguishes fresh frames from skipped work", () => {
    const collector = create();
    for (let i = 0; i < 30; i++) collector.observe(i * 1000 / 30);
    collector.complete(sample(0), 100);
    collector.complete(sample(400), 600);
    collector.increment("busy", 28);
    const result = collector.snapshot(1000);
    expect(result.inputFps).toBeCloseTo(30);
    expect(result.analysisFps).toBe(2);
    expect(result.counters).toMatchObject({ presented: 30, analyzed: 2, busy: 28 });
    expect(collector.snapshot(4000).analysisFps).toBeNull();
  });
  it("retains only the latest 120 metadata samples while cumulative counts remain complete", () => {
    const collector = create();
    for (let i = 0; i < 500; i++) collector.complete(sample(i * 100), i * 100 + 110);
    const result = collector.export(50010);
    expect(result.samples).toHaveLength(120);
    expect(result.samples[0].timeMs).toBe(38000);
    expect(result.diagnostics.counters.analyzed).toBe(500);
    expect(result.imageDataIncluded).toBe(false);
    result.diagnostics.counters.analyzed = 0;
    expect(collector.snapshot(50010).counters.analyzed).toBe(500);
  });
});

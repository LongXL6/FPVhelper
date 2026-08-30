import { describe, expect, it } from "vitest";
import {
  advanceStickPeakTracker,
  appendStickMotionSample,
  createStickPeakTracker,
  visibleStickPeak,
} from "./stick-motion";

describe("stick motion visualization", () => {
  it("keeps the maximum point from the last completed excursion", () => {
    let tracker = createStickPeakTracker({ x: 0, y: 0 });
    tracker = advanceStickPeakTracker(tracker, { x: 30, y: 0 });
    tracker = advanceStickPeakTracker(tracker, { x: 70, y: 20 });
    tracker = advanceStickPeakTracker(tracker, { x: 5, y: 5 });
    expect(visibleStickPeak(tracker)).toEqual({ x: 70, y: 20 });

    tracker = advanceStickPeakTracker(tracker, { x: -40, y: 0 });
    expect(visibleStickPeak(tracker)).toEqual({ x: 70, y: 20 });
  });

  it("uses low throttle as the neutral point for the left stick", () => {
    let tracker = createStickPeakTracker({ x: 0, y: -100 });
    tracker = advanceStickPeakTracker(tracker, { x: 0, y: -60 });
    tracker = advanceStickPeakTracker(tracker, { x: 40, y: 50 });
    tracker = advanceStickPeakTracker(tracker, { x: 0, y: -95 });
    expect(visibleStickPeak(tracker)).toEqual({ x: 40, y: 50 });
  });

  it("retains only the requested blur-trail window", () => {
    const samples = Array.from({ length: 24 }, (_, sequence) => ({
      sequence,
      left: { x: sequence, y: 0 },
      right: { x: 0, y: sequence },
    }));
    const retained = samples.reduce((current, sample) => appendStickMotionSample(current, sample, 8), [] as typeof samples);
    expect(retained).toHaveLength(8);
    expect(retained[0].sequence).toBe(16);
  });
});

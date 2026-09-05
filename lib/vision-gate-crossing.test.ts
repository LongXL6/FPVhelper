import { describe, expect, it } from "vitest";
import { createVisionGateCrossingDetector } from "./vision-gate-crossing";

describe("vision start-gate crossing detector", () => {
  it("uses direction, hysteresis and interpolation to produce one forward pass", () => {
    const detector = createVisionGateCrossingDetector({
      gateId: "start",
      direction: "forward",
      confidenceThreshold: 0.8,
      hysteresisDistance: 0.2,
      cooldownMs: 500,
      maxSampleGapMs: 250,
    });
    expect(detector.push({ timestampMs: 0, signedDistance: -1, confidence: 0.9 })).toBeNull();
    expect(detector.push({ timestampMs: 80, signedDistance: -0.05, confidence: 0.9 })).toBeNull();
    expect(detector.push({ timestampMs: 100, signedDistance: 1, confidence: 0.9 })).toMatchObject({
      gateId: "start",
      direction: "forward",
      timestampMs: 50,
      confidence: 0.9,
    });
    expect(detector.push({ timestampMs: 120, signedDistance: 0.8, confidence: 0.95 })).toBeNull();
  });

  it("ignores low-confidence samples and enforces cooldown after rearming", () => {
    const detector = createVisionGateCrossingDetector({
      gateId: "start",
      direction: "forward",
      confidenceThreshold: 0.8,
      hysteresisDistance: 0.2,
      cooldownMs: 1_000,
      maxSampleGapMs: 500,
    });
    detector.push({ timestampMs: 0, signedDistance: -1, confidence: 0.9 });
    expect(detector.push({ timestampMs: 100, signedDistance: 1, confidence: 0.7 })).toBeNull();
    expect(detector.push({ timestampMs: 200, signedDistance: 1, confidence: 0.9 })).not.toBeNull();
    detector.push({ timestampMs: 300, signedDistance: -1, confidence: 0.9 });
    expect(detector.push({ timestampMs: 400, signedDistance: 1, confidence: 0.9 })).toBeNull();
    detector.push({ timestampMs: 1_300, signedDistance: -1, confidence: 0.9 });
    expect(detector.push({ timestampMs: 1_500, signedDistance: 1, confidence: 0.9 })).not.toBeNull();
  });

  it("rejects non-monotonic detector timestamps", () => {
    const detector = createVisionGateCrossingDetector({
      gateId: "start",
      direction: "forward",
      confidenceThreshold: 0.8,
      hysteresisDistance: 0.2,
      cooldownMs: 500,
      maxSampleGapMs: 250,
    });
    detector.push({ timestampMs: 10, signedDistance: -1, confidence: 0.9 });
    expect(() => detector.push({ timestampMs: 9, signedDistance: 1, confidence: 0.9 })).toThrow(/单调/);
  });

  it("resets tracking after a missing-frame gap without synthesizing a crossing", () => {
    const detector = createVisionGateCrossingDetector({
      gateId: "start",
      direction: "forward",
      confidenceThreshold: 0.8,
      hysteresisDistance: 0.2,
      cooldownMs: 500,
      maxSampleGapMs: 100,
    });
    detector.push({ timestampMs: 0, signedDistance: -1, confidence: 0.9 });
    expect(detector.push({ timestampMs: 101, signedDistance: 1, confidence: 0.9 })).toBeNull();
    detector.push({ timestampMs: 150, signedDistance: -1, confidence: 0.9 });
    expect(detector.push({ timestampMs: 250, signedDistance: 1, confidence: 0.9 })).toMatchObject({ timestampMs: 200 });
  });

  it("accepts a sample gap exactly at the configured maximum and validates the cap", () => {
    const detector = createVisionGateCrossingDetector({
      gateId: "start",
      direction: "forward",
      confidenceThreshold: 0.8,
      hysteresisDistance: 0.2,
      cooldownMs: 0,
      maxSampleGapMs: 100,
    });
    detector.push({ timestampMs: 0, signedDistance: -1, confidence: 0.9 });
    expect(detector.push({ timestampMs: 100, signedDistance: 1, confidence: 0.9 })).toMatchObject({ timestampMs: 50 });

    expect(() => createVisionGateCrossingDetector({
      gateId: "start",
      direction: "forward",
      confidenceThreshold: 0.8,
      hysteresisDistance: 0.2,
      cooldownMs: 0,
      maxSampleGapMs: 0,
    })).toThrow(/maxSampleGapMs/);
  });
});

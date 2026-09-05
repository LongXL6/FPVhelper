import { describe, expect, it } from "vitest";
import {
  calculateTrainingCaptureQuality,
  createTrainingCaptureContext,
  parseTrainingCaptureContext,
  parseTrainingCaptureQuality,
} from "./training-capture-quality";

function samples(times: number[], source: "ground_rc" | "demo" = "ground_rc") {
  return times.map((elapsedMs) => ({ elapsedMs, source }));
}

describe("stored host receipt capture quality", () => {
  it("measures the original 100 Hz target using actual adjacent sample times", () => {
    const quality = calculateTrainingCaptureQuality(samples([0, 10, 20, 30, 40]));
    expect(quality).toMatchObject({
      version: 1,
      basis: "stored_host_receive_timestamps",
      targetPollHz: 100,
      source: "ground_rc",
      sampleCount: 5,
      positiveIntervalCount: 4,
      zeroIntervalCount: 0,
      negativeIntervalCount: 0,
      invalidIntervalCount: 0,
      intervalStatsMs: { median: 10, p95: 10, p99: 10, max: 10 },
      gaps: [],
      rfPacketLossMeasured: false,
    });
    expect(quality.usablePeriods).toEqual([{
      source: "ground_rc", startSampleIndex: 0, endSampleIndex: 4,
      startElapsedMs: 0, endElapsedMs: 40, durationMs: 40,
    }]);
  });

  it("reports interpolated tail intervals and observed gaps without inventing edge gaps", () => {
    const quality = calculateTrainingCaptureQuality(samples([1_000, 1_010, 1_030, 1_060, 1_160, 1_210]));
    expect(quality.intervalStatsMs).toEqual({ median: 30, p95: 90, p99: 98, max: 100 });
    expect(quality.gaps).toEqual([{
      startSampleIndex: 3, endSampleIndex: 4,
      startElapsedMs: 1_060, endElapsedMs: 1_160, durationMs: 100,
    }]);
    expect(quality.usablePeriods.map((period) => [period.startSampleIndex, period.endSampleIndex])).toEqual([[0, 3], [4, 5]]);
  });

  it("includes exactly 50 ms in usable intervals and excludes larger gaps", () => {
    const quality = calculateTrainingCaptureQuality(samples([0, 50, 100.001]));
    expect(quality.gaps[0].durationMs).toBe(50.001);
    expect(quality.usablePeriods[0]).toMatchObject({ startSampleIndex: 0, endSampleIndex: 1, durationMs: 50 });
  });

  it("separates batched zero times and backwards clocks from positive intervals", () => {
    const quality = calculateTrainingCaptureQuality(samples([0, 10, 10, 5, 15, Number.NaN, 30, -5, 40, 50]));
    expect(quality).toMatchObject({
      positiveIntervalCount: 3, zeroIntervalCount: 1, negativeIntervalCount: 1, invalidIntervalCount: 4,
      intervalStatsMs: { median: 10, p95: 10, p99: 10, max: 10 },
      gaps: [], rfPacketLossMeasured: false,
    });
    expect(quality.usablePeriods.map((period) => [period.startSampleIndex, period.endSampleIndex])).toEqual([[0, 1], [3, 4], [8, 9]]);
  });

  it("does not claim valid timing from empty, single, zero or backwards intervals", () => {
    for (const times of [[], [10], [10, 10], [10, 5]]) {
      const quality = calculateTrainingCaptureQuality(samples(times));
      expect(quality.intervalStatsMs).toEqual({ median: null, p95: null, p99: null, max: null });
      expect(quality.usablePeriods).toEqual([]);
    }
    expect(calculateTrainingCaptureQuality([]).source).toBe("empty");
  });

  it("labels demo and mixed sources and separates periods at source transitions", () => {
    expect(calculateTrainingCaptureQuality(samples([0, 10], "demo")).source).toBe("demo");
    const quality = calculateTrainingCaptureQuality([
      ...samples([0, 10]), ...samples([20, 30], "demo"), ...samples([40, 50]),
    ]);
    expect(quality.source).toBe("mixed");
    expect(quality.usablePeriods.map((period) => [period.source, period.startSampleIndex, period.endSampleIndex])).toEqual([
      ["ground_rc", 0, 1], ["demo", 2, 3], ["ground_rc", 4, 5],
    ]);
  });

  it("accepts a matching extension and rejects false sample-derived claims or unsupported fields", () => {
    const captured = samples([0, 10, 110]);
    const quality = calculateTrainingCaptureQuality(captured);
    expect(parseTrainingCaptureQuality(JSON.parse(JSON.stringify(quality)), captured)).toEqual(quality);
    for (const invalid of [
      null,
      { ...quality, version: 2 },
      { ...quality, targetPollHz: 50 },
      { ...quality, sampleCount: 99 },
      { ...quality, gaps: [] },
      { ...quality, intervalStatsMs: { ...quality.intervalStatsMs, p99: -1 } },
      { ...quality, rfPacketLossMeasured: true },
      { ...quality, unknown: "ignored" },
    ]) expect(() => parseTrainingCaptureQuality(invalid, captured)).toThrow("captureQuality");
    expect(() => parseTrainingCaptureQuality(quality, samples([0, 20, 110]))).toThrow("captureQuality");
  });

  it("describes host timing, units and normalization without a device or air-packet rate claim", () => {
    const context = createTrainingCaptureContext();
    expect(context).toMatchObject({
      version: 1,
      timestamp: { clock: "performance.now", unit: "ms", origin: "session_start", batchingPossible: true },
      channels: { unit: "us", order: "roll_pitch_yaw_throttle_then_aux" },
      sequence: { meaning: "host_generated_frame_counter", airPacketSequence: false },
      normalization: { axisMidpointUs: 1500, axisHalfRangeUs: 500, clamped: true },
      deviceSampleRateHz: null, rfPacketLossMeasured: false,
    });
    expect(parseTrainingCaptureContext(JSON.parse(JSON.stringify(context)))).toEqual(context);
    expect(createTrainingCaptureContext().normalization).not.toBe(context.normalization);
    for (const invalid of [
      null,
      { ...context, version: 2 },
      { ...context, deviceSampleRateHz: 100 },
      { ...context, sequence: { ...context.sequence, airPacketSequence: true } },
      { ...context, normalization: { ...context.normalization, axisMidpointUs: 1000 } },
    ]) expect(() => parseTrainingCaptureContext(invalid)).toThrow("captureContext");
  });
});

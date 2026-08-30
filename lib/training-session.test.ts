import { describe, expect, it } from "vitest";
import { EMPTY_TELEMETRY } from "./telemetry";
import {
  appendTrainingSessionSample,
  createTrainingSessionDraft,
  finishTrainingSession,
  serializeTrainingSession,
  trainingSessionFilename,
} from "./training-session";

describe("local training session", () => {
  it("records unique RC samples against a monotonic session clock", () => {
    const draft = createTrainingSessionDraft("session-12345678", "serial", 1_700_000_000_000, 1_000);
    const first = {
      ...EMPTY_TELEMETRY,
      timestamp: 1_700_000_000_100,
      monotonicTimestampMs: 1_100,
      sequence: 1,
      rollStickPercent: 20,
      throttleStickPercent: 60,
      rcThrottleUs: 1600,
      groundMspRssiPercent: 92,
      groundBridgeVoltage: 5,
    };

    expect(appendTrainingSessionSample(draft, first, "serial")).toBe(true);
    expect(appendTrainingSessionSample(draft, first, "serial")).toBe(false);
    expect(draft.samples).toEqual([
      {
        elapsedMs: 100,
        sequence: 1,
        source: "ground_rc",
        rc: {
          rollStickPercent: 20,
          pitchStickPercent: 0,
          yawStickPercent: 0,
          throttleStickPercent: 60,
          throttleUs: 1600,
        },
        groundBridge: {
          mspRssiPercent: 92,
          voltage: 5,
        },
      },
    ]);
  });

  it("finalizes source, timing and sample-rate metadata", () => {
    const draft = createTrainingSessionDraft("session-12345678", "demo", 1_700_000_000_000, 1_000);
    appendTrainingSessionSample(draft, { ...EMPTY_TELEMETRY, monotonicTimestampMs: 1_100, sequence: 1 }, "demo");
    appendTrainingSessionSample(draft, { ...EMPTY_TELEMETRY, monotonicTimestampMs: 1_150, sequence: 2 }, "demo");

    const session = finishTrainingSession(draft, 1_700_000_001_000, 2_000);
    expect(session).toMatchObject({
      schemaVersion: 1,
      durationMs: 1000,
      dataSources: ["demo"],
      sampleCount: 2,
      estimatedRcSampleRateHz: 20,
      video: { recorded: false, synchronized: false },
      timing: { clock: "performance.now", videoOffsetCalibrated: false },
    });
    expect(JSON.parse(serializeTrainingSession(session)).sampleCount).toBe(2);
    expect(trainingSessionFilename(session)).toBe("fpv-session-2023-11-14T22-13-20Z-12345678.json");
  });
});

import { describe, expect, it } from "vitest";
import {
  analyticsConnectionTransition,
  describeAnalyticsInterruptedSessionLoss,
  analyticsObservedRcFrameDelta,
  analyticsSerialLifecycleMetrics,
  analyticsSerialWasLost,
  analyticsVideoWasLost,
  createAnalyticsEventDeduper,
} from "../lib/analytics/lifecycle";

describe("analytics lifecycle transition helpers", () => {
  it("emits stall and resume only for genuine serial transitions", () => {
    expect(analyticsConnectionTransition("live", "stale", "serial")).toBe("stalled");
    expect(analyticsConnectionTransition("stale", "live", "serial")).toBe("resumed");
    expect(analyticsConnectionTransition("live", "stale", "demo")).toBeNull();
    expect(analyticsConnectionTransition("demo", "live", "serial")).toBeNull();
    expect(analyticsConnectionTransition("live", "live", "serial")).toBeNull();
  });

  it("separates an unexpected video loss from an intentional disconnect", () => {
    expect(analyticsVideoWasLost("live", "error", false)).toBe(true);
    expect(analyticsVideoWasLost("live", "idle", false)).toBe(true);
    expect(analyticsVideoWasLost("live", "idle", true)).toBe(false);
    expect(analyticsVideoWasLost("connecting", "error", false)).toBe(false);
  });

  it("ends a serial lifecycle only when a real live/stale connection leaves serial", () => {
    expect(analyticsSerialWasLost({
      previousSource: "serial", previousConnection: "live", currentSource: "demo", currentConnection: "demo",
    })).toBe(true);
    expect(analyticsSerialWasLost({
      previousSource: "serial", previousConnection: "stale", currentSource: "demo", currentConnection: "error",
    })).toBe(true);
    expect(analyticsSerialWasLost({
      previousSource: "serial", previousConnection: "live", currentSource: "serial", currentConnection: "stale",
    })).toBe(false);
    expect(analyticsSerialWasLost({
      previousSource: "serial", previousConnection: "stale", currentSource: "serial", currentConnection: "live",
    })).toBe(false);
    expect(analyticsSerialWasLost({
      previousSource: "demo", previousConnection: "connecting", currentSource: "demo", currentConnection: "error",
    })).toBe(false);
  });

  it("describes one unexported interruption and evaluates validity before that interruption", () => {
    expect(describeAnalyticsInterruptedSessionLoss({
      interrupted: true, exportedAt: null, alreadyTracked: false, invalidReasons: ["interrupted"],
    })).toEqual({ validBeforeInterruption: true });
    expect(describeAnalyticsInterruptedSessionLoss({
      interrupted: true, exportedAt: null, alreadyTracked: false, invalidReasons: ["too_short", "interrupted"],
    })).toEqual({ validBeforeInterruption: false });
    expect(describeAnalyticsInterruptedSessionLoss({
      interrupted: true, exportedAt: null, alreadyTracked: true, invalidReasons: ["interrupted"],
    })).toBeNull();
    expect(describeAnalyticsInterruptedSessionLoss({
      interrupted: true,
      exportedAt: "2026-08-31T00:00:00.000Z",
      alreadyTracked: false,
      invalidReasons: ["interrupted"],
    })).toBeNull();
    expect(describeAnalyticsInterruptedSessionLoss({
      interrupted: false, exportedAt: null, alreadyTracked: false, invalidReasons: [],
    })).toBeNull();
  });

  it("deduplicates noisy lifecycle notifications inside their quiet window", () => {
    const deduper = createAnalyticsEventDeduper();
    expect(deduper.shouldEmit("js:abc", 1_000, 5_000)).toBe(true);
    expect(deduper.shouldEmit("js:abc", 2_000, 5_000)).toBe(false);
    expect(deduper.shouldEmit("js:def", 2_000, 5_000)).toBe(true);
    expect(deduper.shouldEmit("js:abc", 6_001, 5_000)).toBe(true);
  });

  it("counts every observed RC frame when React coalesces sequence updates", () => {
    expect(analyticsObservedRcFrameDelta(null, 100)).toBe(0);
    expect(analyticsObservedRcFrameDelta(100, 104)).toBe(4);
    expect(analyticsObservedRcFrameDelta(104, 104)).toBe(0);
    expect(analyticsObservedRcFrameDelta(104, 3)).toBe(0);
  });

  it("derives serial-loss counters from only the active parser lifecycle", () => {
    expect(analyticsSerialLifecycleMetrics({
      start: {
        bytesReceived: 1_000,
        checksumValidFrames: 10,
        protocolErrors: 1,
        checksumErrors: 2,
        resyncs: 3,
        discardedBytes: 4,
      },
      end: {
        bytesReceived: 10_000,
        checksumValidFrames: 132,
        protocolErrors: 4,
        checksumErrors: 5,
        resyncs: 9,
        discardedBytes: 24,
      },
      rcFrames: 110,
      liveMs: 5_000,
    })).toEqual({
      rc_frames: 110,
      analog_frames: 9,
      checksum_errors: 3,
      error_frames: 3,
      effective_hz: 22,
    });
  });

  it("clamps parser resets and impossible analog deltas instead of mixing connections", () => {
    const previousConnection = {
      bytesReceived: 9_000,
      checksumValidFrames: 500,
      protocolErrors: 8,
      checksumErrors: 12,
      resyncs: 10,
      discardedBytes: 30,
    };
    expect(analyticsSerialLifecycleMetrics({
      start: previousConnection,
      end: { ...previousConnection, checksumValidFrames: 3, protocolErrors: 0, checksumErrors: 1 },
      rcFrames: 12,
      liveMs: 0,
    })).toEqual({
      rc_frames: 12,
      analog_frames: 0,
      checksum_errors: 0,
      error_frames: 0,
      effective_hz: 0,
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  analyticsConnectionTransition,
  analyticsInterruptedSessionIsLost,
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

  it("marks only an unexported interrupted session once", () => {
    expect(analyticsInterruptedSessionIsLost({ interrupted: true, exportedAt: null, alreadyTracked: false })).toBe(true);
    expect(analyticsInterruptedSessionIsLost({ interrupted: true, exportedAt: null, alreadyTracked: true })).toBe(false);
    expect(analyticsInterruptedSessionIsLost({ interrupted: true, exportedAt: "2026-08-31T00:00:00.000Z", alreadyTracked: false })).toBe(false);
    expect(analyticsInterruptedSessionIsLost({ interrupted: false, exportedAt: null, alreadyTracked: false })).toBe(false);
  });

  it("deduplicates noisy lifecycle notifications inside their quiet window", () => {
    const deduper = createAnalyticsEventDeduper();
    expect(deduper.shouldEmit("js:abc", 1_000, 5_000)).toBe(true);
    expect(deduper.shouldEmit("js:abc", 2_000, 5_000)).toBe(false);
    expect(deduper.shouldEmit("js:def", 2_000, 5_000)).toBe(true);
    expect(deduper.shouldEmit("js:abc", 6_001, 5_000)).toBe(true);
  });
});

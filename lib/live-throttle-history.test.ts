import { describe, expect, it } from "vitest";
import { createLiveThrottleHistory, liveThrottleSegments, LIVE_THROTTLE_MAX_POINTS, type LiveThrottleSample } from "./live-throttle-history";

const point = (monotonicTimestampMs: number, throttleStickPercent = 50): LiveThrottleSample => ({
  monotonicTimestampMs, throttleStickPercent, source: "serial", breakBefore: false,
});

describe("live throttle receive-time window", () => {
  it.each([20, 50, 100])("keeps only three seconds at %i Hz without mistaking the display stride for a raw gap", (hz) => {
    const history = createLiveThrottleHistory();
    let samples: LiveThrottleSample[] = [];
    for (let index = 1; index <= hz * 6; index += 1) {
      samples = history.observe(point(index * 1000 / hz), "serial", index % 5 === 0) ?? samples;
    }
    expect(samples.every((sample) => sample.monotonicTimestampMs >= 3000 && sample.monotonicTimestampMs <= 6000)).toBe(true);
    expect(samples.length).toBe(Math.floor(hz * 3 / 5) + 1);
    expect(liveThrottleSegments(samples, 6000)).toHaveLength(1);
    expect(liveThrottleSegments(samples, 9001)).toEqual([]);
  });

  it("uses unequal receive intervals for x and never stretches a partial window to three seconds", () => {
    const segments = liveThrottleSegments([point(1000, 0), point(1010, 100), point(1040, 50)], 1500);
    const [a, b, c] = segments[0];
    expect(a.x).toBeCloseTo(2500 / 3000 * 640);
    expect((c.x - b.x) / (b.x - a.x)).toBeCloseTo(3);
    expect(c.x).toBeLessThan(640);
    expect([a.y, b.y, c.y]).toEqual([96, 12, 54]);
  });

  it("carries a gap observed in a non-displayed raw sample into the next displayed point", () => {
    const history = createLiveThrottleHistory();
    history.observe(point(0), "serial", true);
    history.observe(point(10), "serial", false);
    history.observe(point(100), "serial", false);
    history.observe(point(110), "serial", false);
    const broken = history.observe(point(120), "serial", true)!;
    expect(liveThrottleSegments(broken, 120).map((segment) => segment.length)).toEqual([1, 1]);
    const recovered = history.observe(point(130), "serial", true)!;
    expect(liveThrottleSegments(recovered, 130).map((segment) => segment.length)).toEqual([1, 2]);
  });

  it("keeps ordinary jitter continuous while respecting the existing strict greater-than-50-ms definition", () => {
    const history = createLiveThrottleHistory();
    let samples: LiveThrottleSample[] = [];
    for (const time of [0, 8, 19, 50, 100]) samples = history.observe(point(time), "serial", true)!;
    expect(liveThrottleSegments(samples, 100)).toHaveLength(1);
    samples = history.observe(point(150.1), "serial", true)!;
    expect(liveThrottleSegments(samples, 150.1)).toHaveLength(2);
  });

  it("does not draw a fabricated baseline or connect duplicate timestamps", () => {
    expect(liveThrottleSegments([], 100)).toEqual([]);
    const history = createLiveThrottleHistory();
    history.observe(point(10), "serial", true);
    const samples = history.observe(point(10, 80), "serial", true)!;
    expect(liveThrottleSegments(samples, 10).map((segment) => segment.length)).toEqual([1, 1]);
  });

  it("discards the previous visual run on a backwards clock or source change, without changing input", () => {
    const history = createLiveThrottleHistory();
    const input = Object.freeze(point(100));
    history.observe(input, "serial", true);
    expect(history.observe(point(90), "serial", true)).toHaveLength(1);
    const switched = history.observe(point(110), "demo", true)!;
    expect(switched).toHaveLength(1);
    expect(switched[0].source).toBe("demo");
    expect(input).toEqual(point(100));
    history.reset();
    expect(history.observe(point(120), "serial", true)).toEqual([point(120)]);
  });

  it("breaks continuity around invalid observations and ignores future and expired points", () => {
    const history = createLiveThrottleHistory();
    history.observe(point(10), "serial", true);
    expect(history.observe(point(Number.NaN), "serial", true)).toBeNull();
    const samples = history.observe(point(20), "serial", true)!;
    expect(liveThrottleSegments(samples, 20)).toHaveLength(2);
    expect(liveThrottleSegments([point(0), point(3000), point(4001), point(Infinity)], 4000)).toHaveLength(1);
    expect(liveThrottleSegments([point(1)], NaN)).toEqual([]);
  });

  it("bounds display-only memory even if many frames arrive within a single window", () => {
    const history = createLiveThrottleHistory();
    let samples: LiveThrottleSample[] = [];
    for (let i = 0; i < 2000; i += 1) samples = history.observe(point(i / 10), "serial", true)!;
    expect(samples).toHaveLength(LIVE_THROTTLE_MAX_POINTS);
    expect(samples.at(-1)?.monotonicTimestampMs).toBe(199.9);
  });
});

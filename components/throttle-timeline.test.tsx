import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveThrottleSample } from "@/lib/live-throttle-history";
import { ThrottleTimeline } from "./throttle-timeline";

let renderer: ReactTestRenderer | null = null;
let now = 0;
const samples: LiveThrottleSample[] = [100, 150].map((monotonicTimestampMs) => ({
  monotonicTimestampMs, throttleStickPercent: 50, source: "serial", breakBefore: false,
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  now = 150;
  vi.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function tick(time: number) {
  now = time;
  act(() => { vi.advanceTimersByTime(50); });
}

describe("ThrottleTimeline", () => {
  it("ages out the trace while input is stalled, without requiring new props", () => {
    act(() => { renderer = create(<ThrottleTimeline samples={samples} />); });
    tick(200);
    expect(renderer!.root.findAllByType("polyline")).toHaveLength(1);
    const points = renderer!.root.findByType("polyline").props.points;
    tick(1200);
    expect(renderer!.root.findByType("polyline").props.points).not.toEqual(points);
    tick(3151);
    expect(renderer!.root.findAllByType("polyline")).toHaveLength(0);
    expect(renderer!.root.findAllByType("circle")).toHaveLength(0);
  });

  it("shows isolated observations as points and never invents a line for empty input", () => {
    act(() => { renderer = create(<ThrottleTimeline samples={[]} />); });
    tick(200);
    expect(renderer!.root.findAllByType("polyline")).toHaveLength(0);
    act(() => renderer!.update(<ThrottleTimeline samples={[samples[0]]} />));
    expect(renderer!.root.findAllByType("circle")).toHaveLength(1);
    expect(renderer!.root.findAllByType("polyline")).toHaveLength(0);
  });

  it("stops its display clock when hidden, refreshes on return and cleans up on unmount", () => {
    act(() => { renderer = create(<ThrottleTimeline samples={samples} />); });
    tick(200);
    expect(vi.getTimerCount()).toBe(1);
    act(() => renderer!.update(<ThrottleTimeline samples={samples} active={false} />));
    expect(vi.getTimerCount()).toBe(0);
    act(() => renderer!.update(<ThrottleTimeline samples={samples} active />));
    tick(4000);
    expect(renderer!.root.findAllByType("polyline")).toHaveLength(0);
    act(() => renderer!.unmount());
    renderer = null;
    expect(vi.getTimerCount()).toBe(0);
  });
});

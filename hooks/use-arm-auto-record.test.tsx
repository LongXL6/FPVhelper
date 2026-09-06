import { StrictMode, useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_TELEMETRY,
  type SubscribeTelemetrySamples,
  type TelemetrySampleListener,
  type TelemetrySource,
} from "../lib/telemetry";
import { useArmAutoRecord, type UseArmAutoRecordOptions } from "./use-arm-auto-record";

vi.mock("@/lib/arm-auto-record", () => import("../lib/arm-auto-record"));

let current: ReturnType<typeof useArmAutoRecord>;
let renderer: ReactTestRenderer | null;
let options: UseArmAutoRecordOptions;
let nowMs: number;
let strictMode: boolean;
let listeners: Set<TelemetrySampleListener>;
let start: ReturnType<typeof vi.fn<UseArmAutoRecordOptions["start"]>>;
let stop: ReturnType<typeof vi.fn<UseArmAutoRecordOptions["stop"]>>;

function Harness({ value }: { value: UseArmAutoRecordOptions }) {
  const next = useArmAutoRecord(value);
  useEffect(() => { current = next; }, [next]);
  return null;
}

function tree() {
  const harness = <Harness value={options} />;
  return strictMode ? <StrictMode>{harness}</StrictMode> : harness;
}

async function mount(overrides: Partial<UseArmAutoRecordOptions> = {}, strict = false) {
  options = { ...options, ...overrides };
  strictMode = strict;
  await act(async () => { renderer = create(tree()); });
}

async function update(overrides: Partial<UseArmAutoRecordOptions> = {}) {
  options = { ...options, ...overrides };
  await act(async () => { renderer?.update(tree()); });
}

async function sample(aux: number, timestampMs: number, sampleSource: TelemetrySource = "serial") {
  nowMs = timestampMs;
  await act(async () => {
    for (const listener of listeners) {
      listener({
        ...EMPTY_TELEMETRY,
        timestamp: timestampMs,
        monotonicTimestampMs: timestampMs,
        rcChannelsUs: [1500, 1500, 1500, 1000, aux],
      }, sampleSource);
    }
  });
}

async function enable() {
  await act(async () => { expect(current.enable()).toBe(true); });
}

async function arm() {
  await sample(1000, 0);
  await sample(1000, 120);
  await sample(1800, 130);
  await sample(1800, 250);
}

async function tick(timestampMs: number) {
  nowMs = timestampMs;
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  nowMs = 0;
  vi.spyOn(performance, "now").mockImplementation(() => nowMs);
  renderer = null;
  strictMode = false;
  listeners = new Set();
  start = vi.fn<UseArmAutoRecordOptions["start"]>().mockResolvedValue(true);
  stop = vi.fn<UseArmAutoRecordOptions["stop"]>().mockResolvedValue(undefined);
  options = {
    subscribeSamples: vi.fn<SubscribeTelemetrySamples>((listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }),
    source: "serial",
    connection: "live",
    linkState: "ok",
    inputKey: "pilot-1",
    start,
    stop,
    canEnable: true,
  };
});

afterEach(async () => {
  if (renderer) await act(async () => { renderer?.unmount(); });
  renderer = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useArmAutoRecord", () => {
  it("keeps disabled detection inert and gates enabling on capture readiness", async () => {
    await mount({ canEnable: false });
    expect(current.config).toEqual({ auxIndex: 0, min: 1700, max: 2100 });
    expect(current.enable()).toBe(false);
    await arm();
    await tick(2000);
    expect(current.state.phase).toBe("disabled");
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    await update({ canEnable: true });
    await enable();
    expect(current.state.phase).toBe("waiting_disarm");
  });

  it("evaluates a lazy canEnable only when the user enables detection", async () => {
    const canEnable = vi.fn<() => boolean>().mockReturnValue(false);
    await mount({ canEnable });
    await update();
    await arm();
    await tick(1000);
    expect(canEnable).not.toHaveBeenCalled();
    expect(current.enable()).toBe(false);
    expect(canEnable).toHaveBeenCalledOnce();
    canEnable.mockReturnValue(true);
    await enable();
    expect(canEnable).toHaveBeenCalledTimes(2);
    expect(current.state.enabled).toBe(true);
  });

  it("does not start from demo connection state or demo-labelled raw samples", async () => {
    await mount({ source: "demo", connection: "demo" });
    await enable();
    await arm();
    expect(start).not.toHaveBeenCalled();
    await update({ source: "serial", connection: "live" });
    await sample(1000, 260, "demo");
    await sample(1000, 380, "demo");
    await sample(1800, 390, "demo");
    await sample(1800, 510, "demo");
    expect(start).not.toHaveBeenCalled();
    expect(current.state.phase).toBe("waiting_disarm");
    await sample(1000, 520);
    await sample(1000, 640);
    await sample(1800, 650);
    await sample(1800, 770);
    expect(start).toHaveBeenCalledOnce();
    expect(current.state.phase).toBe("recording");
  });

  it("freezes the AUX configuration while enabled and permits changes after disabling", async () => {
    await mount();
    await act(async () => { current.setConfig({ auxIndex: 0, min: 1600, max: 2000 }); });
    expect(current.config.min).toBe(1600);
    await enable();
    await act(async () => { current.setConfig({ auxIndex: 2, min: 1800, max: 2100 }); });
    expect(current.config).toEqual({ auxIndex: 0, min: 1600, max: 2000 });
    await act(async () => { await current.disable(); });
    await act(async () => { current.setConfig({ auxIndex: 2, min: 1800, max: 2100 }); });
    expect(current.config.auxIndex).toBe(2);
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("keeps one controller in Strict Mode and uses updated callbacks without stopping on rerender", async () => {
    await mount({}, true);
    await enable();
    await sample(1000, 0);
    await sample(1000, 120);
    const updatedStart = vi.fn<UseArmAutoRecordOptions["start"]>().mockResolvedValue(true);
    await update({ start: updatedStart });
    await sample(1800, 130);
    await sample(1800, 250);
    expect(start).not.toHaveBeenCalled();
    expect(updatedStart).toHaveBeenCalledOnce();
    expect(current.state.phase).toBe("recording");
    const updatedStop = vi.fn<UseArmAutoRecordOptions["stop"]>().mockResolvedValue(undefined);
    await update({ stop: updatedStop, canEnable: false });
    await update();
    await sample(1800, 260);
    expect(stop).not.toHaveBeenCalled();
    expect(updatedStop).not.toHaveBeenCalled();
    expect(current.state.phase).toBe("recording");
    expect(listeners.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => { await current.disable(); });
    expect(updatedStop).toHaveBeenCalledExactlyOnceWith("disabled");
  });

  it("can replace a raw sample subscription without closing the active recording", async () => {
    await mount();
    await enable();
    await arm();
    const replacement: SubscribeTelemetrySamples = (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    };
    await update({ subscribeSamples: replacement });
    expect(listeners.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    expect(current.state.phase).toBe("recording");
    expect(stop).not.toHaveBeenCalled();
    await sample(1800, 260);
    expect(start).toHaveBeenCalledOnce();
  });

  it.each(["lost", "unknown"] as const)(
    "cancels DISARM countdown but keeps capture on an RX link that becomes %s",
    async (linkState) => {
      await mount();
      await enable();
      await arm();
      await sample(1000, 260);
      await sample(1000, 380);
      expect(current.state.disarmRemainingMs).toBe(15000);
      await update({ linkState });
      expect(current.state.disarmRemainingMs).toBeNull();
      expect(current.state.phase).toBe("recording");
      await sample(1000, 16000);
      await tick(17000);
      expect(stop).not.toHaveBeenCalled();
      await update({ linkState: "ok" });
      await sample(1800, 17010);
      await sample(1800, 17130);
      expect(start).toHaveBeenCalledOnce();
    },
  );

  it("cancels countdown on stale data through its timer without requiring another sample", async () => {
    await mount();
    await enable();
    await arm();
    await sample(1000, 260);
    await sample(1000, 380);
    await tick(15380);
    expect(current.state.disarmRemainingMs).toBeNull();
    expect(current.state.phase).toBe("recording");
    expect(stop).not.toHaveBeenCalled();
  });

  it("treats canObserve=false as unknown signal while preserving an existing capture", async () => {
    await mount({ canObserve: false });
    await enable();
    await arm();
    expect(start).not.toHaveBeenCalled();
    await update({ canObserve: true });
    await sample(1000, 260);
    await sample(1000, 380);
    await sample(1800, 390);
    await sample(1800, 510);
    await sample(1000, 520);
    await sample(1000, 640);
    await update({ canObserve: false });
    expect(current.state.disarmRemainingMs).toBeNull();
    await tick(17000);
    expect(current.state.phase).toBe("recording");
    expect(stop).not.toHaveBeenCalled();
  });

  it("disables on inputKey changes so another pilot cannot continue the old ARM trigger", async () => {
    await mount();
    await enable();
    await arm();
    await update({ inputKey: "pilot-2" });
    expect(stop).toHaveBeenCalledExactlyOnceWith("disabled");
    expect(current.state.phase).toBe("disabled");
    await sample(1000, 260);
    await sample(1000, 380);
    await sample(1800, 390);
    await sample(1800, 510);
    expect(start).toHaveBeenCalledOnce();
  });

  it("stops once on unmount and releases raw sample listeners and timers", async () => {
    await mount();
    await enable();
    await arm();
    const previous = current;
    await act(async () => { renderer?.unmount(); });
    renderer = null;
    expect(stop).toHaveBeenCalledExactlyOnceWith("disabled");
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(previous.enable()).toBe(false);
  });

  it("passes raw samples through to the continuous 15-second DISARM finish rule", async () => {
    await mount();
    await enable();
    await arm();
    for (let timestampMs = 260; timestampMs <= 15260; timestampMs += 500) {
      await sample(1000, timestampMs);
    }
    expect(stop).toHaveBeenCalledExactlyOnceWith("disarm");
    expect(current.state.phase).toBe("waiting_disarm");
    expect(current.state.enabled).toBe(true);
  });
});

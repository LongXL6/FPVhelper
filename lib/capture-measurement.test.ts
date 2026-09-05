import { afterEach, describe, expect, it, vi } from "vitest";
import type { MeasurementSetup } from "./capture-measurement";

async function load({ build = "true", hostname = "localhost", setup }: {
  build?: string;
  hostname?: string;
  setup?: MeasurementSetup;
} = {}) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_FPV_MEASUREMENT", build);
  vi.stubGlobal("window", { location: { hostname, search: "?measurement=on" }, __fpvMeasurementSetup: setup });
  return import("./capture-measurement");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("capture measurement gates and bounded trace", () => {
  it.each([
    { build: "false", hostname: "localhost", setup: { mode: "on", maxEvents: 20 } },
    { build: "true", hostname: "race.example.com", setup: { mode: "on", maxEvents: 20 } },
    { build: "true", hostname: "localhost", setup: undefined },
    { build: "true", hostname: "localhost", setup: { mode: "on", maxEvents: 200_001 } },
    { build: "true", hostname: "localhost", setup: { mode: "on", maxEvents: 0 } },
  ] as const)("does not expose a bridge without all build/host/handshake gates: %j", async (options) => {
    const collector = await load(options);
    expect(collector.measurementEnabled()).toBe(false);
    expect(window.__fpvMeasurement).toBeUndefined();
    window.__fpvMeasurementSetup = { mode: "on", maxEvents: 20 };
    expect(collector.measurementEnabled()).toBe(false);
    expect(window.__fpvMeasurement).toBeUndefined();
  });

  it("keeps P0 fixed off without reading sample fields, copying events, or creating timers", async () => {
    const setup: MeasurementSetup = { mode: "off", maxEvents: 20, runId: "p0-test" };
    const collector = await load({ setup });
    const clone = vi.spyOn(globalThis, "structuredClone");
    const interval = vi.spyOn(globalThis, "setInterval");
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const sample = { get sequence() { throw new Error("off probe read product data"); } };
    setup.mode = "on";
    for (let index = 0; index < 100; index += 1) {
      expect(collector.measurementEnabled()).toBe(false);
      collector.measurementEvent("ignored", {});
      expect(collector.measurementIdentity(sample, "sample")).toBe("");
      expect(collector.measurementSampleFields(sample as never)).toEqual({});
    }
    expect(clone).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
    expect(timeout).not.toHaveBeenCalled();
    const mark = window.__fpvMeasurement!.mark("boundary");
    expect(mark.timeMs).toBeGreaterThan(0);
    expect(mark.index).toBeNull();
    expect(window.__fpvMeasurement!.snapshot()).toMatchObject({ mode: "off", enabled: false, events: [], overflowCount: 0 });
  });

  it("copies only trace metadata and keeps hook, generation and raw AUX identity immutable", async () => {
    const collector = await load({ setup: { mode: "on", maxEvents: 20, runId: "p1-identity" } });
    const hook = {};
    const sample = { sequence: 4, monotonicTimestampMs: 12, rcChannelsUs: [1500, 1500, 1000, 1500, 1020, 1000, 1002, 1001] };
    const context = { hookId: collector.measurementIdentity(hook, "hook"), pilotChannelId: "pilot-2", connectionGeneration: 3, source: "serial" as const };
    collector.measurementBindSample(sample, context);
    collector.measurementEvent("rc.decoded", collector.measurementSampleFields(sample));
    const analogSample = { ...sample, monotonicTimestampMs: 14 };
    collector.measurementInheritSample(analogSample, sample);
    collector.measurementEvent("store.updated", collector.measurementSampleFields(analogSample));
    sample.rcChannelsUs[4] = 1900;
    context.connectionGeneration = 99;
    const snapshot = window.__fpvMeasurement!.snapshot();
    expect(snapshot).toMatchObject({ enabled: true, runId: "p1-identity", timeOriginEpochMs: performance.timeOrigin });
    expect(snapshot.events[0]).toMatchObject({ index: 0, kind: "rc.decoded", hookId: context.hookId, connectionGeneration: 3, channelsUs: [1500, 1500, 1000, 1500, 1020, 1000, 1002, 1001] });
    expect(snapshot.events[1]).toMatchObject({ kind: "store.updated", connectionGeneration: 3, monotonicTimestampMs: 14 });
    snapshot.events[0].kind = "edited";
    expect(window.__fpvMeasurement!.snapshot().events[0].kind).toBe("rc.decoded");
    expect(collector.measurementIdentity(hook, "hook")).toBe(context.hookId);
    expect(collector.measurementIdentity({}, "hook")).not.toBe(context.hookId);
  });

  it("records subscription instances without changing duplicate Set subscription semantics", async () => {
    const collector = await load({ setup: { mode: "on", maxEvents: 20 } });
    const owner = new Set();
    const listener = () => undefined;
    const first = collector.measurementRegisterSubscription(owner, listener);
    const duplicate = collector.measurementRegisterSubscription(owner, listener);
    expect(first.added).toBe(true);
    expect(duplicate.added).toBe(false);
    expect(duplicate.subscriptionId).toBe(first.subscriptionId);
    expect(duplicate.registrationId).not.toBe(first.registrationId);
    expect(collector.measurementRemoveSubscription(owner, listener, duplicate.registrationId)).toMatchObject({ deleted: true, subscriptionId: first.subscriptionId });
    expect(collector.measurementRemoveSubscription(owner, listener, first.registrationId).deleted).toBe(false);
    const again = collector.measurementRegisterSubscription(owner, listener);
    expect(again.consumerId).toBe(first.consumerId);
    expect(again.subscriptionId).not.toBe(first.subscriptionId);
  });

  it("stops at the cap without overwriting records or reporting an overflowed run as enabled", async () => {
    const collector = await load({ setup: { mode: "on", maxEvents: 2 } });
    collector.measurementEvent("first", { channelsUs: [1001] });
    collector.measurementEvent("second", {});
    collector.measurementEvent("overflow", {});
    for (let index = 0; index < 100; index += 1) collector.measurementEvent("ignored", {});
    expect(collector.measurementEnabled()).toBe(false);
    expect(collector.measurementIdentity({}, "after-overflow")).toBe("");
    const snapshot = window.__fpvMeasurement!.snapshot();
    expect(snapshot).toMatchObject({ enabled: false, overflowed: true, overflowCount: 1 });
    expect(snapshot.events.map((event) => event.kind)).toEqual(["first", "second"]);
  });

  it("contains instrumentation copy failures instead of changing product exception behavior", async () => {
    const collector = await load({ setup: { mode: "on", maxEvents: 20 } });
    const clone = vi.spyOn(globalThis, "structuredClone").mockImplementationOnce(() => { throw new Error("trace copy failed"); });
    expect(() => collector.measurementEvent("sample", {})).not.toThrow();
    expect(collector.measurementEnabled()).toBe(false);
    clone.mockRestore();
    expect(window.__fpvMeasurement!.snapshot()).toMatchObject({ instrumentationErrorCount: 1, events: [] });
  });
});

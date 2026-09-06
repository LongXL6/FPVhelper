import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelemetryController } from "./use-betaflight-telemetry";
import { createPilotTelemetryWorkspaceStore } from "./use-pilot-telemetry-workspace";
import { EMPTY_BETAFLIGHT_DEVICE_NAMES, type BetaflightDeviceNames } from "../lib/betaflight-device-name";

vi.mock("./use-betaflight-telemetry", () => ({
  useBetaflightTelemetry: vi.fn(),
}));

function controller(id: string, deviceNames: BetaflightDeviceNames = EMPTY_BETAFLIGHT_DEVICE_NAMES) {
  return { id, deviceNames } as unknown as TelemetryController;
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

async function measuredStore(mode: "on" | "off") {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_FPV_MEASUREMENT", "true");
  vi.stubGlobal("window", { location: { hostname: "localhost" }, __fpvMeasurementSetup: { mode, maxEvents: 1000 } });
  return (await import("./use-pilot-telemetry-workspace")).createPilotTelemetryWorkspaceStore();
}

describe("pilot telemetry workspace store", () => {
  it.each(["on", "off"] as const)("preserves notification order, exact reads and duplicate subscriptions with measurement %s", async (mode) => {
    const store = await measuredStore(mode);
    const calls: string[] = [];
    const first = () => { calls.push("first"); store.getSnapshot("one"); };
    const removeFirst = store.subscribe("one", first);
    const removeDuplicate = store.subscribe("one", first);
    const removeSecond = store.subscribe("one", () => { calls.push("second"); });
    const next = controller("next");
    store.publish("one", next);
    store.publish("one", next);
    removeDuplicate();
    store.publish("one", controller("third"));
    removeFirst();
    removeSecond();
    store.remove("one");
    expect(calls).toEqual(["first", "second", "second"]);
    const events = window.__fpvMeasurement!.snapshot().events;
    if (mode === "off") { expect(events).toEqual([]); return; }
    expect(events.filter((event) => event.kind === "store.read")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "store.updated")).toHaveLength(2);
    expect(events.filter((event) => event.kind === "store.publish.skipped")).toHaveLength(1);
    expect(events.filter((event) => event.kind.startsWith("store.listener.")).map((event) => event.kind))
      .toEqual(["store.listener.attempted", "store.listener.returned", "store.listener.attempted", "store.listener.returned", "store.listener.attempted", "store.listener.returned"]);
    const registrations = events.filter((event) => event.kind === "store.subscription.add");
    expect(registrations[1]).toMatchObject({ added: false, subscriptionId: registrations[0].subscriptionId });
    expect(events.filter((event) => event.kind === "store.subscription.remove").map((event) => event.deleted)).toEqual([true, false, true]);
  });

  it("observes and rethrows the original listener error without calling later listeners", async () => {
    const store = await measuredStore("on");
    const error = new Error("original listener failure");
    const later = vi.fn();
    store.subscribe("one", () => { throw error; });
    store.subscribe("one", later);
    const next = controller("next");
    let thrown: unknown;
    try { store.publish("one", next); } catch (caught) { thrown = caught; }
    expect(thrown).toBe(error);
    expect(later).not.toHaveBeenCalled();
    expect(store.getSnapshot("one")).toBe(next);
    const events = window.__fpvMeasurement!.snapshot().events;
    expect(events.filter((event) => event.kind.startsWith("store.listener.")).map((event) => event.kind))
      .toEqual(["store.listener.attempted", "store.listener.threw"]);
  });

  it("keeps each pilot controller and subscriber isolated", () => {
    const store = createPilotTelemetryWorkspaceStore();
    const pilotOne = controller("pilot-one");
    const pilotTwo = controller("pilot-two");
    const pilotOneListener = vi.fn();
    const pilotTwoListener = vi.fn();
    const unsubscribePilotOne = store.subscribe("pilot-one", pilotOneListener);
    store.subscribe("pilot-two", pilotTwoListener);

    store.publish("pilot-one", pilotOne);
    store.publish("pilot-two", pilotTwo);

    expect(store.getSnapshot("pilot-one")).toBe(pilotOne);
    expect(store.getSnapshot("pilot-two")).toBe(pilotTwo);
    expect(pilotOneListener).toHaveBeenCalledTimes(1);
    expect(pilotTwoListener).toHaveBeenCalledTimes(1);

    store.remove("pilot-one");
    expect(store.getSnapshot("pilot-one")).not.toBe(pilotOne);
    expect(store.getSnapshot("pilot-two")).toBe(pilotTwo);
    expect(pilotOneListener).toHaveBeenCalledTimes(2);
    expect(pilotTwoListener).toHaveBeenCalledTimes(1);

    unsubscribePilotOne();
    store.publish("pilot-one", controller("pilot-one-reconnected"));
    expect(pilotOneListener).toHaveBeenCalledTimes(2);
  });

  it("does not notify when a bridge republishes the same controller object", () => {
    const store = createPilotTelemetryWorkspaceStore();
    const listener = vi.fn();
    const stableController = controller("stable");
    store.subscribe("pilot-one", listener);

    store.publish("pilot-one", stableController);
    store.publish("pilot-one", stableController);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps an empty names snapshot for idle channels and missing controllers", () => {
    const store = createPilotTelemetryWorkspaceStore();
    const initial = store.getNamesSnapshot();
    const listener = vi.fn();
    store.subscribeNames(listener);
    store.publish("pilot-one", controller("idle"));
    store.remove("missing");
    store.remove("pilot-one");

    expect(store.getNamesSnapshot()).toBe(initial);
    expect(store.getSnapshot(undefined).deviceNames).toBe(EMPTY_BETAFLIGHT_DEVICE_NAMES);
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not notify names subscribers during 100 telemetry updates with identical metadata", () => {
    const store = createPilotTelemetryWorkspaceStore();
    const names: BetaflightDeviceNames = { pilotName: "PILOT-01", craftName: "CRAFT-01", status: "ready" };
    store.publish("pilot-one", controller("initial", names));
    const initial = store.getNamesSnapshot();
    const namesListener = vi.fn();
    const controllerListener = vi.fn();
    store.subscribeNames(namesListener);
    store.subscribe("pilot-one", controllerListener);

    for (let tick = 0; tick < 100; tick += 1) store.publish("pilot-one", controller(String(tick), { ...names }));

    expect(store.getNamesSnapshot()).toBe(initial);
    expect(namesListener).not.toHaveBeenCalled();
    expect(controllerListener).toHaveBeenCalledTimes(100);
  });

  it("publishes a single names change while preserving other pilots and previous snapshots", () => {
    const store = createPilotTelemetryWorkspaceStore();
    const names: BetaflightDeviceNames = { pilotName: "PILOT-01", craftName: "CRAFT-01", status: "ready" };
    store.publish("pilot-one", controller("one", names));
    store.publish("pilot-two", controller("two", { ...names, pilotName: "PILOT-02" }));
    const initial = store.getNamesSnapshot();
    const listener = vi.fn();
    const unsubscribe = store.subscribeNames(listener);

    store.publish("pilot-one", controller("renamed", { ...names, pilotName: "NEW-NAME" }));
    const renamed = store.getNamesSnapshot();
    expect(renamed).not.toBe(initial);
    expect(renamed["pilot-one"].pilotName).toBe("NEW-NAME");
    expect(initial["pilot-one"].pilotName).toBe("PILOT-01");
    expect(renamed["pilot-two"]).toBe(initial["pilot-two"]);
    expect(listener).toHaveBeenCalledTimes(1);

    store.remove("pilot-one");
    expect(store.getNamesSnapshot()).toEqual({ "pilot-two": initial["pilot-two"] });
    expect(listener).toHaveBeenCalledTimes(2);
    store.remove("pilot-one");
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    store.remove("pilot-two");
    expect(store.getNamesSnapshot()).toEqual({});
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("publishes status and craft-name changes and removes names when a connection returns to idle", () => {
    const store = createPilotTelemetryWorkspaceStore();
    const initial = store.getNamesSnapshot();
    const listener = vi.fn();
    store.subscribeNames(listener);
    store.publish("pilot-one", controller("reading", { ...EMPTY_BETAFLIGHT_DEVICE_NAMES, status: "reading" }));
    store.publish("pilot-one", controller("craft", { pilotName: "", craftName: "CRAFT-01", status: "ready" }));
    store.publish("pilot-one", controller("new-craft", { pilotName: "", craftName: "CRAFT-02", status: "ready" }));
    store.publish("pilot-one", controller("unavailable", { ...EMPTY_BETAFLIGHT_DEVICE_NAMES, status: "unavailable" }));
    expect(store.getNamesSnapshot()["pilot-one"].status).toBe("unavailable");
    expect(listener).toHaveBeenCalledTimes(4);

    store.publish("pilot-one", controller("disconnected"));
    expect(store.getNamesSnapshot()).toBe(initial);
    expect(listener).toHaveBeenCalledTimes(5);
  });
});

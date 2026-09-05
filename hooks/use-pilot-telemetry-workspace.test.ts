import { describe, expect, it, vi } from "vitest";
import type { TelemetryController } from "./use-betaflight-telemetry";
import { createPilotTelemetryWorkspaceStore } from "./use-pilot-telemetry-workspace";
import { EMPTY_BETAFLIGHT_DEVICE_NAMES, type BetaflightDeviceNames } from "../lib/betaflight-device-name";

vi.mock("./use-betaflight-telemetry", () => ({
  useBetaflightTelemetry: vi.fn(),
}));

function controller(id: string, deviceNames: BetaflightDeviceNames = EMPTY_BETAFLIGHT_DEVICE_NAMES) {
  return { id, deviceNames } as unknown as TelemetryController;
}

describe("pilot telemetry workspace store", () => {
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
